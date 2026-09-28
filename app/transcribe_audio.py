"""Transcribe one local audio file with the project-local faster-whisper runtime."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def transcribe(audio_path: Path, model_name: str, model_root: Path) -> dict:
    model_root.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(model_root),
    )
    segments_iter, info = model.transcribe(
        str(audio_path),
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    segments = []
    for index, segment in enumerate(segments_iter, 1):
        words = []
        probabilities = []
        for word in segment.words or []:
            probability = clamp(word.probability)
            probabilities.append(probability)
            words.append(
                {
                    "start": round(float(word.start), 3),
                    "end": round(float(word.end), 3),
                    "text": word.word,
                    "probability": probability,
                }
            )
        confidence = (
            sum(probabilities) / len(probabilities)
            if probabilities
            else clamp(pow(2.718281828459045, float(segment.avg_logprob)))
        )
        text = segment.text.strip()
        if not text:
            continue
        segments.append(
            {
                "index": index,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
                "confidence": confidence,
                "avg_logprob": float(segment.avg_logprob),
                "no_speech_prob": float(segment.no_speech_prob),
                "words": words,
            }
        )
    return {
        "schema_version": "hermes/asr-transcript/v1",
        "engine": "faster-whisper",
        "model": model_name,
        "device": "cpu",
        "compute_type": "int8",
        "language": info.language,
        "language_probability": clamp(info.language_probability),
        "duration_seconds": round(float(info.duration), 3),
        "segments": segments,
        "text": "\n".join(item["text"] for item in segments),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    if args.prepare:
        Path(args.model_root).mkdir(parents=True, exist_ok=True)
        WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=args.model_root,
        )
        print(json.dumps({"status": "ready", "model": args.model}, ensure_ascii=False))
        return
    if not args.audio:
        parser.error("--audio is required unless --prepare is used")
    result = transcribe(Path(args.audio), args.model, Path(args.model_root))
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
