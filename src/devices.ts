/**
 * Audio device discovery on macOS via ffmpeg's avfoundation device list.
 *
 * ffmpeg identifies capture (input) devices by index; we let users name devices
 * in .env (e.g. "BlackHole 2ch") and resolve them to the right index here.
 *
 * Run directly to print the device list:  npm run devices
 */
import { spawn } from "node:child_process";

export interface AudioDevice {
  index: number;
  name: string;
}

/** Parse `ffmpeg -f avfoundation -list_devices true -i ""` for audio input devices. */
export async function listInputDevices(): Promise<AudioDevice[]> {
  const stderr = await new Promise<string>((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let buf = "";
    p.stderr.on("data", (d) => (buf += d.toString()));
    p.on("close", () => resolve(buf));
    p.on("error", () => resolve(buf));
  });

  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices:/.test(line)) {
      inAudio = true;
      continue;
    }
    if (inAudio) {
      const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
      if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
      else if (/AVFoundation video devices:/.test(line)) inAudio = false;
    }
  }
  return devices;
}

/** Resolve a device spec (an index, exact name, or substring) to its ffmpeg index. */
export async function resolveInputIndex(spec: string): Promise<number> {
  if (/^\d+$/.test(spec.trim())) return Number(spec.trim());
  const devices = await listInputDevices();
  const needle = spec.trim().toLowerCase();
  const exact = devices.find((d) => d.name.toLowerCase() === needle);
  if (exact) return exact.index;
  const partial = devices.find((d) => d.name.toLowerCase().includes(needle));
  if (partial) return partial.index;
  throw new Error(`Audio input device not found: "${spec}". Available: ${devices.map((d) => `[${d.index}] ${d.name}`).join(", ")}`);
}

// CLI: print the device table.
if (import.meta.url === `file://${process.argv[1]}`) {
  listInputDevices().then((devices) => {
    console.log("Audio input devices (use these names in .env):\n");
    for (const d of devices) console.log(`  [${d.index}]  ${d.name}`);
    console.log("\nOutput devices (for MONITOR_DEVICE / CALL_MIC playback) are named the same in CoreAudio.");
  });
}
