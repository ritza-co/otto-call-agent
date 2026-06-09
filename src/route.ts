/**
 * System audio output routing via `SwitchAudioSource` (brew install switchaudio-osx).
 *
 * While a session runs we point the system output at the "Otto Monitor" device
 * (a Multi-Output: your real output + BlackHole 2ch) so you keep hearing the call
 * AND we capture it. On exit we restore your previous output. All functions
 * degrade gracefully if SwitchAudioSource or the device isn't present.
 */
import { spawn } from "node:child_process";

function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("SwitchAudioSource", args);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
    p.on("error", () => resolve({ ok: false, out: "" }));
  });
}

export async function available(): Promise<boolean> {
  return (await run(["-t", "output", "-c"])).ok;
}

export async function currentOutput(): Promise<string | null> {
  const { ok, out } = await run(["-t", "output", "-c"]);
  return ok && out ? out : null;
}

export async function listOutputs(): Promise<string[]> {
  const { ok, out } = await run(["-t", "output", "-a"]);
  return ok ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export async function setOutput(name: string): Promise<boolean> {
  return (await run(["-t", "output", "-s", name])).ok;
}
