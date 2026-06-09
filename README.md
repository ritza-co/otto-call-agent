# Otto — Call Agent 🎧

A **local** voice agent that rides on top of *any* call platform (Zoom, Meet,
Teams, …) using macOS virtual audio. It hears the whole call, saves transcripts
locally, and — the impressive part — **anyone on the call can say "Otto, …" and
the reply is spoken into the call so everyone hears it.**

No browser, no platform plugin. It works at the OS audio layer, so the call app
never knows it's there.

## What it does

- **Listens** to the call's incoming audio (diarized) + your mic, and keeps a
  **saved transcript** per meeting (`notes/`).
- **Answers out loud, into the call** — wake word "Otto" → LLM (with **web search**
  + your **notes archive**) → Aura TTS → injected into the call's mic so everyone
  hears it (and played to your speakers too).
- **Context-aware** — stays silent on "Thanks, Otto" or when one person is talking
  to another participant.
- **Recall across meetings** — "Otto, what did we decide about pricing last week?"

## Requirements

macOS, with (the setup script installs/creates what's missing):

- [Homebrew](https://brew.sh), `ffmpeg`, `sox`
- [BlackHole](https://existential.audio/blackhole/) **2ch** and **16ch**
  (`brew install blackhole-2ch blackhole-16ch`)
- `switchaudio-osx` (`brew install switchaudio-osx`)
- Xcode command-line tools (`xcode-select --install`) — only for auto-creating the
  monitor device; otherwise the setup prints manual steps.

## Setup

```bash
npm install
cp .env.example .env     # paste DEEPGRAM_API_KEY + OPENAI_API_KEY
npm run setup            # checks tools, creates the "Otto Monitor" device, writes .env
```

`npm run setup` will finish by telling you the **one** manual step: set your call
app's **microphone to `BlackHole 2ch`**, and use **headphones**.

## Audio routing (how it works)

```
 call incoming audio ─▶ system output = "Otto Monitor" (your output + BlackHole 16ch)
                           ├─▶ your headphones (you hear the call, no lag)
                           └─▶ BlackHole 16ch ─▶ capture ─┐
 your mic ───────────────────────────────────▶ capture ──┼─▶ Deepgram STT ─▶ transcript
                                                          │        │ "Otto, …"
                                                          │        ▼
                                                          │   LLM (+web +notes)
                                                          │        ▼  Aura TTS
 call app mic = BlackHole 2ch ◀── mixer: your mic + Otto ─┘   (everyone hears Otto)
```

- **`BlackHole 2ch`** — the call app's microphone. The app mixes your real mic +
  Otto's voice into it.
- **`BlackHole 16ch`** — carries the call's incoming audio to us for transcription.
- **`Otto Monitor`** — a Multi-Output device (your real output + BlackHole 16ch) so
  you keep hearing the call while we capture it. The app switches to it on start and
  restores your output on exit.

> **Headphones matter:** if Otto plays out of speakers, your mic re-captures it and
> the call gets an echo. Headphones avoid that.

## Two modes

| Command | Brain | Notes |
|---|---|---|
| `npm run converse` | **Deepgram Voice Agent API** | One socket: **Flux** STT + adaptive echo cancellation + model-level turn-taking/barge-in + **Aura** TTS + an OpenAI "think" brain with a `web_search` function. Deepgram handles STT, self-echo, and interruption. **Most Deepgram-native — the speaker-friendly path.** |
| `npm run dev` | **Custom pipeline** | Our own dual STT + wake-word + LLM + Aura, with mic-ducking / RMS barge-in. More control; needs headphones for clean speaker use. |

Both share the same audio routing, transcript persistence, notes archive, and UI.

In Voice Agent mode, "Otto only answers when addressed" is enforced via the think
prompt — tune it (and the greeting, which calibrates the echo canceller) to taste.

## Run

```bash
npm run converse   # Voice Agent mode (recommended) — Ctrl-C to stop
npm run dev        # custom-pipeline mode
npm run devices    # list audio device names (for .env)
```

Then join your call (mic = `BlackHole 2ch`). Anyone can say **"Otto, …"**.

## Configuration (`.env`)

| Variable | Notes |
|---|---|
| `DEEPGRAM_API_KEY` | required (STT + Aura TTS) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | per `LLM_PROVIDER` |
| `LLM_PROVIDER` / `LLM_MODEL` | `openai`/`gpt-4o-mini` (default) or `anthropic`/`claude-sonnet-4-6` |
| `AGENT_NAME` | wake word (default `Otto`) |
| `MIC_DEVICE` / `CALL_CAPTURE_DEVICE` / `CALL_MIC_DEVICE` / `MONITOR_DEVICE` / `ROUTE_DEVICE` | audio devices (set by `npm run setup`) |
| `NOTES_DIR` | where transcripts are saved (default `./notes`) |

## Project layout

```
src/
  index.ts       orchestration: capture → STT → wake → LLM → TTS → speak + inject
  audio.ts       ffmpeg capture, sox playback, PcmSink (streaming output)
  mixer.ts       CallMixer — your mic + Otto's TTS → the call's mic cable
  deepgram.ts    streaming STT (one per audio source)
  tts.ts         Aura TTS as raw PCM
  llm.ts         context-aware LLM with web search + notes recall
  wakeword.ts    wake-word detection + question extraction
  transcript.ts  disk-persisted transcript + notes archive reader
  route.ts       system-output switching (SwitchAudioSource)
  devices.ts     audio device discovery (npm run devices)
  setup.ts       packaged one-time setup (npm run setup)
scripts/
  create-multi-output.swift   CoreAudio helper to create the monitor device
```

A UI is planned (Phase 4) — for now it runs in the terminal with a live transcript.
