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
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInputIndex } from "./devices.js";

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/** Downmix interleaved s16le stereo to mono (average L/R). */
export function stereoToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    const l = stereo.readInt16LE(f * 4);
    const r = stereo.readInt16LE(f * 4 + 2);
    mono.writeInt16LE((l + r) >> 1, f * 2);
  }
  return mono;
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

/**
 * Play a finite raw PCM buffer to a named CoreAudio output device.
 *
 * We stage it to a temp file and let sox read the whole file, rather than piping
 * via stdin: sox plays CoreAudio output in real time, and a slow stdin consumer
 * drains only one pipe buffer (~0.34s) before hitting EOF/EPIPE. Reading a file
 * (known length) plays the clip in full and exits cleanly.
 */
export async function playPCM(deviceName: string, pcm: Buffer, format: PcmFormat): Promise<void> {
  const tmp = join(tmpdir(), `otto-tts-${process.pid}-${Date.now()}.raw`);
  await writeFile(tmp, pcm);
  try {
    await new Promise<void>((resolve) => {
      const sox = spawn("sox", [
        "-t", "raw", "-r", String(format.sampleRate), "-e", "signed", "-b", "16", "-c", String(format.channels),
        tmp,
        "-t", "coreaudio", deviceName,
      ]);
      sox.on("close", () => resolve());
      sox.on("error", () => resolve());
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
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
    // Continuously fed in real time by the mic; ignore EPIPE if sox ever exits.
    this.proc.stdin?.on("error", () => {});
  }

  write(pcm: Buffer): void {
    const s = this.proc.stdin;
    if (s && s.writable) s.write(pcm);
  }

  stop(): void {
    this.proc.stdin?.end();
    this.proc.kill("SIGKILL");
  }
}
