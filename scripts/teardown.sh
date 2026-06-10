#!/usr/bin/env bash
# Remove everything Otto created and leave your audio settings exactly as before.
#
# Otto's tap never changes your system output or any audio device, so there's
# nothing about your setup to "undo". This just stops the tap, cleans up any
# private device left by a crash, and tells you how to remove the optional bits.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Stopping any running tap…"
pkill -f "OttoTap.app/Contents/MacOS/otto-tap" 2>/dev/null || true

echo "Removing any leftover Otto audio devices (normally none)…"
swift scripts/destroy-aggregates.swift 2>/dev/null || echo "  (skipped — Swift toolchain not found; a reboot also clears them)"

cat <<'EOF'

Otto does not change your system output or any audio setting, so nothing else
needs undoing. To fully remove the optional pieces:

  • Revoke the tap permission:
      System Settings › Privacy & Security › Microphone (and/or
      "Screen & System Audio Recording") → remove "Otto Tap"
  • Remove the virtual mic cable (only used to inject Otto's voice into calls):
      brew uninstall blackhole-2ch
  • Delete the tap bundle:
      rm -rf bin/OttoTap.app

EOF
echo "Teardown complete."
