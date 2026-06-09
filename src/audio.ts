/**
 * Local audio I/O on macOS.
 *
 *  - capture(): ffmpeg reads a CoreAudio/avfoundation input device and emits
 *    raw 16-bit PCM (s16le) chunks — fed straight into Deepgram.
 *  - playPCM(): sox plays raw PCM to a named CoreAudio output device. Used to
 *    monitor Otto on your speakers, and (Phase 2) to inject into the call mic.
 *
 * We shell out to ffmpeg/sox because Node has no native CoreAudio access and
 * these handle device selection + format conversion cleanly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolveInputIndex } from "./devices.js";

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

export interface CaptureHandle {
  stop(): void;
}

/** Start capturing an input device as PCM. Calls onData with s16le chunks. */
export async function capture(
  deviceSpec: string,
  format: PcmFormat,
  onData: (chunk: Buffer) => void,
  onError?: (err: string) => void,
): Promise<CaptureHandle> {
  const index = await resolveInputIndex(deviceSpec);
  const proc = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "avfoundation",
    "-i", `:${index}`,
    "-ac", String(format.channels),
    "-ar", String(format.sampleRate),
    "-f", "s16le",
    "pipe:1",
  ]);

  proc.stdout.on("data", onData);
  proc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg && onError) onError(msg);
  });
  proc.on("error", (e) => onError?.(String(e)));

  return {
    stop() {
      proc.kill("SIGKILL");
    },
  };
}

/** Play a raw PCM buffer to a named CoreAudio output device. Resolves when done. */
export function playPCM(deviceName: string, pcm: Buffer, format: PcmFormat): Promise<void> {
  return new Promise((resolve) => {
    const sox = spawn("sox", [
      "-t", "raw",
      "-r", String(format.sampleRate),
      "-e", "signed",
      "-b", "16",
      "-c", String(format.channels),
      "-", // read raw PCM from stdin
      "-t", "coreaudio", deviceName,
    ]);
    sox.on("close", () => resolve());
    sox.on("error", () => resolve());
    sox.stdin.write(pcm);
    sox.stdin.end();
  });
}

/**
 * A long-lived sink that streams PCM to a CoreAudio device. Used to feed the
 * call-mic cable continuously (Phase 2 mixer writes mic + TTS here).
 */
export class PcmSink {
  private proc: ChildProcess;

  constructor(deviceName: string, format: PcmFormat) {
    this.proc = spawn("sox", [
      "-t", "raw", "-r", String(format.sampleRate), "-e", "signed", "-b", "16", "-c", String(format.channels), "-",
      "-t", "coreaudio", deviceName,
    ]);
    this.proc.on("error", () => {});
  }

  write(pcm: Buffer): void {
    this.proc.stdin?.write(pcm);
  }

  stop(): void {
    this.proc.stdin?.end();
    this.proc.kill("SIGKILL");
  }
}
