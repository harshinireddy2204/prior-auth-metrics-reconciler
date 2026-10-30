// The Ollama extractor is tested against a fake HTTP response, so the test needs no model.
// It checks the request shape, and that the LLM's answer still goes through validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaExtractor } from '../src/ingest/faxLlm.js';
import { parseFax } from '../src/ingest/fax.js';

const PAGE = `=== FAX PAGE FX-000001 | RECEIVED 03/14/2026 10:42 ===
PRIOR AUTHORIZATION REQUEST FORM
Member: smudged      DOB: smudged
Provider: smudged
Service: smudged`;

function fakeFetch(reply: object, seen: { body?: any }) {
  return (async (_url: string, init: { body: string }) => {
    seen.body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(reply) } }) };
  }) as unknown as typeof fetch;
}

test('hybrid mode calls the LLM only for pages the rules could not read, and validates its answer', async () => {
  const seen: { body?: any } = {};
  const llm = ollamaExtractor({
    model: 'qwen2.5:7b',
    fetchImpl: fakeFetch({ memberId: 'M1O293848', dob: '1968-04-11', npi: '1234567893', cpt: '72148', priority: 'standard' }, seen),
  });
  const { records, extractorCalls } = await parseFax(PAGE, { mode: 'hybrid', llm });
  assert.equal(extractorCalls, 1);
  assert.equal(seen.body.model, 'qwen2.5:7b');
  assert.equal(seen.body.stream, false);
  assert.ok(seen.body.format.properties.memberId);
  const r = records[0];
  assert.equal(r.memberId, 'M10293848'); // the LLM left an O; validation repaired it
  assert.equal(r.cpt, '72148');
  assert.ok(r.issues[0].includes('LLM'));
});

test('an LLM answer that fails validation is not trusted over the rules', async () => {
  const llm = ollamaExtractor({ model: 'x', fetchImpl: fakeFetch({ memberId: 'banana', dob: '', npi: '1234567890', cpt: '', priority: 'standard' }, {}) });
  const { records } = await parseFax(PAGE, { mode: 'hybrid', llm });
  assert.ok(!records[0].issues[0]?.includes('LLM'));
});

test('if Ollama is down the run continues with the rules result and a warning', async () => {
  const llm = ollamaExtractor({ model: 'x', fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch });
  const { records, warnings } = await parseFax(PAGE, { mode: 'hybrid', llm });
  assert.equal(records.length, 1);
  assert.ok(warnings[0].includes('LLM extraction failed'));
});
