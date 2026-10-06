// Trajectory evaluation: score a recorded run against an expected tool-call
// trajectory, plus reference-free checks (efficiency, errors, retries) and an
// outcome check on the final answer. Everything here is pure — it only reads
// the recorded steps — so it works identically on live and simulated traces,
// on a fork, or on a trace JSON exported from another instance.
import type { LlmStep, Run, Step, ToolStep } from '../types.js';

/**
 * How the actual tool-call sequence must line up with `expected`:
 *  - exact     → same calls, same order, nothing extra
 *  - in_order  → expected calls appear in order; extra calls are allowed
 *  - any_order → every expected call appears somewhere; order ignored
 * In `exact` and `in_order`, calls issued together in one parallel group
 * (one model turn) may appear in any order relative to each other — the
 * model emitted them simultaneously, so their listing order is not a decision.
 */
export type MatchMode = 'exact' | 'in_order' | 'any_order';

/**
 * How tool arguments are compared:
 *  - exact  → same keys and values
 *  - subset → every expected key is present with an equal value (extra keys ok)
 *  - ignore → tool name only
 * Strings compare trimmed and case-insensitively; numbers by value.
 */
export type ArgMatch = 'exact' | 'subset' | 'ignore';

export interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
  argMatch?: ArgMatch;
}

export interface OutcomeSpec {
  /** Case-insensitive substrings the final answer must contain. */
  mustContain?: string[];
  /** Case-insensitive substrings the final answer must not contain. */
  mustNotContain?: string[];
  /** Case-insensitive regular expressions the final answer must match. */
  matches?: string[];
}

export interface TrajectorySpec {
  expected: ExpectedCall[];
  match?: MatchMode;
  argMatch?: ArgMatch;
  forbiddenTools?: string[];
  maxSteps?: number;
  maxToolCalls?: number;
  outcome?: OutcomeSpec;
}

export interface ActualCall {
  index: number;
  group: number;
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  edited: boolean;
}

export interface OutcomeCheck {
  kind: 'mustContain' | 'mustNotContain' | 'matches';
  value: string;
  passed: boolean;
}

