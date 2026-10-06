import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Run, Step } from '../types';
import { fmtCost, fmtDuration, fmtTokens } from '../format';
import { StepCard } from './StepCard';
import { EvalPanel } from './EvalPanel';

// Signature used to detect where two timelines diverge.
function sig(s: Step): string {
  if (s.type === 'prompt') return `p|${s.system}|${s.userMessage}`;
  if (s.type === 'llm_call') return `l|${JSON.stringify(s.content)}`;
  return `t|${s.toolName}|${JSON.stringify(s.input)}|${s.result}`;
}

export function CompareView({ aId, bId }: { aId: string; bId: string }) {
  const [a, setA] = useState<{ run: Run; steps: Step[] } | null>(null);
  const [b, setB] = useState<{ run: Run; steps: Step[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getRun(aId), api.getRun(bId)])
      .then(([ra, rb]) => {
        setA(ra);
        setB(rb);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [aId, bId]);

  useEffect(() => {
    // keep polling if either side is still running
    if (a?.run.status !== 'running' && b?.run.status !== 'running') return;
    const t = setInterval(() => {
      Promise.all([api.getRun(aId), api.getRun(bId)]).then(([ra, rb]) => {
        setA(ra);
        setB(rb);
      });
    }, 1500);
    return () => clearInterval(t);
  }, [a?.run.status, b?.run.status, aId, bId]);

  if (error) return <div className="error-box">{error}</div>;
  if (!a || !b) return <div className="empty">Loading timelines…</div>;

  const maxLen = Math.max(a.steps.length, b.steps.length);
  let divergeAt = maxLen;
  for (let i = 0; i < maxLen; i++) {
    const sa = a.steps[i];
    const sb = b.steps[i];
    if (!sa || !sb || sig(sa) !== sig(sb)) {
      divergeAt = i;
      break;
    }
  }

  const deltaCost = b.run.metrics.costUsd - a.run.metrics.costUsd;
  const deltaTokens =
    b.run.metrics.inputTokens + b.run.metrics.outputTokens -
    (a.run.metrics.inputTokens + a.run.metrics.outputTokens);

  return (
    <div className="section-gap">
      <div className="crumbs">
        <a href="#/">Traces</a> / compare
      </div>

      <div className="card">
        <div className="run-header">
          <div style={{ flex: 1 }}>
            <h1>⇆ Timeline comparison</h1>
            <div className="metrics">
              <span className="metric">
                shared prefix <b>{divergeAt}</b> step{divergeAt === 1 ? '' : 's'}
              </span>
              <span className="metric">
                Δ tokens <b>{deltaTokens >= 0 ? '+' : ''}{fmtTokens(Math.abs(deltaTokens)) === '0' ? '0' : `${deltaTokens >= 0 ? '' : '-'}${fmtTokens(Math.abs(deltaTokens))}`}</b>
              </span>
              <span className="metric">
                Δ cost <b>{deltaCost >= 0 ? '+' : '-'}{fmtCost(Math.abs(deltaCost))}</b>
              </span>
            </div>
          </div>
        </div>
      </div>

      <EvalPanel aId={aId} bId={bId} ready={a.run.status !== 'running' && b.run.status !== 'running'} />

      <div className="compare-grid">
        <div>
          <ColHead run={a.run} label="A" />
        </div>
        <div>
          <ColHead run={b.run} label="B" />
        </div>

        {/* shared prefix, aligned row by row */}
        {Array.from({ length: divergeAt }).map((_, i) => (
          <FragmentRow key={`shared-${i}`} left={a.steps[i]} right={b.steps[i]} />
        ))}

        {divergeAt < maxLen && <div className="divergence-rule">timelines diverge here</div>}

        {/* divergent tails, aligned by offset from the divergence point */}
        {Array.from({ length: maxLen - divergeAt }).map((_, j) => {
          const i = divergeAt + j;
          return <FragmentRow key={`tail-${i}`} left={a.steps[i]} right={b.steps[i]} diverged />;
        })}
      </div>
    </div>
  );
}

function ColHead({ run, label }: { run: Run; label: string }) {
  return (
    <a className="compare-col-head" href={`#/run/${run.id}`} style={{ display: 'block' }}>
      <div className="t">
        {label} · {run.parentRunId && <span className="fork-glyph">⑂</span>}
        {run.name}
      </div>
      <div className="s">
        {run.id} · {run.status} · {fmtTokens(run.metrics.inputTokens + run.metrics.outputTokens)} tok ·{' '}
        {fmtCost(run.metrics.costUsd)} · {fmtDuration(run.metrics.durationMs)}
      </div>
    </a>
  );
}

function FragmentRow({ left, right, diverged }: { left?: Step; right?: Step; diverged?: boolean }) {
  return (
    <>
      <div>
        {left ? (
          <StepCard step={left} compact diverged={diverged} />
        ) : (
          <div className="step-slot-empty">— no step —</div>
        )}
      </div>
      <div>
        {right ? (
          <StepCard step={right} compact diverged={diverged} />
        ) : (
          <div className="step-slot-empty">— no step —</div>
        )}
      </div>
    </>
  );
}
