---
name: meeting-recorder
description: Autonomously join Google Meet/Zoom meetings, auto-answer WhatsApp calls, record audio, and transcribe
version: 4.0.0
author: saar
metadata:
  openclaw:
    requires:
      env:
        - DISPLAY
      bins:
        - node
        - python3
      optionalBins:
        - ffmpeg
      optionalEnv:
        - GOG_ACCOUNT
        - GOG_KEYRING_PASSWORD
        - OPENAI_API_KEY
        - OPENROUTER_API_KEY
        - ANTHROPIC_API_KEY
    primaryEnv: DISPLAY
    category: productivity
    tags:
      - meetings
      - recording
      - transcription
      - automation
      - google-meet
      - zoom
      - whatsapp
---

# Meeting Recorder

An OpenClaw skill for recording and transcribing meetings & calls automatically. Supports **Google Meet**, **Zoom**, and **WhatsApp** incoming calls.

## Features

- **Multi-platform**: Google Meet, Zoom, WhatsApp voice/video calls
- **Autonomous calendar joining**: Auto-joins meetings from Google Calendar
- **WhatsApp call watcher**: Persistent daemon with allow/block lists
- **AI transcription**: Multi-provider (local faster-whisper, OpenAI Whisper API, OpenRouter)
- **Headless operation**: Runs on servers without display via Xvfb

## Quick Start

### Join a Meeting
```bash
# Google Meet
join-meeting "https://meet.google.com/xxx-yyyy-zzz" "standup"

# Zoom  
join-meeting "https://zoom.us/j/123456789?pwd=abc" "weekly-sync"
```

### Leave Meeting
```bash
leave-meeting
```

### WhatsApp Call Watcher
```bash
# Setup (one-time QR auth)
start-whatsapp-watcher --setup

# Start daemon
start-whatsapp-watcher

# Check status
start-whatsapp-watcher --status

# Stop
stop-whatsapp-watcher
```

### Calendar Integration
```bash
# Check schedule
node meeting-scheduler.js --status

# Scan calendar
node meeting-scheduler.js --scan
```

## Configuration

Copy templates and customize:
```bash
cp config.example.json config.json
cp .env.example .env
```

### config.json
- `botName`: Display name in meetings (default: "Meeting Bot")
- `transcription.model`: Whisper model (tiny/base/small/medium/large)
- `transcription.language`: Language code or "auto"
- `whatsapp.allowList`: Patterns for auto-answer ("+1*", "*")
- `calendar.joinBeforeMinutes`: Minutes before meeting to join

### .env (Optional)
```bash
# Google Calendar
GOG_ACCOUNT=your-email@gmail.com
GOG_KEYRING_PASSWORD=your-password

# AI metadata generation
OPENROUTER_API_KEY=sk-or-...
```

## Output

Recordings saved to `~/meeting-transcripts/YYYY/MM/`:
```
YYYY-MM-DD_HHMMSS_meeting-name/
├── audio.webm     # Recording (WebRTC/Opus)
├── audio.txt      # Transcript
├── audio.srt      # Subtitles
├── session.json   # Metadata + AI summary
```

## Requirements

| Dependency | Purpose |
|------------|---------|
| Node.js 18+ | Runtime |
| Python 3.8+ | Transcription (faster-whisper) |
| FFmpeg | Audio conversion (optional) |
| Xvfb | Headless display |
| Chrome/Chromium | Browser automation |

## Installation

```bash
# Install dependencies
sudo bash scripts/setup/install-deps.sh

# Verify setup
bash scripts/setup/verify-setup.sh
```

## Platform Notes

- **Google Meet**: Works out of the box
- **Zoom**: Host must enable "Join from browser"
- **WhatsApp**: Requires one-time QR code authentication

## Links

- [README](README.md) - Full documentation
- [LICENSE](LICENSE) - MIT License
