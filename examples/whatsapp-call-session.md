# WhatsApp Web Call Recording

Example workflow for capturing WhatsApp calls.

## Important Limitations

WhatsApp Web has limited call support:
- Voice/video calls are primarily phone-based
- Web interface shows call status but audio may not flow through browser
- Desktop WhatsApp app has better call support

## Alternative Approaches

### Option 1: Desktop WhatsApp (Recommended)
Install WhatsApp Desktop on Linux and capture its audio output.

### Option 2: Phone Audio Capture
Use a phone with audio output to computer for capture.

### Option 3: Web Session for Text/Context

While calls are limited, you can use WhatsApp Web for:
- Reading chat context before/after calls
- Sending follow-up messages
- Accessing shared media

## WhatsApp Web Setup

### 1. Initial Session
```bash
chromium https://web.whatsapp.com
```

### 2. Authenticate
Scan QR code with phone camera (WhatsApp > Settings > Linked Devices)

### 3. Session Persistence
The session is saved in browser storage. Future visits won't require re-authentication (until logout).

## If Audio Does Work

If WhatsApp Web sends audio through browser:

```bash
# Setup
bash /path/to/meeting-recorder/scripts/setup/create-virtual-sink.sh

# Start recording
bash /path/to/meeting-recorder/scripts/recording/start-recording.sh "whatsapp-call"

# Route audio
pactl move-sink-input <BROWSER_ID> meeting_recorder

# Stop when done
bash /path/to/meeting-recorder/scripts/recording/stop-recording.sh
```

## Desktop WhatsApp Alternative

For reliable WhatsApp call recording:

1. Install WhatsApp Desktop:
   ```bash
   snap install whatsapp-for-linux
   ```

2. Set up audio routing
3. Use same recording workflow as Google Meet
