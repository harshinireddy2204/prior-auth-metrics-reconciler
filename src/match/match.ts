// Reconciliation: group source records that describe the same prior authorization request.
//
// Rules (all stated, all configurable):
//  1. A decision-only record (fax notice, phone relay) attaches to the submission it answers,
//     by fax reference or by authorization number.
//  2. Two submissions are the same request when they share an auth number, or when they
//     arrive on different channels within WINDOW days, for the same member (exact ID, or an ID
//     one edit away with the same date of birth), for the same service, before that request
//     was decided. A submission arriving after the decision is a new request (or an appeal).
//     A different provider NPI counts against a match; near misses go to the review queue.
//  3. The original (earliest) submission is the system of record for priority and decision.
//     Any disagreement from a later record is kept and sent to the review queue.
//  4. Appeals link by original auth number, else by member and service to the most recent
//     denial before the appeal.

import type { AppealRecord, Case, Channel, Decision, SourceRecord } from '../types.js';
import { DAY } from '../util/time.js';
import { editDistance } from '../util/ids.js';

export interface MatchConfig {
  windowDays: number;
  appealWindowDays: number;
  mergeThreshold: number;
  channelPrecedence: Channel[];
  lowConfidence: number;
}

export const DEFAULT_MATCH: MatchConfig = {
  windowDays: 21,
  appealWindowDays: 120,
  mergeThreshold: 4,
  channelPrecedence: ['fhir', 'portal', 'fax', 'phone'],
  lowConfidence: 0.7,
};

export interface ReviewItem {
  type: 'decision-conflict' | 'priority-conflict' | 'possible-duplicate' | 'orphan-decision' | 'unlinked-appeal' | 'low-confidence' | 'missing-receipt-time';
  caseId?: string;
  refs: string[];
  message: string;
}

/** A submission with the decision information that attached to it. */
export interface Effective {
  rec: SourceRecord;
  decision?: Decision;
  decidedAt?: number;
  decisionRef?: string;
  withdrawn: boolean;
  closedDuplicate: boolean;
  extended: boolean;
  auths: Set<string>;
  attached: string[];
}

export interface Reconciliation {
  cases: Case[];
  byRef: Map<string, SourceRecord>;
  effective: Map<string, Effective>;
  caseOfRecord: Map<string, string>;
  appeals: AppealRecord[];
  caseOfAppeal: Map<string, string>;
  inquiries: string[];
  review: ReviewItem[];
  config: MatchConfig;
}

export function attachDecisions(records: SourceRecord[], review: ReviewItem[]): Map<string, Effective> {
  const eff = new Map<string, Effective>();
  const byAuth = new Map<string, Effective>();
  for (const r of records) {
    if (r.kind !== 'submission') continue;
    const e: Effective = {
      rec: r,
      decision: r.decision,
      decidedAt: r.decision ? r.decidedAt : undefined,
      decisionRef: r.decision ? r.ref : undefined,
      withdrawn: !!r.withdrawn,
      closedDuplicate: !!r.closedDuplicate,
      extended: !!r.extended,
      auths: new Set(r.authNumber ? [r.authNumber] : []),
      attached: [],
    };
    eff.set(r.ref, e);
    if (r.authNumber) byAuth.set(r.authNumber, e);
  }
  for (const d of records) {
    if (d.kind !== 'decision') continue;
    const target = (d.linksTo && eff.get(d.linksTo)) || (d.authNumber && byAuth.get(d.authNumber)) || undefined;
    if (!target) {
      review.push({ type: 'orphan-decision', refs: [d.ref], message: `Decision record ${d.ref} (auth ${d.authNumber ?? 'none'}) matches no submission` });
      continue;
    }
    target.attached.push(d.ref);
    if (d.authNumber) {
      target.auths.add(d.authNumber);
      byAuth.set(d.authNumber, target);
    }
    if (d.withdrawn) target.withdrawn = true;
    if (d.closedDuplicate) target.closedDuplicate = true;
    if (d.extended) target.extended = true;
    if (d.decision && (!target.decision || (d.decidedAt ?? Infinity) < (target.decidedAt ?? Infinity))) {
      target.decision = d.decision;
      target.decidedAt = d.decidedAt;
      target.decisionRef = d.ref;
    }
  }
  return eff;
}

interface Cluster {
  members: Effective[];
  first: number;
  memberIds: Set<string>;
  dobs: Set<string>;
  cpts: Set<string>;
  npis: Set<string>;
  channels: Set<Channel>;
  auths: Set<string>;
  determinedAt?: number;
}

function newCluster(e: Effective): Cluster {
  const c: Cluster = {
    members: [],
    first: e.rec.receivedAt!,
    memberIds: new Set(),
    dobs: new Set(),
    cpts: new Set(),
    npis: new Set(),
    channels: new Set(),
    auths: new Set(),
  };
  addTo(c, e);
  return c;
}

