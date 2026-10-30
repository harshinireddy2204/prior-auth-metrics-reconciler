// Optional LLM extractor for fax pages, using a local model through Ollama (free, nothing leaves
// the machine, which matters for PHI). The model only proposes field values; every value is then
// validated by the same checks as the rules extractor (checksum, shape, date parse).

import type { FaxExtractor, FaxFields } from './fax.js';

const SCHEMA = {
  type: 'object',
  properties: {
    memberId: { type: 'string', description: 'Member ID, letter M followed by 8 digits' },
    dob: { type: 'string', description: 'Date of birth as YYYY-MM-DD' },
    npi: { type: 'string', description: '10 digit provider NPI' },
    cpt: { type: 'string', description: '5 character CPT or HCPCS code, empty if unreadable' },
    serviceText: { type: 'string', description: 'service description text' },
    priority: { type: 'string', enum: ['standard', 'expedited'] },
  },
  required: ['memberId', 'dob', 'npi', 'cpt', 'priority'],
};

const SYSTEM = `You read OCR text of prior authorization fax forms and return the fields as JSON.
OCR often swaps letters for digits: O or D for 0, I or l for 1, S for 5, B for 8, Z for 2, G for 6.
Member IDs are the letter M then 8 digits. NPIs are 10 digits. Fix obvious OCR swaps in numeric fields.
If a field is unreadable return an empty string. Never invent values.`;

export function ollamaExtractor(opts: { model: string; host?: string; fetchImpl?: typeof fetch }): FaxExtractor {
  const host = opts.host ?? 'http://localhost:11434';
  const f = opts.fetchImpl ?? fetch;
  return async (page) => {
    const res = await f(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        format: SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: page.body },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(data.message?.content ?? '{}') as Record<string, string>;
    const out: FaxFields = {
      memberId: parsed.memberId || undefined,
      dob: parsed.dob || undefined,
      npi: parsed.npi || undefined,
      cpt: parsed.cpt || undefined,
      serviceText: parsed.serviceText || undefined,
      priority: parsed.priority === 'expedited' ? 'expedited' : 'standard',
    };
    return out;
  };
}
