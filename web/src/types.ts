// Mirror of the server's trace model (server/src/types.ts).

export type RunStatus = 'running' | 'completed' | 'error';
export type RunMode = 'live' | 'simulated';

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
}

export type ForkEdit =
  | { type: 'tool_result'; newResult: string }
  | { type: 'reroll' }
  | { type: 'prompt'; newUserMessage?: string; newSystem?: string };

export interface Run {
  id: string;
  name: string;
  status: RunStatus;
  mode: RunMode;
  model: string;
  createdAt: string;
  completedAt?: string;
  parentRunId?: string;
  forkAtIndex?: number;
  edit?: ForkEdit;
  error?: string;
  metrics: RunMetrics;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type ContentBlock = TextBlock | ToolUseBlock;

interface BaseStep {
  id: string;
  runId: string;
  index: number;
  startedAt: string;
  durationMs: number;
}

export interface PromptStep extends BaseStep {
  type: 'prompt';
  system: string;
  userMessage: string;
}
export interface LlmStep extends BaseStep {
  type: 'llm_call';
  model: string;
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
  costUsd: number;
}
export interface ToolStep extends BaseStep {
  type: 'tool_call';
  llmStepId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  edited?: boolean;
}
export type Step = PromptStep | LlmStep | ToolStep;

export interface Health {
  ok: boolean;
  mode: RunMode;
  model: string;
  tools: string[];
  defaultSystem: string;
}

// Trajectory eval (mirror of server/src/eval/*).
export interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
  argMatch?: 'exact' | 'subset' | 'ignore';
}

export interface TrajectorySpec {
  expected: ExpectedCall[];
  match?: 'exact' | 'in_order' | 'any_order';
  argMatch?: 'exact' | 'subset' | 'ignore';
  forbiddenTools?: string[];
  maxSteps?: number;
  maxToolCalls?: number;
  outcome?: { mustContain?: string[]; mustNotContain?: string[] };
}

export interface EvalReport {
  runId: string | null;
  status: string;
  trajectory: null | {
    mode: string;
    matched: boolean;
    expected: number;
    actual: number;
    precision: number;
    recall: number;
    f1: number;
    missing: ExpectedCall[];
    unexpected: Array<{ index: number; tool: string; args: Record<string, unknown> }>;
  };
  efficiency: { steps: number; toolCalls: number; redundantCalls: number; callEfficiency: number | null; withinBudget: boolean | null };
  errors: { toolErrors: number; retries: number; runError: string | null };
  outcome: { checked: boolean; passed: boolean | null; checks: Array<{ kind: string; value: string; passed: boolean }> };
  forbidden: { calls: number; tools: string[] };
  pass: boolean;
}

export interface MetricDelta {
  metric: string;
  direction: 'higher' | 'lower';
  a: number | null;
  b: number | null;
  delta: number | null;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'n/a';
}

export interface CompareResult {
  spec: TrajectorySpec;
  a: EvalReport;
  b: EvalReport;
  diff: { metrics: MetricDelta[]; improved: string[]; regressed: string[]; passFlip: string };
}

export interface EvalScenario {
  id: string;
  description: string;
  prompt: string;
  spec: TrajectorySpec;
}
