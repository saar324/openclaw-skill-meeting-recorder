#!/bin/bash
# Meeting transcription using faster-whisper
# Default: small model with auto language detection

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

AUDIO_FILE="$1"
WHISPER_MODEL="${2:-small}"
LANGUAGE="${3:-auto}"

# Try to load config for default language
if [ -f "$SKILL_DIR/lib/config.js" ]; then
    CONFIG_LANG=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().transcription?.language || 'auto')" 2>/dev/null)
    if [ -n "$CONFIG_LANG" ] && [ "$LANGUAGE" = "auto" ]; then
        LANGUAGE="$CONFIG_LANG"
    fi
    CONFIG_MODEL=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().transcription?.model || 'small')" 2>/dev/null)
    if [ -n "$CONFIG_MODEL" ] && [ "$WHISPER_MODEL" = "small" ]; then
        WHISPER_MODEL="$CONFIG_MODEL"
    fi
fi

# Use the fast transcription script
exec "$SKILL_DIR/scripts/transcription/transcribe-fast.sh" "$AUDIO_FILE" "$WHISPER_MODEL" "$LANGUAGE"
