# Transcription Options

## Whisper Models

| Model | Size | VRAM | Speed | Quality |
|-------|------|------|-------|---------|
| tiny | 39M | ~1GB | Fastest | Basic |
| base | 74M | ~1GB | Fast | Good |
| small | 244M | ~2GB | Medium | Better |
| medium | 769M | ~5GB | Slow | Great |
| large | 1550M | ~10GB | Slowest | Best |

### Recommendations
- **Hebrew/RTL languages**: Use `small` or `medium` for better accuracy
- **Quick transcripts**: `tiny` or `base`
- **High quality**: `medium` or `large`
- **Low memory**: `tiny`

## Language Support

Whisper supports 99+ languages. Common codes:

| Language | Code |
|----------|------|
| Hebrew | `he` |
| English | `en` |
| Arabic | `ar` |
| Russian | `ru` |
| French | `fr` |
| Spanish | `es` |
| German | `de` |
| Auto-detect | `auto` or omit |

## Output Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| txt | Plain text | Reading, search |
| vtt | WebVTT subtitles | Video captioning |
| srt | SubRip subtitles | Video players |
| json | Structured data | Programmatic access |
| tsv | Tab-separated | Spreadsheets |

## Usage Examples

### Basic transcription (Hebrew)
```bash
whisper audio.wav --model base --language he
```

### High quality English
```bash
whisper audio.wav --model medium --language en --output_format all
```

### Auto-detect language
```bash
whisper audio.wav --model small
```

### Faster processing (GPU)
```bash
whisper audio.wav --model medium --device cuda
```

## Tips

### Mixed language content
- Use auto-detection or specify primary language
- Consider transcribing twice with different languages

### Long recordings
- Split into chunks if memory issues
- Use smaller model for initial pass

### Improving accuracy
- 16kHz mono WAV is optimal
- Clean audio with minimal background noise
- Consistent speaker volume

## Alternative Tools

### faster-whisper
Optimized implementation, 4x faster:
```bash
pip install faster-whisper
```

### whisper.cpp
CPU-optimized, no Python needed:
```bash
./main -m models/ggml-base.bin -f audio.wav -l he
```
