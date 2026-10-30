# OCR and keying noise

Fax pages have OCR errors (O for 0, B for 8, smudged service codes, varied date formats) and call agents mistype member IDs. Matching must survive noisy identifiers without merging different patients.

- Reporting year: 2026
- True requests: 316
- Seed: 303

Files: fhir_pas.ndjson, portal_export.csv, fax_ocr.txt, call_center_log.csv, appeals.csv. truth.json is the answer key and is never read by the reconciler.
