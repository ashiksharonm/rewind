// OpenTelemetry GenAI -> Rewind recording format.
//
// Input is an OTLP/JSON trace export (`resourceSpans[].scopeSpans[].spans[]`)
// whose spans follow the OTel GenAI semantic conventions (`gen_ai.*`).
// Output is one Run + ordered Steps per trace id, in the same shape the
// recorder produces, so imported runs can be inspected, evaluated, diffed and
// forked like native ones.
//
// Mapping:
//   gen_ai.operation.name = chat | text_completion | generate_content  -> llm_call step
//   gen_ai.operation.name = execute_tool                               -> tool_call step
//   first system/user input of the first model call                    -> prompt step
//   root span (or invoke_agent / gen_ai.agent.name)                    -> run name
//
// Message content is read from either the stable span attributes
// (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`)
// or the older span events (`gen_ai.user.message`, `gen_ai.choice`, ...).
import { createHash } from 'node:crypto';
import { costUsd, hasPricing } from '../pricing.js';
import type { ContentBlock, LlmStep, PromptStep, Run, Step, ToolStep } from '../types.js';

type Json = unknown;
type Attrs = Record<string, Json>;

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startMs: number;
  endMs: number;
  attrs: Attrs;
  events: { name: string; attrs: Attrs }[];
  error: boolean;
}

export interface ImportedTrace {
  run: Run;
  steps: Step[];
}

export class OtlpImportError extends Error {}

const LLM_OPS = new Set(['chat', 'text_completion', 'generate_content', 'completion']);

// --- OTLP decoding ---------------------------------------------------------
function anyValue(v: Json): Json {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, Json>;
  if ('stringValue' in o) return o.stringValue;
  if ('intValue' in o) return Number(o.intValue);
  if ('doubleValue' in o) return Number(o.doubleValue);
  if ('boolValue' in o) return o.boolValue;
  if ('arrayValue' in o) return (((o.arrayValue as Record<string, Json>)?.values as Json[]) ?? []).map(anyValue);
  if ('kvlistValue' in o) return attrsOf(((o.kvlistValue as Record<string, Json>)?.values as Json[]) ?? []);
  return undefined;
}

function attrsOf(list: Json): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    const e = kv as { key?: string; value?: Json };
    if (typeof e?.key === 'string') out[e.key] = anyValue(e.value);
  }
  return out;
}

const nanoToMs = (n: Json): number => {
  if (n === undefined || n === null || n === '') return 0;
  // Nanosecond timestamps exceed 2^53; BigInt keeps millisecond precision.
  try {
    return Number(BigInt(String(n)) / 1_000_000n);
  } catch {
    return 0;
  }
};

function decodeSpans(doc: Json): Span[] {
  const rs = (doc as { resourceSpans?: Json[] })?.resourceSpans;
  if (!Array.isArray(rs)) throw new OtlpImportError('not an OTLP/JSON trace: missing resourceSpans');
  const spans: Span[] = [];
  for (const r of rs) {
    for (const ss of ((r as { scopeSpans?: Json[] }).scopeSpans ?? []) as Json[]) {
      for (const raw of ((ss as { spans?: Json[] }).spans ?? []) as Record<string, Json>[]) {
        spans.push({
          traceId: String(raw.traceId ?? ''),
          spanId: String(raw.spanId ?? ''),
          parentSpanId: String(raw.parentSpanId ?? ''),
          name: String(raw.name ?? ''),
          startMs: nanoToMs(raw.startTimeUnixNano),
          endMs: nanoToMs(raw.endTimeUnixNano),
          attrs: attrsOf(raw.attributes),
          events: (((raw.events as Json[]) ?? []) as Record<string, Json>[]).map((e) => ({
            name: String(e.name ?? ''),
            attrs: attrsOf(e.attributes),
          })),
          error: (raw.status as { code?: Json } | undefined)?.code === 2 || (raw.status as { code?: Json } | undefined)?.code === 'STATUS_CODE_ERROR',
        });
      }
    }
  }
  return spans;
}

// --- message extraction ----------------------------------------------------
interface Msg {
  role: string;
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
}

function parseMaybeJson(v: Json): Json {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const asObject = (v: Json): Record<string, unknown> => {
  const p = parseMaybeJson(v);
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : p === undefined || p === '' ? {} : { value: p };
};

function textOf(content: Json): string {
  const c = parseMaybeJson(content);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => textOf((p as { text?: Json; content?: Json })?.text ?? (p as { content?: Json })?.content ?? p)).join('');
  return '';
}

