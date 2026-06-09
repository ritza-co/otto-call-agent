# Otto — Call Agent

A **local** voice agent that sits on top of *any* call platform (Zoom, Meet, Teams, …)
via macOS virtual audio. It hears the call, keeps transcripts saved locally, and —
the impressive part — anyone on the call can invoke it ("Otto, …") and it replies
**through your audio into the call so everyone hears it**.

No browser mic, no platform integration. It works at the OS audio layer, so the call
app never knows it's there.

## What it does

1. **Listens to the whole call** — captures both the incoming call audio (everyone
   else) and your mic, transcribes with Deepgram (diarized), and saves the transcript
   locally per meeting.
2. **Answers out loud, into the call** — wake word "Otto" → LLM (with web search +
   your notes archive) → Aura TTS → injected into the call's microphone so every
   participant hears the reply (and you hear it too).
3. **LLM over your notes** — ask about the current call or anything in your saved
   meeting history ("Otto, what did we decide about pricing last week?").

## Audio topology (macOS + BlackHole)

We use the two BlackHole devices as one-way "cables". **Our app is the mixer.**

```
                    ┌────────────────── Otto (local Node app) ──────────────────┐
 Call app (Zoom)    │                                                            │
 ──────────────     │  CAPTURE                                                   │
 incoming audio ──▶ system output = Multi-Output("Otto Monitor")                 │
                    │      ├─▶ your real headphones  (you hear the call, 0 lag)   │
                    │      └─▶ BlackHole 2ch ──▶ ffmpeg capture ─┐                │
 your mic ─────────▶ MacBook mic ──▶ ffmpeg capture ────────────┼─▶ Deepgram STT │
                    │                                            │   (2 streams)  │
                    │                                            ▼                │
                    │                                   transcript (saved)        │
                    │                                            │ "Otto, …"      │
                    │                                            ▼                │
                    │                                   LLM (+web +notes)         │
                    │                                            ▼                │
                    │                                       Aura TTS (PCM)        │
                    │   INJECT                                   │                │
 Zoom mic =         │   mixer: [your mic] + [TTS] ──▶ BlackHole 16ch ◀────────────┘
 BlackHole 16ch ◀───┘   (everyone on the call hears you + Otto)                   │
                    │   …and TTS also ──▶ your headphones (monitor)               │
                    └────────────────────────────────────────────────────────────┘
```

**Device roles** (already present on this machine):
| Device | Role |
|---|---|
| `BlackHole 16ch` | **Call mic** cable. Set Zoom's microphone to this. App writes `your mic + Otto TTS` here. |
| `BlackHole 2ch` | **Call capture** cable. App reads the call's incoming audio here. |
| `MacBook … Microphone` | Your real mic. App reads it (transcript + passthrough into the call mic). |
| `Otto Monitor` (Multi-Output: Headphones + BlackHole 2ch) | System output during a call, so you hear the call *and* we capture it. |

**The one setup step we automate/guide:** creating the `Otto Monitor` Multi-Output
device and pointing Zoom's mic at `BlackHole 16ch`. The app can switch the system
output to `Otto Monitor` at session start and restore it after (via SwitchAudioSource).

## Why our app must be the mixer

BlackHole is just a pipe — whatever you *play* to it appears as its *input*. To get
**both** your live mic and Otto's voice into the call, the app continuously forwards
your mic into `BlackHole 16ch` and mixes in TTS when Otto speaks. (Loopback/Audio
Hijack would do this without code, but we're staying free.)

## Build phases

- **Phase 0 — audio proof (done first):** confirm we can capture from and inject into
  BlackHole via ffmpeg/sox on this machine.
- **Phase 1 — listen + notes:** dual-stream capture → Deepgram (diarized) → live +
  persisted transcripts; wake word → LLM(+web+notes) → TTS to **your speakers**.
- **Phase 2 — speak into the call:** the mic+TTS mixer into `BlackHole 16ch`; system
  output auto-switch; the full "everyone hears Otto" experience.
- **Phase 3 — packaged setup:** one `setup` command (BlackHole check, Multi-Output
  device creation, device config, Zoom instructions).
- **Phase 4 — UI:** a minimal bespoke front-end, clear "Otto is speaking" state
  (built last, with the frontend-design skill).

## Reused from the web-app version

Deepgram STT wrapper, wake-word detection (+ stitching + acknowledgement filter),
the context-aware LLM with web search, Aura TTS, and the transcript model — adapted
from browser I/O to local system-audio I/O.

## Stack

Node + TypeScript. Audio in/out via `ffmpeg`/`sox` child processes (CoreAudio).
Device control via `SwitchAudioSource`. Notes persisted as local JSON/Markdown.
