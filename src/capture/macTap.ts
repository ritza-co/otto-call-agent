/**
 * macOS system-audio capture via a CoreAudio process tap (see
 * scripts/system-tap.swift). The tap is shipped as bin/OttoTap.app — a minimal,
 * ad-hoc-signed bundle — because the kTCCServiceAudioCapture permission is only
 * granted to a process with a real bundle identity, and only when launched via
 * LaunchServices (`open`). Direct-exec'ing the binary is NOT authorized.
 *
 * We launch it with `open --stdout <fifo>`, so the tap's mono s16le PCM streams
 * into a FIFO we read here. Nothing about the user's audio devices is changed,
 * and the tap + its private aggregate are destroyed when the helper exits.
 */
import { spawn, execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SystemCapture, SystemCaptureOpts } from "./index.js";

const APP = resolve(process.cwd(), "bin/OttoTap.app");
const BIN = join(APP, "Contents/MacOS/otto-tap");
const PROC_MATCH = "OttoTap.app/Contents/MacOS/otto-tap";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the helper's stderr log until it's ready, returning the capture rate. */
async function waitForReady(errlog: string, onAuthError?: (m: string) => void): Promise<number> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const log = existsSync(errlog) ? readFileSync(errlog, "utf8") : "";
    if (/@AUTH NOT authorized/.test(log)) {
      const msg =
        "macOS denied system-audio recording (kTCCServiceAudioCapture). Grant it once with " +
        "`npm run tap:grant` (click Allow on the dialog), then start Otto again.";
      onAuthError?.(msg);
      throw new Error(msg);
    }
    if (/@READY/.test(log)) {
      const m = log.match(/@RATE\s+(\d+)/);
      return m ? Number(m[1]) : 44100;
    }
    await sleep(100);
  }
  throw new Error(`system tap didn't become ready (no @READY in ${errlog}). Built? run ./scripts/build-tap.sh`);
}

export async function createMacSystemCapture(opts: SystemCaptureOpts): Promise<SystemCapture> {
  if (!existsSync(BIN)) {
    throw new Error(`tap not built — run \`./scripts/build-tap.sh\` (missing ${APP}).`);
  }

  const dir = mkdtempSync(join(tmpdir(), "otto-tap-"));
  const fifo = join(dir, "pcm.fifo");
  const errlog = join(dir, "tap.err");
  execFileSync("mkfifo", [fifo]);

  // Open the read end first so `open`'s write-end open rendezvous succeeds.
  const reader = createReadStream(fifo);
  reader.on("error", (e) => opts.onError?.(e));

  // Kill any stale instance, then launch via LaunchServices for the TCC identity.
  try { execFileSync("pkill", ["-f", PROC_MATCH]); } catch { /* none running */ }
  spawn("open", ["--stdout", fifo, "--stderr", errlog, APP], { stdio: "ignore", detached: true }).unref();

  const sampleRate = await waitForReady(errlog, opts.onAuthError);

  return {
    sampleRate,
    channels: 1,
    onData(cb) {
      reader.on("data", (b) => cb(b as Buffer));
    },
    stop() {
      try { execFileSync("pkill", ["-f", PROC_MATCH]); } catch { /* already gone */ }
      reader.destroy();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
