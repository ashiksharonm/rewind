import type { AnthropicToolDef, ContentBlock, Usage } from '../types.js';

// One model turn: what the model said, why it stopped, what it cost.
export interface ModelTurn {
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
}

export interface WireMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      >;
}

export interface Driver {
  model: string;
  next(system: string, messages: WireMessage[], tools: AnthropicToolDef[]): Promise<ModelTurn>;
}
