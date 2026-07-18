import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnthropicToolDef } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));

let client: Client | null = null;
let toolDefs: AnthropicToolDef[] = [];

export async function connectMcp(): Promise<void> {
  if (client) return;
  const c = new Client({ name: 'rewind', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'tools-server.mjs')],
  });
  await c.connect(transport);
  const { tools } = await c.listTools();
  toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Record<string, unknown>,
  }));
  client = c;
  console.log(`[mcp] connected to demo tools server — ${tools.map((t) => t.name).join(', ')}`);
}

export function getToolDefs(): AnthropicToolDef[] {
  return toolDefs;
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  if (!client) throw new Error('MCP client not connected');
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return { result: text, isError: Boolean(res.isError) };
  } catch (err) {
    return { result: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
