# Service Adapters

Patterns for connecting to different meeting services via browser.

## Google Meet

### URL Format
```
https://meet.google.com/xxx-yyyy-zzz
```

### Join Sequence
1. Navigate to meeting URL
2. Wait for "Ready to join" or preview screen
3. Mute camera/mic if needed (privacy)
4. Click "Join now" or "Ask to join"

### Key Elements (CSS Selectors)
```javascript
// Join button
'button[data-mdc-dialog-action="join"]'
'[aria-label="Join now"]'

// Mute buttons
'[aria-label*="Turn off camera"]'
'[aria-label*="Turn off microphone"]'

// Leave button
'[aria-label="Leave call"]'
```

### Notes
- Works best when already signed into Google account
- May need to handle "You are the only one here" state
- Audio output goes to system default (route to virtual sink)

---

## Zoom Web Client

### URL Format
```
https://zoom.us/wc/join/MEETING_ID
https://zoom.us/j/MEETING_ID?pwd=PASSWORD
```

### Join Sequence
1. Navigate to meeting URL
2. Enter name if prompted
3. Click "Join" button
4. Accept browser permissions for audio

### Key Elements
```javascript
// Name input
'#inputname'

// Join button
'button.join-audio-by-voip'
'[data-reactid*="join"]'

// Leave button
'.leave-meeting-btn'
```

### Notes
- Zoom web client has limited features vs desktop app
- Some meetings may require password
- May need to wait in lobby if enabled

---

## WhatsApp Web

### URL Format
```
https://web.whatsapp.com
```

### Setup (One-time)
1. Navigate to WhatsApp Web
2. Scan QR code with phone
3. Wait for session to sync

### Call Handling
WhatsApp Web voice/video calls are challenging:
- Calls initiated from phone, web shows status
- Web client audio may not be capturable
- Consider using phone audio capture instead

### Key Elements
```javascript
// Search/contacts
'[data-icon="search"]'
'[data-testid="chat-list"]'

// Message area
'[data-testid="conversation-panel-messages"]'
```

### Notes
- Session persists via localStorage
- Must keep tab open
- Calls work better on desktop WhatsApp app

---

## General Browser Audio Routing

For any browser-based meeting:

1. **Create virtual sink** before joining
2. **Start recording** before audio begins
3. **Route browser audio** to virtual sink:
   - Linux: Use pavucontrol or pactl
   - In browser: May need to select audio output device

### Browser Audio Output Selection

Some browsers allow per-tab audio output:
```javascript
// Check if supported
navigator.mediaDevices.selectAudioOutput({deviceId: "meeting_recorder"})
```

Most reliable: System-level audio routing via PulseAudio.
