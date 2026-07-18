import type { Step } from '../types';
import { fmtCost, fmtDuration, fmtTokens } from '../format';

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const TYPE_LABEL: Record<Step['type'], string> = {
  prompt: 'Prompt',
  llm_call: 'Model turn',
  tool_call: 'MCP tool call',
};

const TYPE_BADGE: Record<Step['type'], string> = {
  prompt: 'prompt',
  llm_call: 'llm',
  tool_call: 'tool',
};

export function StepCard({
  step,
  actions,
  diverged,
  compact,
}: {
  step: Step;
  actions?: React.ReactNode;
  diverged?: boolean;
  compact?: boolean;
}) {
  const isError = step.type === 'tool_call' && step.isError;
  const isEdited = step.type === 'tool_call' && step.edited;

  return (
    <div
      className={[
        'step',
        step.type,
        isError ? 'is-error' : '',
        isEdited ? 'is-edited' : '',
        diverged ? 'diverged' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="step-head">
        <span className={`badge ${TYPE_BADGE[step.type]}`}>{TYPE_BADGE[step.type]}</span>
        <span className="step-title">
          {step.type === 'tool_call' ? step.toolName : TYPE_LABEL[step.type]}
        </span>
        {isEdited && <span className="badge edited">edited in fork</span>}
        {isError && <span className="badge error">error</span>}
        <span className="grow" />
        <span className="step-meta">
          #{step.index}
          {step.type === 'llm_call' &&
            ` · ${fmtTokens(step.usage.inputTokens)} in / ${fmtTokens(step.usage.outputTokens)} out` +
              (step.costUsd > 0 ? ` · ${fmtCost(step.costUsd)}` : '')}
          {step.durationMs > 0 && ` · ${fmtDuration(step.durationMs)}`}
        </span>
        {actions}
      </div>

      <div className="step-body">
        {step.type === 'prompt' && (
          <>
            <div className="step-text">{step.userMessage}</div>
            {!compact && (
              <details className="collapsible">
                <summary>System prompt</summary>
                <pre className="step-json">{step.system}</pre>
              </details>
            )}
          </>
        )}

        {step.type === 'llm_call' && (
          <>
            {step.content.map((block, i) =>
              block.type === 'text' ? (
                <div className="step-text" key={i}>
                  {block.text}
                </div>
              ) : (
                <div key={i}>
                  <span className="tool-chip">→ {block.name}</span>
                  {!compact && <pre className="step-json">{JSON.stringify(block.input, null, 2)}</pre>}
                </div>
              ),
            )}
            {!compact && (
              <div className="step-meta" style={{ marginTop: 6 }}>
                {step.model} · stop: {step.stopReason}
              </div>
            )}
          </>
        )}

        {step.type === 'tool_call' && (
          <>
            {!compact && (
              <>
                <div className="kv">input</div>
                <pre className="step-json">{JSON.stringify(step.input, null, 2)}</pre>
              </>
            )}
            <div className="kv">result</div>
            <pre className="step-json">{prettyJson(step.result)}</pre>
          </>
        )}
      </div>
    </div>
  );
}
