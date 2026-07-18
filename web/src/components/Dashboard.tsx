import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Health, Run } from '../types';
import { fmtCost, fmtDuration, fmtTokens, timeAgo } from '../format';
import { TokensChart } from './TokensChart';

const SUGGESTIONS = [
  'Plan a 4-day trip to Tokyo from San Francisco on a $2000 budget.',
  'Plan a romantic long weekend in Paris from London.',
  'Plan a two-week food tour of Rome from Berlin.',
];

export function Dashboard({ health }: { health: Health | null }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listRuns().then((r) => setRuns(r.runs)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const launch = async () => {
    if (!prompt.trim()) return;
    setLaunching(true);
    setError(null);
    try {
      const { run } = await api.createRun({ prompt, system: system || undefined });
      window.location.hash = `#/run/${run.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await api.deleteRun(id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const forks = runs.filter((r) => r.parentRunId).length;
  const totals = runs.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.metrics.inputTokens + r.metrics.outputTokens,
      cost: acc.cost + r.metrics.costUsd,
      duration: acc.duration + r.metrics.durationMs,
      toolCalls: acc.toolCalls + r.metrics.toolCalls,
    }),
    { tokens: 0, cost: 0, duration: 0, toolCalls: 0 },
  );

  return (
    <div className="section-gap">
      <div className="tiles">
        <div className="tile">
          <div className="label">Runs recorded</div>
          <div className="value">{runs.length}</div>
          <div className="detail">{forks} fork{forks === 1 ? '' : 's'}</div>
        </div>
        <div className="tile">
          <div className="label">Tokens traced</div>
          <div className="value">{fmtTokens(totals.tokens)}</div>
          <div className="detail">{totals.toolCalls} MCP tool calls</div>
        </div>
        <div className="tile">
          <div className="label">Spend</div>
          <div className="value">{fmtCost(totals.cost)}</div>
          <div className="detail">{health?.mode === 'live' ? health.model : 'simulated runs are free'}</div>
        </div>
        <div className="tile">
          <div className="label">Agent time</div>
          <div className="value">{fmtDuration(totals.duration)}</div>
          <div className="detail">
            avg {fmtDuration(runs.length ? Math.round(totals.duration / runs.length) : 0)} / run
          </div>
        </div>
      </div>

      <div className="card">
        <h2>New run</h2>
        <p className="hint">
          The demo agent plans trips using {health?.tools.length ?? 4} MCP tools
          {health ? ` (${health.tools.join(', ')})` : ''}. Every model turn and tool call is recorded as a
          replayable trace.
        </p>
        <div className="field">
          <textarea
            rows={2}
            placeholder="Describe a trip to plan…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="btn ghost sm" onClick={() => setPrompt(s)}>
              {s.slice(0, 44)}…
            </button>
          ))}
        </div>
        <details className="collapsible" style={{ marginBottom: 12 }}>
          <summary>Custom system prompt (optional)</summary>
          <div className="mt">
            <textarea
              className="mono"
              rows={3}
              placeholder={health?.defaultSystem ?? 'System prompt…'}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
            />
          </div>
        </details>
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" onClick={launch} disabled={launching || !prompt.trim()}>
          {launching ? 'Launching…' : '▶ Launch run'}
        </button>
      </div>

      <div className="card">
        <h2>Tokens per run</h2>
        <p className="hint">Last 12 runs, oldest → newest. ⑂ marks forks. Click a bar to open its trace.</p>
        <TokensChart runs={runs} />
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '18px 20px 6px' }}>
          <h2>Trace library</h2>
          <p className="hint">Every run is a replayable trace. Open one to inspect, fork, and compare timelines.</p>
        </div>
        {runs.length === 0 ? (
          <div className="empty" style={{ margin: 20 }}>
            No runs yet. Launch one above, or run <code>npm run seed</code> for demo traces.
          </div>
        ) : (
          <table className="runs">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th className="num">LLM · tools</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Duration</th>
                <th className="num">Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => (window.location.hash = `#/run/${r.id}`)}>
                  <td>
                    <span className="run-name">
                      {r.parentRunId && <span className="fork-glyph">⑂</span>}
                      {r.name}
                    </span>
                    <div className="run-sub">
                      {r.id} · {r.mode}
                    </div>
                  </td>
                  <td>
                    <span className="status-pill">
                      <span className={`dot ${r.status}`} />
                      {r.status}
                    </span>
                  </td>
                  <td className="num">
                    {r.metrics.llmCalls} · {r.metrics.toolCalls}
                  </td>
                  <td className="num">{fmtTokens(r.metrics.inputTokens + r.metrics.outputTokens)}</td>
                  <td className="num">{fmtCost(r.metrics.costUsd)}</td>
                  <td className="num">{fmtDuration(r.metrics.durationMs)}</td>
                  <td className="num">{timeAgo(r.createdAt)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {r.parentRunId && (
                      <a
                        href={`#/compare/${r.parentRunId}/${r.id}`}
                        className="btn ghost sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        compare
                      </a>
                    )}
                    <button className="btn ghost sm" title="Delete run" onClick={(e) => remove(e, r.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
