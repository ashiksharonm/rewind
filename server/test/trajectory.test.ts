import { describe, expect, it } from 'vitest';
import {
  argsMatch,
  countRedundant,
  countRetries,
  evaluateRun,
  extractToolCalls,
  maxMatching,
  precisionRecall,
  specFromRun,
  trajectoryMatches,
  type ActualCall,
  type ExpectedCall,
} from '../src/eval/trajectory.js';
import { diffEvaluations } from '../src/eval/compare.js';
import type { Run, Step } from '../src/types.js';

// Build a trace from turns: each inner array is one parallel tool group.
function trace(turns: Array<Array<[string, Record<string, unknown>, boolean?]>>, finalText = 'done'): Step[] {
  const steps: Step[] = [
    { id: 'p', runId: 'r', index: 0, type: 'prompt', startedAt: '', durationMs: 0, system: '', userMessage: 'x' },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  turns.forEach((group, t) => {
    const llmId = `l${t}`;
    steps.push({
      id: llmId, runId: 'r', index: steps.length, type: 'llm_call', startedAt: '', durationMs: 0,
      model: 'm', content: [], stopReason: 'tool_use', usage, costUsd: 0,
    });
    group.forEach(([tool, input, isError], k) => {
      steps.push({
        id: `t${t}_${k}`, runId: 'r', index: steps.length, type: 'tool_call', startedAt: '', durationMs: 0,
        llmStepId: llmId, toolUseId: `u${t}_${k}`, toolName: tool, input, result: '{}', isError: Boolean(isError),
      });
    });
  });
  steps.push({
    id: 'final', runId: 'r', index: steps.length, type: 'llm_call', startedAt: '', durationMs: 0,
    model: 'm', content: [{ type: 'text', text: finalText }], stopReason: 'end_turn', usage, costUsd: 0,
  });
  return steps;
}

const run = (status: Run['status'] = 'completed'): Run => ({
  id: 'r', name: 'r', status, mode: 'simulated', model: 'm', createdAt: '',
  metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 },
});

// weather+currency in parallel, then flights+advisory in parallel
const travel = trace(
  [
    [['get_weather', { city: 'Tokyo' }], ['convert_currency', { amount: 2000, from: 'USD', to: 'JPY' }]],
    [['search_flights', { origin: 'SF', destination: 'Tokyo' }], ['get_travel_advisory', { country: 'Japan' }]],
  ],
  'Tokyo plan: pack warm layers. Budget in JPY.',
);
const calls = extractToolCalls(travel);
const e = (tool: string, args?: Record<string, unknown>): ExpectedCall => ({ tool, args });

describe('extractToolCalls', () => {
  it('tags each call with its parallel group', () => {
    expect(calls.map((c) => [c.tool, c.group])).toEqual([
      ['get_weather', 0], ['convert_currency', 0], ['search_flights', 1], ['get_travel_advisory', 1],
    ]);
  });
});

describe('argsMatch', () => {
  it('subset ignores extra actual keys; exact does not', () => {
    expect(argsMatch({ to: 'JPY' }, { amount: 1, to: 'JPY' }, 'subset')).toBe(true);
    expect(argsMatch({ to: 'JPY' }, { amount: 1, to: 'JPY' }, 'exact')).toBe(false);
  });
  it('compares strings case-insensitively and trimmed, numbers by value', () => {
    expect(argsMatch({ city: ' tokyo ' }, { city: 'Tokyo' }, 'exact')).toBe(true);
    expect(argsMatch({ amount: 2000 }, { amount: 2000.0 }, 'exact')).toBe(true);
    expect(argsMatch({ amount: 2000 }, { amount: '2000' }, 'exact')).toBe(false);
  });
  it('handles nested objects and arrays', () => {
    expect(argsMatch({ a: { b: [1, 'X'] } }, { a: { b: [1, 'x'], c: 2 } }, 'subset')).toBe(true);
    expect(argsMatch({ a: { b: [1, 'X'] } }, { a: { b: [1, 'x'], c: 2 } }, 'exact')).toBe(false);
    expect(argsMatch({ a: [1, 2] }, { a: [2, 1] }, 'exact')).toBe(false);
  });
  it('ignore mode and missing expected args always match', () => {
    expect(argsMatch({ city: 'Paris' }, { city: 'Tokyo' }, 'ignore')).toBe(true);
    expect(argsMatch(undefined, { city: 'Tokyo' }, 'exact')).toBe(true);
  });
});

describe('maxMatching', () => {
  it('finds the optimal assignment where greedy first-fit fails', () => {
    // e0 matches both actual calls, e1 only the first: greedy would give e0→a0 and strand e1.
    const actual: ActualCall[] = [
      { index: 1, group: 0, tool: 'get_weather', args: { city: 'Tokyo' }, isError: false, edited: false },
      { index: 2, group: 0, tool: 'get_weather', args: { city: 'Kyoto' }, isError: false, edited: false },
    ];
    const m = maxMatching([e('get_weather'), e('get_weather', { city: 'Tokyo' })], actual, 'subset');
    expect(m).toEqual([1, 0]);
  });
});

