import express from 'express';
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
app.use(express.json({ limit: '1mb' }));

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
// Static frontend (built by `npm run build -w web`)
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
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
