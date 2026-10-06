import { beforeEach, describe, expect, it, vi } from 'vitest';

// The engine talks to the demo MCP server through this module; replace it with
// a deterministic in-process fake so the tests need no subprocess.
vi.mock('../src/mcp/client.js', () => ({
  getToolDefs: () => [],
  callMcpTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
    result: JSON.stringify({ tool: name, args }),
    isError: false,
  })),
}));

import { buildMessages, createRun, forkRun } from '../src/engine.js';
import { store } from '../src/store.js';
import type { LlmStep, PromptStep, Step, ToolStep } from '../src/types.js';
import { scriptedDriver, waitForRun } from './helpers.js';

const promptStep: PromptStep = {
  id: 'p',
  runId: 'r',
  index: 0,
  type: 'prompt',
  startedAt: '',
  durationMs: 0,
  system: 'sys',
  userMessage: 'plan a trip',
};

function llm(id: string, index: number, toolIds: string[] = []): LlmStep {
  return {
    id,
    runId: 'r',
    index,
    type: 'llm_call',
    startedAt: '',
    durationMs: 0,
    model: 'm',
    content: [
      { type: 'text', text: `turn ${id}` },
      ...toolIds.map((t) => ({ type: 'tool_use' as const, id: t, name: `tool_${t}`, input: {} })),
    ],
    stopReason: toolIds.length ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
}

function tool(llmStepId: string, toolUseId: string, index: number, result: string, isError = false): ToolStep {
  return {
    id: `s_${toolUseId}`,
    runId: 'r',
    index,
    type: 'tool_call',
    startedAt: '',
    durationMs: 0,
    llmStepId,
    toolUseId,
    toolName: `tool_${toolUseId}`,
    input: {},
    result,
    isError,
  };
}

async function recordedRun() {
  const driver = scriptedDriver();
  const run = createRun(driver, 'simulated', { name: 'base', prompt: 'Plan a trip to Tokyo' });
  await waitForRun(run.id);
  return { run: store.getRun(run.id)!, steps: store.getSteps(run.id) };
}

describe('buildMessages', () => {
  it('turns a prompt-only trace into a single user message', () => {
    const { system, messages } = buildMessages([promptStep]);
    expect(system).toBe('sys');
    expect(messages).toEqual([{ role: 'user', content: 'plan a trip' }]);
  });

  it('groups a parallel tool group into one tool_result message, in call order', () => {
    const steps: Step[] = [
      promptStep,
      llm('l1', 1, ['a', 'b']),
      tool('l1', 'a', 2, 'ra'),
      tool('l1', 'b', 3, 'rb', true),
      llm('l2', 4),
    ];
    const { messages } = buildMessages(steps);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'ra', is_error: undefined },
      { type: 'tool_result', tool_use_id: 'b', content: 'rb', is_error: true },
    ]);
  });

  it('does not emit an empty tool_result message for a final text turn', () => {
    const { messages } = buildMessages([promptStep, llm('l1', 1)]);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
  });

  it('throws when the trace has no prompt step', () => {
    expect(() => buildMessages([llm('l1', 1)])).toThrow(/no prompt step/);
  });
});

describe('recording', () => {
  it('records prompt, model turns and tool calls with contiguous indices', async () => {
    const { run, steps } = await recordedRun();
    expect(run.status).toBe('completed');
    expect(steps.map((s) => s.type)).toEqual([
      'prompt',
      'llm_call',
      'tool_call',
      'tool_call',
      'llm_call',
      'tool_call',
      'llm_call',
    ]);
    expect(steps.every((s, i) => s.index === i)).toBe(true);
    expect(run.metrics.llmCalls).toBe(3);
    expect(run.metrics.toolCalls).toBe(3);
  });
});

