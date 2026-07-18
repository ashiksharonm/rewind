import { useRef, useState } from 'react';
import type { Run } from '../types';
import { fmtTokens } from '../format';

// Stacked bar chart: input vs output tokens per run.
// Colors are categorical slots 1–2 of the validated dark palette; marks follow
// the dataviz specs (thin bars, 2px surface gaps between segments, 4px rounded
// data-end on the top segment, hairline grid, hover tooltip, legend).

const SERIES = [
  { key: 'inputTokens' as const, label: 'Input tokens', color: 'var(--series-1)', hex: '#3987e5' },
  { key: 'outputTokens' as const, label: 'Output tokens', color: 'var(--series-2)', hex: '#008300' },
];

interface Tip {
  x: number;
  y: number;
  run: Run;
}

export function TokensChart({ runs }: { runs: Run[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const data = [...runs]
    .filter((r) => r.metrics.inputTokens + r.metrics.outputTokens > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-12);

  if (data.length === 0) {
    return <div className="empty">No token usage recorded yet — launch a run below.</div>;
  }

  const H = 210;
  const padL = 44;
  const padB = 34;
  const padT = 12;
  const slot = 58;
  const barW = 18;
  const W = padL + data.length * slot + 12;
  const plotH = H - padT - padB;

  const maxVal = Math.max(...data.map((r) => r.metrics.inputTokens + r.metrics.outputTokens));
  // round the axis max up to a tidy number
  const pow = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const axisMax = Math.ceil(maxVal / pow) * pow;
  const y = (v: number) => padT + plotH - (v / axisMax) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * axisMax);

  const onEnter = (e: React.MouseEvent<SVGGElement>, run: Run) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const bar = (e.currentTarget as SVGGElement).getBoundingClientRect();
    if (!wrap) return;
    setTip({ x: bar.left - wrap.left + bar.width / 2, y: bar.top - wrap.top, run });
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H} role="img" aria-label="Input and output tokens per run">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--baseline)' : 'var(--grid)'} strokeWidth={1} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtTokens(t)}
              </text>
            </g>
          ))}
          {data.map((run, i) => {
            const cx = padL + i * slot + slot / 2;
            const x0 = cx - barW / 2;
            const inTop = y(run.metrics.inputTokens);
            const totTop = y(run.metrics.inputTokens + run.metrics.outputTokens);
            const gap = 2; // surface gap between stacked segments
            const label = run.name.length > 9 ? `${run.name.slice(0, 8)}…` : run.name;
            const outH = Math.max(0, inTop - gap - totTop);
            return (
              <g
                key={run.id}
                onMouseEnter={(e) => onEnter(e, run)}
                onMouseLeave={() => setTip(null)}
                style={{ cursor: 'pointer' }}
                onClick={() => (window.location.hash = `#/run/${run.id}`)}
              >
                {/* invisible hit target, wider than the mark */}
                <rect x={cx - slot / 2} y={padT} width={slot} height={plotH + padB} fill="transparent" />
                {/* input segment — anchored to baseline, square ends */}
                <rect x={x0} y={inTop} width={barW} height={Math.max(0.5, y(0) - inTop)} fill={SERIES[0].color} />
                {/* output segment — data end, 4px rounded top */}
                {outH > 0 && (
                  <path
                    d={`M ${x0} ${totTop + outH} L ${x0} ${totTop + 4} Q ${x0} ${totTop} ${x0 + 4} ${totTop} L ${x0 + barW - 4} ${totTop} Q ${x0 + barW} ${totTop} ${x0 + barW} ${totTop + 4} L ${x0 + barW} ${totTop + outH} Z`}
                    fill={SERIES[1].color}
                  />
                )}
                {run.parentRunId && (
                  <text x={cx} y={totTop - 6} textAnchor="middle" fontSize={11} fill="var(--violet)">
                    ⑂
                  </text>
                )}
                <text x={cx} y={H - padB + 16} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend">
        {SERIES.map((s) => (
          <span className="li" key={s.key}>
            <span className="sw" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      {tip && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(tip.x + 12, (wrapRef.current?.clientWidth ?? 400) - 170), top: Math.max(0, tip.y - 8) }}
        >
          <div className="tt-title">{tip.run.name}</div>
          {SERIES.map((s) => (
            <div className="tt-row" key={s.key}>
              <span className="sw" style={{ background: s.color }} />
              {s.label.replace(' tokens', '')}
              <span className="v">{tip.run.metrics[s.key].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
