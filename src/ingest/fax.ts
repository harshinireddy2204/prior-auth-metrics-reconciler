// Fax server export: OCR text of inbound request forms plus the outbound determination notices.
// Inbound pages are noisy (OCR swaps O/0, B/8, I/1; labels vary; codes get smudged).
// Fields are pulled out by an extractor (rules by default, or a local LLM), then every value
// is validated the same way: member ID shape, NPI checksum, CPT shape, date parse.

import type { Priority, SourceRecord } from '../types.js';
import { isValidNpi, normalizeAuth, normalizeCpt, normalizeMemberId, normalizeNpi } from '../util/ids.js';
import { serviceFromText } from '../util/services.js';
import { parseDateOnly, parseWall } from '../util/time.js';

export interface FaxPage {
  id: string;
  direction: 'RECEIVED' | 'SENT';
  stamp: string;
  body: string;
}

export interface FaxFields {
  memberId?: string;
  dob?: string;
  npi?: string;
  cpt?: string;
  serviceText?: string;
  priority?: Priority;
}

export type FaxExtractor = (page: FaxPage) => Promise<FaxFields>;

export function splitFaxPages(text: string): FaxPage[] {
  const pages: FaxPage[] = [];
  const re = /^=== FAX PAGE (\S+) \| (RECEIVED|SENT) (.+?) ===\s*$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    pages.push({ id: m[1], direction: m[2] as FaxPage['direction'], stamp: m[3], body: text.slice(start, end).trim() });
  });
  return pages;
}

