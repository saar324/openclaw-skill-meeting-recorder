#!/bin/bash
# Start Chrome for meeting recording with audio support

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Load config if available
DISPLAY_NUM=98
CHROME_PORT=9222
USER_DATA_DIR=/tmp/chrome-meeting

if [ -f "$SKILL_DIR/lib/config.js" ]; then
    DISPLAY_NUM=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().chrome?.display?.replace(':','') || '98')" 2>/dev/null || echo "98")
    CHROME_PORT=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().chrome?.debuggingPort || 9222)" 2>/dev/null || echo "9222")
    USER_DATA_DIR=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().chrome?.userDataDir || '/tmp/chrome-meeting')" 2>/dev/null || echo "/tmp/chrome-meeting")
fi

# Ensure Xvfb is running
if ! pgrep -f "Xvfb :" > /dev/null; then
    echo "Starting Xvfb on :$DISPLAY_NUM..."
    Xvfb :$DISPLAY_NUM -screen 0 1280x800x24 &
    sleep 2
fi

export DISPLAY=:$DISPLAY_NUM

# Ensure PulseAudio is running
if ! pulseaudio --check 2>/dev/null; then
    echo "Starting PulseAudio..."
    pulseaudio --start --exit-idle-time=-1
    sleep 1
fi

# Create virtual sink if not exists
if ! pactl list short sinks | grep -q meeting_recorder; then
    echo "Creating virtual audio sink..."
    pactl load-module module-null-sink sink_name=meeting_recorder sink_properties=device.description=Meeting_Recorder
fi

# Set as default sink
pactl set-default-sink meeting_recorder

# Kill any existing Chrome on this port
pkill -f "chromium.*remote-debugging-port=$CHROME_PORT" 2>/dev/null
pkill -f "chrome.*remote-debugging-port=$CHROME_PORT" 2>/dev/null
sleep 1

# Find Chrome binary
CHROME_BIN=""
for path in /root/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome \
            /usr/bin/google-chrome \
            /usr/bin/chromium-browser \
            /snap/chromium/current/usr/lib/chromium-browser/chrome; do
    if [ -x "$path" ] 2>/dev/null; then
        CHROME_BIN="$path"
        break
    fi
done

if [ -z "$CHROME_BIN" ]; then
    echo "Error: Chrome not found"
    exit 1
fi

# Start Chrome
echo "Starting Chrome on port $CHROME_PORT..."
"$CHROME_BIN" \
    --no-sandbox \
    --user-data-dir="$USER_DATA_DIR" \
    --remote-debugging-port=$CHROME_PORT \
    --autoplay-policy=no-user-gesture-required \
    --password-store=basic \
    --disable-features=TranslateUI \
    "about:blank"
