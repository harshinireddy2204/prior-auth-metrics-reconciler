// Starts the real MCP server over stdio and calls its tools the way an AI assistant would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('MCP server exposes the tools and answers with traceable numbers', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(root, 'src', 'mcp', 'server.ts')],
    cwd: root,
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['explain_metric', 'get_metrics', 'get_request', 'list_scenarios', 'review_queue']);
    const txt = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
      return res.content[0].text;
    };
    const metrics = await txt('get_metrics', { source: '02-double-entry' });
    assert.match(metrics, /standard\.approvedPct/);
    assert.match(metrics, /matching precision/);
    const explain = await txt('explain_metric', { source: '02-double-entry', metric: 'standard.deniedPct', limit: 3 });
    assert.match(explain, /source records:/);
    const req = await txt('get_request', { source: '02-double-entry', id: 'C00001' });
    assert.match(req, /clock starts/);
    const rq = await txt('review_queue', { source: '04-conflicts', type: 'decision-conflict', limit: 2 });
    assert.match(rq, /decision-conflict/);
  } finally {
    await client.close();
  }
});
