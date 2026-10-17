import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/mcp/client.js', () => ({
  getToolDefs: () => [],
  callMcpTool: vi.fn(async () => ({ result: '{}', isError: false })),
}));

import { importOtlp, OtlpImportError } from '../src/otel/import.js';
import { diffRuns, formatDiff } from '../src/diff.js';
import { buildMessages, forkRun } from '../src/engine.js';
import { evaluateRun, specFromRun } from '../src/eval/trajectory.js';
import { store } from '../src/store.js';
import type { LlmStep, ToolStep } from '../src/types.js';
import { scriptedDriver, waitForRun } from './helpers.js';

const load = (n: string) => JSON.parse(readFileSync(new URL(`../../samples/otel/${n}.otlp.json`, import.meta.url), 'utf8'));
const [baseline] = importOtlp(load('trip-baseline'));
const [snow] = importOtlp(load('trip-snowstorm'));

describe('OTel GenAI import', () => {
  it('maps spans to prompt / llm_call / tool_call steps in order (stable-attribute style)', () => {
    expect(baseline.steps.map((s) => s.type)).toEqual(['prompt', 'llm_call', 'tool_call', 'tool_call', 'llm_call', 'tool_call', 'llm_call']);
    expect(baseline.steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(baseline.run).toMatchObject({ source: 'otel', status: 'completed', name: 'travel-planner (baseline)', model: 'sample-model-1' });
    const p = baseline.steps[0];
    expect(p.type === 'prompt' && p.system).toContain('travel planning agent');
    expect(p.type === 'prompt' && p.userMessage).toContain('Tokyo');
  });

  it('reads the older event-based convention and yields the same structure', () => {
    expect(snow.steps.map((s) => s.type)).toEqual(baseline.steps.map((s) => s.type));
    const first = snow.steps[1] as LlmStep;
    expect(first.content.filter((b) => b.type === 'tool_use').map((b) => b.type === 'tool_use' && b.name)).toEqual(['get_weather', 'convert_currency']);
  });

  it('links tool spans to the model turn that requested them, and sums metrics', () => {
    const llm = baseline.steps[1] as LlmStep;
    const tools = baseline.steps.filter((s): s is ToolStep => s.type === 'tool_call');
    expect(tools[0].llmStepId).toBe(llm.id);
    expect(tools[1].llmStepId).toBe(llm.id);
    expect(tools[2].llmStepId).toBe((baseline.steps[4] as LlmStep).id);
    expect(tools[0].input).toEqual({ city: 'Tokyo' });
    expect(baseline.run.metrics).toMatchObject({ llmCalls: 3, toolCalls: 3, inputTokens: 910, outputTokens: 139, durationMs: 2100 });
    expect(baseline.run.metrics.costUsd).toBe(0); // unknown model is not priced
  });

  it('is deterministic (stable ids) so re-import replaces rather than duplicates', () => {
    expect(importOtlp(load('trip-baseline'))[0].run.id).toBe(baseline.run.id);
    store.saveTrace(baseline.run, baseline.steps);
    store.saveTrace(baseline.run, baseline.steps);
    expect(store.getSteps(baseline.run.id)).toHaveLength(7);
  });

  it('rebuilds a valid message history and is scorable by the trajectory evaluator', () => {
    const { messages } = buildMessages(baseline.steps);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const r = evaluateRun(baseline.run, baseline.steps, specFromRun(baseline.steps, { match: 'exact' }));
    expect(r.trajectory?.f1).toBe(1);
  });

  it('synthesises a tool_use block when the model span did not record the call', () => {
    const doc = load('trip-baseline');
    const spans = doc.resourceSpans[0].scopeSpans[0].spans;
    const m = spans.find((s: { spanId: string }) => s.spanId.endsWith('00000002'));
    m.attributes = m.attributes.filter((a: { key: string }) => a.key !== 'gen_ai.output.messages');
    const [t] = importOtlp(doc);
    const llm = t.steps[1] as LlmStep;
    expect(llm.content.filter((b) => b.type === 'tool_use')).toHaveLength(2);
    expect(llm.stopReason).toBe('tool_use');
  });

  it('rejects documents that are not GenAI traces', () => {
    expect(() => importOtlp({})).toThrow(OtlpImportError);
    expect(() => importOtlp({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', name: 'GET /', startTimeUnixNano: '1', endTimeUnixNano: '2' }] }] }] })).toThrow(/no gen_ai/);
  });

  it('imported runs can be forked and the edit reaches the model history', async () => {
    store.saveTrace(snow.run, snow.steps);
    const driver = scriptedDriver();
    const weatherIdx = snow.steps.findIndex((s) => s.type === 'tool_call' && s.toolName === 'get_weather');
    const fork = forkRun(driver, 'simulated', snow.run.id, weatherIdx, { type: 'tool_result', newResult: '{"tempC":30}' });
    await waitForRun(fork.id);
    const firstHistory = JSON.stringify(driver.calls[0]);
    expect(firstHistory).toContain('{\\"tempC\\":30}');
    expect(store.getRun(fork.id)?.parentRunId).toBe(snow.run.id);
  });
});

describe('rewind diff', () => {
  it('reports identical runs', () => {
    const d = diffRuns(baseline, baseline);
    expect(d.identical).toBe(true);
    expect(d.firstDivergence).toBeNull();
  });

  it('finds the first divergent step and per-step deltas', () => {
    const d = diffRuns(baseline, snow);
    expect(d.firstDivergence).toMatchObject({ index: 2, change: 'tool_result' });
    expect(d.steps[6]).toMatchObject({ change: 'text', outputTokens: 7 });
    expect(d.totals.find((t) => t.metric === 'outputTokens')?.delta).toBe(7);
    expect(formatDiff(d)).toContain('First divergence at step 2 [tool_result]');
  });

  it('flags length mismatches and kind changes', () => {
    const shorter = { run: baseline.run, steps: baseline.steps.slice(0, 5) };
    expect(diffRuns(baseline, shorter).firstDivergence).toMatchObject({ index: 5, change: 'only_a' });
    const swapped = { run: baseline.run, steps: [baseline.steps[0], baseline.steps[2], ...baseline.steps.slice(2)] };
    expect(diffRuns(baseline, swapped).firstDivergence?.change).toBe('kind');
  });
});
