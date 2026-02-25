#!/usr/bin/env python3
"""
Multi-provider transcription script.

Supports:
- local: faster-whisper (default, runs on CPU)
- openai: OpenAI Whisper API
- openrouter: OpenRouter API (whisper or multimodal)
- multimodal: GPT-4o audio, Claude, etc.

Usage:
    python3 transcribe-provider.py <audio_file> [--provider local|openai|openrouter|multimodal]
"""

import os
import sys
import json
import argparse
import base64
from pathlib import Path

SKILL_DIR = Path(__file__).parent.parent.parent

def load_config():
    config_path = SKILL_DIR / "config.json"
    if not config_path.exists():
        config_path = SKILL_DIR / "config.example.json"
    
    with open(config_path) as f:
        return json.load(f)

def transcribe_local(audio_path, config):
    """Transcribe using local faster-whisper."""
    from faster_whisper import WhisperModel
    
    model_size = config.get("local", {}).get("model", "small")
    language = config.get("language")
    if language == "auto":
        language = None
    
    print(f"Loading {model_size} model...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    print("Transcribing...")
    if language:
        segments, info = model.transcribe(str(audio_path), language=language, beam_size=5)
    else:
        segments, info = model.transcribe(str(audio_path), beam_size=5)
    
    print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")
    
    full_text = []
    for segment in segments:
        text = segment.text.strip()
        full_text.append(text)
        print(f"[{segment.start:.2f}s] {text}")
    
    return "\n".join(full_text), info.language

def transcribe_openai(audio_path, config):
    """Transcribe using OpenAI Whisper API."""
    import requests
    
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY not set")
    
    model = config.get("openai", {}).get("model", "whisper-1")
    language = config.get("language")
    if language == "auto":
        language = None
    
    print(f"Transcribing with OpenAI {model}...")
    
    # Detect mime type from extension
    ext = audio_path.suffix.lower()
    mime_types = {".wav": "audio/wav", ".webm": "audio/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg"}
    mime = mime_types.get(ext, "audio/wav")
    
    with open(audio_path, "rb") as f:
        files = {"file": (audio_path.name, f, mime)}
        data = {"model": model}
        if language:
            data["language"] = language
        
        response = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
            data=data
        )
    
    if response.status_code != 200:
        raise Exception(f"OpenAI API error: {response.text}")
    
    result = response.json()
    text = result.get("text", "")
    print(text)
    return text, language or "auto"

def transcribe_openrouter(audio_path, config):
    """Transcribe using OpenRouter API."""
    import requests
    
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    
    model = config.get("openrouter", {}).get("model", "openai/whisper-large-v3")
    
    print(f"Transcribing with OpenRouter {model}...")
    
    # Read and encode audio
    with open(audio_path, "rb") as f:
        audio_base64 = base64.b64encode(f.read()).decode()
    
    response = requests.post(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        },
        json={
            "model": model,
            "file": audio_base64,
            "response_format": "text"
        }
    )
    
    if response.status_code != 200:
        raise Exception(f"OpenRouter API error: {response.text}")
    
    text = response.text
    print(text)
    return text, "auto"

def transcribe_multimodal(audio_path, config):
    """Transcribe using multimodal model (GPT-4o, Claude, etc.)."""
    import requests
    
    mm_config = config.get("multimodal", {})
    provider = mm_config.get("provider", "openrouter")
    model = mm_config.get("model", "openai/gpt-4o-audio-preview")
    
    if provider == "openrouter":
        api_key = os.environ.get("OPENROUTER_API_KEY")
        base_url = "https://openrouter.ai/api/v1"
    elif provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        base_url = "https://api.openai.com/v1"
    elif provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        base_url = "https://api.anthropic.com/v1"
    else:
        raise ValueError(f"Unknown provider: {provider}")
    
    if not api_key:
        raise ValueError(f"{provider.upper()}_API_KEY not set")
    
    print(f"Transcribing with {provider} {model}...")
    
    # Read and encode audio
    with open(audio_path, "rb") as f:
        audio_base64 = base64.b64encode(f.read()).decode()
    
    # Build request based on provider
    if provider == "anthropic":
        # Claude format
        response = requests.post(
            f"{base_url}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            },
            json={
                "model": model.replace("anthropic/", ""),
                "max_tokens": 4096,
                "messages": [{
                    "role": "user",
                    "content": [
                        {
                            "type": "audio",
                            "source": {
                                "type": "base64",
                                "media_type": "audio/wav",
                                "data": audio_base64
                            }
                        },
                        {
                            "type": "text",
                            "text": "Transcribe this audio exactly. Output only the transcription, no commentary."
                        }
                    ]
                }]
            }
        )
        if response.status_code != 200:
            raise Exception(f"Anthropic API error: {response.text}")
        text = response.json()["content"][0]["text"]
    else:
        # OpenAI/OpenRouter format
        response = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": audio_base64,
                                "format": "wav"
                            }
                        },
                        {
                            "type": "text",
                            "text": "Transcribe this audio exactly. Output only the transcription."
                        }
                    ]
                }]
            }
        )
        if response.status_code != 200:
            raise Exception(f"API error: {response.text}")
        text = response.json()["choices"][0]["message"]["content"]
    
    print(text)
    return text, "auto"

def save_outputs(audio_path, text, language):
    """Save transcription to txt, srt, vtt files."""
    output_dir = audio_path.parent
    basename = audio_path.stem
    
    # Plain text
    txt_path = output_dir / f"{basename}.txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)
    
    # Simple SRT (no timestamps from API providers)
    srt_path = output_dir / f"{basename}.srt"
    lines = text.strip().split("\n")
    srt_content = []
    for i, line in enumerate(lines, 1):
        if line.strip():
            srt_content.append(f"{i}")
            srt_content.append(f"00:00:00,000 --> 00:00:00,000")
            srt_content.append(line.strip())
            srt_content.append("")
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(srt_content))
    
    # VTT
    vtt_path = output_dir / f"{basename}.vtt"
    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        f.write(text)
    
    print(f"\n✓ Transcription complete!")
    print(f"  Text: {txt_path}")
    print(f"  SRT:  {srt_path}")
    print(f"  VTT:  {vtt_path}")

def main():
    parser = argparse.ArgumentParser(description="Multi-provider transcription")
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--provider", choices=["local", "openai", "openrouter", "multimodal"],
                        help="Transcription provider (default: from config)")
    args = parser.parse_args()
    
    audio_path = Path(args.audio_file)
    if not audio_path.exists():
        print(f"Error: File not found: {audio_path}")
        sys.exit(1)
    
    config = load_config()
    transcription_config = config.get("transcription", {})
    provider = args.provider or transcription_config.get("provider", "local")
    
    print(f"Provider: {provider}")
    print(f"Audio: {audio_path}")
    print()
    
    try:
        if provider == "local":
            text, lang = transcribe_local(audio_path, transcription_config)
        elif provider == "openai":
            text, lang = transcribe_openai(audio_path, transcription_config)
        elif provider == "openrouter":
            text, lang = transcribe_openrouter(audio_path, transcription_config)
        elif provider == "multimodal":
            text, lang = transcribe_multimodal(audio_path, transcription_config)
        else:
            raise ValueError(f"Unknown provider: {provider}")
        
        save_outputs(audio_path, text, lang)
        
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
