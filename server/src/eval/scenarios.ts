// Deterministic eval scenarios for the simulated agent. Each one records a run
// (optionally forks it) through the real MCP tools server, then scores it with
// `evaluateRun`. `expectPass` is what the evaluator SHOULD conclude — a
// scenario whose verdict disagrees means the evaluator (or agent) regressed.
import type { ForkEdit } from '../types.js';
import type { TrajectorySpec } from './trajectory.js';

export interface EvalScenario {
  id: string;
  description: string;
  prompt: string;
  /** Fork the recorded run before scoring; the fork is what gets evaluated. */
  fork?: { at: { tool: string } | { llmTurn: number } | 'prompt'; edit: ForkEdit };
  spec: TrajectorySpec;
  expectPass: boolean;
}

const TOKYO = 'Plan a 4-day trip to Tokyo from San Francisco on a $2000 budget.';

const tokyoTrajectory: TrajectorySpec['expected'] = [
  { tool: 'get_weather', args: { city: 'Tokyo' } },
  { tool: 'convert_currency', args: { from: 'USD', to: 'JPY' } },
  { tool: 'search_flights', args: { origin: 'San Francisco', destination: 'Tokyo' } },
  { tool: 'get_travel_advisory', args: { country: 'Japan' } },
];

export const SCENARIOS: EvalScenario[] = [
  {
    id: 'tokyo-baseline',
    description: 'Researches all four facets in order and grounds the answer in tool results.',
    prompt: TOKYO,
    spec: {
      expected: tokyoTrajectory,
      match: 'in_order',
      maxToolCalls: 4,
      maxSteps: 8,
      outcome: { mustContain: ['Tokyo', 'JPY', 'Advisory'] },
    },
    expectPass: true,
  },
  {
    id: 'paris-exact',
    description: 'Exact trajectory (no extra calls) with origin/destination arguments.',
    prompt: 'Plan a romantic long weekend in Paris from London.',
    spec: {
      expected: [
        { tool: 'get_weather', args: { city: 'Paris' } },
        { tool: 'convert_currency', args: { to: 'EUR' } },
        { tool: 'search_flights', args: { origin: 'London', destination: 'Paris' } },
        { tool: 'get_travel_advisory', args: { country: 'France' } },
      ],
      match: 'exact',
      outcome: { mustContain: ['Paris', 'EUR'] },
    },
    expectPass: true,
  },
  {
    id: 'tokyo-snowstorm-fork',
    description:
      'What-if fork: weather rewritten to 2°C heavy snow. Same trajectory, but the answer must adapt (warm layers, not a light jacket).',
    prompt: TOKYO,
    fork: {
      at: { tool: 'get_weather' },
      edit: {
        type: 'tool_result',
        newResult: JSON.stringify({ city: 'Tokyo', tempC: 2, condition: 'heavy snow', humidityPct: 88 }),
      },
    },
    spec: {
      expected: tokyoTrajectory,
      match: 'in_order',
      outcome: { mustContain: ['heavy snow', 'warm layers'], mustNotContain: ['light jacket'] },
    },
    expectPass: true,
  },
  {
    id: 'sydney-reroll-consistency',
    description: 'Reroll the final turn: the re-sampled answer must keep the same trajectory and facts.',
    prompt: 'Plan a month in Sydney from Singapore for a remote worker.',
    fork: { at: { llmTurn: 2 }, edit: { type: 'reroll' } },
    spec: {
      expected: [
        { tool: 'get_weather', args: { city: 'Sydney' } },
        { tool: 'convert_currency', args: { to: 'AUD' } },
        { tool: 'search_flights', args: { origin: 'Singapore', destination: 'Sydney' } },
        { tool: 'get_travel_advisory', args: { country: 'Australia' } },
      ],
      match: 'exact',
      outcome: { mustContain: ['Sydney', 'AUD'] },
    },
    expectPass: true,
  },
  {
    id: 'mumbai-prompt-fork',
    description: 'Prompt-edit fork (Rome → Mumbai): the replayed run must retarget every tool call.',
    prompt: 'Plan a 5-day trip to Rome from Berlin on a $1500 budget.',
    fork: {
      at: 'prompt',
      edit: { type: 'prompt', newUserMessage: 'Plan a 5-day trip to Mumbai from Berlin on a $1500 budget.' },
    },
    spec: {
      expected: [
        { tool: 'get_weather', args: { city: 'Mumbai' } },
        { tool: 'convert_currency', args: { to: 'INR' } },
        { tool: 'search_flights', args: { origin: 'Berlin', destination: 'Mumbai' } },
        { tool: 'get_travel_advisory', args: { country: 'India' } },
      ],
      match: 'any_order',
      forbiddenTools: [],
      outcome: { mustContain: ['Mumbai', 'INR'], mustNotContain: ['Rome'] },
    },
    expectPass: true,
  },
  {
    id: 'rome-minimal-exact',
    description:
      'Negative control for match modes: expects only weather + currency under `exact`. The agent also books flights and checks the advisory, so exact fails (precision 0.5) even though in_order would pass.',
    prompt: 'Plan a 5-day trip to Rome from Berlin on a $1500 budget.',
    spec: {
      expected: [
        { tool: 'get_weather', args: { city: 'Rome' } },
        { tool: 'convert_currency', args: { to: 'EUR' } },
      ],
      match: 'exact',
    },
    expectPass: false,
  },
  {
    id: 'lisbon-unknown-city',
    description:
      'Known agent bug the evaluator should catch: Lisbon is not in the simulated agent’s city table, so it silently falls back to Tokyo.',
    prompt: 'Plan a week in Lisbon from Berlin.',
    spec: {
      expected: [
        { tool: 'get_weather', args: { city: 'Lisbon' } },
        { tool: 'convert_currency', args: { to: 'EUR' } },
        { tool: 'search_flights', args: { origin: 'Berlin', destination: 'Lisbon' } },
        { tool: 'get_travel_advisory', args: { country: 'Portugal' } },
      ],
      match: 'in_order',
      outcome: { mustContain: ['Lisbon'] },
    },
    expectPass: false,
  },
];