describe('trajectoryMatches', () => {
  const full = [
    e('get_weather', { city: 'Tokyo' }), e('convert_currency', { to: 'JPY' }),
    e('search_flights'), e('get_travel_advisory', { country: 'Japan' }),
  ];
  it('exact: passes on the same sequence', () => {
    expect(trajectoryMatches(full, calls, 'exact', 'subset')).toBe(true);
  });
  it('exact: order inside a parallel group does not matter, order across groups does', () => {
    const swappedInGroup = [full[1], full[0], full[3], full[2]];
    expect(trajectoryMatches(swappedInGroup, calls, 'exact', 'subset')).toBe(true);
    const swappedAcross = [full[2], full[3], full[0], full[1]];
    expect(trajectoryMatches(swappedAcross, calls, 'exact', 'subset')).toBe(false);
  });
  it('exact: fails on extra or missing calls', () => {
    expect(trajectoryMatches(full.slice(0, 3), calls, 'exact', 'subset')).toBe(false);
    expect(trajectoryMatches([...full, e('get_weather')], calls, 'exact', 'subset')).toBe(false);
  });
  it('in_order: allows extra calls but enforces group order', () => {
    expect(trajectoryMatches([full[0], full[3]], calls, 'in_order', 'subset')).toBe(true);
    expect(trajectoryMatches([full[3], full[0]], calls, 'in_order', 'subset')).toBe(false);
    expect(trajectoryMatches([full[1], full[0]], calls, 'in_order', 'subset')).toBe(true);
  });
  it('any_order: ignores order entirely', () => {
    expect(trajectoryMatches([full[3], full[0]], calls, 'any_order', 'subset')).toBe(true);
    expect(trajectoryMatches([e('book_hotel')], calls, 'any_order', 'subset')).toBe(false);
  });
  it('argument mismatch breaks the match', () => {
    expect(trajectoryMatches([e('get_weather', { city: 'Lisbon' })], calls, 'any_order', 'subset')).toBe(false);
  });
});

describe('precision / recall', () => {
  it('computes P/R/F1 and handles empty sides', () => {
    expect(precisionRecall(2, 4, 2)).toEqual({ precision: 1, recall: 0.5, f1: 2 / 3 });
    expect(precisionRecall(0, 0, 0)).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(precisionRecall(0, 3, 0)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});

describe('errors, retries, redundancy', () => {
  const flaky = extractToolCalls(
    trace([
      [['convert_currency', { to: 'XYZ' }, true]],
      [['convert_currency', { to: 'XYZ' }, true]],
      [['convert_currency', { to: 'JPY' }]],
      [['get_weather', { city: 'Tokyo' }], ['get_weather', { city: 'tokyo' }]],
    ]),
  );
  it('counts calls made after the same tool errored as retries', () => {
    expect(countRetries(flaky)).toBe(2);
  });
  it('counts repeats of an earlier successful identical call as redundant', () => {
    expect(countRedundant(flaky)).toBe(1); // second get_weather; errored repeats are retries, not redundancy
  });
});

describe('evaluateRun', () => {
  it('scores a passing run', () => {
    const r = evaluateRun(run(), travel, {
      expected: [e('get_weather', { city: 'Tokyo' }), e('get_travel_advisory', { country: 'Japan' })],
      match: 'in_order',
      maxToolCalls: 4,
      outcome: { mustContain: ['warm layers', 'jpy'], mustNotContain: ['light jacket'] },
    });
    expect(r.pass).toBe(true);
    expect(r.trajectory).toMatchObject({ matched: true, truePositives: 2, precision: 0.5, recall: 1 });
    expect(r.efficiency).toMatchObject({ steps: 8, llmCalls: 3, toolCalls: 4, callEfficiency: 0.5, withinBudget: true });
    expect(r.outcome.checks.every((c) => c.passed)).toBe(true);
  });

  it('reports missing and unexpected calls and fails the outcome', () => {
    const r = evaluateRun(run(), travel, {
      expected: [e('get_weather', { city: 'Lisbon' }), e('convert_currency', { to: 'EUR' })],
      match: 'any_order',
      outcome: { mustContain: ['Lisbon'] },
    });
    expect(r.pass).toBe(false);
    expect(r.trajectory?.missing.map((m) => m.args)).toEqual([{ city: 'Lisbon' }, { to: 'EUR' }]);
    expect(r.trajectory?.unexpected).toHaveLength(4);
    expect(r.outcome.passed).toBe(false);
  });

  it('fails on forbidden tools, blown budget, and errored runs', () => {
    expect(evaluateRun(run(), travel, { expected: [], forbiddenTools: ['search_flights'] }).forbidden).toEqual({
      calls: 1,
      tools: ['search_flights'],
    });
    expect(evaluateRun(run(), travel, { expected: [], maxSteps: 5 }).pass).toBe(false);
    expect(evaluateRun(run('error'), travel).pass).toBe(false);
  });

  it('is reference-free without a spec', () => {
    const r = evaluateRun(run(), travel);
    expect(r.trajectory).toBeNull();
    expect(r.efficiency.callEfficiency).toBeNull();
    expect(r.outcome.checked).toBe(false);
    expect(r.pass).toBe(true);
  });

  it('specFromRun reproduces a run exactly', () => {
    const r = evaluateRun(run(), travel, specFromRun(travel, { match: 'exact' }));
    expect(r.trajectory).toMatchObject({ matched: true, precision: 1, recall: 1, f1: 1 });
  });
});

describe('diffEvaluations', () => {
  it('labels improvements and regressions by metric direction', () => {
    const spec = { expected: [e('get_weather')], outcome: { mustContain: ['warm layers'] } };
    const a = evaluateRun(run(), trace([[['get_weather', {}]], [['get_weather', {}]]], 'light jacket'), spec);
    const b = evaluateRun(run(), trace([[['get_weather', {}]]], 'warm layers'), spec);
    const d = diffEvaluations(a, b);
    expect(d.passFlip).toBe('fixed');
    expect(d.improved).toEqual(
      expect.arrayContaining(['pass', 'outcome.checksPassedRate', 'efficiency.toolCalls', 'efficiency.redundantCalls', 'trajectory.precision']),
    );
    expect(d.regressed).toEqual([]);
    const back = diffEvaluations(b, a);
    expect(back.passFlip).toBe('broke');
    expect(back.regressed).toContain('pass');
  });
});
