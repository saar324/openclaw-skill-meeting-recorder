#!/bin/bash
# Organize local meeting transcripts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

RECORDING_DIR="${RECORDING_DIR:-$HOME/meeting-transcripts}"

echo "=== Meeting Transcripts ==="
echo "Directory: $RECORDING_DIR"
echo ""

if [ ! -d "$RECORDING_DIR" ]; then
    echo "No recordings found (directory does not exist)"
    exit 0
fi

# List recent recordings
echo "Recent recordings:"
find "$RECORDING_DIR" -name "metadata.json" -mtime -30 2>/dev/null | while read meta; do
    dir=$(dirname "$meta")
    if [ -f "$meta" ]; then
        NAME=$(jq -r ".meeting_name // \"unknown\"" "$meta" 2>/dev/null)
        DATE=$(jq -r ".started_at // \"unknown\"" "$meta" 2>/dev/null | cut -d"T" -f1)
        HAS_TRANSCRIPT=""
        [ -f "$dir/audio.txt" ] && HAS_TRANSCRIPT=" [transcribed]"
        echo "  $DATE - $NAME$HAS_TRANSCRIPT"
        echo "    $dir"
    fi
done

echo ""
echo "Total recordings: $(find "$RECORDING_DIR" -name "audio.wav" 2>/dev/null | wc -l)"

echo ""
echo "Disk usage:"
du -sh "$RECORDING_DIR" 2>/dev/null
