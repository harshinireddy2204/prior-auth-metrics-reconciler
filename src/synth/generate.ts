// Synthetic data generator. Produces the five exports a health plan would actually have
// (FHIR PAS bundles, portal CSV, fax server OCR text, call center log, appeals log)
// plus truth.json: the answer key that says which records describe which real request.
// No real patient data: member IDs, NPIs and dates are random but realistic in shape.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Channel, Decision, Priority } from '../types.js';
import { DAY, HOUR, formatWall, wallToUtc } from '../util/time.js';
import { npiCheckDigit } from '../util/ids.js';
import { SERVICES, SERVICE_BY_CODE } from '../util/services.js';
import { toCsv } from '../util/csv.js';
import type { ScenarioConfig } from './scenarios.js';

// ---------- seeded randomness ----------
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    exp: (mean: number) => -Math.log(1 - next()) * mean,
    weighted: <K extends string>(w: Record<K, number>): K => {
      const entries = Object.entries(w) as [K, number][];
      const total = entries.reduce((s, [, v]) => s + v, 0);
      let r = next() * total;
      for (const [k, v] of entries) {
        if ((r -= v) < 0) return k;
      }
      return entries[entries.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof rng>;

// ---------- truth model ----------
export interface TruthAppeal {
  ref: string;
  receivedAt: number;
  outcome?: 'overturned' | 'upheld';
  decidedAt?: number;
}
export interface TruthRequest {
  id: string;
  memberId: string;
  dob: string;
  npi: string;
  cpt: string;
  priority: Priority;
  receivedAt: number;
  primary: Channel;
  decision?: Decision;
  decidedAt?: number;
  extended: boolean;
  withdrawn: boolean;
  appeal?: TruthAppeal;
  origin: 'new' | 'legit-repeat' | 'rerequest-after-denial' | 'second-opinion';
}
export interface Truth {
  scenario: string;
  year: number;
  exportedAt: number;
  requests: TruthRequest[];
  /** submission record ref -> request id */
  submissionToRequest: Record<string, string>;
  /** decision-only record ref -> request id */
  decisionToRequest: Record<string, string>;
  inquiries: string[];
  appealToRequest: Record<string, string>;
  /** what the fax intake pages really said, for measuring extraction accuracy */
  faxFields: Record<string, { memberId: string; dob: string; npi: string; cpt: string; priority: Priority }>;
}

// ---------- garbling ----------
const TO_LETTER: Record<string, string[]> = { '0': ['O', 'D'], '1': ['I', 'l'], '5': ['S'], '8': ['B'], '2': ['Z'], '6': ['G'] };

function ocrGarble(r: Rng, s: string, swaps: number): string {
  const chars = s.split('');
  const idx = chars.map((c, i) => (TO_LETTER[c] ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < swaps && idx.length; k++) {
    const i = idx.splice(r.int(0, idx.length - 1), 1)[0];
    chars[i] = r.pick(TO_LETTER[chars[i]]);
  }
  return chars.join('');
}

function keyingTypo(r: Rng, id: string): string {
  // transpose two adjacent digits or replace one digit (the classic call-center errors)
  const c = id.split('');
  const i = r.int(2, c.length - 2);
  if (r.chance(0.5) && c[i] !== c[i + 1]) [c[i], c[i + 1]] = [c[i + 1], c[i]];
  else c[i] = String((Number(c[i]) + r.int(1, 8)) % 10);
  return c.join('');
}

function dobFormat(r: Rng, dob: string, noisy: boolean): string {
  const [y, m, d] = dob.split('-');
  if (!noisy) return `${m}/${d}/${y}`;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return r.pick([`${m}/${d}/${y}`, `${y}-${m}-${d}`, `${mon} ${Number(d)}, ${y}`, `${d}-${mon.toUpperCase()}-${y}`]);
}

// ---------- generator ----------
export function generate(cfg: ScenarioConfig, outDir: string): Truth {
  const r = rng(cfg.seed);
  const Y = cfg.year;
  const yearStart = wallToUtc(Y, 1, 1);
  const yearEnd = wallToUtc(Y + 1, 1, 1);
  const exportedAt = wallToUtc(Y + 1, 1, 31, 23, 59);

  const npis = Array.from({ length: 150 }, () => {
    const first9 = '1' + String(r.int(0, 99_999_999)).padStart(8, '0');
    return first9 + npiCheckDigit(first9);
  });
  // each doctor belongs to a practice with a group NPI
  const groups = Array.from({ length: 30 }, () => {
    const first9 = '1' + String(r.int(0, 99_999_999)).padStart(8, '0');
    return first9 + npiCheckDigit(first9);
  });
  const groupNpi = (npi: string) => groups[Number(npi.slice(5, 9)) % groups.length];
  const members: { id: string; dob: string; npi: string }[] = [];
  const newMember = () => {
    const m = {
      id: 'M' + String(r.int(10_000_000, 99_999_999)),
      dob: `${r.int(1940, 2015)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
      npi: r.pick(npis),
    };
    members.push(m);
    return m;
  };

  const businessTime = (dayStart: number) => dayStart + r.int(7 * 60, 19 * 60) * 60_000 + (r.chance(0.05) ? r.int(0, 10) * HOUR : 0);
  const randomReceipt = () => {
    if (cfg.yearBoundaryShare && r.chance(cfg.yearBoundaryShare)) {
      // around either New Year: Dec 22..Dec 31 of the prior year or of this year
      const y = r.chance(0.5) ? Y - 1 : Y;
      const day = wallToUtc(y, 12, r.int(22, 31));
      return businessTime(day);
    }
    const day = yearStart + r.int(0, 364) * DAY;
    return businessTime(day);
  };

  const requests: TruthRequest[] = [];
  let reqSeq = 0;
  const makeRequest = (
    member: { id: string; dob: string; npi: string },
    cpt: string,
    receivedAt: number,
    origin: TruthRequest['origin'],
  ): TruthRequest => {
    const priority: Priority = r.chance(cfg.pExpedited) ? 'expedited' : 'standard';
    const withdrawn = r.chance(cfg.pWithdrawn);
    const extended = !withdrawn && r.chance(cfg.pExtended);
    const req: TruthRequest = {
      id: `R${String(++reqSeq).padStart(5, '0')}`,
      memberId: member.id,
      dob: member.dob,
      npi: member.npi,
      cpt,
      priority,
      receivedAt,
      primary: r.weighted(cfg.channelMix),
      extended,
      withdrawn,
      origin,
    };
    if (!withdrawn) {
      let delay = priority === 'expedited' ? 1 * HOUR + r.exp(22 * HOUR) : 4 * HOUR + r.exp(3.2 * DAY);
      if (extended) delay += r.int(3, 14) * DAY;
      // a nightly batch makes some decisions land near midnight: exercises the period cutoff
      if (cfg.yearBoundaryShare && r.chance(0.3)) delay = Math.max(delay, 2 * HOUR) + r.int(0, 5) * 15 * 60_000;
      req.decidedAt = receivedAt + delay;
      req.decision = extended ? (r.chance(0.85) ? 'approved' : 'denied') : r.chance(cfg.pApprove) ? 'approved' : 'denied';
      if (cfg.yearBoundaryShare && r.chance(0.15)) {
        // decision right around midnight Dec 31 Eastern (UTC already says Jan 1)
        const nye = wallToUtc(new Date(receivedAt).getUTCFullYear(), 12, 31, 23, r.int(0, 59));
        if (nye > receivedAt + 2 * HOUR && nye - receivedAt < 9 * DAY) req.decidedAt = nye + (r.chance(0.5) ? r.int(1, 45) * 60_000 : -r.int(1, 45) * 60_000);
      }
    }
    requests.push(req);
    return req;
  };

  for (let i = 0; i < cfg.nRequests; i++) {
    const member = members.length > 20 && r.chance(0.25) ? r.pick(members) : newMember();
    const cpt = r.pick(SERVICES).code;
    const req = makeRequest(member, cpt, randomReceipt(), 'new');
    if (r.chance(cfg.pLegitRepeat)) {
      const later = req.receivedAt + r.int(45, 150) * DAY;
      if (later < yearEnd) makeRequest(member, cpt, later, 'legit-repeat');
    }
    if (r.chance(cfg.pSecondOpinion) && req.decidedAt !== undefined && req.decidedAt - req.receivedAt > 30 * HOUR) {
      // another doctor orders the same service for the same patient before the first is decided
      const other = { ...member, npi: r.pick(npis.filter((n) => n !== member.npi)) };
      makeRequest(other, cpt, req.receivedAt + r.int(6, Math.floor((req.decidedAt - req.receivedAt) / HOUR) - 2) * HOUR, 'second-opinion');
    }
    if (req.decision === 'denied' && r.chance(cfg.pRerequestAfterDenial)) {
      makeRequest(member, cpt, req.decidedAt! + r.int(2, 15) * DAY + r.int(0, 8) * HOUR, 'rerequest-after-denial');
    }
  }
  for (const req of requests) {
    if (req.decision === 'denied' && r.chance(cfg.pAppeal)) {
      const receivedAt = req.decidedAt! + r.int(1, 30) * DAY + r.int(0, 8) * HOUR;
      const outcome = r.chance(cfg.pOverturn) ? 'overturned' : 'upheld';
      const decidedAt = receivedAt + (req.priority === 'expedited' ? r.int(4, 70) * HOUR : r.int(3, 25) * DAY);
      req.appeal = { ref: '', receivedAt, outcome, decidedAt };
    }
  }
  requests.sort((a, b) => a.receivedAt - b.receivedAt);

  // ---------- emit channel records ----------
  const truth: Truth = {
    scenario: cfg.name,
    year: Y,
    exportedAt,
    requests,
    submissionToRequest: {},
    decisionToRequest: {},
    inquiries: [],
    appealToRequest: {},
    faxFields: {},
  };

  const fhir: string[] = [];
  const portal: Record<string, string>[] = [];
  const faxPages: { at: number; text: string }[] = [];
  const calls: Record<string, string>[] = [];
  const appeals: Record<string, string>[] = [];
  let seqFhir = 0,
    seqPortal = 0,
    seqFax = 0,
    seqNotice = 0,
    seqCall = 0,
    seqAuth = 0,
    seqAppeal = 0;
  const newAuth = (at: number) => `A${new Date(at).getUTCFullYear()}-${String(++seqAuth).padStart(6, '0')}`;
  const known = (t: number | undefined) => t !== undefined && t <= exportedAt;

  interface Emit {
    req: TruthRequest;
    channel: Channel;
    receivedAt: number;
    priority: Priority;
    outcome: 'decision' | 'closed-duplicate' | 'open';
    decision?: Decision;
    decidedAt?: number;
    isPrimary: boolean;
    npi?: string;
  }

  const emit = (e: Emit): string | undefined => {
    const { req } = e;
    const npi = e.npi ?? req.npi;
    const decided = e.outcome === 'decision' && e.decision && known(e.decidedAt);
    const withdrawn = e.isPrimary && req.withdrawn;
    const withdrawnAt = req.receivedAt + r.int(1, 5) * DAY;
    switch (e.channel) {
      case 'fhir': {
        const id = `PAS-${String(++seqFhir).padStart(6, '0')}`;
        const ref = `fhir:${id}`;
        const claim = {
          resourceType: 'Claim',
          id,
          status: withdrawn ? 'cancelled' : 'active',
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
          use: 'preauthorization',
          patient: { reference: `Patient/${req.memberId}` },
          created: new Date(e.receivedAt - r.int(1, 20) * 60_000).toISOString(),
          provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: npi } },
          priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: e.priority === 'expedited' ? 'stat' : 'normal' }] },
          item: [{ sequence: 1, productOrService: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: req.cpt, display: SERVICE_BY_CODE.get(req.cpt)?.description }] } }],
        };
        const patient = {
          resourceType: 'Patient',
          id: req.memberId,
          identifier: [{ system: 'urn:demo-plan:member-id', value: req.memberId }],
          birthDate: req.dob,
        };
        const entry: object[] = [{ resource: claim }, { resource: patient }];
        if (decided || (e.outcome === 'closed-duplicate' && known(e.decidedAt))) {
          const isDup = e.outcome === 'closed-duplicate';
          entry.push({
            resource: {
              resourceType: 'ClaimResponse',
              id: `${id}-R`,
              status: 'active',
              use: 'preauthorization',
              outcome: isDup ? 'error' : 'complete',
              disposition: isDup ? 'Closed as duplicate request' : undefined,
              created: new Date(e.decidedAt!).toISOString(),
              request: { reference: `Claim/${id}` },
              preAuthRef: newAuth(e.receivedAt),
              extension: [{ url: 'urn:demo-plan:review-timeframe-extended', valueBoolean: e.isPrimary && req.extended }],
              item: isDup
                ? undefined
                : [
                    {
                      itemSequence: 1,
                      adjudication: [
                        {
                          category: { coding: [{ code: 'submitted' }] },
                          extension: [
                            {
                              url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction',
                              extension: [{ url: 'code', valueCodeableConcept: { coding: [{ system: 'https://codesystem.x12.org/005010/306', code: e.decision === 'approved' ? 'A1' : 'A3' }] } }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
            },
          });
        }
        fhir.push(JSON.stringify({ resourceType: 'Bundle', id: `B-${id}`, type: 'collection', timestamp: new Date(e.receivedAt).toISOString(), entry }));
        truth.submissionToRequest[ref] = req.id;
        return ref;
      }
      case 'portal': {
        const id = `PRT-${String(++seqPortal).padStart(6, '0')}`;
        const ref = `portal:${id}`;
        let status = 'Pending Review';
        let updated = '';
        if (withdrawn) {
          status = 'Withdrawn';
          updated = formatWall(withdrawnAt);
        } else if (decided) {
          status = e.decision === 'approved' ? 'Approved' : 'Denied';
          updated = formatWall(e.decidedAt!);
        } else if (e.outcome === 'closed-duplicate' && known(e.decidedAt)) {
          status = 'Closed - Duplicate';
          updated = formatWall(e.decidedAt!);
        }
        portal.push({
          portal_ref: id,
          submitted_at: formatWall(e.receivedAt),
          member_id: req.memberId,
          member_dob: `${req.dob.slice(5, 7)}/${req.dob.slice(8, 10)}/${req.dob.slice(0, 4)}`,
          provider_npi: npi,
          cpt_code: req.cpt,
          urgency: e.priority === 'expedited' ? 'Urgent' : 'Routine',
          status,
          status_updated_at: updated,
          auth_number: newAuth(e.receivedAt),
          extension_taken: e.isPrimary && req.extended && decided ? 'Y' : 'N',
        });
        truth.submissionToRequest[ref] = req.id;
        return ref;
      }
      case 'fax': {
        const id = `FX-${String(++seqFax).padStart(6, '0')}`;
        const ref = `fax:${id}`;
        const noisy = () => r.chance(cfg.pOcrNoise);
        const memberShown = noisy() ? ocrGarble(r, req.memberId, r.int(1, 2)) : req.memberId;
        let npiShown = npi;
        if (noisy()) npiShown = r.chance(0.5) ? ocrGarble(r, npi, 1) : npi.slice(0, 4) + ((Number(npi[4]) + 3) % 10) + npi.slice(5);
        const missingCpt = r.chance(cfg.pMissingCpt);
        const cptShown = missingCpt ? '_____' : noisy() ? ocrGarble(r, req.cpt, 1) : req.cpt;
        const desc = SERVICE_BY_CODE.get(req.cpt)!.description;
        const label = (clean: string, alts: string[]) => (cfg.pOcrNoise && r.chance(0.4) ? r.pick(alts) : clean);
        const urgentLine =
          e.priority === 'expedited'
            ? r.pick(['Urgency: [ ] Standard  [X] Expedited', 'Urgency: ( ) Standard  (X) Expedited', 'URGENT - EXPEDITED REVIEW REQUESTED'])
            : r.pick(['Urgency: [X] Standard  [ ] Expedited', 'Urgency: (x) Standard  ( ) Expedited']);
        const text = [
          `=== FAX PAGE ${id} | RECEIVED ${formatWall(e.receivedAt)} ===`,
          'PRIOR AUTHORIZATION REQUEST FORM',
          `${label('Member ID', ['Member #', 'Mbr ID', 'MEMBER lD'])}: ${memberShown}      ${label('DOB', ['D.O.B.', 'Date of Birth', 'D0B'])}: ${dobFormat(r, req.dob, noisy())}`,
          `${label('Requesting Provider NPI', ['Provider NPI', 'NPl', 'Ordering NPI'])}: ${npiShown}`,
          `${label('Service / CPT', ['CPT/HCPCS', 'Procedure Code', 'Svc Code'])}: ${cptShown}  ${missingCpt && r.chance(0.3) ? 'see attached' : desc}`,
          urgentLine,
          `Clinical notes: ${r.pick(['Failed 6 wks conservative tx.', 'Progressive symptoms, see attached.', 'Follow-up to prior imaging.', 'Per specialist recommendation.'])}`,
        ].join('\n');
        faxPages.push({ at: e.receivedAt, text });
        truth.submissionToRequest[ref] = req.id;
        truth.faxFields[ref] = { memberId: req.memberId, dob: req.dob, npi: npi, cpt: req.cpt, priority: e.priority };
        // outbound notice (system generated, clean)
        let det: string | undefined;
        let detAt: number | undefined;
        if (withdrawn) {
          det = 'WITHDRAWN BY PROVIDER';
          detAt = withdrawnAt;
        } else if (decided) {
          det = e.decision === 'approved' ? 'APPROVED' : 'DENIED';
          detAt = e.decidedAt;
        } else if (e.outcome === 'closed-duplicate' && known(e.decidedAt)) {
          det = 'CLOSED - DUPLICATE REQUEST';
          detAt = e.decidedAt;
        }
        if (det && detAt !== undefined) {
          const nid = `FX-N-${String(++seqNotice).padStart(6, '0')}`;
          faxPages.push({
            at: detAt + r.int(2, 40) * 60_000,
            text: [
              `=== FAX PAGE ${nid} | SENT ${formatWall(detAt + r.int(2, 40) * 60_000)} ===`,
              'NOTICE OF PRIOR AUTHORIZATION DETERMINATION',
              `RE: Your fax ${id}`,
              `Authorization #: ${newAuth(e.receivedAt)}`,
              `Determination: ${det}`,
              `Determination date: ${formatWall(detAt)}`,
              `Review timeframe extended: ${e.isPrimary && req.extended && decided ? 'Yes' : 'No'}`,
            ].join('\n'),
          });
          truth.decisionToRequest[`fax:${nid}`] = req.id;
        }
        return ref;
      }
      case 'phone': {
        const id = `CALL-${String(++seqCall).padStart(6, '0')}`;
        const ref = `phone:${id}`;
        const auth = newAuth(e.receivedAt);
        const missingCpt = r.chance(cfg.pMissingCpt);
        const memberKeyed = r.chance(cfg.pPhoneTypo) ? keyingTypo(r, req.memberId) : req.memberId;
        const svc = SERVICE_BY_CODE.get(req.cpt)!;
        calls.push({
          call_id: id,
          call_start: formatWall(e.receivedAt),
          member_id: memberKeyed,
          member_dob: `${req.dob.slice(5, 7)}/${req.dob.slice(8, 10)}/${req.dob.slice(0, 4)}`,
          provider_npi: npi,
          cpt_code: missingCpt ? '' : req.cpt,
          service_note: missingCpt ? `pt needs ${svc.keywords[0]}` : '',
          urgency: e.priority === 'expedited' ? 'URGENT' : 'ROUTINE',
          disposition: 'NEW REQUEST',
          auth_number: auth,
          um_decided_at: '',
          agent_note: r.pick(['', 'clinicals to follow by fax', 'office called to start auth', '']),
        });
        truth.submissionToRequest[ref] = req.id;
        let disp: string | undefined;
        let at: number | undefined;
        if (withdrawn) {
          disp = 'WITHDRAWN';
          at = withdrawnAt;
        } else if (decided) {
          disp = e.decision === 'approved' ? 'DECISION RELAYED - APPROVED' : 'DECISION RELAYED - DENIED';
          at = e.decidedAt;
        }
        if (disp && at !== undefined) {
          const rid = `CALL-${String(++seqCall).padStart(6, '0')}`;
          calls.push({
            call_id: rid,
            call_start: formatWall(at + r.int(10, 240) * 60_000),
            member_id: req.memberId,
            member_dob: '',
            provider_npi: npi,
            cpt_code: req.cpt,
            service_note: '',
            urgency: '',
            disposition: disp,
            auth_number: auth,
            um_decided_at: formatWall(at),
            agent_note: e.isPrimary && req.extended && decided ? 'review timeframe extended' : '',
          });
          truth.decisionToRequest[`phone:${rid}`] = req.id;
        }
        return ref;
      }
    }
  };

  const primaryAuth = new Map<string, string>();
  const channels: Channel[] = ['fhir', 'portal', 'fax', 'phone'];
  for (const req of requests) {
    const before = seqAuth;
    emit({
      req,
      channel: req.primary,
      receivedAt: req.receivedAt,
      priority: req.priority,
      outcome: req.decision ? 'decision' : 'open',
      decision: req.decision,
      decidedAt: req.decidedAt,
      isPrimary: true,
    });
    if (seqAuth > before) primaryAuth.set(req.id, `A${new Date(req.receivedAt).getUTCFullYear()}-${String(before + 1).padStart(6, '0')}`);

    // resubmission on another channel while waiting
    const wait = (req.decidedAt ?? req.receivedAt + 5 * DAY) - req.receivedAt;
    if (!req.withdrawn && wait > 3 * HOUR && r.chance(cfg.pResubmit)) {
      const ch = r.pick(channels.filter((c) => c !== req.primary));
      const at = req.receivedAt + HOUR + r.next() * Math.min(0.8 * wait - HOUR, 10 * DAY);
      const u = r.next();
      const outcome: Emit['outcome'] = u < cfg.pDupMirror ? 'decision' : u < cfg.pDupMirror + cfg.pDupClosed ? 'closed-duplicate' : 'open';
      let decision = req.decision;
      if (outcome === 'decision' && decision && r.chance(cfg.pDecisionConflict)) decision = decision === 'approved' ? 'denied' : 'approved';
      const priority: Priority = r.chance(cfg.pPriorityConflict) ? (req.priority === 'standard' ? 'expedited' : 'standard') : req.priority;
      emit({
        req,
        channel: ch,
        receivedAt: at,
        priority,
        outcome: outcome === 'decision' && !req.decision ? 'open' : outcome,
        decision,
        decidedAt: req.decidedAt !== undefined ? req.decidedAt + r.int(0, 6 * 60) * 60_000 : undefined,
        isPrimary: false,
        npi: r.chance(cfg.pGroupNpi) ? groupNpi(req.npi) : undefined,
      });
    }

    // status-check calls (not requests)
    let nInq = Math.floor(cfg.inquiriesPerRequest) + (r.chance(cfg.inquiriesPerRequest % 1) ? 1 : 0);
    while (nInq-- > 0) {
      const id = `CALL-${String(++seqCall).padStart(6, '0')}`;
      calls.push({
        call_id: id,
        call_start: formatWall(req.receivedAt + r.int(2, 96) * HOUR),
        member_id: req.memberId,
        member_dob: `${req.dob.slice(5, 7)}/${req.dob.slice(8, 10)}/${req.dob.slice(0, 4)}`,
        provider_npi: req.npi,
        cpt_code: r.chance(0.6) ? req.cpt : '',
        service_note: '',
        urgency: '',
        disposition: 'STATUS INQUIRY',
        auth_number: r.chance(0.4) ? primaryAuth.get(req.id) ?? '' : '',
        um_decided_at: '',
        agent_note: r.pick(['office checking status', 'asked if auth received', 'no update yet']),
      });
      truth.inquiries.push(`phone:${id}`);
    }

    if (req.appeal && req.appeal.receivedAt <= exportedAt) {
      const id = `APL-${String(++seqAppeal).padStart(5, '0')}`;
      req.appeal.ref = `appeal:${id}`;
      const decided = known(req.appeal.decidedAt);
      appeals.push({
        appeal_id: id,
        received_at: formatWall(req.appeal.receivedAt),
        original_auth_number: r.chance(cfg.pAppealNoAuth) ? '' : primaryAuth.get(req.id) ?? '',
        member_id: req.memberId,
        cpt_code: req.cpt,
        priority: req.priority === 'expedited' ? 'Expedited' : 'Standard',
        outcome: decided ? (req.appeal.outcome === 'overturned' ? 'Overturned' : 'Upheld') : 'Pending',
        decided_at: decided ? formatWall(req.appeal.decidedAt!) : '',
      });
      truth.appealToRequest[req.appeal.ref] = req.id;
      if (!decided) {
        req.appeal.outcome = undefined;
        req.appeal.decidedAt = undefined;
      }
    } else if (req.appeal) delete req.appeal;
    // decisions after the export date are unknown to every system: the truth must say pending too
    if (req.decidedAt !== undefined && req.decidedAt > exportedAt) {
      req.decision = undefined;
      req.decidedAt = undefined;
    }
  }

  // ---------- write ----------
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'fhir_pas.ndjson'), fhir.join('\n') + '\n');
  writeFileSync(
    join(outDir, 'portal_export.csv'),
    toCsv(portal, ['portal_ref', 'submitted_at', 'member_id', 'member_dob', 'provider_npi', 'cpt_code', 'urgency', 'status', 'status_updated_at', 'auth_number', 'extension_taken']),
  );
  faxPages.sort((a, b) => a.at - b.at);
  writeFileSync(join(outDir, 'fax_ocr.txt'), faxPages.map((p) => p.text).join('\n\n') + '\n');
  calls.sort((a, b) => a.call_id.localeCompare(b.call_id));
  writeFileSync(
    join(outDir, 'call_center_log.csv'),
    toCsv(calls, ['call_id', 'call_start', 'member_id', 'member_dob', 'provider_npi', 'cpt_code', 'service_note', 'urgency', 'disposition', 'auth_number', 'um_decided_at', 'agent_note']),
  );
  writeFileSync(
    join(outDir, 'appeals.csv'),
    toCsv(appeals, ['appeal_id', 'received_at', 'original_auth_number', 'member_id', 'cpt_code', 'priority', 'outcome', 'decided_at']),
  );
  writeFileSync(join(outDir, 'truth.json'), JSON.stringify(truth, null, 1));
  writeFileSync(
    join(outDir, 'SCENARIO.md'),
    `# ${cfg.title}\n\n${cfg.whatItTests}\n\n- Reporting year: ${Y}\n- True requests: ${requests.length}\n- Seed: ${cfg.seed}\n\nFiles: fhir_pas.ndjson, portal_export.csv, fax_ocr.txt, call_center_log.csv, appeals.csv. truth.json is the answer key and is never read by the reconciler.\n`,
  );
  return truth;
}
