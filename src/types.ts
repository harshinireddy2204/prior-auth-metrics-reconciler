// Shared types for the reconciler.

export type Channel = 'fhir' | 'portal' | 'fax' | 'phone';
export type Priority = 'standard' | 'expedited';
export type Decision = 'approved' | 'denied';

/**
 * One row, page or bundle from one intake channel, normalized.
 * - submission: a provider asking for prior authorization
 * - decision: a record that only carries a determination (fax notice, phone relay call)
 * - inquiry: a status check call; never a request
 */
export interface SourceRecord {
  ref: string; // globally unique, e.g. "portal:PRT-000123"
  channel: Channel;
  kind: 'submission' | 'decision' | 'inquiry';
  memberId?: string; // normalized
  memberIdRaw?: string;
  dob?: string; // YYYY-MM-DD
  npi?: string;
  cpt?: string;
  priority?: Priority;
  receivedAt?: number; // epoch ms, payer receipt
  decision?: Decision;
  decidedAt?: number; // epoch ms
  extended?: boolean;
  withdrawn?: boolean;
  closedDuplicate?: boolean;
  authNumber?: string;
  linksTo?: string; // for decision records: channel ref of the submission they answer (e.g. fax ref)
  confidence: number; // 0..1, how sure the parser is about the fields
  issues: string[];
}

export interface AppealRecord {
  ref: string;
  receivedAt: number;
  authNumber?: string;
  memberId?: string;
  cpt?: string;
  priority?: Priority;
  outcome?: 'overturned' | 'upheld';
  decidedAt?: number;
  issues: string[];
}

/** A reconciled prior authorization request: one or more source records describing it. */
export interface Case {
  id: string;
  records: string[]; // source record refs
  memberId?: string;
  cpt?: string;
  priority: Priority;
  receivedAt: number; // earliest payer receipt across channels
  decision?: Decision;
  decidedAt?: number;
  decisionSource?: string; // ref of the record whose decision was used
  extended: boolean;
  withdrawn: boolean;
  appeals: string[]; // appeal refs
  conflicts: string[];
  needsReview: string[];
}

export interface ParsedInputs {
  records: SourceRecord[];
  appeals: AppealRecord[];
  warnings: string[];
}
