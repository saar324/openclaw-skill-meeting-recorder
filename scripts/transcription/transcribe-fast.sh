#!/bin/bash
# Fast Whisper transcription using faster-whisper (CTranslate2)
# Uses 4x less memory and is 4x faster than standard Whisper

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

AUDIO_FILE="$1"
WHISPER_MODEL="${2:-small}"
LANGUAGE="${3:-auto}"

if [ -z "$AUDIO_FILE" ]; then
    echo "Usage: transcribe-fast.sh <audio-file> [model] [language]"
    echo "Models: tiny, base, small, medium, large"
    echo "Default: small model, auto language detection"
    exit 1
fi

if [ ! -f "$AUDIO_FILE" ]; then
    echo "Error: Audio file not found: $AUDIO_FILE"
    exit 1
fi

# Output directory is same as audio file location
OUTPUT_DIR=$(dirname "$AUDIO_FILE")
BASENAME=$(basename "$AUDIO_FILE" .wav)

echo "Transcribing: $AUDIO_FILE"
echo "Model: $WHISPER_MODEL"
echo "Language: $LANGUAGE"
echo "Output: $OUTPUT_DIR/"
echo ""

# Handle auto language detection
LANG_PARAM=""
if [ "$LANGUAGE" != "auto" ]; then
    LANG_PARAM="language=\"$LANGUAGE\","
fi

# Run faster-whisper
python3 << PYTHON
from faster_whisper import WhisperModel
import os
import sys

audio_file = "$AUDIO_FILE"
model_size = "$WHISPER_MODEL"
language = "$LANGUAGE" if "$LANGUAGE" != "auto" else None
output_dir = "$OUTPUT_DIR"
basename = "$BASENAME"

print(f"Loading {model_size} model (first run downloads ~500MB)...")
model = WhisperModel(model_size, device="cpu", compute_type="int8")

print("Transcribing...")
if language:
    segments, info = model.transcribe(audio_file, language=language, beam_size=5)
else:
    segments, info = model.transcribe(audio_file, beam_size=5)

print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")

# Collect all text
full_text = []
srt_lines = []
vtt_lines = ["WEBVTT", ""]

for i, segment in enumerate(segments, 1):
    text = segment.text.strip()
    full_text.append(text)
    
    # Format timestamps for SRT
    start_srt = f"{int(segment.start // 3600):02d}:{int((segment.start % 3600) // 60):02d}:{int(segment.start % 60):02d},{int((segment.start % 1) * 1000):03d}"
    end_srt = f"{int(segment.end // 3600):02d}:{int((segment.end % 3600) // 60):02d}:{int(segment.end % 60):02d},{int((segment.end % 1) * 1000):03d}"
    
    # Format timestamps for VTT
    start_vtt = f"{int(segment.start // 3600):02d}:{int((segment.start % 3600) // 60):02d}:{int(segment.start % 60):02d}.{int((segment.start % 1) * 1000):03d}"
    end_vtt = f"{int(segment.end // 3600):02d}:{int((segment.end % 3600) // 60):02d}:{int(segment.end % 60):02d}.{int((segment.end % 1) * 1000):03d}"
    
    srt_lines.extend([str(i), f"{start_srt} --> {end_srt}", text, ""])
    vtt_lines.extend([f"{start_vtt} --> {end_vtt}", text, ""])
    
    print(f"[{start_vtt}] {text}")

# Write output files
txt_path = os.path.join(output_dir, f"{basename}.txt")
srt_path = os.path.join(output_dir, f"{basename}.srt")
vtt_path = os.path.join(output_dir, f"{basename}.vtt")

with open(txt_path, "w", encoding="utf-8") as f:
    f.write("\n".join(full_text))

with open(srt_path, "w", encoding="utf-8") as f:
    f.write("\n".join(srt_lines))

with open(vtt_path, "w", encoding="utf-8") as f:
    f.write("\n".join(vtt_lines))

print(f"\n✓ Transcription complete!")
print(f"  Text: {txt_path}")
print(f"  SRT:  {srt_path}")
print(f"  VTT:  {vtt_path}")
PYTHON
