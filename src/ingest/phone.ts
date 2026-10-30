// Call center log. Each row is a call: a new request, a status inquiry (never a request),
// a relayed decision, or a withdrawal.

import type { SourceRecord } from '../types.js';
import { parseCsv } from '../util/csv.js';
import { normalizeAuth, normalizeCpt, normalizeMemberId, normalizeNpi } from '../util/ids.js';
import { serviceFromText } from '../util/services.js';
import { parseDateOnly, parseWall } from '../util/time.js';

export function parsePhone(text: string): { records: SourceRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const records = parseCsv(text).flatMap((row, i): SourceRecord[] => {
    const at = parseWall(row.call_start ?? '');
    if (!row.call_id || at === undefined) {
      warnings.push(`call_center_log.csv row ${i + 2}: missing call id or time, skipped`);
      return [];
    }
    const issues: string[] = [];
    const disp = (row.disposition ?? '').toUpperCase();
    let cpt = normalizeCpt(row.cpt_code);
    if (!cpt && row.service_note) {
      cpt = serviceFromText(row.service_note);
      if (cpt) issues.push(`service code inferred from note "${row.service_note}"`);
    }
    const npi = normalizeNpi(row.provider_npi);
    const base = {
      ref: `phone:${row.call_id}`,
      channel: 'phone' as const,
      memberIdRaw: row.member_id,
      memberId: normalizeMemberId(row.member_id),
      dob: parseDateOnly(row.member_dob ?? ''),
      npi: npi.valid ? npi.npi : undefined,
      cpt,
      authNumber: normalizeAuth(row.auth_number),
      confidence: 0.9, // keyed by an agent while talking: typos happen
      issues,
    };
    if (disp.startsWith('NEW REQUEST')) {
      if (!npi.valid && row.provider_npi) issues.push('NPI failed checksum');
      return [{ ...base, kind: 'submission', receivedAt: at, priority: /URGENT|EXPEDIT/.test((row.urgency ?? '').toUpperCase()) ? 'expedited' : 'standard' }];
    }
    if (disp.startsWith('STATUS')) return [{ ...base, kind: 'inquiry', receivedAt: at }];
    if (disp.startsWith('DECISION RELAYED')) {
      let decidedAt = parseWall(row.um_decided_at ?? '');
      if (decidedAt === undefined) {
        decidedAt = at;
        issues.push('no UM decision time; used call time (overstates response time)');
      }
      return [
        {
          ...base,
          kind: 'decision',
          decision: disp.includes('APPROVED') ? 'approved' : 'denied',
          decidedAt,
          extended: /extend/i.test(row.agent_note ?? ''),
        },
      ];
    }
    if (disp.startsWith('WITHDRAWN')) return [{ ...base, kind: 'decision', withdrawn: true, decidedAt: at }];
    warnings.push(`call_center_log.csv row ${i + 2}: unknown disposition "${row.disposition}", skipped`);
    return [];
  });
  return { records, warnings };
}
