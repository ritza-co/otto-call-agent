/**
 * Local UI server. Serves a single static page, pushes live events over SSE, and
 * exposes a small control + history API:
 *   GET  /events               live event stream (SSE)
 *   POST /control/start        start a session (agent listens)
 *   POST /control/end          end the session (agent stops listening)
 *   GET  /devices              list available audio input devices
 *   POST /control/mic?device=  hot-switch the mic input device
 *   GET  /sessions             list saved session transcripts
 *   GET  /session?id=FILE      one transcript's markdown (for viewing)
 *   GET  /download?id=FILE     one transcript as a downloadable .md
 */
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type AgentState = "listening" | "thinking" | "speaking";

export type UiEvent =
  | { type: "meta"; agentName: string; callMic: string; monitor: string; activeMic?: string }
  | { type: "state"; state: AgentState }
  | { type: "session"; active: boolean; id?: string } // session started/ended
  | { type: "muted"; muted: boolean } // your mic muted into Otto + the call
  | { type: "reset" } // clear the live feed (new session)
  | { type: "line"; kind: "speech" | "agent"; speaker: string; text: string; searched?: boolean; sources?: string[] };

export interface UIHandlers {
  notesDir?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onMute?: (muted: boolean) => void;
  onMicSwitch?: (device: string) => Promise<void>;
  onSummarize?: (transcript: string) => Promise<string>;
  listDevices?: () => Promise<{ index: number; name: string }[]>;
}

export interface UI {
  emit(event: UiEvent): void;
  url: string;
}

const SESSION_FILE = /-meeting\.md$/;
const summaryFileFor = (id: string) => id.replace(/-meeting\.md$/, "-summary.md");

function listSessions(notesDir: string) {
  if (!notesDir || !existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((f) => SESSION_FILE.test(f))
    .map((f) => {
      const full = join(notesDir, f);
      let title = f;
      let lines = 0;
      try {
        const text = readFileSync(full, "utf8");
        title = (text.split("\n", 1)[0] || "").replace(/^#\s*/, "").trim() || f;
        lines = (text.match(/^\*\*/gm) || []).length; // counts attributed utterances
      } catch {
        /* keep filename */
      }
      const m = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      const date = m ? `${m[1]} ${m[2]}:${m[3]}` : "";
      let kb = 0;
      try {
        kb = Math.max(1, Math.round(statSync(full).size / 1024));
      } catch {
        /* 0 */
      }
      return { id: f, title, date, kb, lines, hasSummary: existsSync(join(notesDir, summaryFileFor(f))) };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
}

/** Validate a requested session id and return its absolute path, or null. */
function sessionPath(notesDir: string, id: string | null): string | null {
  if (!notesDir || !id || basename(id) !== id || !SESSION_FILE.test(id)) return null;
  const full = join(resolve(notesDir), id);
  return existsSync(full) ? full : null;
}

function readSummary(notesDir: string, id: string): string | null {
  const p = join(resolve(notesDir), summaryFileFor(id));
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function startUI(port: number, meta: { agentName: string; callMic: string; monitor: string; activeMic?: string }, handlers: UIHandlers = {}): UI {
  const indexPath = resolve(process.cwd(), "public/index.html");
  const notesDir = handlers.notesDir ? resolve(handlers.notesDir) : "";
  const clients = new Set<ServerResponse>();
  const metaEvent: UiEvent = { type: "meta", ...meta };
  let lastState: UiEvent = { type: "state", state: "listening" };
  let lastSession: UiEvent = { type: "session", active: true };
  let lastMuted: UiEvent = { type: "muted", muted: false };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      for (const ev of [metaEvent, lastSession, lastMuted, lastState]) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && path === "/control/start") {
      handlers.onStart?.();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/control/end") {
      handlers.onEnd?.();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/control/mute") {
      handlers.onMute?.(url.searchParams.get("on") === "true");
      return json(res, 200, { ok: true });
    }
    if (path === "/devices") {
      const all = await handlers.listDevices?.() ?? [];
      // Exclude the call-mic passthrough device — it's an output cable, not a real input.
      const callMicLower = meta.callMic.toLowerCase();
      const devices = all.filter((d) => d.name.toLowerCase() !== callMicLower);
      return json(res, 200, devices);
    }
    if (req.method === "POST" && path === "/control/mic") {
      const device = url.searchParams.get("device") ?? "";
      if (!device || !handlers.onMicSwitch) return json(res, 400, { error: "missing device" });
      handlers.onMicSwitch(device)
        .then(() => json(res, 200, { ok: true, device }))
        .catch((e) => json(res, 500, { error: String(e?.message || e) }));
      return;
    }
    if (path === "/sessions") {
      return json(res, 200, listSessions(notesDir));
    }
    if (path === "/session") {
      const p = sessionPath(notesDir, url.searchParams.get("id"));
      if (!p) return json(res, 404, { error: "not found" });
      const id = basename(p);
      return json(res, 200, { id, content: readFileSync(p, "utf8"), summary: readSummary(notesDir, id) });
    }
    if (path === "/summary") {
      const p = sessionPath(notesDir, url.searchParams.get("id"));
      if (!p) return json(res, 404, { error: "not found" });
      return json(res, 200, { summary: readSummary(notesDir, basename(p)) });
    }
    if (req.method === "POST" && path === "/summarize") {
      const p = sessionPath(notesDir, url.searchParams.get("id"));
      if (!p || !handlers.onSummarize) return json(res, 404, { error: "not found" });
      const id = basename(p);
      void handlers
        .onSummarize(readFileSync(p, "utf8"))
        .then((summary) => {
          writeFileSync(join(resolve(notesDir), summaryFileFor(id)), summary);
          json(res, 200, { summary });
        })
        .catch((e) => json(res, 500, { error: String(e?.message || e) }));
      return;
    }
    if (path === "/download") {
      const p = sessionPath(notesDir, url.searchParams.get("id"));
      if (!p) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${basename(p)}"`,
      });
      return res.end(readFileSync(p));
    }

    // SPA: serve the page for anything else (query strings ok).
    if (existsSync(indexPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(indexPath));
    } else {
      res.writeHead(500);
      res.end("UI not found at public/index.html");
    }
  });
  server.listen(port);

  setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15000).unref();

  return {
    url: `http://localhost:${port}`,
    emit(event: UiEvent) {
      if (event.type === "state") lastState = event;
      if (event.type === "session") lastSession = event;
      if (event.type === "muted") lastMuted = event;
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of clients) c.write(data);
    },
  };
}
