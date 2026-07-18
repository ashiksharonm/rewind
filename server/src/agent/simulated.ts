import type { Driver, ModelTurn, WireMessage } from './driver.js';
import type { ContentBlock, Usage } from '../types.js';

// Deterministic simulated model, used when no Anthropic credentials are
// present so the full record → fork → replay → compare loop still works
// end-to-end. Tool calls still go through the real MCP server; only the LLM
// turns are scripted. The final summary is synthesized from whatever tool
// results are in the history — so a fork that edits a tool result produces a
// visibly different ending, exactly like a live model would.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const CITY_META: Record<string, { country: string; currency: string }> = {
  tokyo: { country: 'Japan', currency: 'JPY' },
  kyoto: { country: 'Japan', currency: 'JPY' },
  paris: { country: 'France', currency: 'EUR' },
  london: { country: 'United Kingdom', currency: 'GBP' },
  mumbai: { country: 'India', currency: 'INR' },
  bangalore: { country: 'India', currency: 'INR' },
  sydney: { country: 'Australia', currency: 'AUD' },
  singapore: { country: 'Singapore', currency: 'SGD' },
  berlin: { country: 'Germany', currency: 'EUR' },
  rome: { country: 'Italy', currency: 'EUR' },
};

function extractCities(prompt: string): { origin: string; destination: string } {
  const lower = prompt.toLowerCase();
  const fromMatch = prompt.match(/from\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
  const origin = fromMatch ? fromMatch[1] : 'San Francisco';
  // Destination = earliest known city in the prompt that isn't the origin.
  let destination = 'Tokyo';
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const city of Object.keys(CITY_META)) {
    const idx = lower.indexOf(city);
    if (idx >= 0 && idx < bestIdx && city !== origin.toLowerCase()) {
      bestIdx = idx;
      destination = city[0].toUpperCase() + city.slice(1);
    }
  }
  return { origin, destination };
}

function firstUserText(messages: WireMessage[]): string {
  const first = messages[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  const t = first.content.find((b) => b.type === 'text') as { text?: string } | undefined;
  return t?.text ?? '';
}

function collectToolResults(messages: WireMessage[]): Map<string, unknown> {
  // Map tool_use id -> parsed result, plus tool name -> parsed result.
  const inputsById = new Map<string, { name: string }>();
  const results = new Map<string, unknown>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') inputsById.set(block.id, { name: block.name });
      if (block.type === 'tool_result') {
        const meta = inputsById.get(block.tool_use_id);
        if (!meta) continue;
        try {
          results.set(meta.name, JSON.parse(block.content));
        } catch {
          results.set(meta.name, block.content);
        }
      }
    }
  }
  return results;
}

function fabricateUsage(messages: WireMessage[], content: ContentBlock[]): Usage {
  const inChars = JSON.stringify(messages).length;
  const outChars = JSON.stringify(content).length;
  return {
    inputTokens: Math.max(60, Math.round(inChars / 4)),
    outputTokens: Math.max(20, Math.round(outChars / 4)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

let turnCounter = 0;

export const simulatedDriver: Driver = {
  model: 'simulated-agent-v1',
  async next(_system, messages, _tools): Promise<ModelTurn> {
    const assistantTurns = messages.filter((m) => m.role === 'assistant').length;
    const prompt = firstUserText(messages);
    const { origin, destination } = extractCities(prompt);
    const meta = CITY_META[destination.toLowerCase()] ?? { country: 'Japan', currency: 'JPY' };
    const seed = hash(prompt + assistantTurns);
    const mkId = (n: string) => `toolu_sim_${hash(`${seed}-${n}-${turnCounter++}`).toString(16)}`;

    await sleep(150 + (seed % 350)); // plausible latency, deterministic per turn

    let content: ContentBlock[];
    let stopReason = 'tool_use';

    if (assistantTurns === 0) {
      const intros = [
        `I'll help plan this trip to ${destination}. Let me start by checking the weather and your budget in local currency.`,
        `Planning your ${destination} trip — first I'll pull the forecast and convert your budget to ${meta.currency}.`,
        `Let me research ${destination}: current weather first, then budget conversion.`,
      ];
      content = [
        { type: 'text', text: intros[seed % intros.length] },
        { type: 'tool_use', id: mkId('w'), name: 'get_weather', input: { city: destination } },
        {
          type: 'tool_use',
          id: mkId('c'),
          name: 'convert_currency',
          input: { amount: 2000, from: 'USD', to: meta.currency },
        },
      ];
    } else if (assistantTurns === 1) {
      content = [
        { type: 'text', text: `Now let me find flights from ${origin} and check the travel advisory for ${meta.country}.` },
        {
          type: 'tool_use',
          id: mkId('f'),
          name: 'search_flights',
          input: { origin, destination },
        },
        {
          type: 'tool_use',
          id: mkId('a'),
          name: 'get_travel_advisory',
          input: { country: meta.country },
        },
      ];
    } else {
      // Final turn: synthesize from actual tool results in the history so
      // edited results propagate into the conclusion.
      const results = collectToolResults(messages);
      const weather = results.get('get_weather') as
        | { tempC?: number; condition?: string; city?: string }
        | string
        | undefined;
      const currency = results.get('convert_currency') as
        | { converted?: number; to?: string; amount?: number; from?: string }
        | string
        | undefined;
      const flights = results.get('search_flights') as
        | { flights?: Array<{ airline: string; flight: string; priceUsd: number; stops: number; departLocal: string }> }
        | string
        | undefined;
      const advisory = results.get('get_travel_advisory') as
        | { level?: number; notes?: string }
        | string
        | undefined;

      const lines: string[] = [`Here's your ${destination} trip plan:`, ''];
      if (weather && typeof weather === 'object' && weather.tempC !== undefined) {
        lines.push(
          `**Weather** — ${weather.tempC}°C and ${weather.condition ?? 'variable'}. ` +
            (weather.tempC < 12
              ? 'Pack warm layers.'
              : weather.tempC > 26
                ? 'Pack light; it will be warm.'
                : 'Mild — a light jacket will do.'),
        );
      } else if (weather) {
        lines.push(`**Weather** — ${typeof weather === 'string' ? weather : JSON.stringify(weather)}`);
      }
      if (currency && typeof currency === 'object' && currency.converted !== undefined) {
        lines.push(
          `**Budget** — your ${currency.amount ?? 2000} ${currency.from ?? 'USD'} is about ${currency.converted.toLocaleString()} ${currency.to ?? meta.currency}.`,
        );
      }
      if (flights && typeof flights === 'object' && flights.flights?.length) {
        const best = [...flights.flights].sort((a, b) => a.priceUsd - b.priceUsd)[0];
        lines.push(
          `**Flights** — best option is ${best.airline} ${best.flight}, departing ${best.departLocal} at $${best.priceUsd} (${best.stops === 0 ? 'nonstop' : `${best.stops} stop`}). ${flights.flights.length} options found.`,
        );
      }
      if (advisory && typeof advisory === 'object' && advisory.level !== undefined) {
        lines.push(`**Advisory** — level ${advisory.level}: ${advisory.notes ?? ''}`);
      }
      lines.push('', 'Want me to build a day-by-day itinerary next?');
      content = [{ type: 'text', text: lines.join('\n') }];
      stopReason = 'end_turn';
    }

    return { content, stopReason, usage: fabricateUsage(messages, content) };
  },
};
