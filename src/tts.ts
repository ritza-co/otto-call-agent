/**
 * Deepgram Aura TTS, returned as raw 16-bit PCM so we can play it to a CoreAudio
 * device (your monitor) and inject it into the call-mic cable.
 */
import { createClient, type DeepgramClient } from "@deepgram/sdk";

export const TTS_SAMPLE_RATE = 48000;
export const TTS_CHANNELS = 1;

let client: DeepgramClient | null = null;
function deepgram(): DeepgramClient {
  if (!client) client = createClient(process.env.DEEPGRAM_API_KEY!);
  return client;
}

/** Synthesize `text` to a raw PCM (s16le, mono, 48 kHz) buffer. */
export async function synthesize(text: string): Promise<Buffer> {
  const model = process.env.DEEPGRAM_TTS_MODEL || "aura-2-arcas-en";
  const response = await deepgram().speak.request(
    { text },
    { model, encoding: "linear16", sample_rate: TTS_SAMPLE_RATE, container: "none" },
  );
  const stream = await response.getStream();
  if (!stream) throw new Error("Deepgram TTS returned no audio stream");

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