export interface EvalReport {
  runId: string | null;
  status: Run['status'] | 'unknown';
  trajectory: null | {
    mode: MatchMode;
    argMatch: ArgMatch;
    matched: boolean;
    expected: number;
    actual: number;
    truePositives: number;
    precision: number;
    recall: number;
    f1: number;
    missing: ExpectedCall[];
    unexpected: Array<{ index: number; tool: string; args: Record<string, unknown> }>;
  };
  efficiency: {
    steps: number;
    llmCalls: number;
    toolCalls: number;
    redundantCalls: number;
    /** expected / actual tool calls, capped at 1; null without an expected trajectory. */
    callEfficiency: number | null;
    withinBudget: boolean | null;
  };
  errors: {
    toolErrors: number;
    retries: number;
    runError: string | null;
  };
  outcome: {
    checked: boolean;
    passed: boolean | null;
    checks: OutcomeCheck[];
    finalAnswer: string;
  };
  forbidden: { calls: number; tools: string[] };
  /** Completed, trajectory matched, outcome/budget ok, no forbidden calls. */
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Tool calls in recorded order, tagged with their parallel-group number. */
export function extractToolCalls(steps: Step[]): ActualCall[] {
  const groupOf = new Map<string, number>();
  let group = -1;
  const calls: ActualCall[] = [];
  for (const s of [...steps].sort((a, b) => a.index - b.index)) {
    if (s.type === 'llm_call') groupOf.set(s.id, ++group);
    if (s.type === 'tool_call') {
      calls.push({
        index: s.index,
        group: groupOf.get(s.llmStepId) ?? ++group,
        tool: s.toolName,
        args: s.input,
        isError: s.isError,
        edited: Boolean(s.edited),
      });
    }
  }
  return calls;
}

/** Text of the last model turn — the agent's final answer. */
export function finalAnswer(steps: Step[]): string {
  const llm = steps.filter((s): s is LlmStep => s.type === 'llm_call').sort((a, b) => a.index - b.index);
  const last = llm.at(-1);
  if (!last) return '';
  return last.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalize(v: unknown): unknown {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

export function valuesEqual(expected: unknown, actual: unknown, mode: Exclude<ArgMatch, 'ignore'>): boolean {
  const e = normalize(expected);
  const a = normalize(actual);
  if (Array.isArray(e) || Array.isArray(a)) {
    if (!Array.isArray(e) || !Array.isArray(a) || e.length !== a.length) return false;
    return e.every((x, i) => valuesEqual(x, a[i], mode));
  }
  if (e !== null && a !== null && typeof e === 'object' && typeof a === 'object') {
    return argsMatch(e as Record<string, unknown>, a as Record<string, unknown>, mode);
  }
  return e === a;
}

export function argsMatch(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown>,
  mode: ArgMatch,
): boolean {
  if (mode === 'ignore' || expected === undefined) return true;
  const eKeys = Object.keys(expected);
  if (mode === 'exact' && eKeys.length !== Object.keys(actual).length) return false;
  return eKeys.every((k) => k in actual && valuesEqual(expected[k], actual[k], mode));
}

export function callMatches(e: ExpectedCall, a: ActualCall, defaultArgMatch: ArgMatch): boolean {
  return e.tool === a.tool && argsMatch(e.args, a.args, e.argMatch ?? defaultArgMatch);
}

/**
 * Maximum one-to-one matching between expected and actual calls (Kuhn's
 * augmenting-path algorithm). Greedy first-fit is not enough once argument
 * matching is loose: one actual call can satisfy several expectations.
 * Returns matchOfExpected[i] = index into `actual`, or -1.
 */
export function maxMatching(
  expected: ExpectedCall[],
  actual: ActualCall[],
  defaultArgMatch: ArgMatch,
): number[] {
  const adj = expected.map((e) =>
    actual.flatMap((a, j) => (callMatches(e, a, defaultArgMatch) ? [j] : [])),
  );
  const ownerOfActual = new Array<number>(actual.length).fill(-1);

  const tryAssign = (i: number, seen: boolean[]): boolean => {
    for (const j of adj[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (ownerOfActual[j] === -1 || tryAssign(ownerOfActual[j], seen)) {
        ownerOfActual[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < expected.length; i++) tryAssign(i, new Array(actual.length).fill(false));

  const matchOfExpected = new Array<number>(expected.length).fill(-1);
  ownerOfActual.forEach((i, j) => {
    if (i !== -1) matchOfExpected[i] = j;
  });
  return matchOfExpected;
}

function groupsOf(actual: ActualCall[]): ActualCall[][] {
  const groups: ActualCall[][] = [];
  let last: number | null = null;
  for (const a of actual) {
    if (a.group !== last) groups.push([]);
    groups[groups.length - 1].push(a);
    last = a.group;
  }
  return groups;
}

function perfectlyMatches(expected: ExpectedCall[], group: ActualCall[], argMatch: ArgMatch): boolean {
  return maxMatching(expected, group, argMatch).every((j) => j !== -1);
}

export function trajectoryMatches(
  expected: ExpectedCall[],
  actual: ActualCall[],
  mode: MatchMode,
  argMatch: ArgMatch,
): boolean {
  if (mode === 'any_order') return maxMatching(expected, actual, argMatch).every((j) => j !== -1);

  const groups = groupsOf(actual);

  if (mode === 'exact') {
    if (expected.length !== actual.length) return false;
    let pos = 0;
    for (const g of groups) {
      if (!perfectlyMatches(expected.slice(pos, pos + g.length), g, argMatch)) return false;
      pos += g.length;
    }
    return true;
  }

  // in_order: expected must be a subsequence of the groups. A group may absorb
  // a consecutive run of expected calls (in any order) or be skipped entirely.
  const memo = new Map<string, boolean>();
  const fits = (i: number, g: number): boolean => {
    if (i === expected.length) return true;
    if (g === groups.length) return false;
    const key = `${i}:${g}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let ok = fits(i, g + 1);
    for (let j = i + 1; !ok && j <= Math.min(expected.length, i + groups[g].length); j++) {
      ok = perfectlyMatches(expected.slice(i, j), groups[g], argMatch) && fits(j, g + 1);
    }
    memo.set(key, ok);
    return ok;
  };
  return fits(0, 0);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function precisionRecall(tp: number, expected: number, actual: number) {
  const precision = actual === 0 ? (expected === 0 ? 1 : 0) : tp / actual;
  const recall = expected === 0 ? 1 : tp / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function callKey(c: ActualCall): string {
  const sorted = Object.keys(c.args)
    .sort()
    .map((k) => [k, normalize(c.args[k])]);
  return `${c.tool}|${JSON.stringify(sorted)}`;
}

/** Calls identical (tool + args) to an earlier successful call. */
export function countRedundant(actual: ActualCall[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const c of actual) {
    const k = callKey(c);
    if (seen.has(k)) n++;
    if (!c.isError) seen.add(k);
  }
  return n;
}

/** Calls to a tool whose previous call errored. */
export function countRetries(actual: ActualCall[]): number {
  const lastErrored = new Map<string, boolean>();
  let n = 0;
  for (const c of actual) {
    if (lastErrored.get(c.tool)) n++;
    lastErrored.set(c.tool, c.isError);
  }
  return n;
}

export function checkOutcome(answer: string, spec: OutcomeSpec | undefined): EvalReport['outcome'] {
  if (!spec) return { checked: false, passed: null, checks: [], finalAnswer: answer };
  const text = answer.toLowerCase();
  const checks: OutcomeCheck[] = [
    ...(spec.mustContain ?? []).map((v) => ({
      kind: 'mustContain' as const,
      value: v,
      passed: text.includes(v.toLowerCase()),
    })),
    ...(spec.mustNotContain ?? []).map((v) => ({
      kind: 'mustNotContain' as const,
      value: v,
      passed: !text.includes(v.toLowerCase()),
    })),
    ...(spec.matches ?? []).map((v) => ({
      kind: 'matches' as const,
      value: v,
      passed: new RegExp(v, 'i').test(answer),
    })),
  ];
  return { checked: true, passed: checks.every((c) => c.passed), checks, finalAnswer: answer };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function evaluateRun(run: Run | null, steps: Step[], spec?: TrajectorySpec): EvalReport {
  const actual = extractToolCalls(steps);
  const llmCalls = steps.filter((s) => s.type === 'llm_call').length;

  let trajectory: EvalReport['trajectory'] = null;
  if (spec) {
    const mode = spec.match ?? 'in_order';
    const argMatch = spec.argMatch ?? 'subset';
    const pairs = maxMatching(spec.expected, actual, argMatch);
    const tp = pairs.filter((j) => j !== -1).length;
    const used = new Set(pairs.filter((j) => j !== -1));
    trajectory = {
      mode,
      argMatch,
      matched: trajectoryMatches(spec.expected, actual, mode, argMatch),
      expected: spec.expected.length,
      actual: actual.length,
      truePositives: tp,
      ...precisionRecall(tp, spec.expected.length, actual.length),
      missing: spec.expected.filter((_, i) => pairs[i] === -1),
      unexpected: actual
        .filter((_, j) => !used.has(j))
        .map(({ index, tool, args }) => ({ index, tool, args })),
    };
  }

  const budgets: boolean[] = [];
  if (spec?.maxSteps !== undefined) budgets.push(steps.length <= spec.maxSteps);
  if (spec?.maxToolCalls !== undefined) budgets.push(actual.length <= spec.maxToolCalls);

  const forbiddenSet = new Set(spec?.forbiddenTools ?? []);
  const forbiddenCalls = actual.filter((c) => forbiddenSet.has(c.tool));

  const outcome = checkOutcome(finalAnswer(steps), spec?.outcome);
  const status = run?.status ?? 'unknown';

  const report: EvalReport = {
    runId: run?.id ?? null,
    status,
    trajectory,
    efficiency: {
      steps: steps.length,
      llmCalls,
      toolCalls: actual.length,
      redundantCalls: countRedundant(actual),
      callEfficiency:
        spec && spec.expected.length > 0
          ? Math.min(1, spec.expected.length / Math.max(1, actual.length))
          : null,
      withinBudget: budgets.length ? budgets.every(Boolean) : null,
    },
    errors: {
      toolErrors: actual.filter((c) => c.isError).length,
      retries: countRetries(actual),
      runError: run?.error ?? null,
    },
    outcome,
    forbidden: { calls: forbiddenCalls.length, tools: [...new Set(forbiddenCalls.map((c) => c.tool))] },
    pass: false,
  };
  report.pass =
    status !== 'error' &&
    status !== 'running' &&
    (trajectory?.matched ?? true) &&
    outcome.passed !== false &&
    report.efficiency.withinBudget !== false &&
    report.forbidden.calls === 0;
  return report;
}

/**
 * Use a recorded run's own tool calls as the expected trajectory — e.g. to
 * measure how far a fork drifted from its parent.
 */
export function specFromRun(steps: Step[], opts: Partial<Omit<TrajectorySpec, 'expected'>> = {}): TrajectorySpec {
  return {
    match: 'in_order',
    argMatch: 'exact',
    ...opts,
    expected: steps
      .filter((s): s is ToolStep => s.type === 'tool_call')
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ tool: s.toolName, args: s.input })),
  };
}
