// `rewind diff`: align two runs step by step, find the first step where they
// diverge, and report per-step deltas (tokens, cost, latency) plus run totals.
// Alignment is by step index — it is exact up to the first divergence; steps
// after it are compared positionally and should be read as "what B did instead".
import type { LlmStep, Run, Step, ToolStep } from './types.js';

export type Change = 'same' | 'prompt' | 'text' | 'tool_requests' | 'tool_name' | 'tool_input' | 'tool_result' | 'kind' | 'only_a' | 'only_b';

export interface StepDelta {
  index: number;
  kindA: Step['type'] | null;
  kindB: Step['type'] | null;
  change: Change;
  detail: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface RunDiff {
  a: { id: string; name: string };
  b: { id: string; name: string };
  identical: boolean;
  firstDivergence: StepDelta | null;
  steps: StepDelta[];
  totals: { metric: keyof Run['metrics']; a: number; b: number; delta: number }[];
}

const j = (v: unknown) => JSON.stringify(v);
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}...` : s);
const textOf = (s: LlmStep) => s.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const usesOf = (s: LlmStep) => s.content.flatMap((b) => (b.type === 'tool_use' ? [`${b.name}(${j(b.input)})`] : []));

function compare(a: Step, b: Step): { change: Change; detail: string } {
  if (a.type !== b.type) return { change: 'kind', detail: `${a.type} vs ${b.type}` };
  if (a.type === 'prompt' && b.type === 'prompt') {
    if (a.userMessage !== b.userMessage) return { change: 'prompt', detail: `user message differs` };
    if (a.system !== b.system) return { change: 'prompt', detail: `system prompt differs` };
  }
  if (a.type === 'llm_call' && b.type === 'llm_call') {
    const ua = usesOf(a).join(';');
    const ub = usesOf(b).join(';');
    if (ua !== ub) return { change: 'tool_requests', detail: `requested ${clip(ua || 'nothing')} vs ${clip(ub || 'nothing')}` };
    if (textOf(a) !== textOf(b)) return { change: 'text', detail: `A: "${clip(textOf(a))}" | B: "${clip(textOf(b))}"` };
  }
  if (a.type === 'tool_call' && b.type === 'tool_call') {
    const x: ToolStep = a;
    if (x.toolName !== b.toolName) return { change: 'tool_name', detail: `${x.toolName} vs ${b.toolName}` };
    if (j(x.input) !== j(b.input)) return { change: 'tool_input', detail: `${x.toolName} input ${clip(j(x.input))} vs ${clip(j(b.input))}` };
    if (x.result !== b.result || x.isError !== b.isError) return { change: 'tool_result', detail: `${x.toolName} result ${clip(x.result)} vs ${clip(b.result)}` };
  }
  return { change: 'same', detail: '' };
}

const tok = (s: Step | undefined) => (s?.type === 'llm_call' ? s.usage : { inputTokens: 0, outputTokens: 0 });
const cost = (s: Step | undefined) => (s?.type === 'llm_call' ? s.costUsd : 0);

export function diffRuns(a: { run: Run; steps: Step[] }, b: { run: Run; steps: Step[] }): RunDiff {
  const n = Math.max(a.steps.length, b.steps.length);
  const steps: StepDelta[] = [];
  for (let i = 0; i < n; i++) {
    const sa = a.steps[i];
    const sb = b.steps[i];
    const { change, detail } = sa && sb ? compare(sa, sb) : sa ? { change: 'only_a' as const, detail: `${sa.type} only in A` } : { change: 'only_b' as const, detail: `${sb!.type} only in B` };
    steps.push({
      index: i,
      kindA: sa?.type ?? null,
      kindB: sb?.type ?? null,
      change,
      detail,
      inputTokens: tok(sb).inputTokens - tok(sa).inputTokens,
      outputTokens: tok(sb).outputTokens - tok(sa).outputTokens,
      costUsd: cost(sb) - cost(sa),
      durationMs: (sb?.durationMs ?? 0) - (sa?.durationMs ?? 0),
    });
  }
  const firstDivergence = steps.find((s) => s.change !== 'same') ?? null;
  const keys = Object.keys(a.run.metrics) as (keyof Run['metrics'])[];
  return {
    a: { id: a.run.id, name: a.run.name },
    b: { id: b.run.id, name: b.run.name },
    identical: firstDivergence === null,
    firstDivergence,
    steps,
    totals: keys.map((k) => ({ metric: k, a: a.run.metrics[k], b: b.run.metrics[k], delta: b.run.metrics[k] - a.run.metrics[k] })),
  };
}

export function formatDiff(d: RunDiff): string {
  const out: string[] = [`A: ${d.a.name} (${d.a.id})`, `B: ${d.b.name} (${d.b.id})`, ''];
  out.push(
    d.firstDivergence
      ? `First divergence at step ${d.firstDivergence.index} [${d.firstDivergence.change}]: ${d.firstDivergence.detail}`
      : 'Runs are identical (no divergent step).',
  );
  out.push('', 'step  A->B                      change         d_in   d_out  d_ms');
  for (const s of d.steps) {
    const kinds = `${s.kindA ?? '-'}->${s.kindB ?? '-'}`;
    const sign = (v: number) => (v > 0 ? `+${v}` : String(v));
    out.push(`${String(s.index).padEnd(5)} ${kinds.padEnd(25)} ${(s.change === 'same' ? '=' : s.change).padEnd(14)} ${sign(s.inputTokens).padStart(5)}  ${sign(s.outputTokens).padStart(5)}  ${sign(s.durationMs).padStart(5)}`);
  }
  out.push('', 'totals (A, B, delta):');
  for (const t of d.totals) out.push(`  ${t.metric.padEnd(12)} ${String(+t.a.toFixed(6)).padStart(10)} ${String(+t.b.toFixed(6)).padStart(10)} ${(t.delta > 0 ? '+' : '') + +t.delta.toFixed(6)}`);
  return out.join('\n');
}
