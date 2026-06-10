/**
 * Packaged one-time setup for the Otto Call Agent (macOS).
 *
 *   npm run setup
 *
 * - verifies ffmpeg (mic capture) / sox (Otto's voice playback) / brew
 * - checks BlackHole 2ch is installed (the only virtual device Otto needs — it's
 *   how Otto's voice is injected into the call's mic; else prints the brew command)
 * - builds the system-audio tap bundle (bin/OttoTap.app) via scripts/build-tap.sh
 * - writes the detected device names into .env
 *
 * Otto captures the call's audio with a CoreAudio process tap, so it NEVER changes
 * your system output or any audio device — there is no Multi-Output device and no
 * output switching. You keep hearing the call natively. The only manual steps are
 * granting the tap permission once and pointing the call app's mic at BlackHole 2ch.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listInputDevices } from "./devices.js";
import * as route from "./route.js";

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => res({ code: code ?? 1, out: out.trim(), err: err.trim() }));
    p.on("error", () => res({ code: 127, out: "", err: "not found" }));
  });
}

async function has(cmd: string): Promise<boolean> {
  return (await run("which", [cmd])).code === 0;
}

function updateEnv(updates: Record<string, string>): void {
  const path = resolve(process.cwd(), ".env");
  let lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.join("\n"));
}

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ⚠️  ${s}`);
const step = (s: string) => console.log(`\n${s}`);

async function main() {
  console.log("Otto Call Agent — setup\n=======================");

  step("1. Tooling");
  for (const tool of ["ffmpeg", "sox"]) {
    if (await has(tool)) ok(tool);
    else warn(`${tool} missing — install with: brew install ${tool}`);
  }
  const brew = await has("brew");
  brew ? ok("brew") : warn("Homebrew missing — install from https://brew.sh");

  step("2. BlackHole virtual mic (for injecting Otto's voice into the call)");
  const inputs = await listInputDevices();
  const names = inputs.map((d) => d.name);
  const has2 = names.some((n) => /blackhole 2ch/i.test(n));
  has2 ? ok("BlackHole 2ch") : warn("BlackHole 2ch missing — brew install blackhole-2ch");

  const mic =
    names.find((n) => /microphone/i.test(n) && !/blackhole/i.test(n)) ??
    names.find((n) => !/blackhole/i.test(n)) ??
    "MacBook Air Microphone";
  ok(`your mic detected as: "${mic}"`);

  step("3. System-audio tap (captures the call without touching your audio devices)");
  if (await has("swiftc")) {
    const r = await run("bash", ["scripts/build-tap.sh"]);
    r.code === 0 ? ok("built bin/OttoTap.app") : warn(`build failed: ${r.err.split("\n").slice(-1)[0]}`);
  } else {
    warn("Xcode command-line tools (swiftc) not found — run: xcode-select --install, then: npm run build:tap");
  }

  step("4. Writing .env");
  const currentOut = (await route.currentOutput()) ?? "MacBook Air Speakers";
  updateEnv({
    MIC_DEVICE: mic,
    CALL_MIC_DEVICE: "BlackHole 2ch",
    MONITOR_DEVICE: currentOut, // where Otto's spoken replies are played back to you
  });
  ok("device config saved to .env");

  console.log(`
Done. Two one-time steps, then you're live:

  1. Grant the tap permission:  npm run tap:grant
     (click "Allow" on the macOS dialog — this lets Otto hear the call)
  2. In your call app (Zoom/Meet/Teams), set the MICROPHONE to:  BlackHole 2ch
     (this is how Otto's voice reaches everyone on the call)

Then:

  • Use HEADPHONES (so Otto's spoken replies aren't echoed back into the call).
  • Start the agent:  npm run dev

Your system output is never changed — you keep hearing the call exactly as normal.
Anyone on the call can say "Otto, …" and everyone will hear the reply.

To remove everything later:  npm run teardown
`);
}

void main();
