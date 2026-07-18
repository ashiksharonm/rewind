import type { Usage } from './types.js';

// USD per million tokens.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICING: Record<string, Rates> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const DEFAULT_RATES = PRICING['claude-opus-4-8'];

export function costUsd(model: string, usage: Usage): number {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  const r = key ? PRICING[key] : DEFAULT_RATES;
  const perTok = (n: number, rate: number) => (n * rate) / 1_000_000;
  return (
    perTok(usage.inputTokens, r.input) +
    perTok(usage.outputTokens, r.output) +
    perTok(usage.cacheReadTokens, r.cacheRead) +
    perTok(usage.cacheWriteTokens, r.cacheWrite)
  );
}
