#!/bin/bash
# Auto-join a meeting and start recording
# Usage: auto-join.sh <meeting-url> [meeting-name]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

MEETING_URL="$1"
MEETING_NAME="${2:-meeting}"
DISPLAY_NUM=99

# Load environment
if [ -f "$SKILL_DIR/.env" ]; then
    set -a
    source "$SKILL_DIR/.env"
    set +a
fi

if [ -z "$MEETING_URL" ]; then
    echo "Usage: auto-join.sh <meeting-url> [meeting-name]"
    echo ""
    echo "Examples:"
    echo "  auto-join.sh https://meet.google.com/abc-defg-hij"
    echo "  auto-join.sh https://zoom.us/j/123456789 zoom-standup"
    exit 1
fi

# Detect service
SERVICE="unknown"
if [[ "$MEETING_URL" == *"meet.google.com"* ]]; then
    SERVICE="google-meet"
elif [[ "$MEETING_URL" == *"zoom.us"* ]]; then
    SERVICE="zoom"
elif [[ "$MEETING_URL" == *"teams.microsoft.com"* ]]; then
    SERVICE="teams"
fi

echo "=== Meeting Auto-Join ==="
echo "URL: $MEETING_URL"
echo "Service: $SERVICE"
echo "Name: $MEETING_NAME"
echo ""

# Start Xvfb if not running
if ! pgrep -x Xvfb > /dev/null; then
    echo "[1/5] Starting Xvfb..."
    Xvfb :$DISPLAY_NUM -screen 0 1920x1080x24 &
    sleep 2
else
    echo "[1/5] Xvfb already running"
fi
export DISPLAY=:$DISPLAY_NUM

# Start PulseAudio if not running
if ! pulseaudio --check 2>/dev/null; then
    echo "[2/5] Starting PulseAudio..."
    pulseaudio --start --exit-idle-time=-1
    sleep 1
else
    echo "[2/5] PulseAudio already running"
fi

# Create virtual sink if needed
if ! pactl list short sinks 2>/dev/null | grep -q "meeting_recorder"; then
    echo "[3/5] Creating virtual sink..."
    bash "$SKILL_DIR/scripts/setup/create-virtual-sink.sh" > /dev/null
else
    echo "[3/5] Virtual sink exists"
fi

# Start recording
echo "[4/5] Starting recording..."
bash "$SKILL_DIR/scripts/recording/start-recording.sh" "$MEETING_NAME" > /tmp/recording-start.log 2>&1
RECORDING_PATH=$(grep "Output:" /tmp/recording-start.log | awk '{print $2}')
echo "  Recording to: $RECORDING_PATH"

# Launch browser
echo "[5/5] Launching browser and joining meeting..."

# Kill any existing chrome
pkill -f "chrome.*meeting" 2>/dev/null || true
sleep 1

# Launch Chrome with specific flags for meeting
google-chrome \
    --no-sandbox \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-dev-shm-usage \
    --use-fake-ui-for-media-stream \
    --use-fake-device-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    --user-data-dir=/tmp/chrome-meeting \
    --window-size=1920,1080 \
    "$MEETING_URL" &

CHROME_PID=$!
echo "  Chrome PID: $CHROME_PID"

# Wait for browser to load
sleep 5

# Route Chrome audio to virtual sink
echo ""
echo "Routing audio..."
for i in {1..10}; do
    SINK_INPUT=$(pactl list short sink-inputs 2>/dev/null | grep -i chrome | head -1 | awk '{print $1}')
    if [ -n "$SINK_INPUT" ]; then
        pactl move-sink-input "$SINK_INPUT" meeting_recorder
        echo "  ✓ Routed audio stream $SINK_INPUT to meeting_recorder"
        break
    fi
    sleep 1
done

# Save session info
cat > /tmp/meeting-session.json << EOF
{
    "url": "$MEETING_URL",
    "service": "$SERVICE",
    "name": "$MEETING_NAME",
    "chrome_pid": $CHROME_PID,
    "recording_path": "$RECORDING_PATH",
    "started_at": "$(date -Iseconds)"
}
EOF

echo ""
echo "=== Meeting Session Started ==="
echo "Recording: $RECORDING_PATH"
echo ""
echo "To stop: bash $SKILL_DIR/scripts/auto-leave.sh"
echo ""
echo "NOTE: You may need to manually click Join in the browser."
echo "      Use VNC or the browser automation to complete join."
