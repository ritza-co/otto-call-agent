/**
 * The answering brain (provider-abstracted; OpenAI by default).
 *
 * Abilities:
 *  - Answers questions about the current call (live transcript) and about your
 *    saved meeting notes archive.
 *  - Web search when the answer needs current/external info.
 *  - Context-aware: stays silent (NORESPONSE) when it wasn't genuinely addressed.
 */

export interface AnswerInput {
  agentName: string;
  /** Current call transcript. */
  transcript: string;
  /** The triggering utterance / best-guess question. */
  question: string;
  /** Known speaker labels in the call. */
  participants: string[];
  /** Concatenated text of past saved meetings (optional, for cross-meeting recall). */
  notesArchive?: string;
}

export interface AnswerResult {
  respond: boolean;
  text: string;
  searched: boolean;
  sources: string[];
}

const NO_RESPONSE = "NORESPONSE";

function systemPrompt(agentName: string): string {
  return [
    `You are ${agentName}, a real-time voice assistant listening to a live call. You are NOT one of the human participants.`,
    `You are invoked whenever someone says your name, but hearing your name does NOT always mean someone wants an answer.`,
    `Decide from context whether the latest line is genuinely a question or request directed at YOU. If it is NOT — a thank-you, a greeting, a passing mention, or one person talking to another participant — reply with exactly "${NO_RESPONSE}" and nothing else.`,
    `When it IS a real request: answer using the call transcript when it's about the call, your saved notes when it's about past meetings, or general knowledge otherwise.`,
    `You can search the web. Use it ONLY when the answer needs current/external info (news, prices, weather, scores, recent events). Don't search for things you already know.`,
    `Be extremely concise — one short spoken sentence, at most one useful fact. Your reply is spoken aloud to everyone on the call: no markdown, no URLs/citations, no preamble.`,
    `Examples:`,
    `"${agentName}, what did we decide about pricing?" -> "You agreed on $40 per seat per month."`,
    `"Thanks, ${agentName}." -> "${NO_RESPONSE}"`,
    `Match that brevity. Never pad the answer.`,
  ].join(" ");
}

function userPrompt(input: AnswerInput): string {
  const others = input.participants.filter((p) => p.toLowerCase() !== input.agentName.toLowerCase());
  const parts = [`Speakers on the call (besides you): ${others.join(", ") || "unknown"}.`, ``];
  if (input.notesArchive && input.notesArchive.trim()) {
    parts.push(`Notes from previous meetings:`, input.notesArchive.trim(), ``);
  }
  parts.push(
    `Current call transcript:`,
    input.transcript || "(nothing has been said yet)",
    ``,
    `The latest thing said, which mentioned you or followed your name: "${input.question}"`,
    `If that is genuinely a question or request for you, answer it. Otherwise reply "${NO_RESPONSE}".`,
  );
  return parts.join("\n");
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

function domainsFromUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!out.includes(host)) out.push(host);
    } catch {
      /* skip */
    }
  }
  return out.slice(0, 3);
}

function isNoResponse(text: string): boolean {
  return new RegExp(`^\\s*"?${NO_RESPONSE}`, "i").test(text);
}

export interface LLMProvider {
  answer(input: AnswerInput): Promise<AnswerResult>;
}

class OpenAIProvider implements LLMProvider {
  private clientPromise: Promise<any> | null = null;
  private readonly model = process.env.LLM_MODEL || "gpt-4o-mini";

  private async client() {
    if (!this.clientPromise) {
      const pkg = "openai";
      this.clientPromise = import(pkg).then(({ default: OpenAI }) => new OpenAI());
    }
    return this.clientPromise;
  }

  async answer(input: AnswerInput): Promise<AnswerResult> {
    const client = await this.client();
    const res = await client.responses.create({
      model: this.model,
      instructions: systemPrompt(input.agentName),
      input: userPrompt(input),
      max_output_tokens: 400,
      tools: [{ type: "web_search" }],
    });
    const raw: string = res.output_text ?? "";
    if (isNoResponse(raw)) return { respond: false, text: "", searched: false, sources: [] };
    const urls = [...raw.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    const searched = (res.output ?? []).some((o: any) => o?.type === "web_search_call") || urls.length > 0;
    return { respond: true, text: cleanForSpeech(raw), searched, sources: domainsFromUrls(urls) };
  }
}

class AnthropicProvider implements LLMProvider {
  private clientPromise: Promise<any> | null = null;
  private readonly model = process.env.LLM_MODEL || "claude-sonnet-4-6";

  private async client() {
    if (!this.clientPromise) {
      // Optional dependency — only present if you switch to LLM_PROVIDER=anthropic
      // (run: npm install @anthropic-ai/sdk). Non-literal specifier keeps TS happy.
      const pkg = "@anthropic-ai/sdk";
      this.clientPromise = import(pkg).then(({ default: Anthropic }) => new Anthropic());
    }
    return this.clientPromise;
  }

  async answer(input: AnswerInput): Promise<AnswerResult> {
    const client = await this.client();
    const res = await client.messages.create({
      model: this.model,
      max_tokens: 400,
      system: systemPrompt(input.agentName),
      messages: [{ role: "user", content: userPrompt(input) }],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    });
    const blocks: any[] = res.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    if (isNoResponse(text)) return { respond: false, text: "", searched: false, sources: [] };
    const searched = blocks.some((b) => typeof b.type === "string" && b.type.includes("web_search"));
    const urls: string[] = [];
    for (const b of blocks) if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) if (c?.url) urls.push(c.url);
    return { respond: true, text: cleanForSpeech(text), searched, sources: domainsFromUrls(urls) };
  }
}

/**
 * Standalone web search via OpenAI's Responses API web_search tool. Returns
 * clean, speakable text (no URLs/citations).
 */
let openaiClient: any = null;
export async function searchWeb(query: string): Promise<string> {
  if (!openaiClient) {
    const pkg = "openai";
    const { default: OpenAI } = await import(pkg);
    openaiClient = new OpenAI();
  }
  const res = await openaiClient.responses.create({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    instructions: "Answer in one short, spoken sentence. No URLs, citations, or markdown.",
    input: query,
    max_output_tokens: 300,
    tools: [{ type: "web_search" }],
  });
  return cleanForSpeech(res.output_text ?? "");
}

/**
 * Summarize a meeting transcript into clean, factual Markdown sections. Used by
 * the dashboard's "Summarize meeting" action. Returns markdown text.
 */
export async function summarizeMeeting(transcript: string): Promise<string> {
  if (!transcript || transcript.trim().length < 40) {
    return "_Not enough was said in this meeting to summarize._";
  }
  if (!openaiClient) {
    const pkg = "openai";
    const { default: OpenAI } = await import(pkg);
    openaiClient = new OpenAI();
  }
  const res = await openaiClient.responses.create({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    instructions: [
      "You summarize meeting transcripts. Output clean GitHub-flavored Markdown with EXACTLY these sections, in order:",
      "## Summary — 2–3 sentences.",
      "## Key points — short bullets.",
      "## Decisions — bullets, or 'None.' if there were none.",
      "## Action items — bullets as 'Owner — task' when an owner is clear, else just the task; or 'None.'",
      "Be concise and strictly factual — do not invent anything not in the transcript.",
    ].join("\n"),
    input: transcript,
    max_output_tokens: 700,
  });
  return (res.output_text ?? "").trim() || "_Could not generate a summary._";
}

export function createLLM(): LLMProvider {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "anthropic") return new AnthropicProvider();
  if (provider === "openai") return new OpenAIProvider();
  throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
}
