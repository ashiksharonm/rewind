import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateRun, specFromRun } from '../src/eval/trajectory.js';
import { SCENARIOS } from '../src/eval/scenarios.js';
import type { Run, Step } from '../src/types.js';

// A trace recorded through the real MCP tools server (simulated model),
// exactly as `GET /api/runs/:id` returns it.
const trace = JSON.parse(
  readFileSync(new URL('../../eval/fixtures/tokyo-baseline.simulated.trace.json', import.meta.url), 'utf8'),
) as { run: Run; steps: Step[] };

describe('recorded trace fixture', () => {
  it('passes its scenario spec', () => {
    const spec = SCENARIOS.find((s) => s.id === 'tokyo-baseline')!.spec;
    const r = evaluateRun(trace.run, trace.steps, spec);
    expect(r.pass).toBe(true);
    expect(r.trajectory).toMatchObject({ matched: true, precision: 1, recall: 1 });
  });

  it('exactly reproduces its own trajectory', () => {
    const r = evaluateRun(trace.run, trace.steps, specFromRun(trace.steps, { match: 'exact' }));
    expect(r.trajectory?.f1).toBe(1);
  });
});
