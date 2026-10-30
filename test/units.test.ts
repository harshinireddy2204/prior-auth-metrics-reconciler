// Unit tests: time zones, identifiers, CSV, fax extraction, metric arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWall, localDate, localYear, parseWall, parseDateOnly, wallToUtc } from '../src/util/time.js';
import { editDistance, isValidNpi, normalizeCpt, normalizeMemberId, normalizeNpi } from '../src/util/ids.js';
import { parseCsv, toCsv } from '../src/util/csv.js';
import { parseFax, splitFaxPages, rulesExtractor, faxSubmissionRecord } from '../src/ingest/fax.js';
import { serviceFromText } from '../src/util/services.js';
import { computeMetrics, median, metricMap, type MetricCase } from '../src/metrics/metrics.js';
import { HOUR, DAY } from '../src/util/time.js';

test('Eastern wall time converts to UTC across daylight saving', () => {
  assert.equal(new Date(wallToUtc(2026, 1, 15, 9, 0)).toISOString(), '2026-01-15T14:00:00.000Z'); // EST
  assert.equal(new Date(wallToUtc(2026, 7, 15, 9, 0)).toISOString(), '2026-07-15T13:00:00.000Z'); // EDT
  assert.equal(formatWall(wallToUtc(2026, 3, 8, 3, 30)), '03/08/2026 03:30'); // day DST starts
});

test('11:30 pm on Dec 31 Eastern is still the old year in payer time, but next year in UTC', () => {
  const t = wallToUtc(2026, 12, 31, 23, 30);
  assert.equal(localYear(t), 2026);
  assert.equal(new Date(t).getUTCFullYear(), 2027);
  assert.equal(localDate(t), '2026-12-31');
});

test('parseWall reads every date format the exports use', () => {
  const want = wallToUtc(2026, 3, 14, 10, 42);
  for (const s of ['03/14/2026 10:42', '2026-03-14 10:42', 'Mar 14, 2026 10:42', '14-MAR-2026 10:42', 'March 14 2026 10:42']) {
    assert.equal(parseWall(s), want, s);
  }
  assert.equal(parseWall('not a date'), undefined);
  assert.equal(parseDateOnly('Apr 11, 1968'), '1968-04-11');
});

test('NPI checksum (Luhn with 80840 prefix)', () => {
  assert.ok(isValidNpi('1234567893')); // CMS published example
  assert.ok(!isValidNpi('1234567890'));
  assert.deepEqual(normalizeNpi('12345678B3'), { npi: '1234567883', valid: false }); // OCR B->8 lands on a wrong digit, caught
  assert.equal(normalizeNpi('I234567893').valid, true); // OCR I->1 repaired
});

test('member IDs and service codes survive OCR letter/digit swaps', () => {
  assert.equal(normalizeMemberId('M1O29384B'), 'M10293848');
  assert.equal(normalizeMemberId('N10293848'), 'M10293848');
  assert.equal(normalizeCpt('7214B'), '72148');
  assert.equal(normalizeCpt('E0601'), 'E0601');
  assert.equal(normalizeCpt('E06O1'), 'E0601');
  assert.equal(normalizeCpt('_____'), undefined);
  assert.equal(serviceFromText('pt needs MRI lumbar spine'), '72148');
});

test('edit distance counts a transposition as one edit', () => {
  assert.equal(editDistance('M12345678', 'M12354678'), 1);
  assert.equal(editDistance('M12345678', 'M12345679'), 1);
  assert.equal(editDistance('M12345678', 'M99345678'), 2);
});

