// Rewind demo MCP server (stdio transport).
// Tools are deterministic — same input always yields the same output — so a
// replayed prefix and a re-executed tool call agree, which is what makes
// fork-and-compare meaningful.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const server = new McpServer({ name: 'rewind-demo-tools', version: '1.0.0' });

const CONDITIONS = ['clear skies', 'partly cloudy', 'light rain', 'overcast', 'sunny with a breeze'];

server.registerTool(
  'get_weather',
  {
    description: 'Get the current weather forecast for a city.',
    inputSchema: { city: z.string().describe('City name, e.g. Tokyo') },
  },
  async ({ city }) => {
    const h = hash(city.toLowerCase().trim());
    const tempC = 8 + (h % 24);
    const cond = CONDITIONS[h % CONDITIONS.length];
    const humidity = 40 + (h % 45);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ city, tempC, condition: cond, humidityPct: humidity }),
        },
      ],
    };
  },
);

const RATES = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 158.4, INR: 86.1, AUD: 1.53, SGD: 1.34 };

server.registerTool(
  'convert_currency',
  {
    description: 'Convert an amount between currencies (USD, EUR, GBP, JPY, INR, AUD, SGD).',
    inputSchema: {
      amount: z.number().describe('Amount to convert'),
      from: z.string().describe('Source currency code, e.g. USD'),
      to: z.string().describe('Target currency code, e.g. JPY'),
    },
  },
  async ({ amount, from, to }) => {
    const f = RATES[from.toUpperCase()];
    const t = RATES[to.toUpperCase()];
    if (f === undefined || t === undefined) {
      return {
        content: [{ type: 'text', text: `Unsupported currency: ${f === undefined ? from : to}` }],
        isError: true,
      };
    }
    const converted = Math.round((amount / f) * t * 100) / 100;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ amount, from: from.toUpperCase(), to: to.toUpperCase(), converted, rate: Math.round((t / f) * 10000) / 10000 }),
        },
      ],
    };
  },
);

const AIRLINES = ['Meridian Air', 'Pacifica', 'Northwind', 'Atlas Airways', 'Corvette Jet'];

server.registerTool(
  'search_flights',
  {
    description: 'Search available flights between two cities on a given date.',
    inputSchema: {
      origin: z.string().describe('Origin city'),
      destination: z.string().describe('Destination city'),
      date: z.string().optional().describe('Travel date, YYYY-MM-DD'),
    },
  },
  async ({ origin, destination, date }) => {
    const h = hash(`${origin}|${destination}|${date ?? ''}`.toLowerCase());
    const flights = [0, 1, 2].map((i) => {
      const hh = hash(`${h}-${i}`);
      return {
        airline: AIRLINES[hh % AIRLINES.length],
        flight: `${String.fromCharCode(65 + (hh % 26))}${String.fromCharCode(65 + ((hh >>> 5) % 26))}${100 + (hh % 900)}`,
        departLocal: `${String(6 + (hh % 14)).padStart(2, '0')}:${String((hh >>> 3) % 60).padStart(2, '0')}`,
        durationH: Math.round((3 + (hh % 11) + ((hh >>> 7) % 10) / 10) * 10) / 10,
        priceUsd: 180 + (hh % 900),
        stops: hh % 3 === 0 ? 0 : 1,
      };
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ origin, destination, date: date ?? null, flights }) }],
    };
  },
);

server.registerTool(
  'get_travel_advisory',
  {
    description: 'Get the current travel advisory level and notes for a country.',
    inputSchema: { country: z.string().describe('Country name') },
  },
  async ({ country }) => {
    const h = hash(country.toLowerCase().trim());
    const level = 1 + (h % 3); // 1..3, deterministic
    const notes = [
      'Exercise normal precautions.',
      'Exercise increased caution in crowded areas.',
      'Reconsider travel to certain regions; check local guidance.',
    ][level - 1];
    return {
      content: [{ type: 'text', text: JSON.stringify({ country, level, notes }) }],
    };
  },
);

await server.connect(new StdioServerTransport());
