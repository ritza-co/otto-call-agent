#!/usr/bin/env bash
# Build the Otto system-audio tap as a minimal, ad-hoc-signed .app bundle.
#
# CoreAudio process taps gate on the kTCCServiceAudioCapture permission, which
# macOS only grants to a process with a real bundle identity (Info.plist with a
# usage string + a code signature). So the tap can't be a bare CLI binary — it
# must be this bundle, launched via `open` (LaunchServices) so TCC attributes
# the request to it. See src/capture/macTap.ts for how it's run.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="bin/OttoTap.app"
BIN="$APP/Contents/MacOS/otto-tap"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp scripts/OttoTap-Info.plist "$APP/Contents/Info.plist"

swiftc -O scripts/system-tap.swift -o "$BIN"
codesign --force --sign - --identifier co.ritza.otto.tap "$APP"

echo "built $APP"
