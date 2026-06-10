#!/usr/bin/env bash
# One-time permission grant for the system-audio tap.
#
# CoreAudio taps need the kTCCServiceAudioCapture permission, which macOS only
# grants to a bundle launched via LaunchServices. So we `open` the bundle once;
# it asks for permission, you click Allow, and TCC remembers it for the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x bin/OttoTap.app/Contents/MacOS/otto-tap ] || bash scripts/build-tap.sh

echo "A macOS dialog will ask to let \"Otto Tap\" record this computer's audio — click Allow."
open bin/OttoTap.app
sleep 8
pkill -f "OttoTap.app/Contents/MacOS/otto-tap" 2>/dev/null || true
echo "Done. If you clicked Allow, system-audio capture is granted — run: npm run dev"
