import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { connectMcp, getToolDefs } from './mcp/client.js';
import { seedDemoIfEmpty } from './demo.js';
import { createRun, forkRun, DEFAULT_SYSTEM } from './engine.js';
import { liveDriver, detectLiveCredentials } from './agent/live.js';
import { simulatedDriver } from './agent/simulated.js';
import type { Driver } from './agent/driver.js';
import type { ForkEdit, Run } from './types.js';
import { evaluateRun, specFromRun } from './eval/trajectory.js';
import { diffEvaluations } from './eval/compare.js';
import { parseSpec } from './eval/schema.js';
import { SCENARIOS } from './eval/scenarios.js';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { importOtlp, OtlpImportError } from './otel/import.js';
import { diffRuns } from './diff.js';

const PORT = Number(process.env.PORT ?? 4600);

const MODE: Run['mode'] =
  process.env.REWIND_MODE === 'live'
    ? 'live'
    : process.env.REWIND_MODE === 'simulated'
      ? 'simulated'
      : detectLiveCredentials()
        ? 'live'
        : 'simulated';

const driver: Driver = MODE === 'live' ? liveDriver : simulatedDriver;

const app = express();
app.set('trust proxy', 1); // behind Render/Fly/railway proxies
// Request ids + one structured (JSON) log line per request. Honour an inbound
// X-Request-Id so ids propagate from a proxy.
app.use((req, res, next) => {
  const rid = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) || randomUUID();
  res.setHeader('X-Request-Id', rid);
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    console.log(JSON.stringify({ level: 'info', msg: 'request', requestId: rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
  });
  next();
});
app.use(express.json({ limit: process.env.REWIND_MAX_BODY ?? '5mb' }));

// Light in-memory rate limit on mutating endpoints — enough to keep a free
// public deployment healthy without external dependencies.
const WINDOW_MS = 60_000;
const MAX_WRITES_PER_WINDOW = 30;
const writeCounts = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const key = req.ip ?? 'unknown';
  const nowMs = Date.now();
  const entry = writeCounts.get(key);
  if (!entry || nowMs > entry.resetAt) {
    writeCounts.set(key, { count: 1, resetAt: nowMs + WINDOW_MS });
    return next();
  }
  entry.count += 1;
  if (entry.count > MAX_WRITES_PER_WINDOW) {
    res.status(429).json({ error: 'Rate limit exceeded — try again in a minute.' });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: MODE,
    model: driver.model,
    tools: getToolDefs().map((t) => t.name),
    defaultSystem: DEFAULT_SYSTEM,
  });
});

app.get('/api/runs', (_req, res) => {
  res.json({ runs: store.listRuns() });
});

app.post('/api/runs', (req, res) => {
  const { prompt, name, system } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  const run = createRun(driver, MODE, {
    name: typeof name === 'string' && name.trim() ? name.trim() : prompt.trim().slice(0, 60),
    prompt: prompt.trim(),
    system: typeof system === 'string' ? system : undefined,
  });
  res.status(201).json({ run });
});

app.get('/api/runs/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  res.json({ run, steps: store.getSteps(run.id) });
});

