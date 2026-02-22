#!/bin/bash
# Stop recording and close the meeting
# Usage: auto-leave.sh [--transcribe]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TRANSCRIBE=false

if [ "$1" == "--transcribe" ]; then
    TRANSCRIBE=true
fi

if [ ! -f /tmp/meeting-session.json ]; then
    echo "No active meeting session found"
    exit 1
fi

# Load session info
SESSION=$(cat /tmp/meeting-session.json)
CHROME_PID=$(echo "$SESSION" | jq -r .chrome_pid)
RECORDING_PATH=$(echo "$SESSION" | jq -r .recording_path)
MEETING_NAME=$(echo "$SESSION" | jq -r .name)

echo "=== Stopping Meeting ==="
echo "Meeting: $MEETING_NAME"
echo "Recording: $RECORDING_PATH"
echo ""

# Stop recording
echo "[1/3] Stopping recording..."
bash "$SKILL_DIR/scripts/recording/stop-recording.sh"

# Close browser
echo "[2/3] Closing browser..."
if [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null; then
    kill "$CHROME_PID" 2>/dev/null
    echo "  Closed Chrome (PID: $CHROME_PID)"
fi

# Cleanup session
rm -f /tmp/meeting-session.json

# Transcribe if requested
if [ "$TRANSCRIBE" == true ]; then
    echo "[3/3] Transcribing..."
    bash "$SKILL_DIR/scripts/transcription/transcribe.sh" "$RECORDING_PATH"
else
    echo "[3/3] Skipping transcription"
    echo ""
    echo "To transcribe later:"
    echo "  bash $SKILL_DIR/scripts/transcription/transcribe.sh \"$RECORDING_PATH\""
fi

echo ""
echo "=== Meeting Ended ==="
