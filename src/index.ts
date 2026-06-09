/**
 * Otto — Call Agent. Phase 1: listen to the call + your mic, keep a saved
 * transcript, answer wake-word questions out loud on YOUR speakers.
 * (Phase 2 adds injecting the reply into the call mic so everyone hears it.)
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
dotenv.config();

import { capture } from "./audio.js";
import { playPCM } from "./audio.js";
import { openSTT } from "./deepgram.js";
import { WakeWord } from "./wakeword.js";
import { createLLM } from "./llm.js";
import { synthesize, TTS_SAMPLE_RATE, TTS_CHANNELS } from "./tts.js";
import { TranscriptStore } from "./transcript.js";

const AGENT_NAME = process.env.AGENT_NAME || "Otto";
const HOST_NAME = process.env.HOST_NAME || "You";
const MIC_DEVICE = process.env.MIC_DEVICE || "MacBook Air Microphone";
const CALL_CAPTURE_DEVICE = process.env.CALL_CAPTURE_DEVICE || "BlackHole 2ch";
const MONITOR_DEVICE = process.env.MONITOR_DEVICE || "MacBook Air Speakers";
const NOTES_DIR = resolve(process.env.NOTES_DIR || "./notes");
const STITCH_WINDOW_MS = 12_000;
const STT = { sampleRate: 16000, channels: 1 };

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

let answering = false;
let awaitingQuestion = false;
let awaitingSince = 0;
let lastLine: { text: string; at: number } | null = null;

async function answer(question: string): Promise<void> {
  if (answering) return;
  answering = true;
  try {
    process.stdout.write(`\n${AGENT_NAME} ⟳ thinking…\r`);
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

    try {
      const pcm = await synthesize(result.text);
      await playPCM(MONITOR_DEVICE, pcm, { sampleRate: TTS_SAMPLE_RATE, channels: TTS_CHANNELS });
    } catch (err) {
      console.error("TTS/playback failed:", err);
    }
  } catch (err) {
    console.error("LLM failed:", err);
  } finally {
    answering = false;
  }
}

function handleUtterance(speaker: string, text: string): void {
  if (answering) return; // ignore audio while Otto is speaking (echo)

  transcript.add(speaker, text);
  console.log(`${speaker}: ${text}`);

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
  // Two STT streams: the call (diarized — many remote speakers) and your mic.
  const callStt = openSTT(
    { diarize: true, keyterm: [AGENT_NAME], ...STT },
    { onUtterance: ({ speaker, text }) => handleUtterance(`Speaker ${speaker + 1}`, text), onError: (e) => console.error("call STT:", e) },
  );
  const micStt = openSTT(
    { diarize: false, keyterm: [AGENT_NAME], ...STT },
    { onUtterance: ({ text }) => handleUtterance(HOST_NAME, text), onError: (e) => console.error("mic STT:", e) },
  );

  const callCap = await capture(CALL_CAPTURE_DEVICE, STT, (c) => callStt.send(c), (e) => console.error("call capture:", e));
  const micCap = await capture(MIC_DEVICE, STT, (c) => micStt.send(c), (e) => console.error("mic capture:", e));

  console.log(`\n🎙️  Otto Call Agent — listening`);
  console.log(`   wake word : "${AGENT_NAME}"`);
  console.log(`   call audio: ${CALL_CAPTURE_DEVICE}   |   your mic: ${MIC_DEVICE}`);
  console.log(`   replies on: ${MONITOR_DEVICE}   |   LLM: ${process.env.LLM_PROVIDER || "openai"}/${process.env.LLM_MODEL || "gpt-4o-mini"}`);
  console.log(`   transcript: ${transcript.savedAt}\n`);
  console.log(`Say "${AGENT_NAME}, …" to ask a question. Ctrl-C to stop.\n`);

  const shutdown = () => {
    callCap.stop();
    micCap.stop();
    callStt.close();
    micStt.close();
    console.log(`\nSaved transcript → ${transcript.savedAt}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
