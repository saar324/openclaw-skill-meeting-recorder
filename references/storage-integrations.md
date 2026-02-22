# Storage Integrations

## Local Storage (Default)

### Directory Structure
```
~/meeting-transcripts/
├── 2026/
│   └── 02/
│       └── 2026-02-19_google-meet_project-sync/
│           ├── audio.wav          # Original recording
│           ├── audio.txt          # Plain text transcript
│           ├── audio.vtt          # VTT subtitles
│           ├── audio.srt          # SRT subtitles
│           ├── audio.json         # Detailed transcript
│           └── metadata.json      # Recording metadata
```

### Metadata Format
```json
{
    "meeting_name": "project-sync",
    "started_at": "2026-02-19T10:30:00+02:00",
    "ended_at": "2026-02-19T11:15:00+02:00",
    "audio_file": "audio.wav",
    "sample_rate": 16000,
    "channels": 1,
    "source": "meeting_recorder.monitor",
    "transcription": {
        "model": "base",
        "language": "he"
    }
}
```

### Managing Storage

```bash
# List recent recordings
bash /path/to/meeting-recorder/scripts/storage/organize-local.sh

# Check disk usage
du -sh ~/meeting-transcripts

# Clean old recordings (older than 30 days)
find ~/meeting-transcripts -name "audio.wav" -mtime +30 -delete
```

---

## Notion Integration

### Setup

1. Create a Notion integration:
   - Go to https://www.notion.so/my-integrations
   - Create new integration
   - Copy the "Internal Integration Token"

2. Create a database in Notion with properties:
   - Name (title)
   - Date (date)
   - Tags (multi-select)

3. Share database with integration:
   - Open database in Notion
   - Click "..." → "Add connections" → Your integration

4. Get database ID from URL:
   ```
   https://notion.so/myworkspace/DATABASE_ID?v=...
   ```

### Configuration
```bash
export NOTION_API_KEY="secret_xxxxx"
export NOTION_DATABASE_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Usage
```bash
python3 /path/to/meeting-recorder/scripts/storage/upload-notion.py \
    ~/meeting-transcripts/2026/02/2026-02-19_meeting/
```

---

## Future Integrations

### Google Drive
```bash
# Requires: pip install google-api-python-client
# Setup OAuth credentials, then:
gdrive upload ~/meeting-transcripts/2026/02/*/
```

### Dropbox
```bash
# Requires: pip install dropbox
# Create app and get access token
```

### S3/MinIO
```bash
# Requires: aws-cli configured
aws s3 sync ~/meeting-transcripts s3://my-bucket/meetings/
```

### Obsidian
Local markdown vault compatible:
```bash
# Copy transcripts to Obsidian vault
cp ~/meeting-transcripts/*/audio.txt ~/obsidian-vault/meetings/
```
