/**
 * Packaged one-time setup for the Otto Call Agent (macOS).
 *
 *   npm run setup
 *
 * - verifies ffmpeg / sox / brew
 * - installs switchaudio-osx (for output switching) if missing
 * - checks BlackHole 2ch + 16ch are installed (else tells you the brew command)
 * - creates the "Otto Monitor" multi-output device (your output + BlackHole 2ch)
 *   via a CoreAudio helper — falls back to printed Audio MIDI Setup steps
 * - writes the detected device names into .env
 * - prints the single manual step: set your call app's mic to BlackHole 16ch
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
    else { warn(`${tool} missing — install with: brew install ${tool}`); }
  }
  const brew = await has("brew");
  brew ? ok("brew") : warn("Homebrew missing — install from https://brew.sh");

  step("2. Output switching (switchaudio-osx)");
  if (await has("SwitchAudioSource")) ok("SwitchAudioSource");
  else if (brew) {
    console.log("  installing switchaudio-osx…");
    const r = await run("brew", ["install", "switchaudio-osx"]);
    r.code === 0 ? ok("installed") : warn(`install failed: ${r.err.split("\n").slice(-1)[0]}`);
  } else warn("install with: brew install switchaudio-osx");

  step("3. BlackHole virtual devices");
  const inputs = await listInputDevices();
  const names = inputs.map((d) => d.name);
  const has2 = names.some((n) => /blackhole 2ch/i.test(n));
  const has16 = names.some((n) => /blackhole 16ch/i.test(n));
  has2 ? ok("BlackHole 2ch") : warn("BlackHole 2ch missing — brew install blackhole-2ch");
  has16 ? ok("BlackHole 16ch") : warn("BlackHole 16ch missing — brew install blackhole-16ch");

  const mic = names.find((n) => /microphone/i.test(n) && !/blackhole/i.test(n)) ?? names.find((n) => !/blackhole/i.test(n)) ?? "MacBook Air Microphone";
  ok(`your mic detected as: "${mic}"`);

  step("4. Monitor device (so you hear the call while we capture it)");
  const ROUTE_DEVICE = "Otto Monitor";
  const currentOut = (await route.currentOutput()) ?? "MacBook Air Speakers";
  const outs = await route.listOutputs();
  if ((await has("swiftc")) && has16) {
    // The helper destroys any prior "Otto Monitor" and rebuilds it around the
    // CURRENT output device — so re-running setup after changing headphones works.
    console.log(`  building "${ROUTE_DEVICE}" = [${currentOut} + BlackHole 16ch]…`);
    const swift = resolve(process.cwd(), "scripts/create-multi-output.swift");
    const bin = "/tmp/otto-mkdev";
    const c = await run("swiftc", [swift, "-o", bin, "-framework", "CoreAudio"]);
    if (c.code !== 0) {
      warn(`compile failed: ${c.err.split("\n").slice(-1)[0]}`);
      manualMonitorSteps(currentOut);
    } else {
      const r = await run(bin, [ROUTE_DEVICE, currentOut, "BlackHole 16ch"]);
      r.code === 0 ? ok(`built "${ROUTE_DEVICE}" around ${currentOut}`) : (warn(`build failed: ${r.err}`), manualMonitorSteps(currentOut));
    }
  } else if (outs.includes(ROUTE_DEVICE)) {
    ok(`"${ROUTE_DEVICE}" exists (install Xcode CLT to auto-rebuild it for a new output)`);
  } else {
    warn(await has("swiftc") ? "BlackHole 16ch needed first" : "Xcode command-line tools (swiftc) not found");
    manualMonitorSteps(currentOut);
  }

  step("5. Writing .env");
  updateEnv({
    MIC_DEVICE: mic,
    CALL_CAPTURE_DEVICE: "BlackHole 16ch",
    CALL_MIC_DEVICE: "BlackHole 2ch",
    MONITOR_DEVICE: currentOut,
    ROUTE_DEVICE,
  });
  ok("device config saved to .env");

  console.log(`
Done. To use Otto on a call:

  1. In your call app (Zoom/Meet/Teams), set the MICROPHONE to:  BlackHole 2ch
  2. Use HEADPHONES (so Otto's voice isn't echoed back into the call).
  3. Start the agent:  npm run dev
     (it routes your system output through "${ROUTE_DEVICE}" automatically, and restores it on exit)

Then anyone on the call can say "Otto, …" and everyone will hear the reply.
`);
}

function manualMonitorSteps(currentOut: string): void {
  console.log(`
  → Create it manually (one time) in Audio MIDI Setup:
      • Open "Audio MIDI Setup"  (Applications ▸ Utilities)
      • Click  +  (bottom-left) ▸ "Create Multi-Output Device"
      • Tick:  ${currentOut}  AND  BlackHole 16ch
      • Rename it to:  Otto Monitor`);
}

void main();
