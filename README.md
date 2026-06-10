# Otto — Call Agent 🎧

A **local** voice agent that rides on top of *any* call platform (Zoom, Meet,
Teams, …) using macOS virtual audio. It hears the whole call, saves transcripts
locally, and — the impressive part — **anyone on the call can say "Otto, …" and
the reply is spoken into the call so everyone hears it.**

No browser, no platform plugin. It works at the OS audio layer, so the call app
never knows it's there — and it **never changes your audio settings**: the call's
audio is captured with a CoreAudio process tap, so your system output is untouched
and you keep hearing the call natively (no routing, no Multi-Output device, no lag).

## What it does

- **Listens** to the call's incoming audio (diarized) + your mic, and keeps a
  **saved transcript** per meeting (`notes/`).
- **Answers out loud, into the call** — wake word "Otto" → LLM (with **web search**
  + your **notes archive**) → Aura TTS → injected into the call's mic so everyone
  hears it (and played to your speakers too).
- **Context-aware** — stays silent on "Thanks, Otto" or when one person is talking
  to another participant.
- **Recall across meetings** — "Otto, what did we decide about pricing last week?"
- **Meeting-records dashboard** (http://localhost:4848) — your hub for everything: start/end sessions, browse every past meeting (search included), read live + saved transcripts, generate an LLM **summary** (Summary / Key points / Decisions / Action items), and **download** any transcript as `.md`. Deep-link a meeting with `?open=<id>`.

## Requirements

macOS **14.4+** (for CoreAudio process taps), with (the setup script installs/checks what's missing):

- [Homebrew](https://brew.sh), `ffmpeg` (mic capture), `sox` (plays Otto's voice back to you)
- [BlackHole](https://existential.audio/blackhole/) **2ch** — the *only* virtual
  device needed, and only to inject Otto's voice into the call (`brew install blackhole-2ch`)
- Xcode command-line tools (`xcode-select --install`) — to build the tap bundle (`bin/OttoTap.app`)

## Setup

```bash
npm install
cp .env.example .env     # paste DEEPGRAM_API_KEY + OPENAI_API_KEY
npm run setup            # checks tools, builds the tap bundle, writes .env
npm run tap:grant        # click "Allow" once so the tap can hear the call
```

Then the **one** manual step: set your call app's **microphone to `BlackHole 2ch`**,
and use **headphones**. Your system output / speaker is **not** changed.

## Audio routing (how it works)

```
 call incoming audio ─▶ your output device (unchanged — you hear the call natively)
                           │
                           └─▶ CoreAudio process tap (bin/OttoTap.app) ─┐
 your mic ─────────────────────────────────────────────▶ capture ──────┼─▶ Deepgram STT ─▶ transcript
                                                                        │        │ "Otto, …"
                                                                        │        ▼
                                                                        │   LLM (+web +notes)
                                                                        │        ▼  Aura TTS
 call app mic = BlackHole 2ch ◀── mixer: your mic + Otto ───────────────┘   (everyone hears Otto)
```

- **Process tap** — captures the system-output mix (the call's incoming audio) for
  transcription, *without* changing your output device or adding any cable. Shipped
  as a tiny ad-hoc-signed bundle (`bin/OttoTap.app`) because the macOS
  `kTCCServiceAudioCapture` permission is only granted to a real bundle launched via
  LaunchServices — hence `npm run tap:grant` (one click, remembered thereafter).
- **`BlackHole 2ch`** — the call app's microphone. The app mixes your real mic +
  Otto's voice into it so everyone on the call hears Otto.
- Otto's TTS is also played to your output (`MONITOR_DEVICE`) so you hear it too. The
  tap is muted for those moments so Otto never transcribes himself.

> **Headphones matter:** if Otto plays out of speakers, your mic re-captures it and
> the call gets an echo. Headphones avoid that.
>
> **Nothing to undo:** the tap changes no audio settings. `npm run teardown` stops it
> and prints how to remove the optional BlackHole cable and the permission.

## Two modes

| Command | Brain | Notes |
|---|---|---|
| `npm run dev` | **Custom pipeline** (the product) | Dual Deepgram STT (diarized call + your mic) → wake-word gate → context-aware LLM (web search + notes) → Aura TTS, injected into the call. Otto stays silent until called by name. **Recommended.** |
| `npm run converse` | **Deepgram Voice Agent API** (experimental) | One socket: Flux STT + Aura + an OpenAI "think" brain. Impressive, but built for *active* 1:1 conversation — see "Why not the Voice Agent API?" below. |

Both share the audio capture, transcript persistence, notes archive, and UI.

### Why not the Voice Agent API?

The Voice Agent API is excellent for phone-style agents that converse turn-by-turn
with one caller. This product is the opposite: a **passive, wake-word-gated copilot
in a multi-person room** that should stay quiet until someone says "Otto." The Voice
Agent responds on *every* detected turn by design, so "only speak when addressed"
can't be enforced reliably from a prompt — and its adaptive echo cancellation
expects a browser-clean mic, which a native capture pipeline doesn't provide. The
custom pipeline fits the wake-word use case directly (it only acts on "Otto …" and
gates with a NORESPONSE check), so it's the product; `converse` stays in the repo as
a documented experiment.

## Run

```bash
npm run dev        # the agent (Ctrl-C to stop; transcript saved to notes/)
npm run devices    # list audio device names (for .env)
npm run tap:grant  # re-grant the tap permission (e.g. after rebuilding it)
npm run teardown   # stop the tap + clean up; nothing else to undo
npm run converse   # experimental Voice Agent mode
```

Then join your call (mic = `BlackHole 2ch`). Anyone can say **"Otto, …"**.

## Configuration (`.env`)

| Variable | Notes |
|---|---|
| `DEEPGRAM_API_KEY` | required (STT + Aura TTS) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | per `LLM_PROVIDER` |
| `LLM_PROVIDER` / `LLM_MODEL` | `openai`/`gpt-4o-mini` (default) or `anthropic`/`claude-sonnet-4-6` |
| `AGENT_NAME` | wake word (default `Otto`) |
| `MIC_DEVICE` | your real microphone (Otto records you from this) |
| `CALL_MIC_DEVICE` | the call app's mic cable — `BlackHole 2ch` (Otto's voice is injected here) |
| `MONITOR_DEVICE` | where Otto's spoken replies play back to you; `default` follows your current output (Bluetooth-safe) |
| `NOTES_DIR` | where transcripts are saved (default `./notes`) |

The call's incoming audio needs **no** device config — it's captured by the process tap.

## Portability

The OS audio glue is macOS-only, but the design ports cleanly — each platform just
"captures what's playing":

- **macOS:** CoreAudio process tap (this repo)
- **Windows:** WASAPI loopback capture
- **Linux:** PipeWire / PulseAudio monitor source

Everything above the audio layer (Deepgram STT/TTS, wake-word, context-aware LLM,
transcripts, dashboard) is plain Node/TS and runs anywhere. The capture seam lives
in `src/capture/` — add a `winLoopback.ts` / `linuxMonitor.ts` and switch on it in
`src/capture/index.ts`.

## Project layout

```
src/
  index.ts       orchestration: capture → STT → wake → LLM → TTS → speak + inject
  audio.ts       ffmpeg mic capture, sox playback, PcmSink (streaming output)
  capture/
    index.ts     platform-agnostic system-audio capture seam
    macTap.ts    macOS impl: launches bin/OttoTap.app via `open`, reads PCM from a FIFO
  mixer.ts       CallMixer — your mic + Otto's TTS → the call's mic cable
  deepgram.ts    streaming STT (one per audio source)
  tts.ts         Aura TTS as raw PCM
  llm.ts         context-aware LLM with web search + notes recall
  wakeword.ts    wake-word detection + question extraction
  transcript.ts  disk-persisted transcript + notes archive reader
  route.ts       system-output query (SwitchAudioSource) — used only to label .env
  devices.ts     audio device discovery (npm run devices)
  setup.ts       packaged one-time setup (npm run setup)
scripts/
  system-tap.swift           CoreAudio process tap → mono s16le on stdout
  OttoTap-Info.plist         bundle Info.plist (TCC usage string + identity)
  build-tap.sh               compiles + ad-hoc-signs bin/OttoTap.app
  grant-tap.sh               one-time permission grant (npm run tap:grant)
  teardown.sh                stop the tap + cleanup (npm run teardown)
  destroy-aggregates.swift   removes any leftover private Otto audio devices
  create-multi-output.swift  legacy helper (pre-tap Multi-Output device)
```
