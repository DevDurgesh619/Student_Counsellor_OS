/**
 * Per-million-token pricing in USD. Anthropic publishes these on their
 * pricing page; update when they change. Pinned to the model IDs we actually
 * use (CLAUDE_CODE.md §4).
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

function normalizeModel(model: string): string {
  // Strip Anthropic's date suffix (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
  return model.replace(/-\d{8}$/, '');
}

export const USD_TO_INR = 83;

export function computeCost(
  model: string,
  tokensInput: number,
  tokensOutput: number,
): { usd: number; inr: number } {
  const p = PRICING[normalizeModel(model)] ?? PRICING['claude-sonnet-4-6']!;
  const usd = (tokensInput * p.input + tokensOutput * p.output) / 1_000_000;
  return { usd, inr: usd * USD_TO_INR };
}
