// rewind CLI (no server needed).
//   rewind import <otlp.json>            convert and print a summary (--save writes into the local store)
//   rewind diff <A> <B> [--json]         A/B are a stored run id, a trace JSON ({run,steps}) or an OTLP/JSON file
//   rewind export <otlp.json> <out.json> write the converted trace(s) as {run,steps} JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { diffRuns, formatDiff } from './diff.js';
import { importOtlp, OtlpImportError, type ImportedTrace } from './otel/import.js';

// npm runs workspace scripts from server/; INIT_CWD is where the user invoked npm.
const cwd = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string) => resolvePath(cwd, p);
const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));

const usage = () => {
  console.error('usage: rewind import <otlp.json> [--save] | rewind diff <A> <B> [--json] | rewind export <otlp.json> <out.json>');
  process.exit(2);
};

function loadFile(path: string): ImportedTrace[] {
  const doc = JSON.parse(readFileSync(abs(path), 'utf8'));
  if (doc.resourceSpans) return importOtlp(doc);
  if (doc.run && doc.steps) return [doc as ImportedTrace];
  throw new Error(`${path}: neither OTLP/JSON nor a {run, steps} trace`);
}

async function resolve(ref: string): Promise<ImportedTrace> {
  try {
    return loadFile(ref)[0];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { store } = await import('./store.js'); // opens the SQLite store only when needed
  const run = store.getRun(ref);
  if (!run) throw new Error(`"${ref}" is neither a file nor a stored run id`);
  return { run, steps: store.getSteps(ref) };
}

try {
  if (cmd === 'import' && pos[0]) {
    const traces = loadFile(pos[0]);
    if (flags.has('--save')) {
      const { store } = await import('./store.js');
      for (const t of traces) store.saveTrace(t.run, t.steps);
    }
    for (const t of traces) {
      const m = t.run.metrics;
      console.log(`${t.run.id}  ${t.run.name}  steps=${t.steps.length} llm=${m.llmCalls} tools=${m.toolCalls} tokens=${m.inputTokens + m.outputTokens}${flags.has('--save') ? '  (saved)' : ''}`);
    }
  } else if (cmd === 'diff' && pos.length === 2) {
    const d = diffRuns(await resolve(pos[0]), await resolve(pos[1]));
    console.log(flags.has('--json') ? JSON.stringify(d, null, 2) : formatDiff(d));
    process.exit(d.identical ? 0 : 1);
  } else if (cmd === 'export' && pos.length === 2) {
    const traces = loadFile(pos[0]);
    writeFileSync(abs(pos[1]), JSON.stringify(traces.length === 1 ? traces[0] : traces, null, 2) + '\n');
  } else usage();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof OtlpImportError ? 3 : 2);
}