const LINE = {
  member: /(?:member\s*(?:id|#|l[dD])|mbr\s*id)\s*:\s*([A-Za-z0-9|\-]+)/i,
  dob: /(?:d\.?\s*[o0]\.?\s*b\.?|date of birth)\s*:\s*(.+?)(?:\s{2,}|$)/im,
  npi: /(?:np[il1]|provider npi)\s*:\s*([A-Za-z0-9|]+)/i,
  service: /(?:service\s*\/\s*cpt|cpt\/hcpcs|procedure code|svc code)\s*:\s*(\S+)\s*(.*)$/im,
};

/** Deterministic extractor: label regexes tolerant to OCR variants. */
export const rulesExtractor: FaxExtractor = async (page) => {
  const b = page.body;
  const f: FaxFields = {};
  f.memberId = b.match(LINE.member)?.[1];
  f.dob = b.match(LINE.dob)?.[1]?.trim();
  f.npi = b.match(LINE.npi)?.[1];
  const svc = b.match(LINE.service);
  if (svc) {
    f.cpt = svc[1];
    f.serviceText = svc[2];
  }
  f.priority = /[\[(]\s*x\s*[\])]\s*expedited|expedited review requested|\burgent\b/i.test(b) ? 'expedited' : 'standard';
  return f;
};

/** Turn extracted (possibly wrong) fields into a validated record. */
export function faxSubmissionRecord(page: FaxPage, f: FaxFields): SourceRecord {
  const issues: string[] = [];
  let confidence = 1;
  const memberId = normalizeMemberId(f.memberId);
  if (!memberId || !/^M\d{8}$/.test(memberId)) {
    issues.push(`member ID unreadable ("${f.memberId ?? ''}")`);
    confidence -= 0.4;
  } else if (memberId !== f.memberId?.toUpperCase()) issues.push(`member ID repaired from "${f.memberId}"`);
  const npi = normalizeNpi(f.npi);
  if (!npi.valid) {
    issues.push(`NPI "${f.npi ?? ''}" failed checksum, ignored for matching`);
    confidence -= 0.1;
  }
  let cpt = normalizeCpt(f.cpt);
  if (!cpt) {
    cpt = serviceFromText(f.serviceText);
    if (cpt) issues.push(`service code unreadable, recovered from description "${f.serviceText}"`);
    else {
      issues.push('service code unreadable');
      confidence -= 0.3;
    }
  } else if (cpt !== f.cpt) issues.push(`service code repaired from "${f.cpt}"`);
  const dob = f.dob ? parseDateOnly(f.dob) : undefined;
  if (!dob) {
    issues.push('date of birth unreadable');
    confidence -= 0.2;
  }
  return {
    ref: `fax:${page.id}`,
    channel: 'fax',
    kind: 'submission',
    memberIdRaw: f.memberId,
    memberId,
    dob,
    npi: npi.valid ? npi.npi : undefined,
    cpt,
    priority: f.priority ?? 'standard',
    receivedAt: parseWall(page.stamp),
    confidence: Math.max(0, confidence),
    issues,
  };
}

export function faxNoticeRecord(page: FaxPage): SourceRecord | undefined {
  const b = page.body;
  if (!/NOTICE OF PRIOR AUTHORIZATION DETERMINATION/i.test(b)) return undefined;
  const det = b.match(/Determination:\s*(.+)$/im)?.[1]?.trim().toUpperCase() ?? '';
  const when = b.match(/Determination date:\s*(.+)$/im)?.[1];
  const rec: SourceRecord = {
    ref: `fax:${page.id}`,
    channel: 'fax',
    kind: 'decision',
    authNumber: normalizeAuth(b.match(/Authorization #:\s*(\S+)/i)?.[1]),
    linksTo: (() => {
      const m = b.match(/RE: Your fax\s+(\S+)/i);
      return m ? `fax:${m[1]}` : undefined;
    })(),
    decidedAt: when ? parseWall(when) : parseWall(page.stamp),
    extended: /Review timeframe extended:\s*yes/i.test(b),
    confidence: 1,
    issues: [],
  };
  if (det.startsWith('APPROVED')) rec.decision = 'approved';
  else if (det.startsWith('DENIED')) rec.decision = 'denied';
  else if (det.startsWith('WITHDRAWN')) rec.withdrawn = true;
  else if (det.includes('DUPLICATE')) rec.closedDuplicate = true;
  else rec.issues.push(`unrecognized determination "${det}"`);
  return rec;
}

export interface FaxParseResult {
  records: SourceRecord[];
  warnings: string[];
  extractorCalls: number;
}

/**
 * mode "rules": regex only.  mode "llm": the LLM reads every inbound page.
 * mode "hybrid": rules first, the LLM only re-reads pages where rules left a problem.
 */
export async function parseFax(
  text: string,
  opts: { mode: 'rules' | 'llm' | 'hybrid'; llm?: FaxExtractor } = { mode: 'rules' },
): Promise<FaxParseResult> {
  const records: SourceRecord[] = [];
  const warnings: string[] = [];
  let extractorCalls = 0;
  for (const page of splitFaxPages(text)) {
    if (page.direction === 'SENT') {
      const n = faxNoticeRecord(page);
      if (n) records.push(n);
      else warnings.push(`fax ${page.id}: outbound page is not a determination notice, skipped`);
      continue;
    }
    let rec = faxSubmissionRecord(page, await rulesExtractor(page));
    const wantLlm = opts.llm && (opts.mode === 'llm' || (opts.mode === 'hybrid' && rec.confidence < 1));
    if (wantLlm) {
      extractorCalls++;
      try {
        const viaLlm = faxSubmissionRecord(page, await opts.llm!(page));
        if (opts.mode === 'llm' || viaLlm.confidence > rec.confidence) {
          viaLlm.issues.unshift('fields read by LLM');
          rec = viaLlm;
        }
      } catch (e) {
        warnings.push(`fax ${page.id}: LLM extraction failed (${(e as Error).message}); kept rules result`);
      }
    }
    if (rec.receivedAt === undefined) warnings.push(`fax ${page.id}: receipt stamp unreadable`);
    records.push(rec);
  }
  return { records, warnings, extractorCalls };
}

export { isValidNpi };
