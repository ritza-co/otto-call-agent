/**
 * Otto — Call Agent, Voice Agent edition (Deepgram-native).
 *
 *   npm run converse
 *
 * Uses the Deepgram Voice Agent API (Flux STT + adaptive echo cancellation +
 * model-level turn-taking/barge-in + Aura TTS + an OpenAI "think" brain with a
 * web_search function). We feed it the room audio (call + your mic) and inject
 * its replies into the call. Deepgram handles STT, self-echo, and interruption —
 * replacing the custom wake-word / ducking / RMS-barge-in pipeline in index.ts.
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
dotenv.config();

import { capture, PcmSink, stereoToMono } from "./audio.js";
import { CallMixer } from "./mixer.js";
import { TranscriptStore } from "./transcript.js";
import { startUI } from "./ui.js";
import { startVoiceAgent } from "./voiceAgent.js";
import { searchWeb } from "./llm.js";
import * as route from "./route.js";

const AGENT_NAME = process.env.AGENT_NAME || "Otto";
const MIC_DEVICE = process.env.MIC_DEVICE || "MacBook Air Microphone";
const CALL_CAPTURE_DEVICE = process.env.CALL_CAPTURE_DEVICE || "BlackHole 16ch";
const CALL_MIC_DEVICE = process.env.CALL_MIC_DEVICE || "BlackHole 2ch";
const MONITOR_DEVICE = process.env.MONITOR_DEVICE || "MacBook Air Speakers";
const ROUTE_DEVICE = process.env.ROUTE_DEVICE || "Otto Monitor";
const NOTES_DIR = resolve(process.env.NOTES_DIR || "./notes");
const UI_PORT = Number(process.env.UI_PORT || 4848);
const STT_MODEL = process.env.STT_MODEL || "flux-general-en";
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || "aura-2-arcas-en";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
// On speakers, stop feeding the mic to the agent while Otto speaks, so his voice
// from the speakers can't loop back in and re-trigger him. true (speakers) /
// false (headphones — no acoustic path, keeps full mid-sentence barge-in).
const ECHO_GUARD = (process.env.ECHO_GUARD ?? "true").toLowerCase() !== "false";

const AGENT_RATE = 16000; // Voice Agent input
const TTS_RATE = 48000; // Voice Agent output (we set it)
const CALL_FMT = { sampleRate: AGENT_RATE, channels: 1 };
const MIC_FMT = { sampleRate: 48000, channels: 2 };
const CABLE_FMT = { sampleRate: 48000, channels: 2 };

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY.");
  process.exit(1);
}

/** Sum two real-time 16 kHz mono streams (call + your mic) into one for the agent. */
class InputMixer {
  private call = Buffer.alloc(0);
  private mic = Buffer.alloc(0);
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly frame = 640; // 20ms @ 16k mono (s16le)
  private readonly cap = 6400; // ~200ms backlog ceiling

  constructor(private readonly emit: (b: Buffer) => void) {
    this.timer = setInterval(() => this.tick(), 20);
  }
  pushCall(b: Buffer) {
    this.call = Buffer.concat([this.call, b]);
    if (this.call.length > this.cap) this.call = this.call.subarray(this.call.length - this.cap);
  }
  pushMic(b: Buffer) {
    this.mic = Buffer.concat([this.mic, b]);
    if (this.mic.length > this.cap) this.mic = this.mic.subarray(this.mic.length - this.cap);
  }
  private tick() {
    const out = Buffer.alloc(this.frame);
    const c = this.call;
    const m = this.mic;
    for (let i = 0; i + 1 < this.frame; i += 2) {
      const cv = i + 1 < c.length ? c.readInt16LE(i) : 0;
      const mv = i + 1 < m.length ? m.readInt16LE(i) : 0;
      let s = cv + mv;
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out.writeInt16LE(s, i);
    }
    this.call = c.subarray(Math.min(this.frame, c.length));
    this.mic = m.subarray(Math.min(this.frame, m.length));
    this.emit(out);
  }
  stop() {
    clearInterval(this.timer);
  }
}

/** Decimate 48 kHz mono → 16 kHz mono (take every 3rd sample). */
function downsample48to16(mono48: Buffer): Buffer {
  const inN = Math.floor(mono48.length / 2);
  const outN = Math.floor(inN / 3);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) out.writeInt16LE(mono48.readInt16LE(i * 3 * 2), i * 2);
  return out;
}

// Echo-guard state: true while Otto's audio is actually playing out the speakers,
// so we pause feeding the mic into the agent and it can't hear itself.
//
// Deepgram bursts the TTS faster than real time, but it PLAYS over its true
// duration — so we track the real playback end from the bytes we've queued
// (bytes ÷ rate), not the burst arrival. Keeps the guard up for the whole reply.
let agentSpeaking = false;
let playbackEndsAt = 0;
let guardTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGuardOff() {
  if (guardTimer) clearTimeout(guardTimer);
  const wait = Math.max(0, playbackEndsAt - Date.now()) + 400; // +tail for sox latency
  guardTimer = setTimeout(() => {
    if (Date.now() >= playbackEndsAt) agentSpeaking = false;
    else scheduleGuardOff();
  }, wait);
}

