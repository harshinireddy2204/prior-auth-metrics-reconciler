// Named test scenarios. Each one isolates a failure mode the reconciler must handle;
// "realistic" mixes all of them at production-like volume for the demo.

import type { Channel } from '../types.js';

export interface ScenarioConfig {
  name: string;
  title: string;
  whatItTests: string;
  seed: number;
  year: number; // reporting calendar year
  nRequests: number;
  channelMix: Record<Channel, number>;
  pExpedited: number;
  pApprove: number;
  pWithdrawn: number;
  pExtended: number;
  pResubmit: number; // provider resubmits the same request on another channel before a decision
  pDupMirror: number; // a duplicate record also shows the decision
  pDupClosed: number; // a duplicate record is closed as duplicate (rest stay open)
  pDecisionConflict: number; // a mirrored decision on a duplicate disagrees with the original
  pPriorityConflict: number; // a duplicate is marked with the other priority
  pOcrNoise: number; // per fax page, chance each identifying field is garbled
  pPhoneTypo: number; // call center member ID keying error
  pMissingCpt: number; // fax or phone record without a readable service code
  pAppeal: number; // share of denials that are appealed
  pOverturn: number;
  pAppealNoAuth: number; // appeal filed without the original auth number
  pLegitRepeat: number; // same member and service, new request 45+ days later (must NOT merge)
  pRerequestAfterDenial: number; // new request soon after a denial (must NOT merge)
  inquiriesPerRequest: number; // status-check calls (never requests)
  yearBoundaryShare: number; // share of requests placed around Dec 31 to test period cutoffs
  pSecondOpinion: number; // a DIFFERENT provider requests the same service for the same member days later (must NOT merge)
  pGroupNpi: number; // a resubmission comes in under the practice's group NPI instead of the doctor's (should merge)
}

const base: Omit<ScenarioConfig, 'name' | 'title' | 'whatItTests' | 'seed'> = {
  year: 2026,
  nRequests: 300,
  channelMix: { fhir: 0.3, portal: 0.35, fax: 0.25, phone: 0.1 },
  pExpedited: 0.2,
  pApprove: 0.76,
  pWithdrawn: 0.02,
  pExtended: 0.05,
  pResubmit: 0,
  pDupMirror: 0.35,
  pDupClosed: 0.5,
  pDecisionConflict: 0,
  pPriorityConflict: 0,
  pOcrNoise: 0,
  pPhoneTypo: 0,
  pMissingCpt: 0,
  pAppeal: 0.3,
  pOverturn: 0.45,
  pAppealNoAuth: 0,
  pLegitRepeat: 0.05,
  pRerequestAfterDenial: 0,
  inquiriesPerRequest: 0,
  yearBoundaryShare: 0,
  pSecondOpinion: 0,
  pGroupNpi: 0,
};

export const SCENARIOS: ScenarioConfig[] = [
  {
    ...base,
    name: '01-clean',
    title: 'Clean baseline',
    whatItTests: 'Every request arrives once, on one channel, with no noise. Naive counting and reconciliation should agree with the answer key exactly.',
    seed: 101,
  },
  {
    ...base,
    name: '02-double-entry',
    title: 'Cross-channel resubmissions',
    whatItTests: 'A third of providers resubmit on a second channel before hearing back (fax, then portal). Status-check calls are mixed into the call log. Naive counting double counts requests and shortens response times.',
    seed: 202,
    pResubmit: 0.35,
    inquiriesPerRequest: 0.3,
  },
  {
    ...base,
    name: '03-ocr-noise',
    title: 'OCR and keying noise',
    whatItTests: 'Fax pages have OCR errors (O for 0, B for 8, smudged service codes, varied date formats) and call agents mistype member IDs. Matching must survive noisy identifiers without merging different patients.',
    seed: 303,
    channelMix: { fhir: 0.2, portal: 0.25, fax: 0.4, phone: 0.15 },
    pResubmit: 0.35,
    pOcrNoise: 0.5,
    pPhoneTypo: 0.3,
    pMissingCpt: 0.15,
  },
  {
    ...base,
    name: '04-conflicts',
    title: 'Channels disagree',
    whatItTests: 'Duplicate records carry a different decision or priority than the original. The reconciler must pick one by a stated rule and send every disagreement to a human review queue.',
    seed: 404,
    pResubmit: 0.4,
    pDupMirror: 0.6,
    pDupClosed: 0.3,
    pDecisionConflict: 0.35,
    pPriorityConflict: 0.2,
  },
  {
    ...base,
    name: '05-appeals-extensions',
    title: 'Appeals, extensions and look-alike requests',
    whatItTests: 'Many denials are appealed (some without the original auth number), many reviews are extended, and the same patient often asks again after a denial or months later. Those are new requests and must not be merged.',
    seed: 505,
    pResubmit: 0.2,
    pAppeal: 0.7,
    pAppealNoAuth: 0.3,
    pExtended: 0.25,
    pLegitRepeat: 0.12,
    pRerequestAfterDenial: 0.3,
  },
  {
    ...base,
    name: '06-year-boundary',
    title: 'Calendar year cutoffs and time zones',
    whatItTests: 'Requests cluster around New Year in both directions. Portal, fax and phone exports use Eastern wall time while FHIR uses UTC, so a decision at 11:30 pm on Dec 31 Eastern is already Jan 1 in UTC.',
    seed: 606,
    pResubmit: 0.2,
    yearBoundaryShare: 0.4,
  },
  {
    ...base,
    name: '07-realistic',
    title: 'Realistic mix (demo)',
    whatItTests: 'All of the above at once, at 2,000 requests: the dry run a plan would do before filing.',
    seed: 707,
    nRequests: 2000,
    pResubmit: 0.25,
    pDupMirror: 0.4,
    pDupClosed: 0.45,
    pDecisionConflict: 0.12,
    pPriorityConflict: 0.06,
    pOcrNoise: 0.35,
    pPhoneTypo: 0.2,
    pMissingCpt: 0.08,
    pAppeal: 0.35,
    pAppealNoAuth: 0.2,
    pExtended: 0.08,
    pWithdrawn: 0.03,
    pLegitRepeat: 0.06,
    pRerequestAfterDenial: 0.1,
    inquiriesPerRequest: 0.4,
    yearBoundaryShare: 0.1,
    pSecondOpinion: 0.03,
    pGroupNpi: 0.1,
  },
  {
    ...base,
    name: '08-look-alikes',
    title: 'Look-alike requests (hard)',
    whatItTests: 'Two genuinely ambiguous patterns. A second doctor asks for the same service for the same patient days later (a separate request), and a practice resubmits under its group NPI instead of the doctor NPI (the same request). Identifiers alone cannot always tell these apart, so the tool should route the doubtful ones to review rather than guess.',
    seed: 808,
    pResubmit: 0.35,
    pSecondOpinion: 0.2,
    pGroupNpi: 0.4,
  },
];

export function getScenario(name: string): ScenarioConfig {
  const s = SCENARIOS.find((x) => x.name === name || x.name.slice(3) === name);
  if (!s) throw new Error(`Unknown scenario "${name}". Known: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  return s;
}
