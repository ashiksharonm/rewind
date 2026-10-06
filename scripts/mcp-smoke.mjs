// MCP smoke test: spawn the Rewind MCP server over stdio with the official
// SDK client and exercise evaluate_run / compare_runs against a running
// Rewind instance. Usage: node scripts/mcp-smoke.mjs (BASE_URL to override)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const serverDir = fileURLToPath(new URL('../server', import.meta.url));
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name} ${cond ? '' : extra}`);
  if (!cond) failed++;
};

const client = new Client({ name: 'rewind-mcp-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/rewind-server.ts'],
    cwd: serverDir,
    env: { ...process.env, REWIND_URL: BASE },
  }),
);
const text = (r) => r.content.map((c) => c.text).join('');
const json = (r) => JSON.parse(text(r));

console.log(`Rewind MCP smoke test against ${BASE}\n`);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check('exposes evaluate_run and compare_runs', names.includes('evaluate_run') && names.includes('compare_runs'), names.join(','));

// Record a run through the HTTP API, then evaluate it over MCP.
const created = await (await fetch(`${BASE}/api/runs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Plan a trip to Paris from London.', name: 'smoke: mcp' }),
})).json();
const runId = created.run.id;
for (let i = 0; i < 100; i++) {
  const r = json(await client.callTool({ name: 'get_run', arguments: { runId } }));
  if (r.run.status !== 'running') break;
  await new Promise((res) => setTimeout(res, 200));
}

const evalRes = await client.callTool({
  name: 'evaluate_run',
  arguments: {
    runId,
    spec: { expected: [{ tool: 'get_weather', args: { city: 'Paris' } }], match: 'any_order', outcome: { mustContain: ['Paris'] } },
  },
});
const report = json(evalRes).report;
check('evaluate_run returns a passing report', report.pass === true && report.trajectory.recall === 1, text(evalRes).slice(0, 200));

const forkRes = json(await client.callTool({ name: 'fork_run', arguments: { runId, atIndex: 0, edit: { type: 'prompt', newUserMessage: 'Plan a trip to Rome from London.' } } }));
for (let i = 0; i < 100; i++) {
  const r = json(await client.callTool({ name: 'get_run', arguments: { runId: forkRes.run.id } }));
  if (r.run.status !== 'running') break;
  await new Promise((res) => setTimeout(res, 200));
}
const cmp = json(await client.callTool({ name: 'compare_runs', arguments: { a: runId, b: forkRes.run.id } }));
check('compare_runs flags the retargeted fork as diverged', cmp.diff.passFlip === 'broke' && cmp.diff.regressed.includes('trajectory.recall'), JSON.stringify(cmp.diff).slice(0, 200));

const bad = await client.callTool({ name: 'evaluate_run', arguments: { runId: 'run_missing' } });
check('errors surface as MCP tool errors', bad.isError === true);

for (const id of [forkRes.run.id, runId]) await fetch(`${BASE}/api/runs/${id}`, { method: 'DELETE' });
await client.close();
console.log(failed ? `\n${failed} failed` : '\nall MCP checks passed');
process.exit(failed ? 1 : 0);
