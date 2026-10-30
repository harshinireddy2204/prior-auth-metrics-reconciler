// End-to-end: generate every scenario into a temp folder, reconcile it, and check the
// numbers against the answer key. Thresholds are the measured results with a small margin,
// so a change that makes matching worse fails the build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS } from '../src/synth/scenarios.js';
import { generate } from '../src/synth/generate.js';
import { run } from '../src/pipeline.js';
import { metricMap } from '../src/metrics/metrics.js';

const tmp = mkdtempSync(join(tmpdir(), 'par-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const total = (m: Record<string, { value: number | null }>) => (m['standard.total'].value ?? 0) + (m['expedited.total'].value ?? 0);

for (const s of SCENARIOS) {
  test(`scenario ${s.name}`, async () => {
    const dir = join(tmp, s.name);
    generate(s, dir);
    const r = await run(s.name, dir, { year: s.year });
    const rec = metricMap(r.reconciled);
    const naive = metricMap(r.naive);
    const truth = metricMap(r.truth!);
    const e = r.evaluation!;

    if (s.name === '01-clean') {
      // nothing to reconcile: every metric must equal the answer key exactly
      for (const k of Object.keys(truth)) assert.equal(rec[k].value, truth[k].value, k);
      assert.equal(r.counts.reviewItems, 0);
      return;
    }
    // reconciled request count within 2.5% of the truth, and closer than naive counting
    const recErr = Math.abs(total(rec) - total(truth)) / total(truth);
    const naiveErr = Math.abs(total(naive) - total(truth)) / total(truth);
    assert.ok(recErr <= 0.025, `request count off by ${(recErr * 100).toFixed(1)}%`);
    assert.ok(recErr < naiveErr, 'reconciled should beat naive');
    // merging precision stays high everywhere: wrong merges corrupt metrics silently
    assert.ok((e.pairPrecision ?? 1) >= 0.98, `pair precision ${e.pairPrecision}`);
    if (s.name !== '08-look-alikes' && s.name !== '07-realistic') assert.ok((e.pairRecall ?? 1) >= 0.97, `pair recall ${e.pairRecall}`);
    assert.ok((e.appealLinkAccuracy ?? 1) >= 0.95, `appeal linking ${e.appealLinkAccuracy}`);
    // standard approval rate within 1 point of the truth
    assert.ok(Math.abs((rec['standard.approvedPct'].value ?? 0) - (truth['standard.approvedPct'].value ?? 0)) <= 1);
    if (s.name === '04-conflicts') assert.ok(r.rec.review.some((x) => x.type === 'decision-conflict'));
    if (s.name === '06-year-boundary') assert.ok(r.counts.utcYearShift > 0, 'scenario should include decisions that flip year in UTC');
    if (s.name === '08-look-alikes') assert.ok(r.rec.review.some((x) => x.type === 'possible-duplicate'), 'ambiguous pairs must be flagged');
  });
}
