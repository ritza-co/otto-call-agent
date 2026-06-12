/**
 * Deepgram streaming STT, fed raw PCM from a local capture device.
 *
 * We run TWO of these: one over the call's incoming audio (diarized — it's a mix
 * of remote participants) and one over your mic (single speaker). Each emits
 * finalized utterances that get attributed and committed to the transcript.
 */
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

export interface FinalUtterance {
  speaker: number;
  text: string;
}

export interface STTCallbacks {
  onInterim?: (text: string, speaker: number) => void;
  onUtterance: (u: FinalUtterance) => void;
  onError?: (err: unknown) => void;
}

export interface STTOptions {
  diarize: boolean;
  keyterm?: string[];
  sampleRate: number;
  channels: number;
}

export interface STTConnection {
  send(audio: Buffer): void;
  close(): void;
}

export function openSTT(opts: STTOptions, cb: STTCallbacks): STTConnection {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

  let connection: ReturnType<typeof deepgram.listen.live>;
  let closedByUser = false;
  let lastAudioAt = Date.now();
  let buffer = "";
  let speaker = 0;
  let sawSpeaker = false;

  const commit = () => {
    const text = buffer.trim();
    buffer = "";
    sawSpeaker = false;
    if (text) cb.onUtterance({ speaker, text });
  };

  // (Re)open the live socket and bind handlers. Deepgram closes a streaming
  // connection after ~10s without audio — which happens whenever you mute, while
  // Otto is speaking (the call feed is gated), or during a quiet stretch. We send
  // KeepAlives during silence AND auto-reconnect on an unexpected close, so the
  // transcript never silently dies.
  const connect = () => {
    connection = deepgram.listen.live({
      model: process.env.DEEPGRAM_STT_MODEL || "nova-3",
      language: "en-US",
      smart_format: true,
      diarize: opts.diarize,
      interim_results: true,
      // How long Otto waits after you stop talking before finalizing → biggest
      // lever on perceived response speed. 400ms is snappy but still tolerant of
      // brief pauses (the wake-word stitcher covers any over-eager splits).
      endpointing: 700,
      utterance_end_ms: 1500,
      vad_events: true,
      encoding: "linear16",
      sample_rate: opts.sampleRate,
      channels: opts.channels,
      ...(opts.keyterm ? { keyterm: opts.keyterm } : {}),
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const alt = data?.channel?.alternatives?.[0];
      const text: string = alt?.transcript ?? "";
      if (!text) return;

      const firstWord = alt?.words?.[0];
      if (!sawSpeaker && typeof firstWord?.speaker === "number") {
        speaker = firstWord.speaker;
        sawSpeaker = true;
      }

      if (data.is_final) {
        buffer = buffer ? `${buffer} ${text}` : text;
        if (data.speech_final) commit();
      } else {
        cb.onInterim?.(buffer ? `${buffer} ${text}` : text, speaker);
      }
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => commit());
    connection.on(LiveTranscriptionEvents.Error, (err: unknown) => cb.onError?.(err));
    connection.on(LiveTranscriptionEvents.Close, () => {
      if (!closedByUser) setTimeout(connect, 300); // unexpected close → reconnect
    });
  };
  connect();

  // KeepAlive: ping during silence so Deepgram doesn't idle-close the socket.
  const keepAlive = setInterval(() => {
    if (closedByUser) return;
    if (Date.now() - lastAudioAt > 5000) {
      try { connection.keepAlive(); } catch { /* socket mid-reconnect */ }
    }
  }, 5000);
  keepAlive.unref?.();

  return {
    send(audio: Buffer) {
      lastAudioAt = Date.now();
      try {
        const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
        connection.send(ab as ArrayBuffer);
      } catch {
        /* socket mid-reconnect — drop this frame */
      }
    },
    close() {
      closedByUser = true;
      clearInterval(keepAlive);
      try {
        connection.requestClose();
      } catch {
        /* already closed */
      }
    },
  };
}
