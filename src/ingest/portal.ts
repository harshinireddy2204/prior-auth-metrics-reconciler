// Provider portal export (CSV, payer-local wall time).

import type { SourceRecord } from '../types.js';
import { parseCsv } from '../util/csv.js';
import { normalizeAuth, normalizeCpt, normalizeMemberId, normalizeNpi } from '../util/ids.js';
import { parseDateOnly, parseWall } from '../util/time.js';

export function parsePortal(text: string): { records: SourceRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const records = parseCsv(text).flatMap((row, i): SourceRecord[] => {
    const receivedAt = parseWall(row.submitted_at ?? '');
    if (!row.portal_ref || receivedAt === undefined) {
      warnings.push(`portal_export.csv row ${i + 2}: missing reference or submit time, skipped`);
      return [];
    }
    const issues: string[] = [];
    const npi = normalizeNpi(row.provider_npi);
    if (!npi.valid) issues.push('NPI failed checksum');
    const status = (row.status ?? '').toLowerCase();
    const updated = parseWall(row.status_updated_at ?? '');
    const rec: SourceRecord = {
      ref: `portal:${row.portal_ref}`,
      channel: 'portal',
      kind: 'submission',
      memberIdRaw: row.member_id,
      memberId: normalizeMemberId(row.member_id),
      dob: parseDateOnly(row.member_dob ?? ''),
      npi: npi.valid ? npi.npi : undefined,
      cpt: normalizeCpt(row.cpt_code),
      priority: /urgent|expedit/i.test(row.urgency ?? '') ? 'expedited' : 'standard',
      receivedAt,
      authNumber: normalizeAuth(row.auth_number),
      extended: /^y/i.test(row.extension_taken ?? ''),
      confidence: 1,
      issues,
    };
    if (status === 'approved' || status === 'denied') {
      rec.decision = status;
      rec.decidedAt = updated;
      if (updated === undefined) issues.push('decision without a status time');
    } else if (status.startsWith('withdrawn')) rec.withdrawn = true;
    else if (status.includes('duplicate')) {
      rec.closedDuplicate = true;
      rec.decidedAt = updated;
    }
    return [rec];
  });
  return { records, warnings };
}
