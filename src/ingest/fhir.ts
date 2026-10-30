// FHIR channel: one Bundle per line holding a PAS-shaped Claim (use = preauthorization),
// the Patient, and the ClaimResponse once a decision exists.
// Shapes follow the Da Vinci PAS pattern but are not validated against the implementation guide.

import type { SourceRecord } from '../types.js';
import { normalizeCpt, normalizeMemberId, normalizeNpi } from '../util/ids.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const REVIEW_ACTION = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction';

function reviewActionCode(cr: any): string | undefined {
  for (const item of cr.item ?? []) {
    for (const adj of item.adjudication ?? []) {
      for (const ext of adj.extension ?? []) {
        if (ext.url !== REVIEW_ACTION) continue;
        for (const sub of ext.extension ?? []) {
          const code = sub.valueCodeableConcept?.coding?.[0]?.code;
          if (code) return code;
        }
      }
    }
  }
  return undefined;
}

export function parseFhir(text: string): { records: SourceRecord[]; warnings: string[] } {
  const records: SourceRecord[] = [];
  const warnings: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let bundle: any;
    try {
      bundle = JSON.parse(line);
    } catch {
      warnings.push(`fhir_pas.ndjson line ${i + 1}: not valid JSON, skipped`);
      return;
    }
    const res = (bundle.entry ?? []).map((e: any) => e.resource);
    const claim = res.find((r: any) => r?.resourceType === 'Claim' && r.use === 'preauthorization');
    if (!claim) {
      warnings.push(`fhir_pas.ndjson line ${i + 1}: no preauthorization Claim, skipped`);
      return;
    }
    const patient = res.find((r: any) => r?.resourceType === 'Patient');
    const cr = res.find((r: any) => r?.resourceType === 'ClaimResponse');
    const issues: string[] = [];
    const receivedAt = Date.parse(bundle.timestamp ?? claim.created);
    if (!bundle.timestamp) issues.push('no Bundle.timestamp; used Claim.created as receipt time');
    const memberRaw = patient?.identifier?.[0]?.value ?? claim.patient?.reference?.split('/')[1];
    const npi = normalizeNpi(claim.provider?.identifier?.value);
    if (!npi.valid) issues.push('NPI failed checksum');
    const rec: SourceRecord = {
      ref: `fhir:${claim.id}`,
      channel: 'fhir',
      kind: 'submission',
      memberIdRaw: memberRaw,
      memberId: normalizeMemberId(memberRaw),
      dob: patient?.birthDate,
      npi: npi.valid ? npi.npi : undefined,
      cpt: normalizeCpt(claim.item?.[0]?.productOrService?.coding?.[0]?.code),
      priority: claim.priority?.coding?.[0]?.code === 'stat' ? 'expedited' : 'standard',
      receivedAt,
      withdrawn: claim.status === 'cancelled',
      confidence: 1,
      issues,
    };
    if (cr) {
      rec.authNumber = cr.preAuthRef;
      const decidedAt = Date.parse(cr.created);
      if (cr.outcome === 'error' && /duplicate/i.test(cr.disposition ?? '')) {
        rec.closedDuplicate = true;
        rec.decidedAt = decidedAt;
      } else {
        const code = reviewActionCode(cr);
        if (code === 'A1' || code === 'A6') rec.decision = 'approved'; // A6 = modified (partial approval)
        else if (code === 'A3') rec.decision = 'denied';
        if (rec.decision) rec.decidedAt = decidedAt;
        else if (code !== 'A4') issues.push(`ClaimResponse without a recognized review action (${code ?? 'none'})`);
      }
      rec.extended = (cr.extension ?? []).some((x: any) => /extended/i.test(x.url) && x.valueBoolean === true);
    }
    records.push(rec);
  });
  return { records, warnings };
}
