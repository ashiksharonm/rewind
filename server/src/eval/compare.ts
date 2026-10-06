// Timeline diff: given two evaluations under the same spec (typically a parent
// and one of its forks), report which metrics B improved or regressed vs A.
import type { Run } from '../types.js';
import type { EvalReport } from './trajectory.js';

export type Direction = 'higher' | 'lower';
export type Verdict = 'improved' | 'regressed' | 'unchanged' | 'n/a';

export interface MetricDelta {
  metric: string;
  direction: Direction;
  a: number | null;
  b: number | null;
  delta: number | null;
  verdict: Verdict;
}

export interface TimelineDiff {
  metrics: MetricDelta[];
  improved: string[];
  regressed: string[];
  /** Overall pass/fail transition from A to B. */
  passFlip: 'fixed' | 'broke' | 'still-passing' | 'still-failing';
}

const EPS = 1e-9;

function metric(name: string, direction: Direction, a: number | null, b: number | null): MetricDelta {
  if (a === null || b === null) return { metric: name, direction, a, b, delta: null, verdict: 'n/a' };
  const delta = b - a;
  const verdict: Verdict =
    Math.abs(delta) < EPS ? 'unchanged' : (delta > 0) === (direction === 'higher') ? 'improved' : 'regressed';
  return { metric: name, direction, a, b, delta, verdict };
}

const bool = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

function outcomeRate(r: EvalReport): number | null {
  if (!r.outcome.checked || r.outcome.checks.length === 0) return null;
  return r.outcome.checks.filter((c) => c.passed).length / r.outcome.checks.length;
}

/**
 * Diff two evaluation reports. Token and cost metrics come from the runs'
 * recorded metrics when provided (they are not part of the trajectory score).
 */
export function diffEvaluations(
  a: EvalReport,
  b: EvalReport,
  runs?: { a?: Run['metrics']; b?: Run['metrics'] },
): TimelineDiff {
  const metrics: MetricDelta[] = [
    metric('pass', 'higher', bool(a.pass), bool(b.pass)),
    metric('trajectory.matched', 'higher', bool(a.trajectory?.matched), bool(b.trajectory?.matched)),
    metric('trajectory.precision', 'higher', a.trajectory?.precision ?? null, b.trajectory?.precision ?? null),
    metric('trajectory.recall', 'higher', a.trajectory?.recall ?? null, b.trajectory?.recall ?? null),
    metric('trajectory.f1', 'higher', a.trajectory?.f1 ?? null, b.trajectory?.f1 ?? null),
    metric('outcome.checksPassedRate', 'higher', outcomeRate(a), outcomeRate(b)),
    metric('efficiency.callEfficiency', 'higher', a.efficiency.callEfficiency, b.efficiency.callEfficiency),
    metric('efficiency.steps', 'lower', a.efficiency.steps, b.efficiency.steps),
    metric('efficiency.toolCalls', 'lower', a.efficiency.toolCalls, b.efficiency.toolCalls),
    metric('efficiency.redundantCalls', 'lower', a.efficiency.redundantCalls, b.efficiency.redundantCalls),
    metric('errors.toolErrors', 'lower', a.errors.toolErrors, b.errors.toolErrors),
    metric('errors.retries', 'lower', a.errors.retries, b.errors.retries),
    metric('forbidden.calls', 'lower', a.forbidden.calls, b.forbidden.calls),
  ];
  if (runs?.a && runs?.b) {
    metrics.push(
      metric(
        'tokens.total',
        'lower',
        runs.a.inputTokens + runs.a.outputTokens,
        runs.b.inputTokens + runs.b.outputTokens,
      ),
      metric('costUsd', 'lower', runs.a.costUsd, runs.b.costUsd),
    );
  }
  const passFlip = a.pass
    ? b.pass
      ? 'still-passing'
      : 'broke'
    : b.pass
      ? 'fixed'
      : 'still-failing';
  return {
    metrics,
    improved: metrics.filter((m) => m.verdict === 'improved').map((m) => m.metric),
    regressed: metrics.filter((m) => m.verdict === 'regressed').map((m) => m.metric),
    passFlip,
  };
}
