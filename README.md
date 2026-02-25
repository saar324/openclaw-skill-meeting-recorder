# Meeting Recorder

> **An [OpenClaw](https://github.com/openclaw/openclaw) skill** for automated meeting recording and transcription.

A headless meeting bot that automatically joins Google Meet, Zoom, and WhatsApp calls, records audio, and transcribes using Whisper AI. Designed as a drop-in skill for OpenClaw (formerly Clawdbot).

## Features

- **Multi-platform support**: Google Meet, Zoom, WhatsApp
- **Automatic calendar joining**: Integrates with Google Calendar to auto-join scheduled meetings
- **WhatsApp call watcher**: Persistent daemon that auto-answers incoming calls based on allow/block lists
- **Audio recording**: Captures meeting/call audio via WebRTC interception (outputs audio.webm)
- **AI transcription**: Multi-provider support (local faster-whisper, OpenAI Whisper API, OpenRouter)
- **AI metadata generation**: Generates summaries, action items, and key points (optional)
- **Headless operation**: Runs on servers without a display using Xvfb

## Installation

### As an OpenClaw Skill

If you're using OpenClaw, install via the skill manager or clone directly to your skills directory:

```bash
cd ~/.openclaw/skills  # or your configured skills path
git clone https://github.com/saar324/openclaw-skill-meeting-recorder.git
cd meeting-recorder
npm install
sudo bash scripts/setup/install-deps.sh
```

### Standalone Installation

```bash
git clone https://github.com/saar324/openclaw-skill-meeting-recorder.git
cd meeting-recorder
npm install
sudo bash scripts/setup/install-deps.sh
```

### Configuration

```bash
# Copy configuration templates
cp config.example.json config.json
cp .env.example .env

# Edit config.json to customize bot name, recording settings, etc.
# Edit .env to add Google Calendar credentials (optional)

# Verify setup
bash scripts/setup/verify-setup.sh
```

## Usage

### Join a Meeting (Google Meet / Zoom)

```bash
# Google Meet
./join-meeting "https://meet.google.com/xxx-yyyy-zzz" "team-standup"

# Zoom
./join-meeting "https://zoom.us/j/123456789?pwd=abc123" "weekly-sync"
```

The bot will:
1. Join the meeting with the configured bot name
2. Record audio
3. Detect when the meeting ends
4. Transcribe the recording
5. Save everything to `~/meeting-transcripts/`

### Leave a Meeting Manually

```bash
./leave-meeting
```

### WhatsApp Call Watcher

```bash
# First-time setup: authenticate WhatsApp Web
./start-whatsapp-watcher --setup

# Start the persistent watcher daemon
./start-whatsapp-watcher

# Check status
./start-whatsapp-watcher --status

# Stop the watcher
./stop-whatsapp-watcher
```

### Calendar Integration (Autonomous Mode)

When configured with Google Calendar credentials, the scheduler can automatically join meetings:

```bash
# Check today's meeting schedule
node meeting-scheduler.js --status

# Scan calendar for upcoming meetings
node meeting-scheduler.js --scan

# View recent changes (new, cancelled, rescheduled)
cat /tmp/meeting-schedule-changes.log
```

Set up cron to run the scheduler automatically:
```bash
# Example: check calendar every minute during work hours
* 7-18 * * 0-4 /path/to/meeting-recorder/meeting-scheduler.sh >> /tmp/meeting-scheduler.log 2>&1
```

## Configuration

### config.json

```json
{
    "botName": "Meeting Bot",
    "language": "en",
    "chrome": {
        "debuggingPort": 9222,
        "display": ":98",
        "userDataDir": "/tmp/chrome-meeting"
    },
    "recording": {
        "outputDir": "~/meeting-transcripts",
        "sampleRate": 16000,
        "channels": 1
    },
    "transcription": {
        "provider": "local",
        "language": "auto",
        "local": { "model": "small" },
        "openai": { "model": "whisper-1" },
        "openrouter": { "model": "openai/whisper-large-v3" }
    },
    "calendar": {
        "enabled": false,
        "joinBeforeMinutes": 2
    },
    "whatsapp": {
        "allowList": ["*"],
        "blockList": [],
        "autoAnswerDelaySec": 3,
        "maxCallDurationMin": 120
    }
}
```

### .env (Optional)

```bash
# Google Calendar integration
GOG_ACCOUNT=your-email@gmail.com
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=your-keyring-password

# AI metadata generation
OPENROUTER_API_KEY=sk-or-v1-...
# Or: ANTHROPIC_API_KEY=sk-ant-...
```

### WhatsApp Allow/Block Lists

Edit `whatsapp-config.json`:

```json
{
    "allowList": ["+1*", "+44*"],
    "blockList": ["+1555*"]
}
```

- `*` = matches everything
- `+1*` = matches any US number
- Block list takes priority over allow list

## Output

Recordings are saved to:
```
~/meeting-transcripts/YYYY/MM/YYYY-MM-DD_HHMMSS_meeting-name/
├── audio.webm      # Original recording (WebRTC/Opus)
├── audio.txt       # Plain text transcript
├── audio.srt       # Subtitles (SubRip format)
├── audio.vtt       # Subtitles (WebVTT format)
├── metadata.json   # Recording metadata
└── session.json    # Full session info with AI analysis
```

## Architecture

```
meeting-recorder/
├── SKILL.md                # OpenClaw skill manifest
├── meeting-bot.js          # Core meeting joiner (Google Meet, Zoom)
├── meeting-scheduler.js    # Calendar integration & scheduling
├── whatsapp-watcher.js     # WhatsApp call watcher daemon
├── lib/
│   └── config.js           # Configuration loader
├── platforms/
│   ├── base.js             # Abstract platform adapter
│   ├── google-meet.js      # Google Meet implementation
│   ├── zoom.js             # Zoom implementation
│   ├── whatsapp.js         # WhatsApp implementation
│   └── index.js            # Platform resolver
└── scripts/
    ├── setup/              # Installation & Chrome setup
    ├── recording/          # Audio recording (ffmpeg)
    ├── transcription/      # Whisper transcription
    └── cleanup/            # Maintenance scripts
```

## Requirements

- **Node.js** 18+
- **Python** 3.8+ with faster-whisper
- **FFmpeg** for audio conversion (optional, for format conversion)
- **Xvfb** for headless browser
- **Chrome/Chromium** with remote debugging

## Platform Notes

### Google Meet
- Works out of the box
- Bot appears with configured name
- Supports both scheduled and instant meetings

### Zoom
- Host must have "Join from browser" enabled
- URLs are auto-converted to web client format
- Waiting room supported (bot waits for host admission)

### WhatsApp
- Requires one-time QR code authentication
- Uses logged-in account identity (not separate bot)
- Persistent watcher mode (not URL-based)

## Troubleshooting

### Bot can't connect to Chrome
```bash
# Start Chrome manually
bash scripts/setup/start-chrome.sh
```

### No audio in recordings
```bash
# Audio is captured via WebRTC interception (no PulseAudio needed)
# Check the meeting bot log for capture status:
tail -20 /tmp/meeting-bot.log | grep AudioCapture

# If no streams are captured, ensure the meeting has other participants with audio
```

### WhatsApp shows QR code
```bash
# Re-authenticate
./start-whatsapp-watcher --setup
```

### Transcription fails
```bash
# Check faster-whisper installation
python3 -c "import faster_whisper; print('OK')"

# Install if missing
pip3 install faster-whisper
```

## OpenClaw Integration

This skill is designed for [OpenClaw](https://github.com/openclaw/openclaw). The `SKILL.md` file contains the skill manifest with:

- Required environment variables (`DISPLAY`)
- Required binaries (`node`, `ffmpeg`, `pactl`, `pulseaudio`, `python3`)
- Optional environment variables for calendar and AI features

## License

MIT License - see [LICENSE](LICENSE)

## Contributing

Contributions welcome! Please ensure any changes maintain compatibility with the OpenClaw skill format.
