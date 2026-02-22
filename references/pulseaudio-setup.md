# PulseAudio Setup for Meeting Recording

## How It Works

PulseAudio virtual sinks act as virtual audio outputs. Audio sent to a virtual sink can be captured via its `.monitor` source.

```
Browser Audio → Virtual Sink (meeting_recorder) → Monitor Source → FFmpeg Recording
```

## Creating the Virtual Sink

```bash
pactl load-module module-null-sink sink_name=meeting_recorder \
    sink_properties=device.description="Meeting_Recorder"
```

This creates:
- **Sink**: `meeting_recorder` - where audio is sent
- **Monitor**: `meeting_recorder.monitor` - where we capture from

## Routing Browser Audio

### Method 1: pavucontrol (GUI)
1. Open `pavucontrol`
2. Go to "Playback" tab
3. Find browser audio stream
4. Change output to "Meeting_Recorder"

### Method 2: pactl (CLI)
```bash
# List current audio streams
pactl list short sink-inputs

# Move stream to virtual sink (replace INPUT_ID)
pactl move-sink-input INPUT_ID meeting_recorder
```

### Method 3: Default sink
```bash
# Set as default (all new audio goes here)
pactl set-default-sink meeting_recorder
```

## Verifying Audio Flow

### Check sink exists
```bash
pactl list short sinks | grep meeting_recorder
```

### Monitor audio levels
```bash
# See if audio is flowing
pactl subscribe | grep sink-input
```

### Test recording
```bash
# Record 5 seconds
timeout 5 ffmpeg -f pulse -i meeting_recorder.monitor test.wav

# Check file has audio
ffprobe test.wav
```

## Troubleshooting

### PulseAudio not running
```bash
pulseaudio --start --exit-idle-time=-1
```

### No audio captured
1. Verify browser is playing audio
2. Check audio is routed to correct sink:
   ```bash
   pactl list sink-inputs
   ```
3. Verify sink is not muted:
   ```bash
   pactl set-sink-mute meeting_recorder 0
   ```

### Multiple audio sources
Create multiple virtual sinks and combine:
```bash
pactl load-module module-combine-sink \
    sink_name=combined \
    slaves=sink1,sink2
```

## Cleaning Up

### Remove virtual sink
```bash
pactl unload-module module-null-sink
```

### List loaded modules
```bash
pactl list short modules | grep null-sink
```
