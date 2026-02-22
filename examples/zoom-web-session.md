# Zoom Web Client Recording Session

Example workflow for recording a Zoom meeting via web browser.

## Prerequisites
- Zoom meeting link (web-compatible)
- Virtual sink created
- Browser with audio permissions

## Step-by-Step

### 1. Setup Audio
```bash
bash /path/to/meeting-recorder/scripts/setup/create-virtual-sink.sh
```

### 2. Start Recording
```bash
bash /path/to/meeting-recorder/scripts/recording/start-recording.sh "zoom-call"
```

### 3. Join Zoom Web
```bash
# For web client URL format:
chromium "https://zoom.us/wc/join/123456789"

# Or with password:
chromium "https://zoom.us/j/123456789?pwd=abc123"
```

### 4. Route Audio
```bash
# Find browser stream and route to virtual sink
pactl list short sink-inputs | grep -i chrom
pactl move-sink-input <ID> meeting_recorder
```

### 5. Handle Prompts
- Enter display name if requested
- Click "Join Audio by Computer" 
- Allow microphone access if needed

### 6. After Meeting
```bash
bash /path/to/meeting-recorder/scripts/recording/stop-recording.sh
```

### 7. Transcribe
```bash
bash /path/to/meeting-recorder/scripts/transcription/transcribe.sh \
    ~/meeting-transcripts/2026/02/*/audio.wav
```

## Notes

- Zoom web client may have limited features
- Host must enable "Join from browser" option
- Some enterprise accounts disable web client
- Password-protected meetings need pwd parameter
