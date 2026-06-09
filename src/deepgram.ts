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
  const connection = deepgram.listen.live({
    model: process.env.DEEPGRAM_STT_MODEL || "nova-3",
    language: "en-US",
    smart_format: true,
    diarize: opts.diarize,
    interim_results: true,
    endpointing: 800,
    utterance_end_ms: 1200,
    vad_events: true,
    encoding: "linear16",
    sample_rate: opts.sampleRate,
    channels: opts.channels,
    ...(opts.keyterm ? { keyterm: opts.keyterm } : {}),
  });

  let buffer = "";
  let speaker = 0;
  let sawSpeaker = false;

  const commit = () => {
    const text = buffer.trim();
    buffer = "";
    sawSpeaker = false;
    if (text) cb.onUtterance({ speaker, text });
  };

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

  return {
    send(audio: Buffer) {
      const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
      connection.send(ab as ArrayBuffer);
    },
    close() {
      try {
        connection.requestClose();
      } catch {
        /* already closed */
      }
    },
  };
}
