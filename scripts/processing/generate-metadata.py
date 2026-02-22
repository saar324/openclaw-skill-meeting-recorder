#!/usr/bin/env python3
"""
Generate AI-powered metadata from a meeting transcript.
Usage: python3 generate-metadata.py <transcript_path>
Output: JSON to stdout with summary, key points, action items, participants, topics.
"""

import sys
import os
import json
import re
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print(json.dumps({"error": "openai package not installed. Run: pip install openai"}))
    sys.exit(1)


def detect_language(text: str) -> str:
    """Simple language detection based on character frequency."""
    hebrew_chars = len(re.findall(r'[\u0590-\u05FF]', text))
    total_chars = len(re.findall(r'\w', text))
    if total_chars == 0:
        return "unknown"
    hebrew_ratio = hebrew_chars / total_chars
    if hebrew_ratio > 0.3:
        return "he"
    return "en"


def generate_metadata(transcript: str) -> dict:
    """Call OpenRouter API to extract metadata from transcript."""

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        # Try reading from .env file
        env_file = Path(__file__).parent.parent.parent / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("OPENROUTER_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    break

    if not api_key:
        return {"error": "OPENROUTER_API_KEY not set"}

    model = os.environ.get("METADATA_MODEL", "anthropic/claude-3-haiku")
    language = detect_language(transcript)

    if language == "he":
        prompt = f"""אנא נתח את תמליל הפגישה הבא וחלץ מטא-דאטה.

תמליל:
{transcript}

החזר JSON עם המבנה הבא (בעברית):
{{
    "title": "כותרת קצרה ותיאורית לפגישה (עד 50 תווים)",
    "summary": "סיכום של 2-3 משפטים",
    "keyPoints": ["נקודה 1", "נקודה 2", "נקודה 3"],
    "actionItems": [
        {{"owner": "שם", "task": "תיאור המשימה"}}
    ],
    "participants": ["שם1", "שם2"],
    "topics": ["topic1", "topic2"],
    "language": "he"
}}

הנחיות:
- topics צריכים להיות באנגלית, באותיות קטנות, מופרדים במקף
- אם לא בטוח לגבי משהו, השמט אותו
- החזר רק JSON תקין, ללא טקסט נוסף"""
    else:
        prompt = f"""Analyze this meeting transcript and extract metadata.

Transcript:
{transcript}

Return JSON with this structure:
{{
    "title": "Short descriptive meeting title (max 50 chars)",
    "summary": "2-3 sentence summary",
    "keyPoints": ["point 1", "point 2", "point 3"],
    "actionItems": [
        {{"owner": "name", "task": "task description"}}
    ],
    "participants": ["name1", "name2"],
    "topics": ["topic1", "topic2"],
    "language": "en"
}}

Guidelines:
- topics should be lowercase, hyphen-separated English words
- If uncertain about something, omit it
- Return only valid JSON, no additional text"""

    try:
        client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key
        )
        response = client.chat.completions.create(
            model=model,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}]
        )
        response_text = response.choices[0].message.content.strip()

        # Extract JSON from response
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            return json.loads(json_match.group())
        return json.loads(response_text)

    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse AI response as JSON: {e}", "raw": response_text}
    except Exception as e:
        return {"error": f"API error: {e}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: generate-metadata.py <transcript_path>"}))
        sys.exit(1)

    transcript_path = Path(sys.argv[1])
    if not transcript_path.exists():
        print(json.dumps({"error": f"Transcript file not found: {transcript_path}"}))
        sys.exit(1)

    transcript = transcript_path.read_text(encoding="utf-8")
    if not transcript.strip():
        print(json.dumps({"error": "Transcript is empty"}))
        sys.exit(1)

    # Truncate very long transcripts
    max_chars = 50000
    if len(transcript) > max_chars:
        transcript = transcript[:max_chars] + "\n\n[Transcript truncated...]"

    result = generate_metadata(transcript)

    if "language" not in result and "error" not in result:
        result["language"] = detect_language(transcript)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