/** Normalise one message from either the `parts` form or the OpenAI-like form. */
function toMsg(raw: Json, fallbackRole = 'assistant'): Msg {
  const m = (raw ?? {}) as Record<string, Json>;
  const msg: Msg = { role: String(m.role ?? fallbackRole), text: '', toolCalls: [] };
  if (Array.isArray(m.parts)) {
    for (const p of m.parts as Record<string, Json>[]) {
      if (p.type === 'tool_call') {
        msg.toolCalls.push({ id: String(p.id ?? ''), name: String(p.name ?? ''), input: asObject(p.arguments) });
      } else if (typeof p.content === 'string') msg.text += p.content;
      else if (typeof p.text === 'string') msg.text += p.text;
    }
  } else {
    msg.text = textOf(m.content);
    for (const tc of (m.tool_calls as Record<string, Json>[] | undefined) ?? []) {
      const fn = (tc.function ?? tc) as Record<string, Json>;
      msg.toolCalls.push({ id: String(tc.id ?? ''), name: String(fn.name ?? ''), input: asObject(fn.arguments) });
    }
  }
  return msg;
}

function inputMessages(span: Span): { system: string; msgs: Msg[] } {
  let system = textOf(span.attrs['gen_ai.system_instructions']);
  const msgs: Msg[] = [];
  const attr = parseMaybeJson(span.attrs['gen_ai.input.messages']);
  if (Array.isArray(attr)) {
    for (const m of attr) msgs.push(toMsg(m, 'user'));
  } else {
    for (const ev of span.events) {
      const m = ev.name.match(/^gen_ai\.(system|user|assistant|tool)\.message$/);
      if (!m) continue;
      const body = (parseMaybeJson(ev.attrs.body) as Record<string, Json> | undefined) ?? ev.attrs;
      msgs.push(toMsg({ ...(body as object), role: m[1], content: (body as Record<string, Json>).content ?? ev.attrs.content }, m[1]));
    }
  }
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.text);
  if (!system && sys.length) system = sys.join('\n');
  return { system, msgs: msgs.filter((m) => m.role !== 'system') };
}

function outputMessage(span: Span): { msg: Msg; finish: string } {
  const attr = parseMaybeJson(span.attrs['gen_ai.output.messages']);
  const finishAttr = span.attrs['gen_ai.response.finish_reasons'];
  const finish0 = Array.isArray(finishAttr) ? String(finishAttr[0] ?? '') : '';
  if (Array.isArray(attr) && attr.length) {
    const first = attr[0] as Record<string, Json>;
    return { msg: toMsg(first), finish: String(first.finish_reason ?? finish0) };
  }
  const choice = span.events.find((e) => e.name === 'gen_ai.choice');
  if (choice) {
    const body = (parseMaybeJson(choice.attrs.message) as Json) ?? parseMaybeJson(choice.attrs.body);
    return { msg: toMsg(body), finish: String(choice.attrs.finish_reason ?? finish0) };
  }
  return { msg: { role: 'assistant', text: '', toolCalls: [] }, finish: finish0 };
}

