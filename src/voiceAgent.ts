/**
 * Deepgram Voice Agent API client — one WebSocket that does STT (Flux) + LLM
 * (think) + TTS (Aura) + turn-taking + adaptive echo cancellation. We feed it the
 * room audio (call + your mic) and it streams back Otto's spoken audio, which we
 * inject into the call.
 *
 * This replaces our custom STT + wake-word + ducking + barge-in pipeline with
 * Deepgram-native turn detection and self-echo handling.
 */
import { createClient, AgentEvents } from "@deepgram/sdk";

export type AgentState = "listening" | "thinking" | "speaking";

export interface VoiceAgentCallbacks {
  onAudio: (pcm: Buffer) => void; // Otto's TTS out (linear16, mono, output rate)
  onUserText?: (text: string) => void;
  onAgentText?: (text: string) => void;
  onState?: (s: AgentState) => void;
  onFunctionCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  onSettingsApplied?: () => void;
  onError?: (e: unknown) => void;
}

export interface VoiceAgentOptions {
  agentName: string;
  prompt: string;
  functions?: Array<{ name: string; description: string; parameters: unknown }>;
  sttModel: string; // e.g. "flux-general-en"
  ttsModel: string; // e.g. "aura-2-arcas-en"
  llmModel: string; // e.g. "gpt-4o-mini"
  inputSampleRate: number;
  outputSampleRate: number;
  greeting?: string;
}

export interface VoiceAgentHandle {
  feed(pcm: Buffer): void;
  stop(): void;
}

export function startVoiceAgent(opts: VoiceAgentOptions, cb: VoiceAgentCallbacks): VoiceAgentHandle {
  const dg = createClient(process.env.DEEPGRAM_API_KEY!);
  const agent = dg.agent();
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const settings = {
    experimental: false,
    audio: {
      input: { encoding: "linear16", sample_rate: opts.inputSampleRate },
      output: { encoding: "linear16", sample_rate: opts.outputSampleRate, container: "none" },
    },
    agent: {
      language: "en",
      listen: {
        provider: {
          type: "deepgram",
          model: opts.sttModel,
          // keyterms are Nova-3 only; Flux rejects them.
          ...(/nova-3/i.test(opts.sttModel) ? { keyterms: [opts.agentName] } : {}),
        },
      },
      think: {
        provider: { type: "open_ai", model: opts.llmModel },
        prompt: opts.prompt,
        ...(opts.functions && opts.functions.length ? { functions: opts.functions } : {}),
      },
      speak: { provider: { type: "deepgram", model: opts.ttsModel } },
      ...(opts.greeting ? { greeting: opts.greeting } : {}),
    },
  };

  agent.on(AgentEvents.Open, () => {
    // Cast: AgentLiveSchema's provider types predate Flux; the wire accepts it.
    agent.configure(settings as any);
    keepAlive = setInterval(() => agent.keepAlive(), 7000);
  });

  agent.on(AgentEvents.SettingsApplied, () => cb.onSettingsApplied?.());

  agent.on(AgentEvents.Audio, (data: any) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data?.audio ?? data);
    cb.onAudio(buf);
  });

  agent.on(AgentEvents.ConversationText, (msg: any) => {
    if (msg?.role === "user") cb.onUserText?.(msg.content ?? "");
    else if (msg?.role === "assistant") cb.onAgentText?.(msg.content ?? "");
  });

  agent.on(AgentEvents.UserStartedSpeaking, () => cb.onState?.("listening"));
  agent.on(AgentEvents.AgentThinking, () => cb.onState?.("thinking"));
  agent.on(AgentEvents.AgentStartedSpeaking, () => cb.onState?.("speaking"));
  agent.on(AgentEvents.AgentAudioDone, () => cb.onState?.("listening"));

  agent.on(AgentEvents.FunctionCallRequest, async (payload: any) => {
    // Payload carries one or more function calls; shape may be {functions:[...]}
    // or a single {id,name,arguments}. Handle both.
    const calls = payload?.functions ?? [payload];
    for (const call of calls) {
      const id = call?.id ?? call?.function_call_id;
      const name = call?.name;
      let args: Record<string, unknown> = {};
      try {
        args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : call?.arguments ?? {};
      } catch {
        /* leave empty */
      }
      let content = "";
      try {
        content = (await cb.onFunctionCall?.(name, args)) ?? "";
      } catch (e) {
        content = `error: ${String(e)}`;
      }
      agent.functionCallResponse({ id, name, content });
    }
  });

  agent.on(AgentEvents.Error, (e: unknown) => cb.onError?.(e));
  agent.on(AgentEvents.Close, () => {
    if (keepAlive) clearInterval(keepAlive);
  });

  return {
    feed(pcm: Buffer) {
      const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      agent.send(ab as ArrayBuffer);
    },
    stop() {
      if (keepAlive) clearInterval(keepAlive);
      try {
        (agent as any).disconnect?.();
      } catch {
        /* ignore */
      }
    },
  };
}
