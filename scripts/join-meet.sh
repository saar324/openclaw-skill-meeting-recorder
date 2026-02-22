#!/bin/bash
# Join a Google Meet and start recording
# Usage: join-meet.sh <meeting-url> [meeting-name]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

MEETING_URL="$1"
MEETING_NAME="${2:-meeting}"

# Load environment
if [ -f "$SKILL_DIR/.env" ]; then
    set -a
    source "$SKILL_DIR/.env"
    set +a
fi

export DISPLAY="${DISPLAY:-:98}"

if [ -z "$MEETING_URL" ]; then
    echo "Usage: join-meet.sh <meeting-url> [meeting-name]"
    exit 1
fi

# Load config for bot name
BOT_NAME="$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().botName)" 2>/dev/null || echo "Meeting Bot")"

echo "[1/4] Setting up audio..."
bash "$SKILL_DIR/scripts/setup/create-virtual-sink.sh" 2>/dev/null

echo "[2/4] Starting recording..."
bash "$SKILL_DIR/scripts/recording/start-recording.sh" "$MEETING_NAME"

echo "[3/4] Opening meeting..."
chromium-browser --no-sandbox --user-data-dir=/tmp/chrome-login "$MEETING_URL" 2>/dev/null &
sleep 5

echo "[4/4] Joining meeting..."
# Click Got it if present
xdotool mousemove 970 343 click 1 2>/dev/null
sleep 1

# Click on name field and type
xdotool mousemove 808 421 click 1
sleep 0.5
xdotool type "$BOT_NAME"
sleep 0.5

# Click Join now
xdotool mousemove 808 519 click 1
sleep 3

echo ""
echo "=== $BOT_NAME joined the meeting ==="
echo "Recording: $MEETING_NAME"
echo ""
echo "To leave: bash $SKILL_DIR/scripts/leave-meet.sh"
