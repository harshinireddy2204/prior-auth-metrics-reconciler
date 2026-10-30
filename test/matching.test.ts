// Matching rules on small hand-built cases: each test is one situation from real intake work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/match/match.js';
import type { SourceRecord, AppealRecord } from '../src/types.js';
import { DAY, HOUR, wallToUtc } from '../src/util/time.js';

const T0 = wallToUtc(2026, 4, 6, 9, 0);
let n = 0;
function sub(channel: SourceRecord['channel'], hoursAfter: number, extra: Partial<SourceRecord> = {}): SourceRecord {
  return {
    ref: `${channel}:${++n}`,
    channel,
    kind: 'submission',
    memberId: 'M12345678',
    dob: '1970-01-01',
    npi: '1234567893',
    cpt: '72148',
    priority: 'standard',
    receivedAt: T0 + hoursAfter * HOUR,
    confidence: 1,
    issues: [],
    ...extra,
  };
}
const decided = (r: SourceRecord, decision: 'approved' | 'denied', hoursAfter: number): SourceRecord => ({ ...r, decision, decidedAt: T0 + hoursAfter * HOUR });

test('fax then portal resubmission for the same request becomes one case; clock starts at the fax', () => {
  const fax = sub('fax', 0);
  const portal = decided(sub('portal', 30, { authNumber: 'A2026-000002' }), 'approved', 60);
  const r = reconcile([fax, portal], []);
  assert.equal(r.cases.length, 1);
  assert.equal(r.cases[0].receivedAt, fax.receivedAt);
  assert.equal(r.cases[0].decidedAt, T0 + 60 * HOUR);
});

test('status-check calls are never counted as requests', () => {
  const inquiry: SourceRecord = { ...sub('phone', 5), kind: 'inquiry' };
  const r = reconcile([sub('portal', 0), inquiry], []);
  assert.equal(r.cases.length, 1);
  assert.deepEqual(r.inquiries, [inquiry.ref]);
});

test('same patient and service 60 days later is a new request', () => {
  const r = reconcile([sub('portal', 0), sub('fax', 60 * 24)], []);
  assert.equal(r.cases.length, 2);
});

test('a new request after a denial is not merged into the denied one', () => {
  const first = decided(sub('portal', 0), 'denied', 48);
  const again = sub('fax', 72); // after the decision, inside the 21 day window
  const r = reconcile([first, again], []);
  assert.equal(r.cases.length, 2);
});

test('a mistyped member ID still matches when the date of birth agrees', () => {
  const r = reconcile([sub('portal', 0), sub('phone', 10, { memberId: 'M12354678' })], []);
  assert.equal(r.cases.length, 1);
});

test('a mistyped member ID with a different date of birth is a different patient', () => {
  const r = reconcile([sub('portal', 0), sub('phone', 10, { memberId: 'M12354678', dob: '1980-05-05' })], []);
  assert.equal(r.cases.length, 2);
});

test('different service code means a different request', () => {
  const r = reconcile([sub('portal', 0), sub('fax', 10, { cpt: '70553' })], []);
  assert.equal(r.cases.length, 2);
});

test('a different doctor for the same service is not merged, but is flagged for review', () => {
  const r = reconcile([sub('portal', 0), sub('fax', 10, { npi: '1245319599' })], []);
  assert.equal(r.cases.length, 2);
  assert.ok(r.review.some((x) => x.type === 'possible-duplicate'));
});

test('shared auth number links records regardless of other noise', () => {
  const a = sub('portal', 0, { authNumber: 'A2026-000009' });
  const b = sub('portal', 30 * 24, { authNumber: 'A2026-000009', memberId: 'M99999999' });
  assert.equal(reconcile([a, b], []).cases.length, 1);
});

test('a fax determination notice attaches to its fax by reference', () => {
  const fax = sub('fax', 0);
  const notice: SourceRecord = { ref: 'fax:N1', channel: 'fax', kind: 'decision', linksTo: fax.ref, decision: 'denied', decidedAt: T0 + 20 * HOUR, authNumber: 'A2026-000077', confidence: 1, issues: [] };
  const r = reconcile([fax, notice], []);
  assert.equal(r.cases[0].decision, 'denied');
  assert.equal(r.cases[0].decisionSource, 'fax:N1');
});

test('when channels disagree, the original wins and the conflict goes to review', () => {
  const original = decided(sub('fax', 0), 'approved', 50);
  const dup = decided(sub('portal', 5), 'denied', 52);
  const r = reconcile([original, dup], []);
  assert.equal(r.cases[0].decision, 'approved');
  assert.ok(r.review.some((x) => x.type === 'decision-conflict'));
});

test('a duplicate closed by intake does not count as a decision', () => {
  const original = decided(sub('fhir', 0, { authNumber: 'A1' }), 'approved', 40);
  const dup = { ...sub('portal', 5, { authNumber: 'A2' }), closedDuplicate: true, decidedAt: T0 + 6 * HOUR };
  const r = reconcile([original, dup], []);
  assert.equal(r.cases.length, 1);
  assert.equal(r.cases[0].decidedAt, T0 + 40 * HOUR);
});

test('appeals link by auth number, or by member and service to the latest denial', () => {
  const denied = decided(sub('portal', 0, { authNumber: 'A2026-000100' }), 'denied', 24);
  const withAuth: AppealRecord = { ref: 'appeal:1', receivedAt: T0 + 5 * DAY, authNumber: 'A2026-000100', issues: [] };
  const noAuth: AppealRecord = { ref: 'appeal:2', receivedAt: T0 + 6 * DAY, memberId: 'M12345678', cpt: '72148', issues: [] };
  const r = reconcile([denied], [withAuth, noAuth]);
  assert.deepEqual(r.cases[0].appeals, ['appeal:1', 'appeal:2']);
});
