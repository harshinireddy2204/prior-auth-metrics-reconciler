// End to end: load exports -> reconcile -> metrics (naive, reconciled, truth) -> evaluate -> write outputs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInputs, type LoadOptions } from './ingest/index.js';
import { DEFAULT_MATCH, reconcile, type MatchConfig, type Reconciliation } from './match/match.js';
import { computeMetrics, type MetricReport } from './metrics/metrics.js';
import { naiveView, reconciledView, truthView } from './metrics/views.js';
import { evaluate, type Evaluation } from './eval/evaluate.js';
import type { Truth } from './synth/generate.js';
import { toCsv } from './util/csv.js';
import { formatWall, localYear } from './util/time.js';
import { renderReport } from './report/html.js';

export interface RunOptions extends LoadOptions {
  year: number;
  basis?: 'decision' | 'receipt';
  match?: Partial<MatchConfig>;
  title?: string;
  description?: string;
}

export interface RunResult {
  name: string;
  title: string;
  description: string;
  inputDir: string;
  year: number;
  counts: { records: number; submissions: number; decisionRecords: number; inquiries: number; appeals: number; cases: number; reviewItems: number; faxLlmCalls: number; utcYearShift: number };
  reconciled: MetricReport;
  naive: MetricReport;
  truth?: MetricReport;
  evaluation?: Evaluation;
  warnings: string[];
  rec: Reconciliation;
}

export async function run(name: string, inputDir: string, opts: RunOptions): Promise<RunResult> {
  const parsed = await loadInputs(inputDir, opts);
  const rec = reconcile(parsed.records, parsed.appeals, { ...DEFAULT_MATCH, ...opts.match });
  const mopts = { year: opts.year, basis: opts.basis };
  const rv = reconciledView(rec);
  const nv = naiveView(rec);
  const result: RunResult = {
    name,
    title: opts.title ?? name,
    description: opts.description ?? '',
    inputDir,
    year: opts.year,
    counts: {
      records: parsed.records.length,
      submissions: parsed.records.filter((r) => r.kind === 'submission').length,
      decisionRecords: parsed.records.filter((r) => r.kind === 'decision').length,
      inquiries: rec.inquiries.length,
      appeals: parsed.appeals.length,
      cases: rec.cases.length,
      reviewItems: rec.review.length,
      faxLlmCalls: parsed.faxLlmCalls,
      // determinations that land in a different calendar year if read in UTC instead of payer time
      utcYearShift: rec.cases.filter((c) => c.decidedAt !== undefined && localYear(c.decidedAt) !== new Date(c.decidedAt).getUTCFullYear() && (localYear(c.decidedAt) === opts.year || new Date(c.decidedAt).getUTCFullYear() === opts.year)).length,
    },
    reconciled: computeMetrics(rv.cases, rv.appeals, mopts),
    naive: computeMetrics(nv.cases, nv.appeals, mopts),
    warnings: parsed.warnings,
    rec,
  };
  const truthPath = join(inputDir, 'truth.json');
  if (existsSync(truthPath)) {
    const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
    const tv = truthView(truth);
    result.truth = computeMetrics(tv.cases, tv.appeals, mopts);
    result.evaluation = evaluate(rec, truth);
  }
  return result;
}

export function writeOutputs(r: RunResult, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const strip = (m: MetricReport) => ({ ...m, metrics: m.metrics.map(({ ids, ...rest }) => ({ ...rest, n_ids: ids.length })) });
  writeFileSync(
    join(outDir, 'metrics.json'),
    JSON.stringify(
      {
        scenario: r.name,
        year: r.year,
        counts: r.counts,
        reconciled: strip(r.reconciled),
        naive: strip(r.naive),
        truth: r.truth ? strip(r.truth) : undefined,
        evaluation: r.evaluation,
        warnings: r.warnings,
      },
      null,
      2,
    ) + '\n',
  );
  const t = (ms?: number) => (ms === undefined ? '' : formatWall(ms));
  writeFileSync(
    join(outDir, 'cases.csv'),
    toCsv(
      r.rec.cases.map((c) => ({
        case_id: c.id,
        received_at_et: t(c.receivedAt),
        priority: c.priority,
        decision: c.withdrawn ? 'withdrawn' : c.decision ?? 'pending',
        decided_at_et: t(c.decidedAt),
        hours_to_decision: c.decidedAt ? ((c.decidedAt - c.receivedAt) / 3_600_000).toFixed(1) : '',
        extended: c.extended ? 'Y' : 'N',
        member_id: c.memberId,
        service_code: c.cpt,
        n_records: c.records.length,
        channels: [...new Set(c.records.map((x) => x.split(':')[0]))].join('+'),
        decision_source: c.decisionSource,
        source_records: c.records.join(' '),
        appeals: c.appeals.join(' '),
        conflicts: c.conflicts.join(' | '),
      })),
      ['case_id', 'received_at_et', 'priority', 'decision', 'decided_at_et', 'hours_to_decision', 'extended', 'member_id', 'service_code', 'n_records', 'channels', 'decision_source', 'source_records', 'appeals', 'conflicts'],
    ),
  );
  writeFileSync(
    join(outDir, 'review_queue.csv'),
    toCsv(
      r.rec.review.map((x) => ({ type: x.type, case_id: x.caseId, records: x.refs.join(' '), message: x.message })),
      ['type', 'case_id', 'records', 'message'],
    ),
  );
  writeFileSync(join(outDir, 'report.html'), renderReport(r));
}
