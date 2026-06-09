/**
 * Shared call transcript, attributed by speaker label, persisted to disk live as
 * Markdown. Also reads the archive of past meetings so Otto can answer questions
 * about previous calls.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export class TranscriptStore {
  readonly utterances: { speaker: string; text: string }[] = [];
  readonly participants = new Set<string>();
  private readonly notesDir: string;
  private readonly filePath: string;
  private readonly fileName: string;

  constructor(notesDir: string, startedAtISO: string, title = "Meeting") {
    this.notesDir = notesDir;
    mkdirSync(notesDir, { recursive: true });
    const stamp = startedAtISO.replace(/[:.]/g, "-");
    this.fileName = `${stamp}-meeting.md`;
    this.filePath = join(notesDir, this.fileName);
    writeFileSync(this.filePath, `# ${title} — ${startedAtISO}\n\n`);
  }

  add(speaker: string, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.utterances.push({ speaker, text: clean });
    this.participants.add(speaker);
    appendFileSync(this.filePath, `**${speaker}:** ${clean}\n\n`);
  }

  /** Current call as plain text for the LLM. */
  asText(): string {
    return this.utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
  }

  /** Concatenated text of PAST meetings (excludes the current file), newest last, truncated. */
  loadArchive(maxChars = 20000): string {
    if (!existsSync(this.notesDir)) return "";
    const files = readdirSync(this.notesDir)
      .filter((f) => f.endsWith("-meeting.md") && f !== this.fileName)
      .sort();
    let out = "";
    for (const f of files) out += `\n--- ${f} ---\n${readFileSync(join(this.notesDir, f), "utf8")}\n`;
    return out.length > maxChars ? out.slice(-maxChars) : out;
  }

  get savedAt(): string {
    return this.filePath;
  }
}
