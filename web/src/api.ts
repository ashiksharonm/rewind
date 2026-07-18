import type { ForkEdit, Health, Run, Step } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
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
  deleteRun: (id: string) =>
    fetch(`/api/runs/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
};
