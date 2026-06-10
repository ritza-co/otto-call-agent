# Otto : Your Local Call Agent 🎧

A **local** voice agent that rides on top of *any* call platform (Zoom, Meet,
Teams, …), powered by **[Deepgram](https://deepgram.com)** for real-time speech-to-text
and voice. It hears the whole call, keeps a saved transcript, and is available to **anyone in the call** to use while you are connected.

## What it does

- **Listens** to the call and your mic with **Deepgram** streaming speech-to-text — diarized, so each speaker is labelled — and saves a **transcript** per meeting.
- **Answers out loud, into the call** — say "Otto, …" → it replies in a natural **Deepgram Aura** voice through your audio, so everyone on the call hears it.
- **Knows things** — web search for live facts, and recall across your past meetings ("Otto, what did we decide about pricing last week?").
- **Stays out of the way** — only speaks when addressed (not on "Thanks, Otto").
- **Dashboard** at http://localhost:4848 — start/end sessions, browse past meetings, generate a **summary** (Summary / Key points / Decisions / Action items), and **download** any transcript as Markdown.

## Requirements

- **macOS 14.4 or later** (for the system-audio tap)
- [Homebrew](https://brew.sh)
- A [Deepgram](https://deepgram.com) API key and an [OpenAI](https://platform.openai.com) API key

`npm run setup` (below) checks for the rest and tells you how to install anything missing:

- `ffmpeg` and `sox` (`brew install ffmpeg sox`)
- Xcode command-line tools (`xcode-select --install`) — used to build the audio-tap helper

## Install BlackHole

BlackHole is a free virtual audio device — Otto uses it as the call app's
microphone to speak into the call. Install the **2ch** version with Homebrew:

```bash
brew install blackhole-2ch
```

This installs an audio driver, so macOS will ask for your password. If
`BlackHole 2ch` doesn't appear in your call app's microphone list afterwards,
restart the call app (or run `sudo killall coreaudiod` to reload audio, then
reopen it).

## Setup

```bash
npm install
cp .env.example .env      # paste your DEEPGRAM_API_KEY and OPENAI_API_KEY
npm run setup             # checks tools, builds the tap, writes device config
npm run tap:grant         # click "Allow" once to let Otto hear the call
```

Then, in your call app (Zoom / Meet / Teams):

- Set the **microphone** to **`BlackHole 2ch`** — this is how Otto's voice reaches the call.
- Leave the **speaker** as-is, and wear **headphones** (so Otto's reply isn't echoed back into the call).

## Run

```bash
npm run dev
```

Join your call and say **"Otto, …"**. The transcript and controls are at
**http://localhost:4848**.

## How it works

```
 the call's audio ─▶ your output device (unchanged — you hear the call normally)
                         └─▶ system-audio tap ──┐
 your mic ──────────────────────────▶ capture ──┼─▶ Deepgram STT ─▶ transcript
                                                 │        │  "Otto, …"
                                                 │        ▼
                                                 │   answer (web + your notes)
                                                 │        ▼  Deepgram Aura voice
 call mic = BlackHole 2ch ◀── your mic + Otto ───┘   (everyone on the call hears it)
```

- A **CoreAudio process tap** copies the call's audio for transcription **without
  changing your output device** — so you keep hearing the call natively, with no lag.
- Your mic and Otto's spoken replies are mixed into **`BlackHole 2ch`**, which the
  call app uses as its microphone — so the call hears both you and Otto.
- Speech is transcribed by **Deepgram** (diarized). When someone says "Otto", the
  question goes to an LLM (with web search and your saved notes), and the reply is
  spoken with **Deepgram Aura** and injected into the call.

Everything runs on your machine; transcripts are saved locally under `notes/`.

### Built on Deepgram

Deepgram does the real-time listening and speaking:

- **Streaming speech-to-text (Nova-3)** — two live transcription sockets (the call and your mic), so transcripts appear as people talk.
- **Diarization** — labels each speaker on the call, so the transcript reads like a conversation.
- **Keyterm prompting** — the wake word ("Otto") is boosted so it's reliably recognised even in a noisy call.
- **Endpointing** — tuned so Otto responds quickly after you finish a sentence without cutting you off.
- **Aura text-to-speech** — Otto's replies are synthesised in a natural voice and streamed straight into the call.

## Configuration (`.env`)

| Variable | Notes |
|---|---|
| `DEEPGRAM_API_KEY` | required — speech-to-text + Aura voice |
| `OPENAI_API_KEY` | required — the answering model (or set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic`) |
| `AGENT_NAME` | the wake word (default `Otto`) |
| `MIC_DEVICE` | your microphone (set by `npm run setup`) |
| `CALL_MIC_DEVICE` | the call app's mic cable — `BlackHole 2ch` |
| `MONITOR_DEVICE` | where Otto's replies play back to you; `default` follows your current output |
| `NOTES_DIR` | where transcripts are saved (default `./notes`) |

## Uninstall

```bash
npm run teardown
```

Otto never changes your audio settings, so there's nothing to undo. `teardown`
stops the tap and prints how to remove the optional pieces (the BlackHole cable,
the recording permission, and the tap bundle).
