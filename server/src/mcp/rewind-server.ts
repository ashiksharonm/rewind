// Rewind as an MCP server (stdio): lets an MCP client — Claude Code, Claude
// Desktop, another agent — list recorded runs, fork them, and run trajectory
// evals. It is a thin client over a Rewind instance's HTTP API, so it works
// against a local server or a deployed one:
//
//   REWIND_URL=http://localhost:4600 npx tsx server/src/mcp/rewind-server.ts
//
// (Separate from tools-server.mjs, which serves the demo agent's own tools.)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.REWIND_URL ?? 'http://localhost:4600').replace(/\/$/, '');

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});
const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

// Trajectory spec as accepted by POST /api/runs/:id/evaluate (validated server-side).
const spec = z
  .object({
    expected: z.array(
      z.object({ tool: z.string(), args: z.record(z.unknown()).optional(), argMatch: z.enum(['exact', 'subset', 'ignore']).optional() }),
    ),
    match: z.enum(['exact', 'in_order', 'any_order']).optional(),
    argMatch: z.enum(['exact', 'subset', 'ignore']).optional(),
    forbiddenTools: z.array(z.string()).optional(),
    maxSteps: z.number().optional(),
    maxToolCalls: z.number().optional(),
    outcome: z.object({ mustContain: z.array(z.string()).optional(), mustNotContain: z.array(z.string()).optional() }).optional(),
  })
  .describe('Expected trajectory + checks. See GET /api/eval/scenarios for examples.');

const server = new McpServer({ name: 'rewind', version: '1.0.0' });

server.registerTool(
  'list_runs',
  { description: 'List recorded agent runs (newest first) with status, lineage, and metrics.' },
  wrap(async () => {
    const { runs } = (await call('GET', '/api/runs')) as { runs: Array<Record<string, unknown>> };
    return runs.map(({ id, name, status, parentRunId, forkAtIndex, metrics }) => ({ id, name, status, parentRunId, forkAtIndex, metrics }));
  }),
);

server.registerTool(
  'get_run',
  {
    description: 'Get a run and its full step trace (prompt, model turns, tool calls).',
    inputSchema: { runId: z.string() },
  },
  wrap(({ runId }) => call('GET', `/api/runs/${encodeURIComponent(runId)}`)),
);

server.registerTool(
  'fork_run',
  {
    description:
      'Fork a finished run at a step and re-execute the future. edit: {type:"tool_result",newResult} on a tool_call step, {type:"reroll"} on an llm_call step, or {type:"prompt",newUserMessage?,newSystem?} on step 0.',
    inputSchema: {
      runId: z.string(),
      atIndex: z.number().int(),
      edit: z.union([
        z.object({ type: z.literal('tool_result'), newResult: z.string() }),
        z.object({ type: z.literal('reroll') }),
        z.object({ type: z.literal('prompt'), newUserMessage: z.string().optional(), newSystem: z.string().optional() }),
      ]),
    },
  },
  wrap(({ runId, atIndex, edit }) => call('POST', `/api/runs/${encodeURIComponent(runId)}/fork`, { atIndex, edit })),
);

server.registerTool(
  'evaluate_run',
  {
    description:
      'Score a recorded run: tool-call trajectory match (exact / in_order / any_order), precision/recall/F1 with argument matching, efficiency, tool errors and retries, and final-answer outcome checks. Pass `spec`, or `referenceRunId` to use another run as the expected trajectory, or neither for reference-free metrics.',
    inputSchema: { runId: z.string(), spec: spec.optional(), referenceRunId: z.string().optional() },
  },
  wrap(({ runId, spec: s, referenceRunId }) =>
    call('POST', `/api/runs/${encodeURIComponent(runId)}/evaluate`, { spec: s, referenceRunId }),
  ),
);

server.registerTool(
  'compare_runs',
  {
    description:
      'Evaluate two timelines (e.g. a parent and its fork) under the same spec and report which metrics B improved or regressed relative to A. Without a spec, A’s tool calls are the expected trajectory.',
    inputSchema: { a: z.string(), b: z.string(), spec: spec.optional() },
  },
  wrap(({ a, b, spec: s }) => call('POST', '/api/compare', { a, b, spec: s })),
);

server.registerTool(
  'list_eval_scenarios',
  { description: 'List the shipped eval scenarios and their trajectory specs (useful as spec templates).' },
  wrap(() => call('GET', '/api/eval/scenarios')),
);

await server.connect(new StdioServerTransport());
