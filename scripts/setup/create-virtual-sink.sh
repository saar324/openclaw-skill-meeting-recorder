#!/bin/bash
# Create PulseAudio virtual sink for meeting recording

SINK_NAME="meeting_recorder"

# Check if PulseAudio is running
if ! pulseaudio --check 2>/dev/null; then
    echo "Starting PulseAudio..."
    pulseaudio --start --exit-idle-time=-1
    sleep 1
fi

# Check if sink already exists
if pactl list short sinks 2>/dev/null | grep -q "$SINK_NAME"; then
    echo "✓ Virtual sink '$SINK_NAME' already exists"
    pactl list short sinks | grep "$SINK_NAME"
    exit 0
fi

# Create the virtual sink
echo "Creating virtual sink: $SINK_NAME..."
MODULE_ID=$(pactl load-module module-null-sink sink_name="$SINK_NAME" \
    sink_properties=device.description="Meeting_Recorder")

if [ -n "$MODULE_ID" ]; then
    echo "✓ Created virtual sink: $SINK_NAME (module ID: $MODULE_ID)"
    echo ""
    echo "Monitor source for recording: ${SINK_NAME}.monitor"
    echo ""
    echo "To route browser audio to this sink:"
    echo "  pavucontrol → Playback → (browser) → Meeting_Recorder"
    echo ""
    echo "Or via CLI:"
    echo "  pactl move-sink-input <INPUT_ID> $SINK_NAME"
else
    echo "✗ Failed to create virtual sink"
    exit 1
fi
