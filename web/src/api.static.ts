// Server-less API used by the static viewer build (VITE_STATIC=1). Runs live in
// memory: the bundled sample traces, plus anything the visitor imports. The OTLP
// importer, trajectory evaluator and diff are the same modules the server uses.
import { importOtlp } from '../../server/src/otel/import';
import { evaluateRun, specFromRun } from '../../server/src/eval/trajectory';
import { diffEvaluations } from '../../server/src/eval/compare';
import { SCENARIOS } from '../../server/src/eval/scenarios';
import type { CompareResult, EvalScenario, Health, Run, Step, TrajectorySpec } from './types';

type Trace = { run: Run; steps: Step[] };

const otlp = import.meta.glob('../../samples/otel/*.otlp.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const native = import.meta.glob('../../eval/fixtures/*.trace.json', { eager: true, import: 'default' }) as Record<string, Trace>;

const traces = new Map<string, Trace>();
const add = (t: Trace) => traces.set(t.run.id, t);
for (const doc of Object.values(otlp)) for (const t of importOtlp(doc)) add(t as unknown as Trace);
for (const t of Object.values(native)) add(t);

const readOnly = () => Promise.reject(new Error('Read-only demo: recording and forking need the full server (docker compose up). Importing OTLP files works here.'));
const get = (id: string) => {
  const t = traces.get(id);
  if (!t) throw new Error('run not found');
  return t;
};

const health: Health = { ok: true, mode: 'simulated', model: 'static-demo', tools: [], defaultSystem: '' };

export const staticApi = {
  health: async () => health,
  listRuns: async () => ({ runs: [...traces.values()].map((t) => t.run).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }),
  getRun: async (id: string) => structuredClone(get(id)),
  createRun: (_body: { prompt: string; name?: string; system?: string }) => readOnly() as Promise<{ run: Run }>,
  forkRun: (..._args: unknown[]) => readOnly() as Promise<{ run: Run }>,
  deleteRun: (id: string) => readOnly().catch(() => ({ ok: traces.delete(id) })) as Promise<{ ok: boolean }>,
  importOtlp: async (doc: unknown) => {
    const imported = importOtlp(doc) as unknown as Trace[];
    imported.forEach(add);
    return { runs: imported.map((t) => t.run) };
  },
  compare: async (a: string, b: string, spec?: TrajectorySpec): Promise<CompareResult> => {
    const A = get(a);
    const B = get(b);
    const s = (spec ?? specFromRun(A.steps as never)) as never;
    const reportA = evaluateRun(A.run as never, A.steps as never, s);
    const reportB = evaluateRun(B.run as never, B.steps as never, s);
    return { spec: s, a: reportA, b: reportB, diff: diffEvaluations(reportA, reportB, { a: A.run.metrics, b: B.run.metrics }) } as unknown as CompareResult;
  },
  scenarios: async () => ({ scenarios: SCENARIOS.map(({ id, description, prompt, spec, expectPass }) => ({ id, description, prompt, spec, expectPass })) as unknown as EvalScenario[] }),
};
