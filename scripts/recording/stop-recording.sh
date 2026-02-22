#!/bin/bash
# Stop the current recording and finalize

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

PID_FILE="/tmp/meeting-recorder.pid"
CURRENT_FILE="/tmp/meeting-recorder-current.txt"

# Check if recording is active
if [ ! -f "$PID_FILE" ]; then
    echo "✗ No active recording found"
    exit 1
fi

PID=$(cat "$PID_FILE")
OUTPUT_FILE=$(cat "$CURRENT_FILE" 2>/dev/null)

if ! kill -0 "$PID" 2>/dev/null; then
    echo "✗ Recording process not running (stale PID file)"
    rm -f "$PID_FILE" "$CURRENT_FILE"
    exit 1
fi

# Stop recording gracefully
echo "Stopping recording (PID: $PID)..."
kill -SIGINT "$PID"

# Wait for process to finish
TIMEOUT=10
while kill -0 "$PID" 2>/dev/null && [ $TIMEOUT -gt 0 ]; do
    sleep 1
    TIMEOUT=$((TIMEOUT - 1))
done

if kill -0 "$PID" 2>/dev/null; then
    echo "Force killing..."
    kill -9 "$PID"
fi

rm -f "$PID_FILE" "$CURRENT_FILE"

if [ -f "$OUTPUT_FILE" ]; then
    # Update metadata with end time
    METADATA_FILE="$(dirname "$OUTPUT_FILE")/metadata.json"
    if [ -f "$METADATA_FILE" ]; then
        # Add ended_at to metadata (simple append approach)
        TMP_FILE=$(mktemp)
        jq --arg ended "$(date -Iseconds)" '. + {ended_at: $ended}' "$METADATA_FILE" > "$TMP_FILE" 2>/dev/null && mv "$TMP_FILE" "$METADATA_FILE"
    fi
    
    # Get file info
    DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUTPUT_FILE" 2>/dev/null)
    SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
    
    echo ""
    echo "✓ Recording saved"
    echo "  File: $OUTPUT_FILE"
    echo "  Duration: ${DURATION:-unknown}s"
    echo "  Size: $SIZE"
    echo ""
    echo "To transcribe:"
    echo "  bash $SKILL_DIR/scripts/transcription/transcribe.sh \"$OUTPUT_FILE\""
else
    echo "✗ Output file not found: $OUTPUT_FILE"
    exit 1
fi
