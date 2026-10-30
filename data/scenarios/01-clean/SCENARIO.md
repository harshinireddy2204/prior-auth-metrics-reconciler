# Clean baseline

Every request arrives once, on one channel, with no noise. Naive counting and reconciliation should agree with the answer key exactly.

- Reporting year: 2026
- True requests: 308
- Seed: 101

Files: fhir_pas.ndjson, portal_export.csv, fax_ocr.txt, call_center_log.csv, appeals.csv. truth.json is the answer key and is never read by the reconciler.
