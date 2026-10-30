// Grievance and appeals system export.

import type { AppealRecord } from '../types.js';
import { parseCsv } from '../util/csv.js';
import { normalizeAuth, normalizeCpt, normalizeMemberId } from '../util/ids.js';
import { parseWall } from '../util/time.js';

export function parseAppeals(text: string): { appeals: AppealRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const appeals = parseCsv(text).flatMap((row, i): AppealRecord[] => {
    const receivedAt = parseWall(row.received_at ?? '');
    if (!row.appeal_id || receivedAt === undefined) {
      warnings.push(`appeals.csv row ${i + 2}: missing id or received time, skipped`);
      return [];
    }
    const outcome = (row.outcome ?? '').toLowerCase();
    return [
      {
        ref: `appeal:${row.appeal_id}`,
        receivedAt,
        authNumber: normalizeAuth(row.original_auth_number),
        memberId: normalizeMemberId(row.member_id),
        cpt: normalizeCpt(row.cpt_code),
        priority: /expedit|urgent/i.test(row.priority ?? '') ? 'expedited' : 'standard',
        outcome: outcome === 'overturned' ? 'overturned' : outcome === 'upheld' ? 'upheld' : undefined,
        decidedAt: parseWall(row.decided_at ?? ''),
        issues: row.original_auth_number ? [] : ['no original auth number; linked by member and service'],
      },
    ];
  });
  return { appeals, warnings };
}
