// Demo trace seeding, shared by the CLI seed script and server auto-seed.
// Always uses the simulated driver: deterministic, free, no credentials needed.
import { store } from './store.js';
import { createRun, forkRun } from './engine.js';
import { simulatedDriver } from './agent/simulated.js';

const PROMPTS = [
  { name: 'Tokyo spring trip', prompt: 'Plan a 4-day trip to Tokyo from San Francisco on a $2000 budget.' },
  { name: 'Paris anniversary', prompt: 'Plan a romantic long weekend in Paris from London.' },
  { name: 'Sydney remote-work month', prompt: 'Plan a month in Sydney from Singapore for a remote worker.' },
];

function waitForRun(id: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const run = store.getRun(id);
      if (run && run.status !== 'running') {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
}

/** Create demo runs + one what-if fork. Assumes MCP is already connected. */
export async function seedDemo(log: (msg: string) => void = () => {}): Promise<void> {
  log('creating demo runs…');
  for (const p of PROMPTS) {
    const run = createRun(simulatedDriver, 'simulated', p);
    await waitForRun(run.id);
    log(`  ✓ ${run.name} (${run.id})`);
  }

  // Headline feature demo: fork the Tokyo run with an edited weather result.
  const tokyo = store.listRuns().find((r) => r.name === 'Tokyo spring trip');
  if (tokyo) {
    const steps = store.getSteps(tokyo.id);
    const weatherStep = steps.find((s) => s.type === 'tool_call' && s.toolName === 'get_weather');
    if (weatherStep) {
      const fork = forkRun(simulatedDriver, 'simulated', tokyo.id, weatherStep.index, {
        type: 'tool_result',
        newResult: JSON.stringify({ city: 'Tokyo', tempC: 2, condition: 'heavy snow', humidityPct: 88 }),
      });
      await waitForRun(fork.id);
      log(`  ✓ ${fork.name} (${fork.id}) — what-if: snowstorm in Tokyo`);
    }
  }
}

/** Seed only when the trace store is empty (used on server boot for public demos). */
export async function seedDemoIfEmpty(log: (msg: string) => void = () => {}): Promise<void> {
  if (store.listRuns().length > 0) return;
  await seedDemo(log);
}
