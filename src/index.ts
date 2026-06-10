/**
 * Otto — Call Agent.
 *
 * Listens to a call (incoming audio + your mic), keeps a saved transcript, and
 * when anyone says "Otto, …" answers out loud — both on your speakers AND injected
 * into the call's microphone so everyone on the call hears it.
 *
 * Sessions are controlled from the dashboard (Start/End): ending a session stops
 * Otto listening; each session's transcript is saved to NOTES_DIR and browsable
 * (and downloadable) from the dashboard.
 */
import { basename, resolve } from "node:path";
import dotenv from "dotenv";
dotenv.config();

import { capture, PcmSink, playPCMControllable, rms16, stereoToMono, type Playback } from "./audio.js";
import { CallMixer } from "./mixer.js";
import { openSTT, type STTConnection } from "./deepgram.js";
import { WakeWord } from "./wakeword.js";
import { createLLM, summarizeMeeting } from "./llm.js";
import { synthesize, TTS_SAMPLE_RATE } from "./tts.js";
import { TranscriptStore } from "./transcript.js";
import { startUI } from "./ui.js";
import * as route from "./route.js";

const AGENT_NAME = process.env.AGENT_NAME || "Otto";
const HOST_NAME = process.env.HOST_NAME || "You";
const MIC_DEVICE = process.env.MIC_DEVICE || "MacBook Air Microphone";
const CALL_CAPTURE_DEVICE = process.env.CALL_CAPTURE_DEVICE || "BlackHole 16ch";
const CALL_MIC_DEVICE = process.env.CALL_MIC_DEVICE || "BlackHole 2ch";
const MONITOR_DEVICE = process.env.MONITOR_DEVICE || "MacBook Air Speakers";
const ROUTE_DEVICE = process.env.ROUTE_DEVICE || "Otto Monitor";
const NOTES_DIR = resolve(process.env.NOTES_DIR || "./notes");
const UI_PORT = Number(process.env.UI_PORT || 4848);
const STITCH_WINDOW_MS = 12_000;

// Relay mode (Bluetooth-friendly full capture): the call app's SPEAKER is set to
// BlackHole 16ch; Otto transcribes that AND plays it to your headphones, so you
// hear the call without a Multi-Output device. Higher capture rate for nicer
// playback quality. Costs ~150–300ms of added latency hearing others.
const RELAY_CALL = (process.env.RELAY_CALL ?? "false").toLowerCase() === "true";
const CALL_FMT = { sampleRate: RELAY_CALL ? 48000 : 16000, channels: 1 };
const MIC_FMT = { sampleRate: 48000, channels: 2 };

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

function isAcknowledgement(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  return /\b(thanks|thank you|thank u|cheers|got it|appreciate|nice one|good (job|stuff|one)|perfect|awesome|great job|never mind|nevermind)\b/.test(t);
}

const wake = new WakeWord(AGENT_NAME);
const llm = createLLM();
const DUCK = (process.env.DUCK_WHILE_SPEAKING ?? "true").toLowerCase() !== "false";
const mixer = new CallMixer(CALL_MIC_DEVICE, MIC_FMT, DUCK);
// Relay sink: streams the captured call audio to your headphones so you hear the
// call (Bluetooth as a normal single output — no aggregate). Runs independent of
// the Otto session, so you keep hearing the call even when Otto isn't listening.
const relaySink = RELAY_CALL ? new PcmSink(MONITOR_DEVICE, CALL_FMT) : null;
const BARGE_IN = !DUCK;
const BARGE_RMS = Number(process.env.BARGE_RMS || 0.05);

let currentPlayback: Playback | null = null;
let loudFrames = 0;

// --- session state (controlled from the dashboard) ---
let sessionActive = false;
let transcript: TranscriptStore | null = null;
let callStt: STTConnection | null = null;
let micStt: STTConnection | null = null;
let answering = false;
let awaitingQuestion = false;
let awaitingSince = 0;
let lastLine: { text: string; at: number } | null = null;
let micMuted = false; // your mic muted into both Otto (recording) and the call

function interrupt(): void {
  mixer.cancel();
  currentPlayback?.stop();
}

function toggleMute(): void {
  micMuted = !micMuted;
  ui.emit({ type: "muted", muted: micMuted });
  console.log(micMuted ? "🔇 mic muted" : "🔈 mic unmuted");
}

function startSession(): void {
  if (sessionActive) return;
  transcript = new TranscriptStore(NOTES_DIR, new Date().toISOString());
  awaitingQuestion = false;
  lastLine = null;
  answering = false;
  callStt = openSTT(
    { diarize: true, keyterm: [AGENT_NAME], ...CALL_FMT },
    { onUtterance: ({ speaker, text }) => handleUtterance(`Speaker ${speaker + 1}`, text), onError: (e) => console.error("call STT:", e) },
  );
  micStt = openSTT(
    { diarize: false, keyterm: [AGENT_NAME], sampleRate: MIC_FMT.sampleRate, channels: 1 },
    { onUtterance: ({ text }) => handleUtterance(HOST_NAME, text), onError: (e) => console.error("mic STT:", e) },
  );
  sessionActive = true;
  ui.emit({ type: "reset" });
  ui.emit({ type: "session", active: true, id: basename(transcript.savedAt) });
  ui.emit({ type: "state", state: "listening" });
  console.log(`▶ session started → ${transcript.savedAt}`);
}

function endSession(): void {
  if (!sessionActive) return;
  sessionActive = false;
  interrupt();
  callStt?.close();
  micStt?.close();
  callStt = null;
  micStt = null;
  ui.emit({ type: "session", active: false, id: transcript ? basename(transcript.savedAt) : undefined });
  console.log(`⏹ session ended${transcript ? ` → ${transcript.savedAt}` : ""}`);
}