function addTo(c: Cluster, e: Effective) {
  c.members.push(e);
  const r = e.rec;
  if (r.memberId) c.memberIds.add(r.memberId);
  if (r.dob) c.dobs.add(r.dob);
  if (r.cpt) c.cpts.add(r.cpt);
  if (r.npi) c.npis.add(r.npi);
  c.channels.add(r.channel);
  for (const a of e.auths) c.auths.add(a);
  const t = e.decision ? e.decidedAt : e.withdrawn ? Infinity : undefined;
  if (e.decision && t !== undefined && (c.determinedAt === undefined || t < c.determinedAt)) c.determinedAt = t;
}

/** Score how likely submission e belongs to cluster c. Returns -1 when it cannot. */
export function scorePair(c: Cluster, e: Effective, cfg: MatchConfig): number {
  const r = e.rec;
  for (const a of e.auths) if (c.auths.has(a)) return 10;
  if (r.receivedAt! - c.first > cfg.windowDays * DAY) return -1;
  if (c.determinedAt !== undefined && r.receivedAt! >= c.determinedAt) return -1;
  if (c.channels.has(r.channel)) return -1;
  let s = 0;
  if (r.memberId && c.memberIds.has(r.memberId)) s += 3;
  else if (r.memberId && r.dob && c.dobs.has(r.dob) && [...c.memberIds].some((m) => editDistance(m, r.memberId!) <= 1)) s += 2;
  else return -1;
  if (r.cpt && c.cpts.size) {
    if (!c.cpts.has(r.cpt)) return -1;
    s += 2;
  } else s += 0.5;
  // a different (valid) NPI is evidence of a different doctor, but practices also resubmit under a
  // group NPI, so it lowers the score instead of vetoing: doubtful pairs go to review
  if (r.npi && c.npis.size) s += c.npis.has(r.npi) ? 1 : -2;
  return s;
}

function nearReason(c: Cluster, e: Effective): string {
  const r = e.rec;
  const why: string[] = ['same member and service within the window'];
  if (r.npi && c.npis.size && !c.npis.has(r.npi)) why.push(`but a different provider NPI (${r.npi} vs ${[...c.npis][0]})`);
  if (r.memberId && !c.memberIds.has(r.memberId)) why[0] = `member ID one character off (${r.memberId} vs ${[...c.memberIds][0]}) with the same birth date`;
  if (!r.cpt || !c.cpts.size) why.push('but the service code is missing on one side');
  return why.join(', ');
}

