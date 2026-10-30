// Load all five exports from one folder.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedInputs } from '../types.js';
import { parseAppeals } from './appeals.js';
import { parseFax, type FaxExtractor } from './fax.js';
import { parseFhir } from './fhir.js';
import { parsePhone } from './phone.js';
import { parsePortal } from './portal.js';

export const INPUT_FILES = {
  fhir: 'fhir_pas.ndjson',
  portal: 'portal_export.csv',
  fax: 'fax_ocr.txt',
  phone: 'call_center_log.csv',
  appeals: 'appeals.csv',
} as const;

export interface LoadOptions {
  faxMode?: 'rules' | 'llm' | 'hybrid';
  llm?: FaxExtractor;
}

export async function loadInputs(dir: string, opts: LoadOptions = {}): Promise<ParsedInputs & { faxLlmCalls: number }> {
  const read = (f: string) => {
    const p = join(dir, f);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  const warnings: string[] = [];
  const records = [];
  const missing = Object.values(INPUT_FILES).filter((f) => !existsSync(join(dir, f)));
  if (missing.length === Object.keys(INPUT_FILES).length) throw new Error(`No input files found in ${dir}. Expected: ${Object.values(INPUT_FILES).join(', ')}`);
  for (const f of missing) warnings.push(`${f} not found; that channel is treated as empty`);

  const fhir = read(INPUT_FILES.fhir);
  if (fhir) {
    const r = parseFhir(fhir);
    records.push(...r.records);
    warnings.push(...r.warnings);
  }
  const portal = read(INPUT_FILES.portal);
  if (portal) {
    const r = parsePortal(portal);
    records.push(...r.records);
    warnings.push(...r.warnings);
  }
  let faxLlmCalls = 0;
  const fax = read(INPUT_FILES.fax);
  if (fax) {
    const r = await parseFax(fax, { mode: opts.faxMode ?? 'rules', llm: opts.llm });
    records.push(...r.records);
    warnings.push(...r.warnings);
    faxLlmCalls = r.extractorCalls;
  }
  const phone = read(INPUT_FILES.phone);
  if (phone) {
    const r = parsePhone(phone);
    records.push(...r.records);
    warnings.push(...r.warnings);
  }
  const appealsText = read(INPUT_FILES.appeals);
  const appeals = appealsText ? parseAppeals(appealsText) : { appeals: [], warnings: [] };
  warnings.push(...appeals.warnings);
  return { records, appeals: appeals.appeals, warnings, faxLlmCalls };
}
