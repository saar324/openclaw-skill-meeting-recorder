#!/bin/bash
# Start recording audio from the virtual sink

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

SINK_NAME="meeting_recorder"
RECORDING_DIR="${RECORDING_DIR:-$HOME/meeting-transcripts}"
PID_FILE="/tmp/meeting-recorder.pid"
CURRENT_FILE="/tmp/meeting-recorder-current.txt"

# Optional meeting name argument
MEETING_NAME="${1:-meeting}"

# Check if already recording
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "✗ Recording already in progress (PID: $(cat "$PID_FILE"))"
    echo "  Current file: $(cat "$CURRENT_FILE" 2>/dev/null)"
    echo "  Run stop-recording.sh first"
    exit 1
fi

# Check PulseAudio
if ! pulseaudio --check 2>/dev/null; then
    echo "Starting PulseAudio..."
    pulseaudio --start --exit-idle-time=-1
    sleep 1
fi

# Check virtual sink exists
if ! pactl list short sinks 2>/dev/null | grep -q "$SINK_NAME"; then
    echo "✗ Virtual sink '$SINK_NAME' not found"
    echo "  Run create-virtual-sink.sh first"
    exit 1
fi

# Create output directory structure
DATE_DIR=$(date +%Y/%m)
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
SAFE_NAME=$(echo "$MEETING_NAME" | tr ' ' '-' | tr -cd '[:alnum:]-_')
OUTPUT_DIR="$RECORDING_DIR/$DATE_DIR/${TIMESTAMP}_${SAFE_NAME}"
mkdir -p "$OUTPUT_DIR"

OUTPUT_FILE="$OUTPUT_DIR/audio.wav"

# Start recording
echo "Starting recording..."
echo "  Output: $OUTPUT_FILE"
echo "  Source: ${SINK_NAME}.monitor"
echo ""

ffmpeg -y -f pulse -i "${SINK_NAME}.monitor" \
    -ac 1 -ar 16000 -acodec pcm_s16le \
    "$OUTPUT_FILE" \
    -loglevel warning \
    </dev/null >/tmp/ffmpeg-recording.log 2>&1 &

FFMPEG_PID=$!
echo $FFMPEG_PID > "$PID_FILE"
echo "$OUTPUT_FILE" > "$CURRENT_FILE"

# Save metadata
cat > "$OUTPUT_DIR/metadata.json" << METADATA
{
    "meeting_name": "$MEETING_NAME",
    "started_at": "$(date -Iseconds)",
    "audio_file": "audio.wav",
    "sample_rate": 16000,
    "channels": 1,
    "source": "${SINK_NAME}.monitor"
}
METADATA

sleep 1

if kill -0 $FFMPEG_PID 2>/dev/null; then
    echo "✓ Recording started (PID: $FFMPEG_PID)"
    echo ""
    echo "Run stop-recording.sh when finished"
else
    echo "✗ Failed to start recording"
    rm -f "$PID_FILE" "$CURRENT_FILE"
    exit 1
fi
