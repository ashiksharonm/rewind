// Rewind smoke test — exercises every API path and the fork/replay semantics.
// Usage: node scripts/smoke.mjs   (server must be running; BASE_URL to override)
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCompleted(id, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await req('GET', `/api/runs/${id}`);
    if (json?.run?.status && json.run.status !== 'running') return json;
    await sleep(300);
  }
  throw new Error(`run ${id} did not finish within ${timeoutMs}ms`);
}

console.log(`Rewind smoke test against ${BASE}\n`);

// ── health ──────────────────────────────────────────────────────────────
{
  const { status, json } = await req('GET', '/api/health');
  check('health returns ok', status === 200 && json.ok === true);
  check('MCP tools discovered', Array.isArray(json.tools) && json.tools.length === 4, JSON.stringify(json.tools));
}

// ── create + trace shape ────────────────────────────────────────────────
let baseRun;
{
  const { status, json } = await req('POST', '/api/runs', {
    prompt: 'Plan a 5-day trip to Rome from Berlin on a $1500 budget.',
    name: 'smoke: rome',
  });
  check('create run returns 201', status === 201, `got ${status}`);
  baseRun = await waitCompleted(json.run.id);
  check('run completes', baseRun.run.status === 'completed', baseRun.run.status);

  const steps = baseRun.steps;
  check('first step is prompt', steps[0]?.type === 'prompt');
  check('indices are contiguous', steps.every((s, i) => s.index === i));
  const llmIds = new Set(steps.filter((s) => s.type === 'llm_call').map((s) => s.id));
  check(
    'every tool step references an llm step',
    steps.filter((s) => s.type === 'tool_call').every((s) => llmIds.has(s.llmStepId)),
  );
  const last = steps[steps.length - 1];
  check('trace ends with a model turn', last.type === 'llm_call' && last.stopReason === 'end_turn');
  check('metrics aggregated', baseRun.run.metrics.llmCalls > 0 && baseRun.run.metrics.toolCalls > 0);
}

// ── fork: edit tool result ──────────────────────────────────────────────
let heatFork;
{
  const weather = baseRun.steps.find((s) => s.type === 'tool_call' && s.toolName === 'get_weather');
  const { status, json } = await req('POST', `/api/runs/${baseRun.run.id}/fork`, {
    atIndex: weather.index,
    edit: { type: 'tool_result', newResult: JSON.stringify({ city: 'Rome', tempC: 41, condition: 'heatwave', humidityPct: 20 }) },
  });
  check('tool_result fork accepted', status === 201, JSON.stringify(json));
  const fork = await waitCompleted(json.run.id);
  heatFork = fork;
  check('fork completes', fork.run.status === 'completed');
  check('fork records lineage', fork.run.parentRunId === baseRun.run.id && fork.run.forkAtIndex === weather.index);
  const editedStep = fork.steps.find((s) => s.index === weather.index);
  check('edited step flagged', editedStep?.edited === true && editedStep.result.includes('heatwave'));
  // Prefix before the edit must be byte-identical content-wise.
  const sameBefore = fork.steps
    .slice(0, weather.index)
    .every((s, i) => JSON.stringify(strip(s)) === JSON.stringify(strip(baseRun.steps[i])));
  check('prefix before edit is identical', sameBefore);
  const finalText = fork.steps.filter((s) => s.type === 'llm_call').at(-1).content.find((b) => b.type === 'text')?.text ?? '';
  check('edited result propagates to final answer', /41|heatwave|light|warm/i.test(finalText), finalText.slice(0, 80));
}

// ── fork: reroll ────────────────────────────────────────────────────────
{
  const lastLlm = baseRun.steps.filter((s) => s.type === 'llm_call').at(-1);
  const { status, json } = await req('POST', `/api/runs/${baseRun.run.id}/fork`, {
    atIndex: lastLlm.index,
    edit: { type: 'reroll' },
  });
  check('reroll fork accepted', status === 201);
  const fork = await waitCompleted(json.run.id);
  check('reroll completes', fork.run.status === 'completed');
  check('reroll keeps prefix length', fork.steps.length >= lastLlm.index);
}

