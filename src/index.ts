/**
 * Otto — Call Agent.
 *
 * Listens to a call (incoming audio + your mic), keeps a saved transcript, and
 * when anyone says "Otto, …" answers out loud — both on your speakers AND injected
 * into the call's microphone (BlackHole 16ch) so everyone on the call hears it.
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
dotenv.config();

import { capture, playPCM, stereoToMono } from "./audio.js";
import { CallMixer } from "./mixer.js";
import { openSTT } from "./deepgram.js";
import { WakeWord } from "./wakeword.js";
import { createLLM } from "./llm.js";
import { synthesize, TTS_SAMPLE_RATE } from "./tts.js";
import { TranscriptStore } from "./transcript.js";
import { startUI } from "./ui.js";
import * as route from "./route.js";

const AGENT_NAME = process.env.AGENT_NAME || "Otto";
const HOST_NAME = process.env.HOST_NAME || "You";
const MIC_DEVICE = process.env.MIC_DEVICE || "MacBook Air Microphone";
const CALL_CAPTURE_DEVICE = process.env.CALL_CAPTURE_DEVICE || "BlackHole 16ch"; // call's incoming audio
const CALL_MIC_DEVICE = process.env.CALL_MIC_DEVICE || "BlackHole 2ch"; // inject Otto here (stereo); call app's mic
const MONITOR_DEVICE = process.env.MONITOR_DEVICE || "MacBook Air Speakers";
const ROUTE_DEVICE = process.env.ROUTE_DEVICE || "Otto Monitor"; // multi-output created by setup
const NOTES_DIR = resolve(process.env.NOTES_DIR || "./notes");
const UI_PORT = Number(process.env.UI_PORT || 4848);
const STITCH_WINDOW_MS = 12_000;

const CALL_FMT = { sampleRate: 16000, channels: 1 }; // call capture → STT
const MIC_FMT = { sampleRate: 48000, channels: 2 }; // mic capture → mixer (+ downmixed to STT)

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

function isAcknowledgement(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  return /\b(thanks|thank you|thank u|cheers|got it|appreciate|nice one|good (job|stuff|one)|perfect|awesome|great job|never mind|nevermind)\b/.test(t);
}

const transcript = new TranscriptStore(NOTES_DIR, new Date().toISOString());
const wake = new WakeWord(AGENT_NAME);
const llm = createLLM();
// Duck your mic while Otto speaks (default true) so Otto's speaker-echo can't
// loop back into the call. Set DUCK_WHILE_SPEAKING=false on headphones.
const DUCK = (process.env.DUCK_WHILE_SPEAKING ?? "true").toLowerCase() !== "false";
const mixer = new CallMixer(CALL_MIC_DEVICE, MIC_FMT, DUCK);
const ui = startUI(UI_PORT, { agentName: AGENT_NAME, callMic: CALL_MIC_DEVICE, monitor: ROUTE_DEVICE });

let answering = false;
let awaitingQuestion = false;
let awaitingSince = 0;
let lastLine: { text: string; at: number } | null = null;

async function answer(question: string): Promise<void> {
  if (answering) return;
  answering = true;
  ui.emit({ type: "state", state: "thinking" });
  try {
    const result = await llm.answer({
      agentName: AGENT_NAME,
      transcript: transcript.asText(),
      question,
      participants: [...transcript.participants],
      notesArchive: transcript.loadArchive(),
    });
    if (!result.respond || !result.text) {
      console.log(`${AGENT_NAME} … (stayed silent — not addressed)`);
      return;
    }
    const tag = result.searched ? ` 🌐 ${result.sources[0] ?? "web"}` : "";
    console.log(`\n${AGENT_NAME} ▶ ${result.text}${tag}\n`);
    transcript.add(AGENT_NAME, result.text);
    ui.emit({ type: "line", kind: "agent", speaker: AGENT_NAME, text: result.text, searched: result.searched, sources: result.sources });

    try {
      const pcm = await synthesize(result.text); // mono 48k
      ui.emit({ type: "state", state: "speaking" });
      mixer.speak(pcm); // → everyone on the call hears Otto
      await playPCM(MONITOR_DEVICE, pcm, { sampleRate: TTS_SAMPLE_RATE, channels: 1 }); // → you hear Otto
    } catch (err) {
      console.error("TTS/playback failed:", err);
    }
  } catch (err) {
    console.error("LLM failed:", err);
  } finally {
    answering = false;
    ui.emit({ type: "state", state: "listening" });
  }
}

function handleUtterance(speaker: string, text: string): void {
  if (answering) return; // ignore audio while Otto is speaking (avoids self-trigger)

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
  // Route system output through the monitor device so we capture the call while
  // you still hear it. Restored on exit.
  let prevOutput: string | null = null;
  if (await route.available()) {
    const outs = await route.listOutputs();
    if (outs.includes(ROUTE_DEVICE)) {
      prevOutput = await route.currentOutput();
      await route.setOutput(ROUTE_DEVICE);
      console.log(`🔀 system output → "${ROUTE_DEVICE}" (was "${prevOutput}")`);
    } else {
      console.log(`⚠️  Monitor device "${ROUTE_DEVICE}" not found — run \`npm run setup\`. Call audio capture may be silent until then.`);
    }
  }

  const callStt = openSTT(
    { diarize: true, keyterm: [AGENT_NAME], ...CALL_FMT },
    { onUtterance: ({ speaker, text }) => handleUtterance(`Speaker ${speaker + 1}`, text), onError: (e) => console.error("call STT:", e) },
  );
  const micStt = openSTT(
    { diarize: false, keyterm: [AGENT_NAME], sampleRate: MIC_FMT.sampleRate, channels: 1 },
    { onUtterance: ({ text }) => handleUtterance(HOST_NAME, text), onError: (e) => console.error("mic STT:", e) },
  );

  const callCap = await capture(CALL_CAPTURE_DEVICE, CALL_FMT, (c) => callStt.send(c), (e) => console.error("call capture:", e));
  const micCap = await capture(
    MIC_DEVICE,
    MIC_FMT,
    (stereo) => {
      mixer.pushMic(stereo); // passthrough your voice into the call + mix Otto
      micStt.send(stereoToMono(stereo)); // transcribe you
    },
    (e) => console.error("mic capture:", e),
  );

  console.log(`\n🎙️  Otto Call Agent — live`);
  console.log(`   wake word : "${AGENT_NAME}"`);
  console.log(`   call audio: ${CALL_CAPTURE_DEVICE}   your mic: ${MIC_DEVICE}`);
  console.log(`   call mic  : ${CALL_MIC_DEVICE}  ← set your call app's microphone to this`);
  console.log(`   you hear  : ${MONITOR_DEVICE}   LLM: ${process.env.LLM_PROVIDER || "openai"}/${process.env.LLM_MODEL || "gpt-4o-mini"}`);
  console.log(`   UI        : ${ui.url}`);
  console.log(`   transcript: ${transcript.savedAt}\n`);
  console.log(`Anyone on the call can say "${AGENT_NAME}, …" to ask a question. Ctrl-C to stop.\n`);

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    callCap.stop();
    micCap.stop();
    callStt.close();
    micStt.close();
    mixer.stop();
    if (prevOutput) await route.setOutput(prevOutput);
    console.log(`\nSaved transcript → ${transcript.savedAt}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
