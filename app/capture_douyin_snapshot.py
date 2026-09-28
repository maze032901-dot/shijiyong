"""Capture one public Douyin link for the local intake queue.

The worker is intentionally separate from the HTTP receiver: a phone receives a quick
queue acknowledgement while F2, identity generation, and media downloading run later.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
# The checked-in worker is usable locally with the F2 spike vendor directory.  The
# production image supplies the same code at /opt/hermes/f2 through this setting.
F2_ROOT = Path(__import__("os").environ.get("HERMES_F2_ROOT", ROOT / "runtime" / "f2-capture-spike" / "_vendor" / "f2"))
sys.path.insert(0, str(F2_ROOT))

from f2.apps.douyin.crawler import DouyinCrawler
from f2.apps.douyin.filter import PostDetailFilter
from f2.apps.douyin.model import PostDetail
from f2.apps.douyin.utils import AwemeIdFetcher, ClientConfManager, TokenManager
from f2.log.logger import logger as f2_logger
from f2.log.logger import trace_logger as f2_trace_logger
from media_classification import classify_media, collect_assets


F2_DIAGNOSTICS: list[dict] = []


class SafeF2DiagnosticHandler(logging.Handler):
    """Keep only status-level diagnostics; never retain URLs, tokens or response bodies."""

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        status_match = re.search(r"(?:状态码|status(?:_code)?)[：:\s]+(\d{3})", message, re.IGNORECASE)
        event = None
        if "响应内容为空" in message:
            event = {"kind": "empty_response"}
        elif "HTTP状态码错误" in message or "未知HTTP状态码" in message:
            event = {"kind": "http_status"}
        elif "请求端点超时" in message or "请求超时" in message:
            event = {"kind": "timeout"}
        elif "网络连接失败" in message or "连接端点失败" in message:
            event = {"kind": "network_error"}
        if event is None:
            return
        if status_match:
            event["http_status"] = int(status_match.group(1))
        if not F2_DIAGNOSTICS or F2_DIAGNOSTICS[-1] != event:
            F2_DIAGNOSTICS.append(event)
        del F2_DIAGNOSTICS[:-6]


safe_diagnostic_handler = SafeF2DiagnosticHandler()
for active_logger in (f2_logger, f2_trace_logger):
    for handler in active_logger.handlers:
        handler.close()
    active_logger.handlers.clear()
    active_logger.addHandler(safe_diagnostic_handler)
    active_logger.propagate = False

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    "Referer": "https://www.douyin.com/",
}
MAX_ASSET_BYTES = 250 * 1024 * 1024
EXTENSIONS = {"image/jpeg": ".jpg", "image/webp": ".webp", "image/png": ".png", "video/mp4": ".mp4"}


def canonical_douyin_url(aweme_id: str, media_kind: str) -> str | None:
    route = "note" if media_kind == "gallery" else "video" if media_kind == "video" else None
    return f"https://www.douyin.com/{route}/{aweme_id}" if route else None


def reset_diagnostics() -> None:
    F2_DIAGNOSTICS.clear()


def failure_diagnostic(raw: object) -> dict:
    diagnostic: dict = {"f2_events": list(F2_DIAGNOSTICS)}
    if isinstance(raw, dict) and isinstance(raw.get("status_code"), int):
        diagnostic["platform_status"] = raw["status_code"]
    return diagnostic


def safe_exception_message(exc: Exception) -> str:
    # F2 exceptions can include signed request URLs; keep the failure useful without
    # putting those temporary credentials in a queue record.
    message = re.sub(r"https?://\S+", "<redacted-url>", str(exc)).strip()
    return message[:240] or type(exc).__name__


def valid_magic(content_type: str, prefix: bytes) -> bool:
    return (
        (content_type == "image/jpeg" and prefix.startswith(b"\xff\xd8\xff"))
        or (content_type == "image/webp" and prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP")
        or (content_type == "image/png" and prefix.startswith(b"\x89PNG\r\n\x1a\n"))
        or (content_type == "video/mp4" and b"ftyp" in prefix[:32])
    )


async def download_asset(client: httpx.AsyncClient, asset: dict, target_dir: Path) -> dict:
    name = "cover" if asset["kind"] == "cover" else "video" if asset["kind"] == "video" else f"image-{asset['index']:02d}"
    try:
        async with client.stream("GET", asset["url"]) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            extension = EXTENSIONS.get(content_type)
            if not extension:
                raise ValueError(f"unsupported content type: {content_type or 'missing'}")
            part_path = target_dir / f".{name}{extension}.part"
            final_path = target_dir / f"{name}{extension}"
            digest, size, prefix = hashlib.sha256(), 0, bytearray()
            with part_path.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_ASSET_BYTES:
                        raise ValueError("asset exceeds 250 MiB safety limit")
                    if len(prefix) < 64:
                        prefix.extend(chunk[: 64 - len(prefix)])
                    digest.update(chunk)
                    output.write(chunk)
            if size == 0 or not valid_magic(content_type, bytes(prefix)):
                raise ValueError("empty file or content type does not match file header")
            part_path.replace(final_path)
            return {"kind": asset["kind"], "index": asset["index"], "status": "captured", "file": final_path.name, "bytes": size, "sha256": digest.hexdigest()}
    except Exception as exc:
        for candidate in target_dir.glob(f".{name}.*.part"):
            candidate.unlink(missing_ok=True)
        return {"kind": asset["kind"], "index": asset["index"], "status": "failed", "error_type": type(exc).__name__, "error": str(exc)}


async def resolve_aweme_id(url: str) -> str:
    last_error = None
    for _ in range(3):
        try:
            return await AwemeIdFetcher.get_aweme_id(url)
        except Exception as exc:
            last_error = exc
            await asyncio.sleep(1)
    raise last_error or RuntimeError("could not resolve aweme id")


async def capture(url: str, output_root: Path, capture_media: bool = False, persist_snapshot: bool = True) -> dict:
    started = time.monotonic()
    reset_diagnostics()
    try:
        aweme_id = await resolve_aweme_id(url)
        target_dir = output_root / aweme_id
        snapshot_path = target_dir / "snapshot.json"
        if persist_snapshot and snapshot_path.exists():
            prior = json.loads(snapshot_path.read_text(encoding="utf-8"))
            canonical_url = canonical_douyin_url(aweme_id, prior.get("media_kind", "unknown"))
            if canonical_url and prior.get("canonical_url") != canonical_url:
                prior["canonical_url"] = canonical_url
                snapshot_path.write_text(json.dumps(prior, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return {**prior, "reused_snapshot": True}

        ttwid = TokenManager.gen_ttwid()
        kwargs = {"cookie": f"ttwid={ttwid};", "headers": ClientConfManager.headers(), "proxies": ClientConfManager.proxies(), "timeout": 15, "max_retries": 2, "max_connections": 2, "max_tasks": 1}
        async with DouyinCrawler(kwargs) as crawler:
            raw = await crawler.fetch_post_detail(PostDetail(aweme_id=aweme_id))
        ttwid = ""
        if not isinstance(raw, dict) or not raw.get("aweme_detail"):
            return {
                "status": "failed",
                "retryable": True,
                "aweme_id": aweme_id,
                "error_type": "EmptyPlatformResponse",
                "error": "platform returned no aweme_detail",
                "diagnostic": failure_diagnostic(raw),
            }

        if persist_snapshot:
            target_dir.mkdir(parents=True, exist_ok=True)
            (target_dir / "raw.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        detail = PostDetailFilter(raw)
        media_kind, signals = classify_media(raw)
        assets = collect_assets(raw, media_kind)
        # The cloud is a durable inbox, not a video archive. Media is deliberately
        # left for the paired Mac to download and process later.
        if capture_media:
            async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=60) as client:
                media = [await download_asset(client, asset, target_dir) for asset in assets]
        else:
            media = []
        failed_media = [item for item in media if item["status"] != "captured"]
        result = {
            "status": "partial" if failed_media else "captured",
            "retryable": False,
            "aweme_id": aweme_id,
            "source_url": url,
            "canonical_url": canonical_douyin_url(aweme_id, media_kind),
            "author": detail.nickname_raw,
            "description": detail.desc_raw,
            "created_at": detail.create_time,
            "media_kind": media_kind,
            "media_signals": signals,
            "media_manifest": assets,
            "media": media,
            "captured_at": datetime.now(timezone.utc).isoformat(),
        }
        if persist_snapshot:
            snapshot_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result
    except Exception as exc:
        return {
            "status": "failed",
            "retryable": True,
            "error_type": type(exc).__name__,
            "error": safe_exception_message(exc),
            "diagnostic": failure_diagnostic(None),
        }
    finally:
        pass


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--capture-media", action="store_true", help="Download media only when explicitly requested")
    parser.add_argument("--no-persist", action="store_true", help="Do not write raw responses or snapshots; intended for a local diagnostic probe")
    args = parser.parse_args()
    result = await capture(args.url, Path(args.output_root), capture_media=args.capture_media, persist_snapshot=not args.no_persist)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
