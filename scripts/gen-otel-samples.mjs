// Writes two SYNTHETIC OTLP/JSON traces (hand-authored, not captured from a
// real framework) shaped like OTel GenAI instrumentation output. They exist so
// the importer, `rewind diff` and the static viewer have inputs to work on.
//   trip-baseline  — stable-attribute style (gen_ai.input/output.messages)
//   trip-snowstorm — older event style (gen_ai.user.message / gen_ai.choice),
//                    same agent, but the weather tool returned heavy snow
import { writeFileSync, mkdirSync } from 'node:fs';

const s = (v) => ({ stringValue: String(v) });
const i = (v) => ({ intValue: String(v) });
const kv = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));
const T0 = 1_790_000_000_000n; // fixed epoch ms -> deterministic output
const ns = (ms) => String((T0 + BigInt(ms)) * 1_000_000n);

function span(trace, id, parent, name, start, end, attributes, events = []) {
  return {
    traceId: trace, spanId: id, parentSpanId: parent, name, kind: 1,
    startTimeUnixNano: ns(start), endTimeUnixNano: ns(end),
    attributes: kv(attributes), events, status: { code: 1 },
  };
}
const doc = (spans) => ({
  resourceSpans: [{ resource: { attributes: kv({ 'service.name': s('travel-agent-sample') }) }, scopeSpans: [{ scope: { name: 'sample.synthetic' }, spans }] }],
});

const SYSTEM = 'You are a travel planning agent. Use tools, then give a concise plan.';
const USER = 'Plan a 5 day trip to Tokyo from San Francisco with a 2000 USD budget.';
const weather = (snow) => JSON.stringify(snow ? { city: 'Tokyo', tempC: -2, condition: 'heavy snow' } : { city: 'Tokyo', tempC: 25, condition: 'overcast' });
const fx = JSON.stringify({ amount: 2000, from: 'USD', to: 'JPY', converted: 316800 });
const flights = JSON.stringify({ flights: [{ airline: 'ANA', priceUsd: 980 }] });

function build(trace, snow, legacy) {
  const p = (n) => `${trace.slice(0, 8)}${String(n).padStart(8, '0')}`;
  const answer = snow
    ? 'Heavy snow in Tokyo (-2C): pack warm layers, expect transit delays. 2000 USD is about 316,800 JPY; ANA flight is 980 USD.'
    : 'Tokyo is 25C and overcast: a light jacket will do. 2000 USD is about 316,800 JPY; ANA flight is 980 USD.';
  const turn1Calls = [
    { id: 'call_w', name: 'get_weather', arguments: { city: 'Tokyo' } },
    { id: 'call_c', name: 'convert_currency', arguments: { amount: 2000, from: 'USD', to: 'JPY' } },
  ];
  const turn2Calls = [{ id: 'call_f', name: 'search_flights', arguments: { origin: 'San Francisco', destination: 'Tokyo' } }];
  const model = { 'gen_ai.operation.name': s('chat'), 'gen_ai.system': s('sample'), 'gen_ai.request.model': s('sample-model-1') };

  const llmSpan = (id, start, end, inMsgs, outText, calls, inTok, outTok) => {
    const attrs = { ...model, 'gen_ai.usage.input_tokens': i(inTok), 'gen_ai.usage.output_tokens': i(outTok), 'gen_ai.response.finish_reasons': { arrayValue: { values: [s(calls.length ? 'tool_calls' : 'stop')] } } };
    if (!legacy) {
      attrs['gen_ai.system_instructions'] = s(SYSTEM);
      attrs['gen_ai.input.messages'] = s(JSON.stringify(inMsgs.map((m) => ({ role: m.role, parts: [{ type: 'text', content: m.text }] }))));
      attrs['gen_ai.output.messages'] = s(JSON.stringify([{ role: 'assistant', finish_reason: calls.length ? 'tool_calls' : 'stop', parts: [...(outText ? [{ type: 'text', content: outText }] : []), ...calls.map((c) => ({ type: 'tool_call', ...c }))] }]));
      return span(trace, id, p(1), 'chat sample-model-1', start, end, attrs);
    }
    const events = [
      { name: 'gen_ai.system.message', timeUnixNano: ns(start), attributes: kv({ content: s(SYSTEM) }) },
      ...inMsgs.map((m) => ({ name: `gen_ai.${m.role}.message`, timeUnixNano: ns(start), attributes: kv({ content: s(m.text) }) })),
      { name: 'gen_ai.choice', timeUnixNano: ns(end), attributes: kv({ finish_reason: s(calls.length ? 'tool_calls' : 'stop'), message: s(JSON.stringify({ content: outText, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) })) }) },
    ];
    return span(trace, id, p(1), 'chat sample-model-1', start, end, attrs, events);
  };
  const toolSpan = (id, start, end, c, result) =>
    span(trace, id, p(1), `execute_tool ${c.name}`, start, end, {
      'gen_ai.operation.name': s('execute_tool'), 'gen_ai.tool.name': s(c.name), 'gen_ai.tool.call.id': s(c.id),
      'gen_ai.tool.call.arguments': s(JSON.stringify(c.arguments)), 'gen_ai.tool.call.result': s(result),
    });

  return doc([
    span(trace, p(1), '', 'invoke_agent travel-planner', 0, 2100, { 'gen_ai.operation.name': s('invoke_agent'), 'gen_ai.agent.name': s(`travel-planner (${snow ? 'snowstorm' : 'baseline'})`) }),
    llmSpan(p(2), 10, 480, [{ role: 'user', text: USER }], 'Checking weather and converting currency.', turn1Calls, 180, 46),
    toolSpan(p(3), 490, 530, turn1Calls[0], weather(snow)),
    toolSpan(p(4), 490, 510, turn1Calls[1], fx),
    llmSpan(p(5), 540, 1000, [{ role: 'user', text: USER }, { role: 'assistant', text: 'Checking weather and converting currency.' }], 'Now searching flights.', turn2Calls, 310, 38),
    toolSpan(p(6), 1010, 1100, turn2Calls[0], flights),
    llmSpan(p(7), 1110, 2050, [{ role: 'user', text: USER }], answer, [], 420, snow ? 62 : 55),
  ]);
}

mkdirSync('samples/otel', { recursive: true });
writeFileSync('samples/otel/trip-baseline.otlp.json', JSON.stringify(build('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, false), null, 2) + '\n');
writeFileSync('samples/otel/trip-snowstorm.otlp.json', JSON.stringify(build('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', true, true), null, 2) + '\n');
console.log('wrote samples/otel/*.otlp.json');
