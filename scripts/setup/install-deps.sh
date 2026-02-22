#!/bin/bash
# Install dependencies for meeting-recorder skill

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

echo "=== Meeting Recorder: Installing Dependencies ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root"
    exit 1
fi

# Install PulseAudio and jq
echo "[1/4] Installing PulseAudio and utilities..."
apt-get update -qq
apt-get install -y pulseaudio pulseaudio-utils jq xvfb

# Verify FFmpeg
echo "[2/4] Verifying FFmpeg..."
if command -v ffmpeg &> /dev/null; then
    echo "  ✓ FFmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
else
    echo "  ✗ FFmpeg not found, installing..."
    apt-get install -y ffmpeg
fi

# Install Python dependencies
echo "[3/4] Installing Python dependencies..."
pip3 install faster-whisper

# Install Node.js dependencies
echo "[4/4] Installing Node.js dependencies..."
cd "$SKILL_DIR"
npm install

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy config.example.json to config.json and customize"
echo "  2. Copy .env.example to .env and add your credentials (optional)"
echo "  3. Run scripts/setup/verify-setup.sh to confirm everything works"
