import { store } from '../src/store.js';
import type { Driver, ModelTurn, WireMessage } from '../src/agent/driver.js';
import type { ContentBlock } from '../src/types.js';

export function waitForRun(id: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const run = store.getRun(id);
      if (run && run.status !== 'running') {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`run ${id} did not finish`));
      }
    }, 5);
  });
}

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Last tool_result content for a tool name, read from the wire history. */
function lastResultFor(messages: WireMessage[], toolName: string): string | undefined {
  const names = new Map<string, string>();
  let found: string | undefined;
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') names.set(b.id, b.name);
      if (b.type === 'tool_result' && names.get(b.tool_use_id) === toolName) found = b.content;
    }
  }
  return found;
}

/**
 * Scripted three-turn driver:
 *   turn 0 → two parallel tool calls (get_weather + convert_currency)
 *   turn 1 → one tool call (search_flights)
 *   turn 2 → final answer that quotes the weather result it saw
 * Records every message history it was asked to continue from.
 */
export function scriptedDriver(): Driver & { calls: WireMessage[][] } {
  let seq = 0;
  const calls: WireMessage[][] = [];
  const toolUse = (name: string, input: Record<string, unknown>): ContentBlock => ({
    type: 'tool_use',
    id: `toolu_${name}_${seq++}`,
    name,
    input,
  });
  return {
    model: 'scripted-test-model',
    calls,
    async next(_system, messages): Promise<ModelTurn> {
      calls.push(structuredClone(messages));
      const turn = messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) {
        return {
          content: [
            { type: 'text', text: 'checking weather and currency' },
            toolUse('get_weather', { city: 'Tokyo' }),
            toolUse('convert_currency', { amount: 2000, from: 'USD', to: 'JPY' }),
          ],
          stopReason: 'tool_use',
          usage,
        };
      }
      if (turn === 1) {
        return {
          content: [toolUse('search_flights', { origin: 'San Francisco', destination: 'Tokyo' })],
          stopReason: 'tool_use',
          usage,
        };
      }
      return {
        content: [{ type: 'text', text: `final: weather=${lastResultFor(messages, 'get_weather')}` }],
        stopReason: 'end_turn',
        usage,
      };
    },
  };
}
