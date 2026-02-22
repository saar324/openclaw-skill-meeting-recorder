#!/bin/bash
# Leave the meeting and optionally transcribe
# Usage: leave-meet.sh [--transcribe]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
export DISPLAY="${DISPLAY:-:98}"

echo "[1/3] Leaving meeting..."
# Click the red hang up button (approximate location)
xdotool mousemove 783 750 click 1 2>/dev/null
sleep 2

echo "[2/3] Stopping recording..."
bash "$SKILL_DIR/scripts/recording/stop-recording.sh"

if [ "$1" == "--transcribe" ]; then
    echo "[3/3] Transcribing..."
    RECORDING=$(cat /tmp/meeting-recorder-current.txt 2>/dev/null || find ~/meeting-transcripts -name "audio.wav" -mmin -30 | head -1)
    if [ -n "$RECORDING" ]; then
        bash "$SKILL_DIR/scripts/transcription/transcribe.sh" "$RECORDING"
    fi
else
    echo "[3/3] Skipping transcription"
fi

echo ""
echo "=== Meeting ended ==="
