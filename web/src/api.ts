import { staticApi } from './api.static';
import type { CompareResult, EvalScenario, ForkEdit, Health, Run, Step, TrajectorySpec } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const liveApi = {
  health: () => fetch('/api/health').then((r) => json<Health>(r)),
  listRuns: () => fetch('/api/runs').then((r) => json<{ runs: Run[] }>(r)),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => json<{ run: Run; steps: Step[] }>(r)),
  createRun: (body: { prompt: string; name?: string; system?: string }) =>
    fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ run: Run }>(r)),
  forkRun: (id: string, atIndex: number, edit: ForkEdit) =>
    fetch(`/api/runs/${id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atIndex, edit }),
    }).then((r) => json<{ run: Run }>(r)),
  compare: (a: string, b: string, spec?: TrajectorySpec) =>
    fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b, spec }),
    }).then((r) => json<CompareResult>(r)),
  scenarios: () => fetch('/api/eval/scenarios').then((r) => json<{ scenarios: EvalScenario[] }>(r)),
  importOtlp: (doc: unknown) =>
    fetch('/api/import/otlp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }).then((r) => json<{ runs: Run[] }>(r)),
  deleteRun: (id: string) =>
    fetch(`/api/runs/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
};

// `npm run build:static` sets VITE_STATIC: no server, bundled sample traces only.
export const api: typeof liveApi = import.meta.env.VITE_STATIC ? staticApi : liveApi;
