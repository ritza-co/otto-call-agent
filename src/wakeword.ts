/**
 * Wake-word detection by watching the transcript. When a finalized utterance
 * contains the agent's name, the text after it is the question. Fuzzy-matches the
 * name to survive small STT errors ("Otto" / "Auto" / "Oto").
 */
const FILLER = new Set(["hey", "ok", "okay", "hi", "hello", "yo", "uh", "um"]);

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function matchesName(token: string, name: string): boolean {
  if (!token) return false;
  if (token === name) return true;
  const tolerance = name.length >= 6 ? 2 : 1;
  return levenshtein(token, name) <= tolerance;
}

export class WakeWord {
  private readonly name: string;

  constructor(agentName: string) {
    this.name = normalize(agentName);
  }

  private findNameIndex(tokens: string[]): number {
    for (let i = 0; i < tokens.length; i++) {
      if (i <= 2 && FILLER.has(tokens[i])) continue;
      if (matchesName(tokens[i], this.name)) return i;
      if (i >= 3) break;
    }
    return -1;
  }

  contains(text: string): boolean {
    return this.findNameIndex(text.split(/\s+/).filter(Boolean).map(normalize)) >= 0;
  }

  extract(text: string): string | null {
    const rawTokens = text.split(/\s+/).filter(Boolean);
    const idx = this.findNameIndex(rawTokens.map(normalize));
    if (idx < 0) return null;
    const rest = rawTokens
      .slice(idx + 1)
      .join(" ")
      .replace(/^[\s,.:;-]+/, "")
      .trim();
    return rest.length > 0 ? rest : null;
  }
}
