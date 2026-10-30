// CMS-0057-F prior authorization metrics, following the CMS "Prior Authorization Metrics
// Reporting Overview" template:
//  - standard and expedited requests: % approved, % denied, % approved after appeal
//    (denominator = appeals of that type), mean and median time from payer receipt to determination
//  - % of requests whose review timeframe was extended and that were approved (denominator = all requests)
// Optional sub-metric included: % determined within 7 days (standard) or 72 hours (expedited).
//
// Every number carries the list of case IDs behind it, so any figure can be traced back to the
// raw fax page, portal row, call or FHIR bundle.
//
// Period assumption (configurable): a request belongs to the calendar year in which its
// determination was made, in the payer's time zone. Withdrawn and still-pending requests are
// excluded and reported separately. Confirm both choices with the plan's compliance team.

import type { Decision, Priority } from '../types.js';
import { HOUR, PAYER_TZ, localYear } from '../util/time.js';

export interface MetricCase {
  id: string;
  priority: Priority;
  receivedAt: number;
  decision?: Decision;
  decidedAt?: number;
  extended: boolean;
  withdrawn: boolean;
}
export interface MetricAppeal {
  ref: string;
  caseId?: string;
  priority: Priority;
  outcome?: 'overturned' | 'upheld';
  decidedAt?: number;
}

export interface Metric {
  key: string;
  label: string;
  unit: '%' | 'hours' | 'count';
  value: number | null;
  numerator?: number;
  denominator?: number;
  ids: string[]; // case IDs (or appeal refs for appeal metrics) behind the number
  definition: string;
}

export interface MetricOptions {
  year: number;
  tz?: string;
  basis?: 'decision' | 'receipt';
}

export interface MetricReport {
  year: number;
  basis: 'decision' | 'receipt';
  metrics: Metric[];
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
const r1 = (x: number) => Math.round(x * 10) / 10;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeMetrics(cases: MetricCase[], appeals: MetricAppeal[], opts: MetricOptions): MetricReport {
  const tz = opts.tz ?? PAYER_TZ;
  const basis = opts.basis ?? 'decision';
  const inYear = (t: number | undefined) => t !== undefined && localYear(t, tz) === opts.year;
  const determined = cases.filter((c) => c.decision && !c.withdrawn && inYear(basis === 'decision' ? c.decidedAt : c.receivedAt));
  const metrics: Metric[] = [];

  for (const p of ['standard', 'expedited'] as Priority[]) {
    const P = p === 'standard' ? 'Standard' : 'Expedited';
    const all = determined.filter((c) => c.priority === p);
    const appr = all.filter((c) => c.decision === 'approved');
    const den = all.filter((c) => c.decision === 'denied');
    const hours = all.map((c) => (c.decidedAt! - c.receivedAt) / HOUR);
    const limit = p === 'standard' ? 7 * 24 : 72;
    const onTime = all.filter((c) => (c.decidedAt! - c.receivedAt) / HOUR <= limit);
    const apps = appeals.filter((a) => a.priority === p && a.outcome && inYear(a.decidedAt));
    const over = apps.filter((a) => a.outcome === 'overturned');
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    metrics.push(
      { key: `${p}.total`, label: `${P} requests determined`, unit: 'count', value: all.length, ids: ids(all), definition: `${P} requests with an approve or deny determination in ${opts.year}` },
      { key: `${p}.approvedPct`, label: `${P}: % approved`, unit: '%', value: pct(appr.length, all.length), numerator: appr.length, denominator: all.length, ids: ids(appr), definition: 'Approved / all determined requests of this type' },
      { key: `${p}.deniedPct`, label: `${P}: % denied`, unit: '%', value: pct(den.length, all.length), numerator: den.length, denominator: all.length, ids: ids(den), definition: 'Denied / all determined requests of this type' },
      {
        key: `${p}.approvedAfterAppealPct`,
        label: `${P}: % approved after appeal`,
        unit: '%',
        value: pct(over.length, apps.length),
        numerator: over.length,
        denominator: apps.length,
        ids: over.map((a) => a.ref),
        definition: `Appeals overturned / appeals of ${p} requests decided in ${opts.year}${p === 'expedited' ? ' (optional for expedited)' : ''}`,
      },
      { key: `${p}.meanHours`, label: `${P}: mean hours to decision`, unit: 'hours', value: hours.length ? r1(hours.reduce((s, x) => s + x, 0) / hours.length) : null, ids: ids(all), definition: 'Mean of (determination time minus payer receipt time); receipt is the earliest receipt across channels' },
      { key: `${p}.medianHours`, label: `${P}: median hours to decision`, unit: 'hours', value: (() => { const m = median(hours); return m === null ? null : r1(m); })(), ids: ids(all), definition: 'Median of (determination time minus payer receipt time)' },
      { key: `${p}.withinTimeframePct`, label: `${P}: % decided within ${p === 'standard' ? '7 days' : '72 hours'}`, unit: '%', value: pct(onTime.length, all.length), numerator: onTime.length, denominator: all.length, ids: ids(onTime), definition: 'Optional sub-metric: share determined inside the regulatory timeframe' },
    );
  }
  const extAppr = determined.filter((c) => c.extended && c.decision === 'approved');
  metrics.push({
    key: 'all.extendedApprovedPct',
    label: 'All: % with review timeframe extended and approved',
    unit: '%',
    value: pct(extAppr.length, determined.length),
    numerator: extAppr.length,
    denominator: determined.length,
    ids: extAppr.map((c) => c.id),
    definition: 'Requests extended and approved / all determined requests',
  });
  const relevant = (c: MetricCase) => localYear(c.receivedAt, tz) <= opts.year;
  const withdrawn = cases.filter((c) => c.withdrawn && localYear(c.receivedAt, tz) === opts.year);
  const pending = cases.filter((c) => !c.decision && !c.withdrawn && relevant(c));
  metrics.push(
    { key: 'excluded.withdrawn', label: 'Excluded: withdrawn by provider', unit: 'count', value: withdrawn.length, ids: withdrawn.map((c) => c.id), definition: `Withdrawn requests received in ${opts.year}` },
    { key: 'excluded.pending', label: 'Excluded: no determination at export', unit: 'count', value: pending.length, ids: pending.map((c) => c.id), definition: 'Requests with no determination in the data (still open, or the decision record is missing)' },
  );
  return { year: opts.year, basis, metrics };
}

export function metricMap(r: MetricReport): Record<string, Metric> {
  return Object.fromEntries(r.metrics.map((m) => [m.key, m]));
}
