// MCP server: lets an AI assistant (Claude Desktop, Claude Code, Cursor, ...) run the reconciler
// and answer questions with numbers that trace back to source records.
// Transport: stdio. Start with `npm run mcp` (dev) or `node dist/mcp/server.js` after `npm run build`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCENARIOS, getScenario } from '../synth/scenarios.js';
import { generate } from '../synth/generate.js';
import { run, type RunResult } from '../pipeline.js';
import { formatWall } from '../util/time.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA = join(ROOT, 'data', 'scenarios');
const cache = new Map<string, RunResult>();

async function getRun(source: string, year?: number): Promise<RunResult> {
  const key = `${source}|${year ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let r: RunResult;
  if (existsSync(source)) {
    r = await run('custom', resolve(source), { year: year ?? new Date().getFullYear() - 1, title: 'Your data' });
  } else {
    const s = getScenario(source);
    const dir = join(DATA, s.name);
    if (!existsSync(join(dir, 'portal_export.csv'))) generate(s, dir);
    r = await run(s.name, dir, { year: year ?? s.year, title: s.title, description: s.whatItTests });
  }
  cache.set(key, r);
  return r;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const source = z.string().describe('Scenario name such as "07-realistic", or an absolute path to a folder holding the five export files').default('07-realistic');
const t = (ms?: number) => (ms === undefined ? '-' : formatWall(ms));

function describeCase(r: RunResult, id: string): string {
  const c = r.rec.cases.find((x) => x.id === id);
  if (!c) return `No request ${id}.`;
  const lines = [
    `${c.id}: ${c.priority} request for member ${c.memberId}, service ${c.cpt}`,
    `clock starts ${t(c.receivedAt)} ET (earliest receipt across channels); ${c.withdrawn ? 'withdrawn' : c.decision ? `${c.decision} ${t(c.decidedAt)} ET, ${((c.decidedAt! - c.receivedAt) / 3.6e6).toFixed(1)} h` : 'no determination yet'}${c.extended ? '; review extended' : ''}`,
    `decision taken from ${c.decisionSource ?? '-'}`,
    'source records:',
  ];
  for (const ref of c.records) {
    const x = r.rec.byRef.get(ref)!;
    lines.push(`  ${ref} [${x.kind}] received ${t(x.receivedAt)} ${x.decision ?? (x.closedDuplicate ? 'closed as duplicate' : x.withdrawn ? 'withdrawn' : '')} ${x.decidedAt ? t(x.decidedAt) : ''} ${x.authNumber ? 'auth ' + x.authNumber : ''}`.trimEnd());
    for (const i of x.issues) lines.push(`    note: ${i}`);
  }
  for (const a of c.appeals) {
    const ap = r.rec.appeals.find((x) => x.ref === a)!;
    lines.push(`  ${a} [appeal] received ${t(ap.receivedAt)} outcome ${ap.outcome ?? 'pending'} ${ap.decidedAt ? t(ap.decidedAt) : ''}`);
  }
  for (const k of c.conflicts) lines.push(`CONFLICT: ${k}`);
  return lines.join('\n');
}

const server = new McpServer({ name: 'prior-auth-metrics-reconciler', version: '0.1.0' });

server.registerTool(
  'list_scenarios',
  { description: 'List the built-in synthetic test scenarios and what each one tests.', inputSchema: {} },
  async () => text(SCENARIOS.map((s) => `${s.name}: ${s.title}. ${s.whatItTests}`).join('\n\n')),
);

server.registerTool(
  'get_metrics',
  {
    description:
      'Compute the CMS-0057-F prior authorization metrics for a scenario or a folder of exports. Returns naive (sum of channel reports), reconciled, and answer key (synthetic only) side by side, plus matching accuracy.',
    inputSchema: { source, year: z.number().int().optional().describe('Reporting calendar year') },
  },
  async ({ source, year }) => {
    const r = await getRun(source, year);
    const rows = r.reconciled.metrics.map((m) => {
      const n = r.naive.metrics.find((x) => x.key === m.key)?.value;
      const k = r.truth?.metrics.find((x) => x.key === m.key)?.value;
      return `${m.key.padEnd(34)} naive ${String(n ?? '-').padStart(7)}  reconciled ${String(m.value ?? '-').padStart(7)}${r.truth ? `  key ${String(k ?? '-').padStart(7)}` : ''}`;
    });
    const e = r.evaluation;
    return text(
      [
        `${r.title} (${r.name}), reporting year ${r.year}`,
        `${r.counts.records} source records, ${r.counts.submissions} submissions, ${r.counts.inquiries} status calls ignored, ${r.counts.cases} reconciled requests, ${r.counts.reviewItems} review items`,
        ...rows,
        e ? `matching precision ${e.pairPrecision}, recall ${e.pairRecall}, exact ${e.exactRequestAccuracy}, appeals linked ${e.appealLinkAccuracy}` : '',
      ].join('\n'),
    );
  },
);

server.registerTool(
  'explain_metric',
  {
    description: 'Show how one metric was computed: definition, numerator and denominator, and the request IDs behind it (with one fully traced example).',
    inputSchema: { source, metric: z.string().describe('Metric key, e.g. standard.approvedPct, expedited.medianHours, all.extendedApprovedPct'), limit: z.number().int().default(25) },
  },
  async ({ source, metric, limit }) => {
    const r = await getRun(source);
    const m = r.reconciled.metrics.find((x) => x.key === metric);
    if (!m) return text(`Unknown metric. Known: ${r.reconciled.metrics.map((x) => x.key).join(', ')}`);
    const firstCase = m.ids[0] ? r.rec.caseOfAppeal.get(m.ids[0]) ?? m.ids[0] : undefined;
    return text(
      [
        `${m.label}: ${m.value}${m.unit === '%' ? '%' : m.unit === 'hours' ? ' h' : ''}${m.denominator !== undefined ? ` (${m.numerator} of ${m.denominator})` : ''}`,
        `definition: ${m.definition}`,
        `${m.ids.length} items; first ${Math.min(limit, m.ids.length)}: ${m.ids.slice(0, limit).join(', ')}`,
        firstCase ? `\nexample:\n${describeCase(r, firstCase)}` : '',
      ].join('\n'),
    );
  },
);

server.registerTool(
  'get_request',
  {
    description: 'Trace one reconciled request back to every fax page, portal row, call and FHIR bundle behind it. Look up by request ID (C00012), record ref (fax:FX-000031), or auth number.',
    inputSchema: { source, id: z.string() },
  },
  async ({ source, id }) => {
    const r = await getRun(source);
    const q = id.trim();
    let caseId = r.rec.cases.find((c) => c.id === q.toUpperCase())?.id ?? r.rec.caseOfRecord.get(q) ?? r.rec.caseOfAppeal.get(q);
    if (!caseId) caseId = r.rec.cases.find((c) => c.records.some((ref) => r.rec.byRef.get(ref)?.authNumber === q.toUpperCase()))?.id;
    return text(caseId ? describeCase(r, caseId) : `Nothing found for "${id}". Status-check calls are not part of any request.`);
  },
);

server.registerTool(
  'review_queue',
  {
    description: 'List items the reconciler refused to decide on its own: channel conflicts, possible duplicates, unreadable fax fields, orphan decisions, unlinked appeals.',
    inputSchema: {
      source,
      type: z.enum(['decision-conflict', 'priority-conflict', 'possible-duplicate', 'orphan-decision', 'unlinked-appeal', 'low-confidence', 'missing-receipt-time']).optional(),
      limit: z.number().int().default(20),
    },
  },
  async ({ source, type, limit }) => {
    const r = await getRun(source);
    const items = r.rec.review.filter((x) => !type || x.type === type);
    const counts = Object.entries(r.rec.review.reduce<Record<string, number>>((a, x) => ((a[x.type] = (a[x.type] ?? 0) + 1), a), {}))
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    return text([`${items.length} items${type ? ` of type ${type}` : ''} (all types: ${counts || 'none'})`, ...items.slice(0, limit).map((x) => `- ${x.caseId ?? ''} ${x.message}`)].join('\n'));
  },
);

await server.connect(new StdioServerTransport());
