import { describe, expect, it } from 'vitest';
import { staticApi } from '../../web/src/api.static';

describe('static viewer API (no server)', () => {
  it('bundles the sample traces', async () => {
    const { runs } = await staticApi.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.filter((r) => r.source === 'otel')).toHaveLength(2);
  });

  it('compares two imported runs with the shared evaluator', async () => {
    const { runs } = await staticApi.listRuns();
    const [a, b] = runs.filter((r) => r.source === 'otel');
    const res = await staticApi.compare(a.id, b.id);
    expect(res.diff.metrics.length).toBeGreaterThan(0);
  });

  it('rejects recording and forking', async () => {
    await expect(staticApi.createRun({ prompt: 'x' })).rejects.toThrow(/Read-only/);
  });
});
