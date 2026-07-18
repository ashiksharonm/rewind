import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Step } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.REWIND_DATA_DIR ?? join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'rewind.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS steps_by_run ON steps(run_id, idx);
`);

const insertRun = db.prepare('INSERT INTO runs (id, created_at, json) VALUES (?, ?, ?)');
const updateRunStmt = db.prepare('UPDATE runs SET json = ? WHERE id = ?');
const selectRun = db.prepare('SELECT json FROM runs WHERE id = ?');
const selectRuns = db.prepare('SELECT json FROM runs ORDER BY created_at DESC');
const insertStep = db.prepare('INSERT INTO steps (id, run_id, idx, json) VALUES (?, ?, ?, ?)');
const selectSteps = db.prepare('SELECT json FROM steps WHERE run_id = ? ORDER BY idx ASC');
const deleteRunStmt = db.prepare('DELETE FROM runs WHERE id = ?');
const deleteStepsStmt = db.prepare('DELETE FROM steps WHERE run_id = ?');

export const store = {
  createRun(run: Run): void {
    insertRun.run(run.id, run.createdAt, JSON.stringify(run));
  },
  updateRun(run: Run): void {
    updateRunStmt.run(JSON.stringify(run), run.id);
  },
  getRun(id: string): Run | undefined {
    const row = selectRun.get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Run) : undefined;
  },
  listRuns(): Run[] {
    return (selectRuns.all() as { json: string }[]).map((r) => JSON.parse(r.json) as Run);
  },
  addStep(step: Step): void {
    insertStep.run(step.id, step.runId, step.index, JSON.stringify(step));
  },
  getSteps(runId: string): Step[] {
    return (selectSteps.all(runId) as { json: string }[]).map((r) => JSON.parse(r.json) as Step);
  },
  deleteRun(id: string): void {
    deleteStepsStmt.run(id);
    deleteRunStmt.run(id);
  },
};
