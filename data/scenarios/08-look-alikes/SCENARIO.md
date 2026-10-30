# Look-alike requests (hard)

Two genuinely ambiguous patterns. A second doctor asks for the same service for the same patient days later (a separate request), and a practice resubmits under its group NPI instead of the doctor NPI (the same request). Identifiers alone cannot always tell these apart, so the tool should route the doubtful ones to review rather than guess.

- Reporting year: 2026
- True requests: 348
- Seed: 808

Files: fhir_pas.ndjson, portal_export.csv, fax_ocr.txt, call_center_log.csv, appeals.csv. truth.json is the answer key and is never read by the reconciler.