// ── fork: prompt edit ───────────────────────────────────────────────────
{
  const { status, json } = await req('POST', `/api/runs/${baseRun.run.id}/fork`, {
    atIndex: 0,
    edit: { type: 'prompt', newUserMessage: 'Plan a 5-day trip to Mumbai from Berlin on a $1500 budget.' },
  });
  check('prompt fork accepted', status === 201);
  const fork = await waitCompleted(json.run.id);
  const finalText = fork.steps.filter((s) => s.type === 'llm_call').at(-1).content.find((b) => b.type === 'text')?.text ?? '';
  check('prompt fork retargets destination', /mumbai/i.test(finalText), finalText.slice(0, 80));
}

// ── trajectory evaluation ───────────────────────────────────────────────
{
  const spec = {
    expected: [
      { tool: 'get_weather', args: { city: 'Rome' } },
      { tool: 'search_flights', args: { origin: 'Berlin', destination: 'Rome' } },
    ],
    match: 'in_order',
    outcome: { mustContain: ['Rome'] },
  };
  let r = await req('POST', `/api/runs/${baseRun.run.id}/evaluate`, { spec });
  check('evaluate scores a run', r.status === 200 && r.json.report.pass === true && r.json.report.trajectory.recall === 1, JSON.stringify(r.json).slice(0, 200));
  r = await req('POST', `/api/runs/${baseRun.run.id}/evaluate`, { spec: { expected: 'nope' } });
  check('evaluate rejects an invalid spec', r.status === 400);
  r = await req('POST', '/api/compare', {
    a: baseRun.run.id,
    b: heatFork.run.id,
    spec: { ...spec, outcome: { mustContain: ['heatwave'] } },
  });
  check('compare diffs two timelines', r.status === 200 && r.json.diff.passFlip === 'fixed' && r.json.diff.improved.includes('pass'), JSON.stringify(r.json?.diff ?? r.json).slice(0, 200));
  r = await req('GET', '/api/eval/scenarios');
  check('eval scenarios listed', r.status === 200 && r.json.scenarios.length > 0);
}

// ── validation & error paths ────────────────────────────────────────────
{
  let r = await req('POST', '/api/runs', {});
  check('missing prompt rejected', r.status === 400);
  r = await req('POST', `/api/runs/${baseRun.run.id}/fork`, { atIndex: 0, edit: { type: 'reroll' } });
  check('reroll on prompt step rejected', r.status === 400);
  r = await req('POST', `/api/runs/${baseRun.run.id}/fork`, { atIndex: 999, edit: { type: 'reroll' } });
  check('bad index rejected', r.status === 400);
  r = await req('POST', `/api/runs/${baseRun.run.id}/fork`, { atIndex: 1, edit: { type: 'nonsense' } });
  check('unknown edit type rejected', r.status === 400);
  r = await req('GET', '/api/runs/run_does_not_exist');
  check('unknown run 404s', r.status === 404);
  r = await req('DELETE', '/api/runs/run_does_not_exist');
  check('delete unknown run 404s', r.status === 404);
}

// ── delete ──────────────────────────────────────────────────────────────
{
  const created = await req('POST', '/api/runs', { prompt: 'Plan a weekend in London from Paris.', name: 'smoke: delete-me' });
  await waitCompleted(created.json.run.id);
  const del = await req('DELETE', `/api/runs/${created.json.run.id}`);
  check('delete succeeds', del.status === 200);
  const gone = await req('GET', `/api/runs/${created.json.run.id}`);
  check('deleted run is gone', gone.status === 404);
}

// ── rate limiting (spoofed client IP so we do not exhaust our own) ──────
{
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const r = await req('POST', '/api/runs', {}, { 'X-Forwarded-For': '203.0.113.99' });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  check('write rate limit engages', limited);
}

// ── cleanup smoke artifacts ─────────────────────────────────────────────
{
  const { json } = await req('GET', '/api/runs');
  for (const r of json.runs) {
    if (r.name.startsWith('smoke:') || r.name.startsWith('Plan a 5-day trip')) {
      await req('DELETE', `/api/runs/${r.id}`);
    }
  }
}

function strip(step) {
  // ignore per-run identifiers and timing when comparing prefixes
  const { id, runId, startedAt, durationMs, llmStepId, ...rest } = step;
  return rest;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
