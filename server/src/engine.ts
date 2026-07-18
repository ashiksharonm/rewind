import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import { costUsd } from './pricing.js';
import { callMcpTool, getToolDefs } from './mcp/client.js';
import type { Driver, WireMessage } from './agent/driver.js';
import type { ForkEdit, LlmStep, PromptStep, Run, Step, ToolStep } from './types.js';

const MAX_TURNS = 12;

export const DEFAULT_SYSTEM =
  'You are a travel planning agent. Use the available tools to research weather, ' +
  'currency, flights, and travel advisories, then produce a concise, actionable plan. ' +
  'Call tools in parallel when they are independent. Keep the final answer under 250 words.';

function id(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Rebuild the Anthropic message history from a list of recorded steps.
// This is the replay primitive: a prefix of steps IS a message history.
// ---------------------------------------------------------------------------
export function buildMessages(steps: Step[]): { system: string; messages: WireMessage[] } {
  const prompt = steps.find((s): s is PromptStep => s.type === 'prompt');
  if (!prompt) throw new Error('Trace has no prompt step');

  const messages: WireMessage[] = [{ role: 'user', content: prompt.userMessage }];

  for (const step of steps) {
    if (step.type === 'llm_call') {
      messages.push({ role: 'assistant', content: step.content });
      const toolSteps = steps.filter(
        (s): s is ToolStep => s.type === 'tool_call' && s.llmStepId === step.id,
      );
      if (toolSteps.length > 0) {
        messages.push({
          role: 'user',
          content: toolSteps.map((t) => ({
            type: 'tool_result' as const,
            tool_use_id: t.toolUseId,
            content: t.result,
            is_error: t.isError || undefined,
          })),
        });
      }
    }
  }
  return { system: prompt.system, messages };
}

function aggregateMetrics(run: Run, steps: Step[]): void {
  const m = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 };
  for (const s of steps) {
    m.durationMs += s.durationMs;
    if (s.type === 'llm_call') {
      m.llmCalls += 1;
      m.inputTokens += s.usage.inputTokens;
      m.outputTokens += s.usage.outputTokens;
      m.costUsd += s.costUsd;
    }
    if (s.type === 'tool_call') m.toolCalls += 1;
  }
  run.metrics = m;
}

// ---------------------------------------------------------------------------
// The agent loop: ask the model, execute requested MCP tools, repeat.
// Every model turn and every tool call is recorded as a step before the loop
// continues — recording is not an afterthought, it IS the execution log.
// ---------------------------------------------------------------------------
async function runLoop(run: Run, driver: Driver, existingSteps: Step[]): Promise<void> {
  const steps = [...existingSteps];
  let nextIndex = steps.length;
  const tools = getToolDefs();

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { system, messages } = buildMessages(steps);

      const t0 = Date.now();
      const modelTurn = await driver.next(system, messages, tools);
      const llmStep: LlmStep = {
        id: id('step'),
        runId: run.id,
        index: nextIndex++,
        type: 'llm_call',
        startedAt: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        model: driver.model,
        content: modelTurn.content,
        stopReason: modelTurn.stopReason,
        usage: modelTurn.usage,
        costUsd: run.mode === 'live' ? costUsd(driver.model, modelTurn.usage) : 0,
      };
      store.addStep(llmStep);
      steps.push(llmStep);
      aggregateMetrics(run, steps);
      store.updateRun(run);

      const toolUses = modelTurn.content.filter((b) => b.type === 'tool_use');
      if (modelTurn.stopReason !== 'tool_use' || toolUses.length === 0) break;

      for (const tu of toolUses) {
        const tt0 = Date.now();
        const { result, isError } = await callMcpTool(tu.name, tu.input);
        const toolStep: ToolStep = {
          id: id('step'),
          runId: run.id,
          index: nextIndex++,
          type: 'tool_call',
          startedAt: new Date(tt0).toISOString(),
          durationMs: Date.now() - tt0,
          llmStepId: llmStep.id,
          toolUseId: tu.id,
          toolName: tu.name,
          input: tu.input,
          result,
          isError,
        };
        store.addStep(toolStep);
        steps.push(toolStep);
      }
      aggregateMetrics(run, steps);
      store.updateRun(run);
    }

    run.status = 'completed';
    run.completedAt = now();
    aggregateMetrics(run, steps);
    store.updateRun(run);
  } catch (err) {
    run.status = 'error';
    run.error = err instanceof Error ? err.message : String(err);
    run.completedAt = now();
    aggregateMetrics(run, steps);
    store.updateRun(run);
    console.error(`[engine] run ${run.id} failed:`, run.error);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function createRun(
  driver: Driver,
  mode: Run['mode'],
  opts: { name: string; prompt: string; system?: string },
): Run {
  const run: Run = {
    id: id('run'),
    name: opts.name,
    status: 'running',
    mode,
    model: driver.model,
    createdAt: now(),
    metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 },
  };
  store.createRun(run);

  const promptStep: PromptStep = {
    id: id('step'),
    runId: run.id,
    index: 0,
    type: 'prompt',
    startedAt: now(),
    durationMs: 0,
    system: opts.system?.trim() || DEFAULT_SYSTEM,
    userMessage: opts.prompt,
  };
  store.addStep(promptStep);

  void runLoop(run, driver, [promptStep]);
  return run;
}

