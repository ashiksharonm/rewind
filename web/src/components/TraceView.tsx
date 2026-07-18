import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ForkEdit, Run, Step, ToolStep, PromptStep } from '../types';
import { fmtCost, fmtDuration, fmtTokens, timeAgo } from '../format';
import { StepCard } from './StepCard';

interface ForkTarget {
  step: Step;
}

export function TraceView({ runId }: { runId: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forkTarget, setForkTarget] = useState<ForkTarget | null>(null);

  const load = useCallback(() => {
    api
      .getRun(runId)
      .then(({ run, steps }) => {
        setRun(run);
        setSteps(steps);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the run is still executing so the timeline grows live.
  useEffect(() => {
    if (run?.status !== 'running') return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
  }, [run?.status, load]);

  if (error) return <div className="error-box">{error}</div>;
  if (!run) return <div className="empty">Loading trace…</div>;

  const canFork = run.status !== 'running';

  return (
    <div className="section-gap">
      <div className="crumbs">
        <a href="#/">Traces</a> / {run.id}
      </div>

      <div className="card">
        <div className="run-header">
          <div style={{ flex: 1 }}>
            <h1>
              {run.parentRunId && <span className="fork-glyph">⑂</span>}
              {run.name}
            </h1>
            <div className="metrics">
              <span className="status-pill">
                <span className={`dot ${run.status}`} />
                {run.status}
              </span>
              <span className="metric">
                model <b>{run.model}</b>
              </span>
              <span className="metric">
                tokens <b>{fmtTokens(run.metrics.inputTokens + run.metrics.outputTokens)}</b>
              </span>
              <span className="metric">
                cost <b>{fmtCost(run.metrics.costUsd)}</b>
              </span>
              <span className="metric">
                agent time <b>{fmtDuration(run.metrics.durationMs)}</b>
              </span>
              <span className="metric">
                created <b>{timeAgo(run.createdAt)}</b>
              </span>
            </div>
          </div>
          <div className="row">
            {run.parentRunId && (
              <a className="btn" href={`#/compare/${run.parentRunId}/${run.id}`}>
                ⇆ Compare with parent
              </a>
            )}
          </div>
        </div>
        {run.error && (
          <div className="error-box mt">
            Run failed: {run.error}
          </div>
        )}
      </div>

      {run.parentRunId && (
        <div className="fork-banner">
          <span style={{ fontSize: 16 }}>⑂</span>
          <span>
            Forked from <a href={`#/run/${run.parentRunId}`} style={{ textDecoration: 'underline' }}>{run.parentRunId}</a>{' '}
            at step #{run.forkAtIndex} —{' '}
            {run.edit?.type === 'tool_result'
              ? 'tool result rewritten, future re-executed'
              : run.edit?.type === 'reroll'
                ? 'model turn re-sampled'
                : 'prompt edited, run replayed'}
          </span>
        </div>
      )}

      <div>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)' }}>
            Timeline · {steps.length} steps
          </h2>
          {!canFork && <span className="step-meta">forking available when the run finishes</span>}
        </div>
        <div className="timeline">
          {steps.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              actions={
                canFork ? (
                  <button className="btn sm" onClick={() => setForkTarget({ step })}>
                    {step.type === 'prompt' ? '⑂ Edit prompt' : step.type === 'llm_call' ? '⑂ Reroll' : '⑂ Edit result'}
                  </button>
                ) : undefined
              }
            />
          ))}
          {run.status === 'running' && (
            <div className="step" style={{ borderStyle: 'dashed' }}>
              <div className="step-head">
                <span className="status-pill">
                  <span className="dot running" />
                  agent working…
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {forkTarget && (
        <ForkDialog
          run={run}
          step={forkTarget.step}
          onClose={() => setForkTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fork dialog — the "time machine" control panel.
// ---------------------------------------------------------------------------
function ForkDialog({ run, step, onClose }: { run: Run; step: Step; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolResult, setToolResult] = useState(() =>
    step.type === 'tool_call' ? tryPretty((step as ToolStep).result) : '',
  );
  const [userMessage, setUserMessage] = useState(() =>
    step.type === 'prompt' ? (step as PromptStep).userMessage : '',
  );
  const [system, setSystem] = useState(() => (step.type === 'prompt' ? (step as PromptStep).system : ''));

  const submit = async () => {
    setBusy(true);
    setError(null);
    let edit: ForkEdit;
    if (step.type === 'tool_call') {
      edit = { type: 'tool_result', newResult: tryMinify(toolResult) };
    } else if (step.type === 'llm_call') {
      edit = { type: 'reroll' };
    } else {
      edit = { type: 'prompt', newUserMessage: userMessage, newSystem: system };
    }
    try {
      const { run: fork } = await api.forkRun(run.id, step.index, edit);
      window.location.hash = `#/run/${fork.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {step.type === 'tool_call' && (
          <>
            <h3>⑂ Rewind &amp; edit tool result</h3>
            <p className="hint">
              Steps 0–{step.index} are replayed from the recording with your edited result for{' '}
              <code>{(step as ToolStep).toolName}</code>; everything after re-executes for real. The original
              run is untouched.
            </p>
            <div className="field">
              <label>New result for {(step as ToolStep).toolName}</label>
              <textarea className="mono" rows={8} value={toolResult} onChange={(e) => setToolResult(e.target.value)} />
            </div>
          </>
        )}
        {step.type === 'llm_call' && (
          <>
            <h3>⑂ Reroll from step #{step.index}</h3>
            <p className="hint">
              The trace before this model turn is replayed from the recording; this turn and everything after
              it is re-sampled. Use it to answer "would the agent do this again?"
            </p>
          </>
        )}
        {step.type === 'prompt' && (
          <>
            <h3>⑂ Edit prompt &amp; replay</h3>
            <p className="hint">The whole run re-executes with your edited prompt, as a new timeline.</p>
            <div className="field">
              <label>User message</label>
              <textarea rows={3} value={userMessage} onChange={(e) => setUserMessage(e.target.value)} />
            </div>
            <div className="field">
              <label>System prompt</label>
              <textarea className="mono" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} />
            </div>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Forking…' : '⑂ Fork timeline'}
          </button>
        </div>
      </div>
    </div>
  );
}

function tryPretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
function tryMinify(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return s;
  }
}