describe('forkRun', () => {
  let base: Awaited<ReturnType<typeof recordedRun>>;
  beforeEach(async () => {
    base = await recordedRun();
  });

  it('tool_result edit: keeps the whole parallel group, flags the edit, never mutates the parent', async () => {
    const parentBefore = JSON.stringify(store.getSteps(base.run.id));
    const weather = base.steps.find((s): s is ToolStep => s.type === 'tool_call' && s.toolName === 'get_weather')!;
    const sibling = base.steps.find((s): s is ToolStep => s.type === 'tool_call' && s.toolName === 'convert_currency')!;

    const driver = scriptedDriver();
    const fork = forkRun(driver, 'simulated', base.run.id, weather.index, {
      type: 'tool_result',
      newResult: '{"tempC":2,"condition":"heavy snow"}',
    });
    await waitForRun(fork.id);
    const forkSteps = store.getSteps(fork.id);

    expect(JSON.stringify(store.getSteps(base.run.id))).toBe(parentBefore);
    expect(store.getRun(fork.id)).toMatchObject({ parentRunId: base.run.id, forkAtIndex: weather.index });

    const edited = forkSteps[weather.index] as ToolStep;
    expect(edited.edited).toBe(true);
    expect(edited.result).toContain('heavy snow');
    // The sibling call from the same parallel group is copied verbatim.
    expect((forkSteps[sibling.index] as ToolStep).result).toBe(sibling.result);
    expect((forkSteps[sibling.index] as ToolStep).edited).toBeUndefined();

    // Resumed after the group: first driver call already has both tool_results.
    const firstHistory = driver.calls[0];
    expect(firstHistory.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const final = forkSteps.at(-1) as LlmStep;
    expect(final.content[0]).toMatchObject({ type: 'text' });
    expect((final.content[0] as { text: string }).text).toContain('heavy snow');
  });

  it('re-keys copied steps to the fork and remaps tool → llm references', async () => {
    const weather = base.steps.find((s) => s.type === 'tool_call')!;
    const fork = forkRun(scriptedDriver(), 'simulated', base.run.id, weather.index, {
      type: 'tool_result',
      newResult: 'x',
    });
    await waitForRun(fork.id);
    const steps = store.getSteps(fork.id);
    const parentIds = new Set(base.steps.map((s) => s.id));
    expect(steps.every((s) => s.runId === fork.id && !parentIds.has(s.id))).toBe(true);
    expect(steps.every((s, i) => s.index === i)).toBe(true);
    const llmIds = new Set(steps.filter((s) => s.type === 'llm_call').map((s) => s.id));
    for (const s of steps) if (s.type === 'tool_call') expect(llmIds.has(s.llmStepId)).toBe(true);
  });

  it('reroll: drops the target turn and everything after it, then re-samples', async () => {
    const secondTurn = base.steps.filter((s) => s.type === 'llm_call')[1];
    const driver = scriptedDriver();
    const fork = forkRun(driver, 'simulated', base.run.id, secondTurn.index, { type: 'reroll' });
    await waitForRun(fork.id);
    // The first history the driver sees ends right before the rerolled turn.
    const history = driver.calls[0];
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(history.at(-1)?.role).toBe('user');
    const forkSteps = store.getSteps(fork.id);
    expect(forkSteps.slice(0, secondTurn.index).map((s) => s.type)).toEqual(
      base.steps.slice(0, secondTurn.index).map((s) => s.type),
    );
    expect(forkSteps[secondTurn.index].type).toBe('llm_call');
    expect(forkSteps[secondTurn.index].id).not.toBe(secondTurn.id);
  });

  it('prompt edit: replays from scratch with the new message and keeps the old system prompt', async () => {
    const driver = scriptedDriver();
    const fork = forkRun(driver, 'simulated', base.run.id, 0, {
      type: 'prompt',
      newUserMessage: 'Plan a trip to Paris',
    });
    await waitForRun(fork.id);
    const forkSteps = store.getSteps(fork.id);
    const p = forkSteps[0] as PromptStep;
    expect(p.userMessage).toBe('Plan a trip to Paris');
    expect(p.system).toBe((base.steps[0] as PromptStep).system);
    expect(driver.calls[0]).toEqual([{ role: 'user', content: 'Plan a trip to Paris' }]);
    expect((store.getSteps(base.run.id)[0] as PromptStep).userMessage).toBe('Plan a trip to Tokyo');
  });

  it('rejects edits that do not fit the target step', () => {
    const d = scriptedDriver();
    expect(() => forkRun(d, 'simulated', base.run.id, 0, { type: 'reroll' })).toThrow(/llm_call/);
    expect(() => forkRun(d, 'simulated', base.run.id, 1, { type: 'tool_result', newResult: '' })).toThrow(/tool_call/);
    expect(() => forkRun(d, 'simulated', base.run.id, 1, { type: 'prompt' })).toThrow(/prompt step/);
    expect(() => forkRun(d, 'simulated', base.run.id, 99, { type: 'reroll' })).toThrow(/not found/);
    expect(() => forkRun(d, 'simulated', 'run_missing', 0, { type: 'reroll' })).toThrow(/not found/);
    // @ts-expect-error deliberately invalid edit type
    expect(() => forkRun(d, 'simulated', base.run.id, 1, { type: 'nonsense' })).toThrow(/Unknown edit/);
  });

  it('refuses to fork a run that is still executing', () => {
    const run = createRun(scriptedDriver(), 'simulated', { name: 'busy', prompt: 'x' });
    expect(() => forkRun(scriptedDriver(), 'simulated', run.id, 0, { type: 'prompt' })).toThrow(/still executing/);
    return waitForRun(run.id);
  });
});
