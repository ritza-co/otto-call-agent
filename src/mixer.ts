/**
 * CallMixer — makes the call hear "your mic + Otto".
 *
 * The call app's microphone is set to BlackHole 16ch. This mixer owns a
 * continuous PCM sink to that cable. Your real mic is passed straight through
 * (so the call hears you normally), and when Otto speaks, its TTS is summed in.
 *
 * The mic stream paces everything: for each captured stereo mic frame we emit one
 * frame to the cable, mixing in one mono TTS sample per frame. Because the mic is
 * captured in real time, TTS plays back at the correct rate with no separate clock.
 */
import { PcmSink, type PcmFormat } from "./audio.js";

function clip(s: number): number {
  return s > 32767 ? 32767 : s < -32768 ? -32768 : s;
}

export class CallMixer {
  private readonly sink: PcmSink;
  private tts: Buffer = Buffer.alloc(0); // queued mono TTS, consumed in lockstep with mic
  speaking = false;

  /** format is the cable format: stereo, same rate as the mic capture. */
  constructor(deviceName: string, format: PcmFormat) {
    this.sink = new PcmSink(deviceName, format);
  }

  /** Feed one interleaved s16le STEREO mic frame. Otto's TTS (mono) is summed in. */
  pushMic(stereo: Buffer): void {
    let out = stereo;
    if (this.tts.length >= 2) {
      out = Buffer.from(stereo); // don't mutate the caller's buffer
      const frames = Math.floor(out.length / 4);
      let consumed = 0;
      for (let f = 0; f < frames; f++) {
        if (this.tts.length < consumed + 2) break;
        const t = this.tts.readInt16LE(consumed);
        const li = f * 4;
        const ri = f * 4 + 2;
        out.writeInt16LE(clip(out.readInt16LE(li) + t), li);
        out.writeInt16LE(clip(out.readInt16LE(ri) + t), ri);
        consumed += 2;
      }
      this.tts = this.tts.subarray(consumed);
      if (this.tts.length < 2) {
        this.tts = Buffer.alloc(0);
        this.speaking = false;
      }
    }
    this.sink.write(out);
  }

  /** Queue mono TTS PCM (same sample rate as the cable) to speak into the call. */
  speak(monoPcm: Buffer): void {
    this.tts = this.tts.length ? Buffer.concat([this.tts, monoPcm]) : monoPcm;
    this.speaking = true;
  }

  stop(): void {
    this.sink.stop();
  }
}
