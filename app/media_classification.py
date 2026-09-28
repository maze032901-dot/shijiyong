def first_url(container: dict | None) -> str | None:
    if not isinstance(container, dict):
        return None
    urls = container.get("url_list") or []
    return urls[0] if urls else None


def video_play_url(video: dict) -> str | None:
    bit_rates = video.get("bit_rate") or []
    play_addr = (bit_rates[0].get("play_addr") if bit_rates and isinstance(bit_rates[0], dict) else None) or video.get("play_addr")
    return first_url(play_addr)


def media_signals(raw: dict) -> dict:
    detail = raw.get("aweme_detail") or {}
    video = detail.get("video") or {}
    return {
        "aweme_type": detail.get("aweme_type"),
        "has_images": bool(detail.get("images") or []),
        "has_video_play_url": bool(video_play_url(video)),
    }


def classify_media(raw: dict) -> tuple[str, dict]:
    """Classify from independent platform signals, never from a generated URL."""
    signals = media_signals(raw)
    # F2's own Douyin downloader treats aweme_type 68 as an image collection.
    # Some video payloads also carry images, so images must not win by itself.
    if signals["aweme_type"] == 68:
        return "gallery", signals
    if signals["has_video_play_url"]:
        return "video", signals
    if signals["has_images"]:
        return "gallery", signals
    return "unknown", signals


def collect_assets(raw: dict, media_kind: str) -> list[dict]:
    detail = raw.get("aweme_detail") or {}
    aweme_id = str(detail.get("aweme_id") or "unknown")
    video = detail.get("video") or {}
    assets = []
    cover_url = first_url(video.get("origin_cover")) or first_url(video.get("cover"))
    if cover_url:
        assets.append({"aweme_id": aweme_id, "kind": "cover", "index": 1, "url": cover_url})
    images = detail.get("images") or []
    if media_kind == "gallery":
        for index, image in enumerate(images, 1):
            if url := first_url(image):
                assets.append({"aweme_id": aweme_id, "kind": "image", "index": index, "url": url})
    elif media_kind == "video":
        if url := video_play_url(video):
            assets.append({"aweme_id": aweme_id, "kind": "video", "index": 1, "url": url})
    return assets