const ui = startUI(
  UI_PORT,
  { agentName: AGENT_NAME, callMic: CALL_MIC_DEVICE, monitor: ROUTE_DEVICE },
  { notesDir: NOTES_DIR, onStart: startSession, onEnd: endSession, onMute: toggleMute, onSummarize: summarizeMeeting },
);

async function answer(question: string): Promise<void> {
  if (!sessionActive || !transcript || answering) return;
  const t = transcript;
  answering = true;
  ui.emit({ type: "state", state: "thinking" });
  try {
    const result = await llm.answer({
      agentName: AGENT_NAME,
      transcript: t.asText(),
      question,
      participants: [...t.participants],
      notesArchive: t.loadArchive(6000),
    });
    if (!result.respond || !result.text) {
      console.log(`${AGENT_NAME} … (stayed silent — not addressed)`);
      return;
    }
    const tag = result.searched ? ` 🌐 ${result.sources[0] ?? "web"}` : "";
    console.log(`\n${AGENT_NAME} ▶ ${result.text}${tag}\n`);
    t.add(AGENT_NAME, result.text);
    ui.emit({ type: "line", kind: "agent", speaker: AGENT_NAME, text: result.text, searched: result.searched, sources: result.sources });

    try {
      const pcm = await synthesize(result.text);
      ui.emit({ type: "state", state: "speaking" });
      mixer.speak(pcm);
      currentPlayback = playPCMControllable(MONITOR_DEVICE, pcm, { sampleRate: TTS_SAMPLE_RATE, channels: 1 });
      await currentPlayback.done;
      currentPlayback = null;
    } catch (err) {
      console.error("TTS/playback failed:", err);
    }
  } catch (err) {
    console.error("LLM failed:", err);
  } finally {
    answering = false;
    if (sessionActive) ui.emit({ type: "state", state: "listening" });
  }
}

function handleUtterance(speaker: string, text: string): void {
  if (!sessionActive || !transcript || answering) return;

  transcript.add(speaker, text);
  console.log(`${speaker}: ${text}`);
  ui.emit({ type: "line", kind: "speech", speaker, text });

  const now = Date.now();
  const directQuestion = wake.extract(text);
  const addressed = wake.contains(text);

  if (directQuestion) {
    awaitingQuestion = false;
    lastLine = null;
    void answer(directQuestion);
    return;
  }
  if (addressed) {
    if (isAcknowledgement(text)) {
      awaitingQuestion = false;
      lastLine = null;
      return;
    }
    if (lastLine && now - lastLine.at <= STITCH_WINDOW_MS) {
      const q = lastLine.text;
      lastLine = null;
      awaitingQuestion = false;
      void answer(q);
    } else {
      awaitingQuestion = true;
      awaitingSince = now;
    }
    return;
  }
  if (awaitingQuestion && now - awaitingSince <= STITCH_WINDOW_MS) {
    awaitingQuestion = false;
    void answer(text);
    return;
  }
  awaitingQuestion = false;
  lastLine = { text, at: now };
}

async function main() {
  let prevOutput: string | null = null;
  if (await route.available()) {
    const outs = await route.listOutputs();
    if (outs.includes(ROUTE_DEVICE)) {
      prevOutput = await route.currentOutput();
      await route.setOutput(ROUTE_DEVICE);
      console.log(`🔀 system output → "${ROUTE_DEVICE}" (was "${prevOutput}")`);
    } else {
      console.log(`⚠️  Monitor device "${ROUTE_DEVICE}" not found — call-audio capture off (fine for solo).`);
    }
  }

  // Captures run continuously; audio only reaches STT while a session is active.
  const callCap = await capture(
    CALL_CAPTURE_DEVICE,
    CALL_FMT,
    (c) => {
      if (sessionActive) callStt?.send(c); // transcribe the call
      relaySink?.write(c); // …and play it to your headphones (relay mode)
    },
    (e) => console.error("call capture:", e),
  );
  const micCap = await capture(
    MIC_DEVICE,
    MIC_FMT,
    (stereo) => {
      if (micMuted) {
        // Feed silence so Otto's TTS still flows into the call, but your voice
        // doesn't — and don't transcribe/record you.
        mixer.pushMic(Buffer.alloc(stereo.length));
        loudFrames = 0;
        return;
      }
      mixer.pushMic(stereo); // your voice → the call (always, so you're heard)
      if (sessionActive) micStt?.send(stereoToMono(stereo)); // transcribe only while listening

      if (sessionActive && BARGE_IN && mixer.speaking) {
        if (rms16(stereo) > BARGE_RMS) {
          if (++loudFrames >= 3) {
            console.log(`${AGENT_NAME} ⏹  (interrupted)`);
            interrupt();
            loudFrames = 0;
          }
        } else {
          loudFrames = 0;
        }
      } else {
        loudFrames = 0;
      }
    },
    (e) => console.error("mic capture:", e),
  );

  startSession(); // auto-start a session on boot

  console.log(`\n🎙️  Otto Call Agent — live`);
  console.log(`   wake word : "${AGENT_NAME}"   call mic: ${CALL_MIC_DEVICE}`);
  console.log(`   you hear  : ${MONITOR_DEVICE}   LLM: ${process.env.LLM_PROVIDER || "openai"}/${process.env.LLM_MODEL || "gpt-4o-mini"}`);
  console.log(`   dashboard : ${ui.url}  (Start/End + history)`);
  console.log(`   notes dir : ${NOTES_DIR}\n`);

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    endSession();
    callCap.stop();
    micCap.stop();
    mixer.stop();
    relaySink?.stop();
    if (prevOutput) await route.setOutput(prevOutput);
    console.log(`\nStopped. Transcripts in ${NOTES_DIR}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