export function reconcile(records: SourceRecord[], appeals: AppealRecord[], cfg: MatchConfig = DEFAULT_MATCH): Reconciliation {
  const review: ReviewItem[] = [];
  const byRef = new Map(records.map((r) => [r.ref, r]));
  const effective = attachDecisions(records, review);
  const inquiries = records.filter((r) => r.kind === 'inquiry').map((r) => r.ref);

  const subs = [...effective.values()].filter((e) => {
    if (e.rec.receivedAt === undefined || Number.isNaN(e.rec.receivedAt)) {
      review.push({ type: 'missing-receipt-time', refs: [e.rec.ref], message: `${e.rec.ref} has no readable receipt time and cannot be counted` });
      return false;
    }
    return true;
  });
  subs.sort((a, b) => a.rec.receivedAt! - b.rec.receivedAt! || a.rec.ref.localeCompare(b.rec.ref));

  const clusters: Cluster[] = [];
  const open: Cluster[] = []; // clusters still inside the time window
  for (const e of subs) {
    const now = e.rec.receivedAt!;
    while (open.length && now - open[0].first > cfg.windowDays * DAY) open.shift();
    let best: Cluster | undefined;
    let bestScore = -1;
    let near: Cluster | undefined;
    // auth-number links can reach any cluster; fuzzy links only open ones
    const pool = e.auths.size ? clusters : open;
    for (const c of pool) {
      const s = scorePair(c, e, cfg);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best && bestScore >= cfg.mergeThreshold) addTo(best, e);
    else {
      if (best && bestScore >= 2) near = best;
      const c = newCluster(e);
      clusters.push(c);
      open.push(c);
      if (near) {
        review.push({
          type: 'possible-duplicate',
          refs: [e.rec.ref, ...near.members.map((m) => m.rec.ref)],
          message: `${e.rec.ref} may be a resubmission of ${near.members[0].rec.ref}: ${nearReason(near, e)}. Counted separately until a person confirms.`,
        });
      }
    }
  }

  const prec = (ch: Channel) => cfg.channelPrecedence.indexOf(ch);
  clusters.sort((a, b) => a.first - b.first);
  const cases: Case[] = [];
  const caseOfRecord = new Map<string, string>();
  clusters.forEach((c, i) => {
    const id = `C${String(i + 1).padStart(5, '0')}`;
    const members = [...c.members].sort((a, b) => a.rec.receivedAt! - b.rec.receivedAt!);
    const original = members[0];
    const conflicts: string[] = [];
    const needsReview: string[] = [];

    const priority = original.rec.priority ?? 'standard';
    const otherPri = members.filter((m) => m.rec.priority && m.rec.priority !== priority);
    if (otherPri.length) {
      const msg = `Priority: original ${original.rec.ref} says ${priority}; ${otherPri.map((m) => `${m.rec.ref} says ${m.rec.priority}`).join(', ')}`;
      conflicts.push(msg);
      review.push({ type: 'priority-conflict', caseId: id, refs: members.map((m) => m.rec.ref), message: msg });
    }

    const deciders = members.filter((m) => m.decision && !m.closedDuplicate);
    let chosen: Effective | undefined;
    if (deciders.length) {
      chosen = deciders.includes(original) ? original : [...deciders].sort((a, b) => prec(a.rec.channel) - prec(b.rec.channel) || a.rec.receivedAt! - b.rec.receivedAt!)[0];
      const disagree = deciders.filter((m) => m.decision !== chosen!.decision);
      if (disagree.length) {
        const msg = `Decision: ${chosen.decisionRef} says ${chosen.decision}; ${disagree.map((m) => `${m.decisionRef} says ${m.decision}`).join(', ')}`;
        conflicts.push(msg);
        review.push({ type: 'decision-conflict', caseId: id, refs: members.map((m) => m.rec.ref), message: msg });
      }
    }
    const agreeing = chosen ? deciders.filter((m) => m.decision === chosen!.decision) : [];
    const decidedAt = agreeing.length ? Math.min(...agreeing.map((m) => m.decidedAt ?? Infinity)) : undefined;
    for (const m of members) {
      if (m.rec.confidence < cfg.lowConfidence) {
        needsReview.push(`${m.rec.ref}: ${m.rec.issues.join('; ')}`);
        review.push({ type: 'low-confidence', caseId: id, refs: [m.rec.ref], message: `${m.rec.ref} parsed with low confidence: ${m.rec.issues.join('; ')}` });
      }
    }
    const records = members.flatMap((m) => [m.rec.ref, ...m.attached]);
    for (const r of records) caseOfRecord.set(r, id);
    cases.push({
      id,
      records,
      memberId: original.rec.memberId,
      cpt: original.rec.cpt ?? members.find((m) => m.rec.cpt)?.rec.cpt,
      priority,
      receivedAt: c.first,
      decision: chosen?.decision,
      decidedAt: decidedAt === Infinity ? undefined : decidedAt,
      decisionSource: chosen?.decisionRef,
      extended: agreeing.some((m) => m.extended),
      withdrawn: !chosen && original.withdrawn,
      appeals: [],
      conflicts,
      needsReview,
    });
  });

  // ---- appeals ----
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const caseByAuth = new Map<string, Case>();
  for (const c of clusters) {
    const anyRef = c.members[0].rec.ref;
    const k = caseById.get(caseOfRecord.get(anyRef)!)!;
    for (const a of c.auths) caseByAuth.set(a, k);
  }
  const caseOfAppeal = new Map<string, string>();
  const deniedByKey = new Map<string, Case[]>();
  for (const k of cases) {
    if (k.decision !== 'denied' || !k.memberId || !k.cpt) continue;
    const key = `${k.memberId}|${k.cpt}`;
    (deniedByKey.get(key) ?? deniedByKey.set(key, []).get(key)!).push(k);
  }
  for (const a of appeals) {
    let target = a.authNumber ? caseByAuth.get(a.authNumber) : undefined;
    if (!target && a.memberId && a.cpt) {
      const cands = (deniedByKey.get(`${a.memberId}|${a.cpt}`) ?? []).filter(
        (k) => k.decidedAt !== undefined && k.decidedAt < a.receivedAt && a.receivedAt - k.decidedAt <= cfg.appealWindowDays * DAY,
      );
      target = cands.sort((x, y) => y.decidedAt! - x.decidedAt!)[0];
    }
    if (target) {
      target.appeals.push(a.ref);
      caseOfAppeal.set(a.ref, target.id);
    } else review.push({ type: 'unlinked-appeal', refs: [a.ref], message: `Appeal ${a.ref} could not be linked to a denied request` });
  }

  for (const item of review) if (!item.caseId) item.caseId = item.refs.map((x) => caseOfRecord.get(x)).find(Boolean);
  return { cases, byRef, effective, caseOfRecord, appeals, caseOfAppeal, inquiries, review, config: cfg };
}
