/**
 * Minimal local UI server. Serves a single static page and pushes events to it
 * over Server-Sent Events (one-way; the UI is display-only, so no WebSocket /
 * extra deps needed). The agent calls emit() as things happen.
 *
 * Run with --demo to preview the UI with a scripted event loop:  npm run ui:demo
 */
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AgentState = "listening" | "thinking" | "speaking";

export type UiEvent =
  | { type: "meta"; agentName: string; callMic: string; monitor: string }
  | { type: "state"; state: AgentState }
  | { type: "line"; kind: "speech" | "agent"; speaker: string; text: string; searched?: boolean; sources?: string[] };

export interface UI {
  emit(event: UiEvent): void;
  url: string;
}

export function startUI(port: number, meta: { agentName: string; callMic: string; monitor: string }): UI {
  const indexPath = resolve(process.cwd(), "public/index.html");
  const clients = new Set<ServerResponse>();
  const metaEvent: UiEvent = { type: "meta", ...meta };
  let lastState: UiEvent = { type: "state", state: "listening" };

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      res.write(`data: ${JSON.stringify(metaEvent)}\n\n`);
      res.write(`data: ${JSON.stringify(lastState)}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    // Serve the page for any non-/events path (so ?preview query strings work).
    if (existsSync(indexPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(indexPath));
    } else {
      res.writeHead(500);
      res.end("UI not found at public/index.html");
    }
  });
  server.listen(port);

  // keep SSE connections alive through proxies/idle
  setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15000).unref();

  return {
    url: `http://localhost:${port}`,
    emit(event: UiEvent) {
      if (event.type === "state") lastState = event;
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of clients) c.write(data);
    },
  };
}

// --- demo mode -------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.UI_PORT || 4848);
  const ui = startUI(port, { agentName: "Otto", callMic: "BlackHole 2ch", monitor: "Otto Monitor" });
  console.log(`UI demo → ${ui.url}`);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    for (;;) {
      ui.emit({ type: "state", state: "listening" });
      ui.emit({ type: "line", kind: "speech", speaker: "Priya", text: "Okay, for the Q3 launch — still the 15th?" });
      await wait(2200);
      ui.emit({ type: "line", kind: "speech", speaker: "Marcus", text: "Yeah, pending the capital budget sign-off." });
      await wait(2400);
      ui.emit({ type: "line", kind: "speech", speaker: "You", text: "Otto, what's the USD to EUR rate right now?" });
      await wait(900);
      ui.emit({ type: "state", state: "thinking" });
      await wait(1600);
      ui.emit({ type: "line", kind: "agent", speaker: "Otto", text: "It's about 1.08 dollars per euro.", searched: true, sources: ["xe.com"] });
      ui.emit({ type: "state", state: "speaking" });
      await wait(2600);
      ui.emit({ type: "state", state: "listening" });
      await wait(3000);
    }
  })();
}
