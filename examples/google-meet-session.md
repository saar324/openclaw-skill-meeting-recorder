# Google Meet Recording Session

Example workflow for recording a Google Meet meeting.

## Prerequisites
- Browser with Google account signed in
- Virtual sink created
- Xvfb running (for headless)

## Step-by-Step

### 1. Setup Audio
```bash
# Create virtual sink
bash /path/to/meeting-recorder/scripts/setup/create-virtual-sink.sh
```

### 2. Start Recording
```bash
# Start capture (before joining meeting)
bash /path/to/meeting-recorder/scripts/recording/start-recording.sh "team-standup"
```

### 3. Join Meeting
```bash
# Open browser to meeting URL
# Route browser audio to meeting_recorder sink
chromium https://meet.google.com/abc-defg-hij
```

### 4. Route Audio (in another terminal)
```bash
# Find browser's audio stream
pactl list short sink-inputs

# Move to virtual sink (replace ID)
pactl move-sink-input 42 meeting_recorder
```

### 5. During Meeting
Meeting audio is now being recorded.

### 6. After Meeting
```bash
# Stop recording
bash /path/to/meeting-recorder/scripts/recording/stop-recording.sh
```

### 7. Transcribe
```bash
# The script shows the path; transcribe it
bash /path/to/meeting-recorder/scripts/transcription/transcribe.sh \
    ~/meeting-transcripts/2026/02/2026-02-19_143000_team-standup/audio.wav
```

## Automation Script

```bash
#!/bin/bash
# automated-meet-record.sh

MEETING_URL="$1"
MEETING_NAME="$2"

# Setup
bash /path/to/meeting-recorder/scripts/setup/create-virtual-sink.sh

# Start recording
bash /path/to/meeting-recorder/scripts/recording/start-recording.sh "$MEETING_NAME"

# Open browser (background)
chromium "$MEETING_URL" &
BROWSER_PID=$!

echo "Recording started. Press Enter when meeting is over..."
read

# Cleanup
kill $BROWSER_PID
bash /path/to/meeting-recorder/scripts/recording/stop-recording.sh
```