// --- helpers ---------------------------------------------------------------
const hid = (prefix: string, ...parts: string[]) =>
  `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
const num = (v: Json): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (ms: number) => new Date(ms).toISOString();
const opName = (s: Span): string => String(s.attrs['gen_ai.operation.name'] ?? '');

function stopReason(finish: string, hasTools: boolean): string {
  if (hasTools) return 'tool_use';
  if (finish === 'length' || finish === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function buildTrace(spans: Span[]): ImportedTrace {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const llm = sorted.filter((s) => LLM_OPS.has(opName(s)));
  if (llm.length === 0) throw new OtlpImportError('trace has no gen_ai model-call spans (gen_ai.operation.name = chat/text_completion/generate_content)');
  const traceId = sorted[0].traceId;
  const root = sorted.find((s) => !s.parentSpanId) ?? sorted[0];
  const runId = hid('run', traceId);
  const first = inputMessages(llm[0]);
  const userMsg = first.msgs.find((m) => m.role === 'user')?.text ?? '';
  const name = String(root.attrs['gen_ai.agent.name'] ?? '') || root.name || `otel ${traceId.slice(0, 8)}`;
  const startMs = sorted[0].startMs;

  const steps: Step[] = [];
  const prompt: PromptStep = {
    id: hid('step', runId, 'prompt'),
    runId,
    index: 0,
    type: 'prompt',
    startedAt: iso(startMs),
    durationMs: 0,
    system: first.system,
    userMessage: userMsg,
  };
  steps.push(prompt);

  let current: LlmStep | undefined;
  for (const s of sorted) {
    const op = opName(s);
    if (LLM_OPS.has(op)) {
      const { msg, finish } = outputMessage(s);
      const content: ContentBlock[] = [];
      if (msg.text) content.push({ type: 'text', text: msg.text });
      msg.toolCalls.forEach((tc, i) =>
        content.push({ type: 'tool_use', id: tc.id || hid('toolu', s.spanId, String(i)), name: tc.name, input: tc.input }),
      );
      const usage = {
        inputTokens: num(s.attrs['gen_ai.usage.input_tokens'] ?? s.attrs['gen_ai.usage.prompt_tokens']),
        outputTokens: num(s.attrs['gen_ai.usage.output_tokens'] ?? s.attrs['gen_ai.usage.completion_tokens']),
        cacheReadTokens: num(s.attrs['gen_ai.usage.cache_read.input_tokens']),
        cacheWriteTokens: num(s.attrs['gen_ai.usage.cache_creation.input_tokens']),
      };
      const model = String(s.attrs['gen_ai.response.model'] ?? s.attrs['gen_ai.request.model'] ?? 'unknown');
      current = {
        id: hid('step', runId, s.spanId),
        runId,
        index: steps.length,
        type: 'llm_call',
        startedAt: iso(s.startMs),
        durationMs: Math.max(0, s.endMs - s.startMs),
        model,
        content,
        stopReason: stopReason(finish, msg.toolCalls.length > 0),
        usage,
        // Only price models we have rates for; an unknown model is 0, not a guess.
        costUsd: hasPricing(model) ? costUsd(model, usage) : 0,
      };
      steps.push(current);
    } else if (op === 'execute_tool') {
      const toolName = String(s.attrs['gen_ai.tool.name'] ?? s.name.replace(/^execute_tool\s+/, ''));
      const callId = String(s.attrs['gen_ai.tool.call.id'] ?? '');
      const input = asObject(s.attrs['gen_ai.tool.call.arguments'] ?? s.events.find((e) => e.name === 'gen_ai.tool.message')?.attrs.arguments);
      const rawResult = s.attrs['gen_ai.tool.call.result'] ?? s.events.find((e) => e.name === 'gen_ai.tool.message')?.attrs.content;
      const result = typeof rawResult === 'string' ? rawResult : rawResult === undefined ? '' : JSON.stringify(rawResult);
      // Attach to the model turn that requested it; synthesise the tool_use
      // block if the instrumentation did not record the call on the model span.
      let parent = current;
      if (callId) parent = [...steps].reverse().find((x): x is LlmStep => x.type === 'llm_call' && x.content.some((b) => b.type === 'tool_use' && b.id === callId)) ?? current;
      if (!parent) continue; // tool span before any model call: nothing to attach to
      let tu = parent.content.find((b) => b.type === 'tool_use' && (callId ? b.id === callId : b.name === toolName && JSON.stringify(b.input) === JSON.stringify(input)));
      if (!tu) {
        tu = { type: 'tool_use', id: callId || hid('toolu', s.spanId), name: toolName, input };
        parent.content.push(tu);
        parent.stopReason = 'tool_use';
      }
      const step: ToolStep = {
        id: hid('step', runId, s.spanId),
        runId,
        index: steps.length,
        type: 'tool_call',
        startedAt: iso(s.startMs),
        durationMs: Math.max(0, s.endMs - s.startMs),
        llmStepId: parent.id,
        toolUseId: (tu as { id: string }).id,
        toolName,
        input,
        result,
        isError: s.error || s.attrs['error.type'] !== undefined,
      };
      steps.push(step);
    }
  }

  // Tool steps must follow their model step contiguously (in the order the model
  // requested them) for parallel groups to rebuild correctly; then re-index.
  const ordered: Step[] = [steps[0]];
  for (const llmStep of steps.filter((x): x is LlmStep => x.type === 'llm_call')) {
    const order = (t: Step) => llmStep.content.findIndex((b) => b.type === 'tool_use' && t.type === 'tool_call' && b.id === t.toolUseId);
    ordered.push(llmStep, ...steps.filter((x) => x.type === 'tool_call' && x.llmStepId === llmStep.id).sort((a, b) => order(a) - order(b)));
  }
  ordered.forEach((st, i) => (st.index = i));

  const endMs = Math.max(...sorted.map((s) => s.endMs));
  const llmSteps = ordered.filter((x): x is LlmStep => x.type === 'llm_call');
  const run: Run = {
    id: runId,
    name,
    status: root.error ? 'error' : 'completed',
    mode: 'live',
    source: 'otel',
    model: llmSteps[0]?.model ?? 'unknown',
    createdAt: iso(startMs),
    completedAt: iso(endMs),
    metrics: {
      inputTokens: llmSteps.reduce((n, s) => n + s.usage.inputTokens, 0),
      outputTokens: llmSteps.reduce((n, s) => n + s.usage.outputTokens, 0),
      costUsd: llmSteps.reduce((n, s) => n + s.costUsd, 0),
      durationMs: Math.max(0, endMs - startMs),
      llmCalls: llmSteps.length,
      toolCalls: ordered.filter((x) => x.type === 'tool_call').length,
    },
  };
  return { run, steps: ordered };
}

/** Convert an OTLP/JSON document into one ImportedTrace per trace id. Deterministic. */
export function importOtlp(doc: Json): ImportedTrace[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of decodeSpans(doc)) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId)!.push(s);
  }
  const out: ImportedTrace[] = [];
  for (const spans of byTrace.values()) {
    if (spans.some((s) => LLM_OPS.has(opName(s)))) out.push(buildTrace(spans));
  }
  if (out.length === 0) throw new OtlpImportError('no gen_ai model-call spans found in any trace');
  return out;
}