test('CSV round trip with commas, quotes and newlines', () => {
  const rows = [{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2' }];
  assert.deepEqual(parseCsv(toCsv(rows, ['a', 'b', 'c'])), rows);
});

const NOISY = `=== FAX PAGE FX-000042 | RECEIVED 03/14/2026 10:42 ===
PRIOR AUTHORIZATION REQUEST FORM
MEMBER lD: M1O29384B      D0B: Apr 11, 1968
NPl: I234567893
Procedure Code: _____  MRI lumbar spine without contrast
URGENT - EXPEDITED REVIEW REQUESTED

=== FAX PAGE FX-N-000007 | SENT 03/15/2026 09:10 ===
NOTICE OF PRIOR AUTHORIZATION DETERMINATION
RE: Your fax FX-000042
Authorization #: A2026-000123
Determination: DENIED
Determination date: 03/15/2026 09:02
Review timeframe extended: No`;

test('rules extractor repairs a noisy fax page and explains every repair', async () => {
  const [page] = splitFaxPages(NOISY);
  const rec = faxSubmissionRecord(page, await rulesExtractor(page));
  assert.equal(rec.memberId, 'M10293848');
  assert.equal(rec.dob, '1968-04-11');
  assert.equal(rec.npi, '1234567893');
  assert.equal(rec.cpt, '72148');
  assert.equal(rec.priority, 'expedited');
  assert.equal(rec.receivedAt, wallToUtc(2026, 3, 14, 10, 42));
  assert.ok(rec.issues.some((i) => i.includes('repaired')));
  assert.ok(rec.issues.some((i) => i.includes('recovered from description')));
});

test('fax notice becomes a decision record linked to the fax it answers', async () => {
  const { records } = await parseFax(NOISY, { mode: 'rules' });
  const notice = records.find((r) => r.kind === 'decision')!;
  assert.equal(notice.linksTo, 'fax:FX-000042');
  assert.equal(notice.decision, 'denied');
  assert.equal(notice.authNumber, 'A2026-000123');
});

const mk = (id: string, p: 'standard' | 'expedited', d: 'approved' | 'denied' | undefined, hours: number, extra: Partial<MetricCase> = {}): MetricCase => {
  const receivedAt = wallToUtc(2026, 5, 1, 9, 0);
  return { id, priority: p, receivedAt, decision: d, decidedAt: d ? receivedAt + hours * HOUR : undefined, extended: false, withdrawn: false, ...extra };
};

test('metric arithmetic: percentages, mean, median, timeframe, extension, exclusions', () => {
  const cases = [
    mk('a', 'standard', 'approved', 10),
    mk('b', 'standard', 'approved', 20),
    mk('c', 'standard', 'denied', 200), // over 7 days
    mk('d', 'standard', 'approved', 30, { extended: true }),
    mk('e', 'expedited', 'denied', 50),
    mk('f', 'standard', undefined, 0), // pending
    mk('g', 'standard', undefined, 0, { withdrawn: true }),
  ];
  const appeals = [
    { ref: 'x', priority: 'standard' as const, outcome: 'overturned' as const, decidedAt: wallToUtc(2026, 6, 1) },
    { ref: 'y', priority: 'standard' as const, outcome: 'upheld' as const, decidedAt: wallToUtc(2026, 6, 1) },
    { ref: 'z', priority: 'standard' as const, outcome: 'overturned' as const, decidedAt: wallToUtc(2027, 1, 5) }, // next year
  ];
  const m = metricMap(computeMetrics(cases, appeals, { year: 2026 }));
  assert.equal(m['standard.total'].value, 4);
  assert.equal(m['standard.approvedPct'].value, 75);
  assert.equal(m['standard.deniedPct'].value, 25);
  assert.equal(m['standard.meanHours'].value, 65);
  assert.equal(m['standard.medianHours'].value, 25);
  assert.equal(m['standard.withinTimeframePct'].value, 75);
  assert.equal(m['standard.approvedAfterAppealPct'].value, 50); // 1 of 2 appeals decided in 2026
  assert.equal(m['expedited.deniedPct'].value, 100);
  assert.equal(m['expedited.withinTimeframePct'].value, 100); // 50 h <= 72 h
  assert.equal(m['all.extendedApprovedPct'].value, 20); // 1 of 5 determined
  assert.equal(m['excluded.pending'].value, 1);
  assert.equal(m['excluded.withdrawn'].value, 1);
  assert.deepEqual(m['standard.approvedPct'].ids, ['a', 'b', 'd']);
});

test('reporting period follows the determination date in payer time', () => {
  const lateNye = { ...mk('late', 'standard', 'approved', 1), receivedAt: wallToUtc(2026, 12, 28, 9, 0), decidedAt: wallToUtc(2026, 12, 31, 23, 40) };
  const jan = { ...mk('jan', 'standard', 'approved', 1), receivedAt: wallToUtc(2026, 12, 28, 9, 0), decidedAt: wallToUtc(2027, 1, 1, 0, 20) };
  assert.equal(metricMap(computeMetrics([lateNye, jan], [], { year: 2026 }))['standard.total'].value, 1);
  assert.equal(metricMap(computeMetrics([lateNye, jan], [], { year: 2026, basis: 'receipt' }))['standard.total'].value, 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  void DAY;
});
