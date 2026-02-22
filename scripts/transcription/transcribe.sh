#!/bin/bash
# Meeting transcription - supports multiple providers
# 
# Providers:
#   local      - faster-whisper (default, runs on CPU)
#   openai     - OpenAI Whisper API (requires OPENAI_API_KEY)
#   openrouter - OpenRouter API (requires OPENROUTER_API_KEY)
#   multimodal - GPT-4o audio, Claude, etc.
#
# Usage:
#   transcribe.sh <audio-file> [--provider local|openai|openrouter|multimodal]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

AUDIO_FILE="$1"
shift

# Load environment
if [ -f "$SKILL_DIR/.env" ]; then
    set -a
    source "$SKILL_DIR/.env"
    set +a
fi

if [ -z "$AUDIO_FILE" ]; then
    echo "Usage: transcribe.sh <audio-file> [--provider local|openai|openrouter|multimodal]"
    echo ""
    echo "Providers:"
    echo "  local      - faster-whisper (default, runs locally)"
    echo "  openai     - OpenAI Whisper API"
    echo "  openrouter - OpenRouter API"
    echo "  multimodal - GPT-4o audio, Claude, etc."
    echo ""
    echo "Set provider in config.json or use --provider flag"
    exit 1
fi

if [ ! -f "$AUDIO_FILE" ]; then
    echo "Error: Audio file not found: $AUDIO_FILE"
    exit 1
fi

# Check if --provider is specified, otherwise check config
PROVIDER_ARG=""
if [[ "$1" == "--provider" ]]; then
    PROVIDER_ARG="--provider $2"
fi

# Run transcription
python3 "$SCRIPT_DIR/transcribe-provider.py" "$AUDIO_FILE" $PROVIDER_ARG
