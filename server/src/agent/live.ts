import Anthropic from '@anthropic-ai/sdk';
import type { Driver, ModelTurn, WireMessage } from './driver.js';
import type { AnthropicToolDef, ContentBlock } from '../types.js';

const MODEL = process.env.REWIND_MODEL ?? 'claude-opus-4-8';

// Credentials resolve from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// or an `ant auth login` profile) — no key is hardcoded here.
const client = new Anthropic();

export const liveDriver: Driver = {
  model: MODEL,
  async next(system, messages, tools): Promise<ModelTurn> {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
      messages: messages as Anthropic.MessageParam[],
    });

    const content: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
      // thinking blocks are intentionally not persisted in the trace
    }

    return {
      content,
      stopReason: response.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  },
};

export function detectLiveCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