app.post('/api/runs/:id/fork', (req, res) => {
  const { atIndex, edit } = req.body ?? {};
  if (typeof atIndex !== 'number' || !edit || typeof edit.type !== 'string') {
    res.status(400).json({ error: 'atIndex (number) and edit ({type, ...}) are required' });
    return;
  }
  try {
    const fork = forkRun(driver, MODE, req.params.id, atIndex, edit as ForkEdit);
    res.status(201).json({ run: fork });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Import OTLP/JSON GenAI traces (OTel semantic conventions) as replayable runs.
app.post('/api/import/otlp', (req, res) => {
  try {
    const traces = importOtlp(req.body);
    for (const t of traces) store.saveTrace(t.run, t.steps);
    res.status(201).json({ runs: traces.map((t) => t.run) });
  } catch (err) {
    res.status(err instanceof OtlpImportError ? 422 : 400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// First divergent step + per-step deltas between two stored runs.
app.get('/api/diff', (req, res) => {
  const a = typeof req.query.a === 'string' ? store.getRun(req.query.a) : undefined;
  const b = typeof req.query.b === 'string' ? store.getRun(req.query.b) : undefined;
  if (!a || !b) {
    res.status(404).json({ error: 'both runs (a, b) must exist' });
    return;
  }
  res.json(diffRuns({ run: a, steps: store.getSteps(a.id) }, { run: b, steps: store.getSteps(b.id) }));
});

app.delete('/api/runs/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  if (run.status === 'running') {
    res.status(409).json({ error: 'cannot delete a run that is still executing' });
    return;
  }
  store.deleteRun(run.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Trajectory evaluation
// ---------------------------------------------------------------------------
function badRequest(res: express.Response, err: unknown): void {
  const msg =
    err instanceof ZodError
      ? `invalid spec: ${err.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`
      : err instanceof Error
        ? err.message
        : String(err);
  res.status(400).json({ error: msg });
}

app.get('/api/eval/scenarios', (_req, res) => {
  res.json({
    scenarios: SCENARIOS.map(({ id, description, prompt, spec, expectPass }) => ({
      id,
      description,
      prompt,
      spec,
      expectPass,
    })),
  });
});

// Score one run. Body: { spec? } or { referenceRunId? } (use another run's
// tool calls as the expected trajectory). Neither → reference-free metrics.
app.post('/api/runs/:id/evaluate', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  try {
    const { spec: rawSpec, referenceRunId } = req.body ?? {};
    let spec = parseSpec(rawSpec);
    if (!spec && typeof referenceRunId === 'string') {
      if (!store.getRun(referenceRunId)) throw new Error('reference run not found');
      spec = specFromRun(store.getSteps(referenceRunId));
    }
    res.json({ spec: spec ?? null, report: evaluateRun(run, store.getSteps(run.id), spec) });
  } catch (err) {
    badRequest(res, err);
  }
});

// Score two timelines under one spec and diff them (B relative to A).
// Without a spec, A's own tool calls become the expected trajectory.
app.post('/api/compare', (req, res) => {
  const { a, b, spec: rawSpec } = req.body ?? {};
  const runA = typeof a === 'string' ? store.getRun(a) : undefined;
  const runB = typeof b === 'string' ? store.getRun(b) : undefined;
  if (!runA || !runB) {
    res.status(404).json({ error: 'both runs (a, b) must exist' });
    return;
  }
  try {
    const stepsA = store.getSteps(runA.id);
    const stepsB = store.getSteps(runB.id);
    const spec = parseSpec(rawSpec) ?? specFromRun(stepsA);
    const reportA = evaluateRun(runA, stepsA, spec);
    const reportB = evaluateRun(runB, stepsB, spec);
    res.json({
      spec,
      a: reportA,
      b: reportB,
      diff: diffEvaluations(reportA, reportB, { a: runA.metrics, b: runB.metrics }),
    });
  } catch (err) {
    badRequest(res, err);
  }
});

// ---------------------------------------------------------------------------
// Static frontend (built by `npm run build -w web`)
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  // The SPA fallback reads index.html from disk on every request, so cap it per client.
  const staticLimiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.REWIND_STATIC_RATE_LIMIT ?? 300),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, staticLimiter, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

await connectMcp();
if (process.env.REWIND_AUTOSEED !== '0') {
  await seedDemoIfEmpty((msg) => console.log(`[autoseed] ${msg}`));
}
app.listen(PORT, () => {
  console.log(`[rewind] listening on http://localhost:${PORT}  (mode: ${MODE}, model: ${driver.model})`);
  if (!existsSync(webDist)) {
    console.log('[rewind] web/dist not found — run `npm run build` for the UI, or use the Vite dev server');
  }
});
