/**
 * System-audio capture — captures the call's incoming audio from the OS output
 * mix WITHOUT changing the user's output device or routing.
 *
 * This is the platform-agnostic seam. Today only macOS is implemented (CoreAudio
 * process tap). The same shape ports cleanly to:
 *   - Windows: WASAPI loopback capture (capture any output device's render mix)
 *   - Linux:   PipeWire / PulseAudio monitor source
 * Each platform is "capture what's playing" — no virtual cables, no routing.
 */
import { platform } from "node:os";
import { createMacSystemCapture } from "./macTap.js";

export interface SystemCapture {
  /** Native capture sample rate (Hz) — open your STT at this rate. */
  sampleRate: number;
  /** Channels in the emitted PCM (always 1 — we downmix to mono). */
  channels: number;
  /** s16le mono PCM frames as they arrive. */
  onData(cb: (pcm: Buffer) => void): void;
  stop(): void;
}

export interface SystemCaptureOpts {
  /** Called if the OS denies system-audio recording permission (with guidance). */
  onAuthError?: (message: string) => void;
  onError?: (e: Error) => void;
}

export async function createSystemAudioCapture(opts: SystemCaptureOpts = {}): Promise<SystemCapture> {
  switch (platform()) {
    case "darwin":
      return createMacSystemCapture(opts);
    default:
      throw new Error(
        `system-audio capture isn't implemented for "${platform()}" yet — macOS only for now ` +
          `(Windows would use WASAPI loopback; Linux a PipeWire monitor source).`,
      );
  }
}
