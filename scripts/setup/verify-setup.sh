#!/bin/bash
# Verify meeting-recorder environment is properly configured

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

echo "=== Meeting Recorder: Environment Verification ==="
echo ""

ERRORS=0

# Check PulseAudio
echo -n "[1] PulseAudio: "
if command -v pulseaudio &> /dev/null; then
    if pulseaudio --check 2>/dev/null; then
        echo "✓ installed and running"
    else
        echo "✓ installed, not running (will start on demand)"
    fi
else
    echo "✗ NOT INSTALLED"
    ERRORS=$((ERRORS + 1))
fi

# Check pactl
echo -n "[2] pactl: "
if command -v pactl &> /dev/null; then
    echo "✓ available"
else
    echo "✗ NOT FOUND (install pulseaudio-utils)"
    ERRORS=$((ERRORS + 1))
fi

# Check FFmpeg
echo -n "[3] FFmpeg: "
if command -v ffmpeg &> /dev/null; then
    echo "✓ $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"
else
    echo "✗ NOT INSTALLED"
    ERRORS=$((ERRORS + 1))
fi

# Check faster-whisper
echo -n "[4] faster-whisper: "
if python3 -c "import faster_whisper" 2>/dev/null; then
    echo "✓ available"
else
    echo "✗ NOT INSTALLED (pip install faster-whisper)"
    ERRORS=$((ERRORS + 1))
fi

# Check virtual sink
echo -n "[5] Virtual sink (meeting_recorder): "
if pactl list short sinks 2>/dev/null | grep -q "meeting_recorder"; then
    echo "✓ exists"
else
    echo "○ not created yet (run create-virtual-sink.sh)"
fi

# Check Xvfb (for headless browser)
echo -n "[6] Xvfb: "
if command -v Xvfb &> /dev/null; then
    echo "✓ available"
else
    echo "○ not installed (needed for headless browser)"
fi

# Check recording directory
RECORDING_DIR="${RECORDING_DIR:-$HOME/meeting-transcripts}"
echo -n "[7] Recording directory: "
if [ -d "$RECORDING_DIR" ]; then
    echo "✓ $RECORDING_DIR exists"
else
    echo "○ $RECORDING_DIR will be created on first recording"
fi

# Check config files
echo -n "[8] Configuration: "
if [ -f "$SKILL_DIR/config.json" ]; then
    echo "✓ config.json exists"
elif [ -f "$SKILL_DIR/config.example.json" ]; then
    echo "○ using defaults (copy config.example.json to config.json to customize)"
else
    echo "○ using built-in defaults"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo "=== All checks passed! ==="
else
    echo "=== $ERRORS error(s) found - run install-deps.sh ==="
    exit 1
fi