/**
 * Fork a run at a step. The parent's steps up to (and including, where
 * applicable) the fork point are copied into a new run — with the edit
 * applied — and the future is re-executed from there.
 *
 * Edit semantics by target step type:
 *  - prompt      + {type:'prompt'}      → change system/user message, replay everything
 *  - llm_call    + {type:'reroll'}      → drop this turn and everything after; re-sample
 *  - tool_call   + {type:'tool_result'} → rewrite this tool's result; keep siblings; continue after the group
 */
export function forkRun(driver: Driver, mode: Run['mode'], parentId: string, atIndex: number, edit: ForkEdit): Run {
  const parent = store.getRun(parentId);
  if (!parent) throw new Error(`Run ${parentId} not found`);
  if (parent.status === 'running') throw new Error('Cannot fork a run that is still executing');

  const parentSteps = store.getSteps(parentId);
  const target = parentSteps.find((s) => s.index === atIndex);
  if (!target) throw new Error(`Step index ${atIndex} not found in run ${parentId}`);

  // Determine the prefix to copy, per edit type.
  let prefix: Step[];
  if (edit.type === 'prompt') {
    if (target.type !== 'prompt') throw new Error('prompt edit must target the prompt step');
    prefix = [
      {
        ...target,
        system: edit.newSystem?.trim() || target.system,
        userMessage: edit.newUserMessage?.trim() || target.userMessage,
      },
    ];
  } else if (edit.type === 'reroll') {
    if (target.type !== 'llm_call') throw new Error('reroll must target an llm_call step');
    prefix = parentSteps.filter((s) => s.index < atIndex);
  } else if (edit.type === 'tool_result') {
    if (target.type !== 'tool_call') throw new Error('tool_result edit must target a tool_call step');
    // Include the whole parallel tool group the target belongs to, so the
    // rebuilt history has a complete tool_result message.
    const groupEnd = Math.max(
      ...parentSteps
        .filter((s) => s.type === 'tool_call' && s.llmStepId === target.llmStepId)
        .map((s) => s.index),
    );
    prefix = parentSteps
      .filter((s) => s.index <= groupEnd)
      .map((s) =>
        s.index === atIndex && s.type === 'tool_call'
          ? { ...s, result: edit.newResult, isError: false, edited: true }
          : s,
      );
  } else {
    throw new Error('Unknown edit type');
  }

  const editLabel =
    edit.type === 'tool_result'
      ? `edited ${target.type === 'tool_call' ? target.toolName : 'tool'} result`
      : edit.type === 'reroll'
        ? `rerolled turn ${atIndex}`
        : 'edited prompt';

  const fork: Run = {
    id: id('run'),
    name: `${parent.name} ⑂ ${editLabel}`,
    status: 'running',
    mode,
    model: driver.model,
    createdAt: now(),
    parentRunId: parent.id,
    forkAtIndex: atIndex,
    edit,
    metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 },
  };
  store.createRun(fork);

  // Re-key copied steps to the new run; preserve intra-run relationships.
  const idMap = new Map<string, string>();
  const copied: Step[] = prefix.map((s, i) => {
    const newId = id('step');
    idMap.set(s.id, newId);
    const base = { ...s, id: newId, runId: fork.id, index: i };
    if (base.type === 'tool_call') {
      return { ...base, llmStepId: idMap.get(base.llmStepId) ?? base.llmStepId };
    }
    return base;
  });
  for (const s of copied) store.addStep(s);
  aggregateMetrics(fork, copied);
  store.updateRun(fork);

  void runLoop(fork, driver, copied);
  return fork;
}
