/**
 * Drives the real dashboard UI with a scripted, looping meeting so we can record
 * a demo GIF. Not part of the app — just for capturing visuals.
 *
 *   npx tsx src/record-demo.ts      # serves the dashboard on UI_PORT (4848)
 *
 * It writes a few throwaway transcript files to a temp notes dir (so the sidebar
 * looks like a real account) and loops one natural question→answer exchange,
 * cycling Otto's state listening → thinking → speaking so the GIF lands on a reply.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUI } from "./ui.js";

const notesDir = mkdtempSync(join(tmpdir(), "otto-demo-"));
const LIVE_ID = "2026-06-10T15-40-00-000Z-meeting.md";

// A couple of past meetings so the sidebar isn't empty.
writeFileSync(
  join(notesDir, "2026-06-08T10-02-00-000Z-meeting.md"),
  "# Meeting — Q3 launch sync\n\n**Priya:** Are we still targeting the 15th?\n\n**Marcus:** Yes, pending sign-off.\n",
);
writeFileSync(join(notesDir, "2026-06-08T10-02-00-000Z-summary.md"), "## Summary\n\nLaunch on track for the 15th.\n");
writeFileSync(
  join(notesDir, "2026-06-05T14-30-00-000Z-meeting.md"),
  "# Meeting — Pricing review\n\n**You:** Let's revisit the tiers.\n\n**Priya:** Agreed.\n",
);
writeFileSync(join(notesDir, "2026-06-05T14-30-00-000Z-summary.md"), "## Summary\n\nTiers to be revisited next week.\n");
// The live meeting (so it shows in the sidebar with a pulsing live dot).
writeFileSync(join(notesDir, LIVE_ID), "# Call — now\n\n**Priya:** Hi everyone.\n\n**Marcus:** Morning.\n");

const ui = startUI(
  Number(process.env.UI_PORT || 4848),
  { agentName: "Otto", callMic: "BlackHole 2ch", monitor: "default" },
  { notesDir },
);
console.log(`demo dashboard → ${ui.url}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  for (;;) {
    ui.emit({ type: "reset" });
    ui.emit({ type: "session", active: true, id: LIVE_ID });
    ui.emit({ type: "state", state: "listening" });
    await wait(1500);

    ui.emit({ type: "line", kind: "speech", speaker: "Priya", text: "Okay, before we wrap up, did we ever lock in a date for the customer webinar?" });
    await wait(3600);
    ui.emit({ type: "line", kind: "speech", speaker: "Marcus", text: "I think we said the 20th, but I'm not totally sure it got confirmed." });
    await wait(3600);
    ui.emit({ type: "line", kind: "speech", speaker: "You", text: "Otto, when did we decide the webinar was?" });
    await wait(2200);

    ui.emit({ type: "state", state: "thinking" });
    await wait(2200);
    ui.emit({ type: "state", state: "speaking" });
    ui.emit({ type: "line", kind: "agent", speaker: "Otto", text: "You set it for Thursday the 20th in last week's planning call, right after the budget sign off." });
    await wait(6000);

    ui.emit({ type: "state", state: "listening" });
    await wait(3000);
  }
}
void loop();
