#!/usr/bin/env python3
"""
Upload meeting transcript to Notion.

Requires:
    pip install notion-client

Environment:
    NOTION_API_KEY - Notion integration token
    NOTION_DATABASE_ID - Target database ID
"""

import os
import sys
import json
from pathlib import Path

try:
    from notion_client import Client
except ImportError:
    print("Error: notion-client not installed")
    print("Install with: pip install notion-client")
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: upload-notion.py <transcript_directory>")
        print("")
        print("Environment variables:")
        print("  NOTION_API_KEY     - Notion integration token")
        print("  NOTION_DATABASE_ID - Target database ID")
        sys.exit(1)
    
    transcript_dir = Path(sys.argv[1])
    
    # Check for required files
    metadata_file = transcript_dir / "metadata.json"
    transcript_file = None
    for ext in [".txt", ".vtt", ".srt"]:
        candidate = transcript_dir / f"audio{ext}"
        if candidate.exists():
            transcript_file = candidate
            break
    
    if not metadata_file.exists():
        print(f"Error: metadata.json not found in {transcript_dir}")
        sys.exit(1)
    
    if not transcript_file:
        print(f"Error: No transcript file found in {transcript_dir}")
        sys.exit(1)
    
    # Load metadata
    with open(metadata_file) as f:
        metadata = json.load(f)
    
    # Load transcript
    with open(transcript_file) as f:
        transcript_text = f.read()
    
    # Get Notion credentials
    api_key = os.environ.get("NOTION_API_KEY")
    database_id = os.environ.get("NOTION_DATABASE_ID")
    
    if not api_key:
        print("Error: NOTION_API_KEY not set")
        sys.exit(1)
    
    if not database_id:
        print("Error: NOTION_DATABASE_ID not set")
        sys.exit(1)
    
    # Create Notion client
    notion = Client(auth=api_key)
    
    # Create page
    meeting_name = metadata.get("meeting_name", "Untitled Meeting")
    started_at = metadata.get("started_at", "")
    
    print(f"Uploading to Notion: {meeting_name}")
    
    # Split transcript into chunks (Notion has 2000 char limit per block)
    chunks = [transcript_text[i:i+1900] for i in range(0, len(transcript_text), 1900)]
    
    children = [
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": [{"text": {"content": "Transcript"}}]}
        }
    ]
    
    for chunk in chunks:
        children.append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": [{"text": {"content": chunk}}]}
        })
    
    # Add metadata section
    children.insert(0, {
        "object": "block",
        "type": "callout",
        "callout": {
            "rich_text": [{"text": {"content": f"Recorded: {started_at}"}}],
            "icon": {"emoji": "🎙️"}
        }
    })
    
    response = notion.pages.create(
        parent={"database_id": database_id},
        properties={
            "Name": {"title": [{"text": {"content": meeting_name}}]},
        },
        children=children
    )
    
    page_url = response.get("url", "")
    print(f"✓ Created page: {page_url}")

if __name__ == "__main__":
    main()
