// `npm run eval:trace -- <trace.json> [spec.json]` — score an exported trace
// offline. A trace file is exactly what `GET /api/runs/:id` returns.
import { readFileSync } from 'node:fs';
import { evaluateRun, type TrajectorySpec } from './trajectory.js';
import type { Run, Step } from '../types.js';

const [tracePath, specPath] = process.argv.slice(2);
if (!tracePath) {
  console.error('usage: npm run eval:trace -- <trace.json> [spec.json]');
  process.exit(2);
}
const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as { run: Run; steps: Step[] };
const spec = specPath ? (JSON.parse(readFileSync(specPath, 'utf8')) as TrajectorySpec) : undefined;
const report = evaluateRun(trace.run, trace.steps, spec);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
