#!/usr/bin/env node
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { storeMemory, recall } from './store';
import { Tier, getCwdProject } from './core';

const server = new McpServer({
  name: 'mem',
  version: '1.0.0',
});

server.tool(
  'recall',
  'Search stored memories (past decisions, constraints, failed approaches) by relevance to a query. Use this whenever you need context on why a project made a choice or what was tried before.',
  {
    query: z.string().describe('The question or topic to recall memories about'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
    files: z
      .array(z.string())
      .optional()
      .describe('File paths currently in focus; used to boost file-overlapping memories'),
  },
  async ({ query, limit, files }) => {
    const results = await recall(query ?? '', {
      limit: limit ?? 5,
      strategy: 'file_boost_recency',
      files: Array.isArray(files) ? files : [],
    });
    const body = results
      .map(
        (r, i) =>
          `${i + 1}. [${r.tier}] (${r.age_label}) ${r.text}\n` +
          (r.file_tags.length ? `   files: ${r.file_tags.join(', ')}\n` : '') +
          `   project: ${r.project} | id: ${r.id}`
      )
      .join('\n\n');
    if (!body) {
      return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
    }
    return { content: [{ type: 'text', text: body }] };
  }
);

server.tool(
  'remember',
  'Store a new memory for future recall. Use for durable decisions, constraints, or failed approaches.',
  {
    text: z.string().describe('The memory text (1-2 sentences)'),
    tier: z
      .enum(['decision', 'constraint', 'failed_approach', 'raw'])
      .optional()
      .describe('Memory tier'),
    files: z.array(z.string()).optional().describe('File paths this memory relates to'),
  },
  async ({ text, tier, files }) => {
    const { project } = getCwdProject();
    const mem = await storeMemory({
      text: text ?? '',
      tier: (tier as Tier) ?? 'raw',
      files: Array.isArray(files) ? files : [],
      project,
      source: 'session',
    });
    return {
      content: [
        {
          type: 'text',
          text: `Stored ${mem.tier} memory (${mem.id}): ${mem.text}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('MCP server failed:', err);
  process.exit(1);
});