import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CompareResult, EvalReport, EvalScenario, MetricDelta, TrajectorySpec } from '../types';

// Trajectory eval for the compare view: score both timelines under one spec
// and show which metrics the B timeline improved or regressed vs A.

const REFERENCE = '__reference__';

function fmt(m: MetricDelta, v: number | null): string {
  if (v === null) return '—';
  if (m.metric === 'pass' || m.metric === 'trajectory.matched') return v ? 'yes' : 'no';
  if (m.metric === 'costUsd') return `$${v.toFixed(4)}`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function fmtDelta(m: MetricDelta): string {
  if (m.delta === null || m.verdict === 'unchanged') return '';
  const d = m.metric === 'costUsd' ? m.delta.toFixed(4) : Number.isInteger(m.delta) ? String(m.delta) : m.delta.toFixed(2);
  return m.delta > 0 ? `+${d}` : d;
}

const VERDICT_LABEL: Record<MetricDelta['verdict'], string> = {
  improved: '▲ improved',
  regressed: '▼ regressed',
  unchanged: 'unchanged',
  'n/a': '—',
};

export function EvalPanel({ aId, bId, ready }: { aId: string; bId: string; ready: boolean }) {
  const [scenarios, setScenarios] = useState<EvalScenario[]>([]);
  const [source, setSource] = useState(REFERENCE);
  const [specText, setSpecText] = useState('');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (spec?: TrajectorySpec) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.compare(aId, bId, spec);
      setResult(r);
      setSpecText(JSON.stringify(r.spec, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api.scenarios().then((r) => setScenarios(r.scenarios)).catch(() => setScenarios([]));
  }, []);

  // Default: A's own trajectory is the reference; re-run once both runs finish.
  useEffect(() => {
    if (ready) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aId, bId, ready]);

  const pickSource = (value: string) => {
    setSource(value);
    if (value === REFERENCE) return void run();
    const sc = scenarios.find((s) => s.id === value);
    if (sc) void run(sc.spec);
  };

  const evaluateCustom = () => {
    try {
      void run(JSON.parse(specText) as TrajectorySpec);
    } catch {
      setError('Spec is not valid JSON');
    }
  };

  return (
    <div className="card eval-panel">
      <h2>Trajectory eval</h2>
      <p className="hint">
        Both timelines are scored against one expected trajectory: tool-call match, precision / recall with
        argument matching, efficiency, errors and retries, and final-answer checks. Verdicts are for B relative to A.
      </p>

      <div className="eval-controls">
        <label className="field-inline">
          Expected trajectory
          <select value={source} onChange={(e) => pickSource(e.target.value)} disabled={busy}>
            <option value={REFERENCE}>A’s tool calls (reference)</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                scenario · {s.id}
              </option>
            ))}
          </select>
        </label>
        {result && (
          <span className={`flip flip-${result.diff.passFlip}`}>
            A {result.a.pass ? 'PASS' : 'FAIL'} → B {result.b.pass ? 'PASS' : 'FAIL'} · {result.diff.passFlip}
          </span>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="eval-grid">
          <table className="eval-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>A</th>
                <th>B</th>
                <th>Δ</th>
                <th>B vs A</th>
              </tr>
            </thead>
            <tbody>
              {result.diff.metrics.map((m) => (
                <tr key={m.metric}>
                  <td className="mono">
                    {m.metric}
                    <span className="dir">{m.direction === 'higher' ? '↑ better' : '↓ better'}</span>
                  </td>
                  <td className="num">{fmt(m, m.a)}</td>
                  <td className="num">{fmt(m, m.b)}</td>
                  <td className="num">{fmtDelta(m)}</td>
                  <td>
                    <span className={`verdict v-${m.verdict}`}>{VERDICT_LABEL[m.verdict]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="eval-side">
            <Findings label="A" report={result.a} />
            <Findings label="B" report={result.b} />
            <details>
              <summary>Edit spec (JSON)</summary>
              <textarea className="mono" rows={12} value={specText} onChange={(e) => setSpecText(e.target.value)} />
              <button className="btn sm" onClick={evaluateCustom} disabled={busy}>
                Evaluate with this spec
              </button>
            </details>
          </div>
        </div>
      )}
      {!result && !error && <div className="empty">{ready ? 'Scoring…' : 'Waiting for both runs to finish…'}</div>}
    </div>
  );
}

function Findings({ label, report }: { label: string; report: EvalReport }) {
  const t = report.trajectory;
  const failedChecks = report.outcome.checks.filter((c) => !c.passed);
  const items: string[] = [
    ...(t?.missing ?? []).map((m) => `missing ${m.tool}(${JSON.stringify(m.args ?? {})})`),
    ...(t?.unexpected ?? []).map((u) => `unexpected #${u.index} ${u.tool}(${JSON.stringify(u.args)})`),
    ...failedChecks.map((c) => `outcome ${c.kind} “${c.value}” failed`),
    ...(report.forbidden.calls ? [`forbidden tools: ${report.forbidden.tools.join(', ')}`] : []),
    ...(report.efficiency.withinBudget === false ? ['over step / tool-call budget'] : []),
    ...(report.errors.runError ? [`run error: ${report.errors.runError}`] : []),
  ];
  return (
    <div className="findings">
      <div className="findings-head">
        <b>{label}</b> <span className={`verdict ${report.pass ? 'v-improved' : 'v-regressed'}`}>{report.pass ? 'PASS' : 'FAIL'}</span>
      </div>
      {items.length === 0 ? (
        <div className="muted">No trajectory or outcome issues.</div>
      ) : (
        <ul>
          {items.slice(0, 8).map((s) => (
            <li key={s} className="mono">
              {s}
            </li>
          ))}
          {items.length > 8 && <li className="muted">…and {items.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}
