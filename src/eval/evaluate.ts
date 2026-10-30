// Scores a reconciliation against the answer key of a synthetic scenario.

import type { Reconciliation } from '../match/match.js';
import type { Truth } from '../synth/generate.js';

export interface Evaluation {
  submissions: number;
  trueRequestsWithRecords: number;
  casesFound: number;
  pairPrecision: number | null;
  pairRecall: number | null;
  exactRequestAccuracy: number;
  falseMerges: number; // cases that mix records of 2+ real requests
  missedMerges: number; // real requests split across 2+ cases
  appealLinkAccuracy: number | null;
  faxFieldAccuracy: Record<string, number | null>;
  faxPagesScored: number;
}

const pairs = (n: number) => (n * (n - 1)) / 2;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function evaluate(rec: Reconciliation, truth: Truth): Evaluation {
  const subRefs = Object.keys(truth.submissionToRequest).filter((r) => rec.caseOfRecord.has(r));
  const caseSize = new Map<string, number>();
  const reqSize = new Map<string, number>();
  const joint = new Map<string, number>();
  const casesOfReq = new Map<string, Set<string>>();
  const reqsOfCase = new Map<string, Set<string>>();
  for (const ref of subRefs) {
    const c = rec.caseOfRecord.get(ref)!;
    const q = truth.submissionToRequest[ref];
    caseSize.set(c, (caseSize.get(c) ?? 0) + 1);
    reqSize.set(q, (reqSize.get(q) ?? 0) + 1);
    joint.set(`${c}|${q}`, (joint.get(`${c}|${q}`) ?? 0) + 1);
    (casesOfReq.get(q) ?? casesOfReq.set(q, new Set()).get(q)!).add(c);
    (reqsOfCase.get(c) ?? reqsOfCase.set(c, new Set()).get(c)!).add(q);
  }
  const tp = [...joint.values()].reduce((s, n) => s + pairs(n), 0);
  const pp = [...caseSize.values()].reduce((s, n) => s + pairs(n), 0);
  const tpairs = [...reqSize.values()].reduce((s, n) => s + pairs(n), 0);
  let exact = 0;
  for (const [q, cs] of casesOfReq) {
    if (cs.size === 1) {
      const c = [...cs][0];
      if (reqsOfCase.get(c)!.size === 1 && caseSize.get(c) === reqSize.get(q)) exact++;
    }
  }

  let appealOk = 0,
    appealN = 0;
  for (const [aref, q] of Object.entries(truth.appealToRequest)) {
    appealN++;
    const c = rec.caseOfAppeal.get(aref);
    if (c && reqsOfCase.get(c)?.has(q) && reqsOfCase.get(c)!.size === 1) appealOk++;
  }

  const fields = ['memberId', 'dob', 'npi', 'cpt', 'priority'] as const;
  const hits: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
  let faxN = 0;
  for (const [ref, want] of Object.entries(truth.faxFields)) {
    const got = rec.byRef.get(ref);
    if (!got) continue;
    faxN++;
    for (const f of fields) if (got[f] === want[f]) hits[f]++;
  }

  return {
    submissions: subRefs.length,
    trueRequestsWithRecords: reqSize.size,
    casesFound: caseSize.size,
    pairPrecision: pp ? r3(tp / pp) : null,
    pairRecall: tpairs ? r3(tp / tpairs) : null,
    exactRequestAccuracy: r3(exact / (reqSize.size || 1)),
    falseMerges: [...reqsOfCase.values()].filter((s) => s.size > 1).length,
    missedMerges: [...casesOfReq.values()].filter((s) => s.size > 1).length,
    appealLinkAccuracy: appealN ? r3(appealOk / appealN) : null,
    faxFieldAccuracy: Object.fromEntries(fields.map((f) => [f, faxN ? r3(hits[f] / faxN) : null])),
    faxPagesScored: faxN,
  };
}
