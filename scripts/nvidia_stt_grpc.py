#!/usr/bin/env python3
"""Transcribe audio via NVIDIA Riva gRPC on NVCF (parakeet-ctc etc.)."""
from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="NVIDIA NVCF gRPC STT")
    parser.add_argument("--server", default="grpc.nvcf.nvidia.com:443")
    parser.add_argument("--function-id", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="en-US")
    parser.add_argument("--api-key-env", default="NVIDIA_API_KEY")
    args = parser.parse_args()

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        print(f"Missing env var {args.api_key_env}", file=sys.stderr)
        return 1

    try:
        import riva.client
    except ImportError:
        print("Install: pip install nvidia-riva-client", file=sys.stderr)
        return 2

    if not os.path.isfile(args.audio):
        print(f"Audio not found: {args.audio}", file=sys.stderr)
        return 3

    ext = os.path.splitext(args.audio)[1].lower()
    sample_rate = 16000
    if ext == ".wav":
        import wave

        with wave.open(args.audio, "rb") as wf:
            sample_rate = wf.getframerate()
            channels = wf.getnchannels()
            if channels != 1:
                print(f"Warning: expected mono WAV, got {channels} channels", file=sys.stderr)
        encoding = riva.client.AudioEncoding.LINEAR_PCM
    elif ext in (".ogg", ".opus"):
        encoding = riva.client.AudioEncoding.OGGOPUS
    elif ext == ".flac":
        encoding = riva.client.AudioEncoding.FLAC
    else:
        encoding = riva.client.AudioEncoding.LINEAR_PCM

    auth = riva.client.Auth(
        ssl_root_cert=None,
        ssl_client_cert=None,
        ssl_client_key=None,
        use_ssl=True,
        uri=args.server,
        metadata_args=[
            ["function-id", args.function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr = riva.client.ASRService(auth)

    with open(args.audio, "rb") as f:
        audio_data = f.read()

    config = riva.client.RecognitionConfig(
        encoding=encoding,
        sample_rate_hertz=sample_rate,
        language_code=args.language,
        max_alternatives=1,
        enable_automatic_punctuation=True,
    )

    try:
        response = asr.offline_recognize(audio_data, config)
    except Exception as e:
        print(f"gRPC STT failed: {e}", file=sys.stderr)
        return 4

    if not response.results:
        print("No transcription results", file=sys.stderr)
        return 5

    transcript = response.results[0].alternatives[0].transcript.strip()
    if not transcript:
        print("Empty transcript", file=sys.stderr)
        return 6

    print(transcript)
    return 0


if __name__ == "__main__":
    sys.exit(main())
