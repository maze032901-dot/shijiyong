"""Run RapidOCR once per persisted image, preserving per-image outcomes."""

from __future__ import annotations

import argparse
import json
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def as_box(points: object) -> list[int] | None:
    if points is None:
        return None
    try:
        values = [[float(point[0]), float(point[1])] for point in points]  # type: ignore[index]
    except (TypeError, IndexError, ValueError):
        return None
    if not values:
        return None
    return [
        int(round(min(point[0] for point in values))),
        int(round(min(point[1] for point in values))),
        int(round(max(point[0] for point in values))),
        int(round(max(point[1] for point in values))),
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-jsonl", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    jobs = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(jobs, list) or not jobs:
        raise SystemExit("manifest must be a non-empty JSON array")

    from PIL import Image
    import onnxruntime
    from rapidocr import RapidOCR

    started = time.perf_counter()
    ocr = RapidOCR()
    init_ms = (time.perf_counter() - started) * 1000
    output_path = Path(args.output_jsonl)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as output:
        for index, job in enumerate(jobs, start=1):
            item_started = time.perf_counter()
            result_record: dict[str, object] = {
                "job_id": job.get("job_id"),
                "event_id": job.get("event_id"),
                "asset_id": job.get("asset_id"),
                "local_path": job.get("local_path"),
                "image_path": job.get("image_path"),
            }
            try:
                with Image.open(job["image_path"]) as image:
                    width, height = image.size
                prediction = ocr(job["image_path"])
                raw_boxes_value = getattr(prediction, "boxes", None)
                raw_texts_value = getattr(prediction, "txts", None)
                raw_scores_value = getattr(prediction, "scores", None)
                raw_boxes = list(raw_boxes_value) if raw_boxes_value is not None else []
                raw_texts = list(raw_texts_value) if raw_texts_value is not None else []
                raw_scores = list(raw_scores_value) if raw_scores_value is not None else []
                regions = []
                for region_index, raw_text in enumerate(raw_texts):
                    text = str(raw_text).strip()
                    raw_polygon = raw_boxes[region_index] if region_index < len(raw_boxes) else None
                    box = as_box(raw_polygon)
                    if not text or box is None:
                        continue
                    try:
                        polygon = [
                            [int(round(float(point[0]))), int(round(float(point[1])))]
                            for point in raw_polygon
                        ]
                    except (TypeError, IndexError, ValueError):
                        polygon = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
                    try:
                        score = max(0.0, min(1.0, float(raw_scores[region_index])))
                    except (IndexError, TypeError, ValueError):
                        score = 0.0
                    regions.append({
                        "index": len(regions) + 1,
                        "text": text,
                        "confidence": score,
                        "box_px": box,
                        "polygon_px": polygon,
                    })
                regions.sort(key=lambda region: (region["box_px"][1], region["box_px"][0]))
                for region_index, region in enumerate(regions, start=1):
                    region["index"] = region_index
                item_status = "completed_text" if regions else "completed_empty"
                result_record["result"] = {
                    "engine": "RapidOCR",
                    "status": item_status,
                    "image_width_px": width,
                    "image_height_px": height,
                    "versions": {
                        "rapidocr": package_version("rapidocr"),
                        "onnxruntime": getattr(onnxruntime, "__version__", "unknown"),
                    },
                    "settings": {
                        "det_model": "PP-OCRv6_det_small",
                        "rec_model": "PP-OCRv6_rec_small",
                        "cls_model": "ch_ppocr_mobile_v2.0_cls_mobile",
                        "engine": "onnxruntime",
                        "device": "cpu",
                        "text_score": 0.5,
                        "coordinate_system": "pixel top-left",
                    },
                    "timing": {
                        "model_init_ms": init_ms if index == 1 else 0,
                        "predict_ms": float(getattr(prediction, "elapse", 0.0)) * 1000,
                        "process_ms": (time.perf_counter() - item_started) * 1000,
                    },
                    "regions": regions,
                    "error": None,
                }
            except Exception as exc:  # keep the batch moving and make failure explicit
                result_record["result"] = {
                    "engine": "RapidOCR",
                    "status": "failed",
                    "versions": {"rapidocr": package_version("rapidocr")},
                    "timing": {"process_ms": (time.perf_counter() - item_started) * 1000},
                    "regions": [],
                    "error": str(exc)[:500],
                }
            output.write(json.dumps(result_record, ensure_ascii=False) + "\n")
            output.flush()
            current = result_record["result"]
            print(
                f"[{index}/{len(jobs)}] {current['status']} "
                f"{result_record['event_id']} {result_record['asset_id']} "
                f"regions={len(current.get('regions', []))}",
                flush=True,
            )


if __name__ == "__main__":
    main()
