// Three views of the same data, fed into the same metric function:
//  - reconciled: one case per real request (this tool)
//  - naive: every channel counts its own records, then the channel reports are added up
//  - truth: the answer key (only for synthetic scenarios)

import type { AppealRecord } from '../types.js';
import type { Reconciliation } from '../match/match.js';
import type { Truth } from '../synth/generate.js';
import type { MetricAppeal, MetricCase } from './metrics.js';

export function reconciledView(rec: Reconciliation): { cases: MetricCase[]; appeals: MetricAppeal[] } {
  const caseById = new Map(rec.cases.map((c) => [c.id, c]));
  return {
    cases: rec.cases.map((c) => ({
      id: c.id,
      priority: c.priority,
      receivedAt: c.receivedAt,
      decision: c.decision,
      decidedAt: c.decidedAt,
      extended: c.extended,
      withdrawn: c.withdrawn,
    })),
    appeals: rec.appeals.map((a) => appealView(a, rec.caseOfAppeal.get(a.ref), (id) => caseById.get(id)?.priority)),
  };
}

function appealView(a: AppealRecord, caseId: string | undefined, priorityOf: (id: string) => MetricCase['priority'] | undefined): MetricAppeal {
  return { ref: a.ref, caseId, priority: (caseId && priorityOf(caseId)) || a.priority || 'standard', outcome: a.outcome, decidedAt: a.decidedAt };
}

/** What a plan gets by adding up per-channel reports: each submission record is its own request. */
export function naiveView(rec: Reconciliation): { cases: MetricCase[]; appeals: MetricAppeal[] } {
  const cases: MetricCase[] = [];
  for (const e of rec.effective.values()) {
    if (e.rec.receivedAt === undefined || e.closedDuplicate) continue; // channels do know when they closed a duplicate
    cases.push({
      id: e.rec.ref,
      priority: e.rec.priority ?? 'standard',
      receivedAt: e.rec.receivedAt,
      decision: e.decision,
      decidedAt: e.decidedAt,
      extended: e.extended,
      withdrawn: e.withdrawn && !e.decision,
    });
  }
  return { cases, appeals: rec.appeals.map((a) => ({ ref: a.ref, priority: a.priority ?? 'standard', outcome: a.outcome, decidedAt: a.decidedAt })) };
}

export function truthView(t: Truth): { cases: MetricCase[]; appeals: MetricAppeal[] } {
  return {
    cases: t.requests.map((r) => ({
      id: r.id,
      priority: r.priority,
      receivedAt: r.receivedAt,
      decision: r.decision,
      decidedAt: r.decidedAt,
      extended: r.extended && !!r.decision,
      withdrawn: r.withdrawn,
    })),
    appeals: t.requests
      .filter((r) => r.appeal?.ref)
      .map((r) => ({ ref: r.appeal!.ref, caseId: r.id, priority: r.priority, outcome: r.appeal!.outcome, decidedAt: r.appeal!.decidedAt })),
  };
}