function noteOttoAudio(byteLength: number) {
  const durMs = (byteLength / 2 / TTS_RATE) * 1000; // s16le mono
  playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + durMs;
  agentSpeaking = true;
  scheduleGuardOff();
}

const transcript = new TranscriptStore(NOTES_DIR, new Date().toISOString(), "Call");
const ui = startUI(UI_PORT, { agentName: AGENT_NAME, callMic: CALL_MIC_DEVICE, monitor: ROUTE_DEVICE });
const mixer = new CallMixer(CALL_MIC_DEVICE, CABLE_FMT, true); // duck your mic while Otto speaks
const monitor = new PcmSink(MONITOR_DEVICE, { sampleRate: TTS_RATE, channels: 1 });

function buildPrompt(): string {
  const notes = transcript.loadArchive(8000);
  return [
    `You are ${AGENT_NAME}, a voice assistant quietly listening to a live multi-person meeting.`,
    `CRITICAL: only respond when someone explicitly addresses you by name ("${AGENT_NAME}"). If the latest thing said is just people talking to each other and does not address you, do not respond at all — produce no output and stay silent.`,
    `When you are addressed, answer in ONE short spoken sentence with at most one useful fact. Be direct; no preamble, no markdown.`,
    `Use the web_search function only when the answer needs current or external information (news, prices, weather, scores, recent events).`,
    notes ? `\nNotes from previous meetings you can reference if asked:\n${notes}` : ``,
  ].join("\n");
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
      console.log(`⚠️  "${ROUTE_DEVICE}" not found — run \`npm run setup\`.`);
    }
  }

  const va = startVoiceAgent(
    {
      agentName: AGENT_NAME,
      prompt: buildPrompt(),
      functions: [
        {
          name: "web_search",
          description: "Search the web for current or external information and return a one-sentence answer.",
          parameters: { type: "object", properties: { query: { type: "string", description: "what to look up" } }, required: ["query"] },
        },
      ],
      sttModel: STT_MODEL,
      ttsModel: TTS_MODEL,
      llmModel: LLM_MODEL,
      inputSampleRate: AGENT_RATE,
      outputSampleRate: TTS_RATE,
      greeting: `Otto here — I'll jump in when you call my name.`,
    },
    {
      onSettingsApplied: () => console.log(`✅ Voice Agent live (Flux ${STT_MODEL} · Aura ${TTS_MODEL} · ${LLM_MODEL})`),
      onAudio: (pcm) => {
        noteOttoAudio(pcm.length); // hold the echo guard for the real playback duration
        mixer.speak(pcm); // → into the call (everyone hears Otto)
        monitor.write(pcm); // → you hear Otto
      },
      onUserText: (text) => {
        transcript.add("Call", text);
        ui.emit({ type: "line", kind: "speech", speaker: "Call", text });
      },
      onAgentText: (text) => {
        transcript.add(AGENT_NAME, text);
        ui.emit({ type: "line", kind: "agent", speaker: AGENT_NAME, text });
      },
      onState: (s) => {
        if (s === "listening") mixer.cancel(); // drop any buffered Otto
        ui.emit({ type: "state", state: s });
        // Note: the echo guard is driven by actual audio playback (noteOttoAudio),
        // not these state events — Deepgram bursts audio ahead of playback.
      },
      onFunctionCall: async (name, args) => {
        if (name === "web_search") {
          const q = String((args as any).query ?? "");
          console.log(`🌐 web_search: ${q}`);
          return await searchWeb(q);
        }
        return `Unknown function: ${name}`;
      },
      onError: (e) => console.error("Voice Agent error:", JSON.stringify(e)?.slice(0, 300)),
    },
  );

  const input = new InputMixer((frame) => va.feed(frame));

  const callCap = await capture(CALL_CAPTURE_DEVICE, CALL_FMT, (c) => input.pushCall(c), (e) => console.error("call capture:", e));
  const micCap = await capture(
    MIC_DEVICE,
    MIC_FMT,
    (stereo) => {
      mixer.pushMic(stereo); // your voice → the call (+ Otto mixed in)
      // Don't feed the agent your mic while Otto is speaking (echo guard), else
      // his voice from the speakers loops back in and re-triggers him.
      if (!(ECHO_GUARD && agentSpeaking)) {
        input.pushMic(downsample48to16(stereoToMono(stereo))); // your voice → the agent's ears
      }
    },
    (e) => console.error("mic capture:", e),
  );

  console.log(`\n🎙️  Otto Call Agent (Voice Agent mode)`);
  console.log(`   call mic  : ${CALL_MIC_DEVICE}  ← set your call app's microphone to this`);
  console.log(`   UI        : ${ui.url}`);
  console.log(`   transcript: ${transcript.savedAt}\n`);
  console.log(`Anyone on the call can say "${AGENT_NAME}, …". Ctrl-C to stop.\n`);

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    input.stop();
    callCap.stop();
    micCap.stop();
    va.stop();
    mixer.stop();
    monitor.stop();
    if (prevOutput) await route.setOutput(prevOutput);
    console.log(`\nSaved transcript → ${transcript.savedAt}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
