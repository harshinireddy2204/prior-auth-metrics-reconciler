# Calendar year cutoffs and time zones

Requests cluster around New Year in both directions. Portal, fax and phone exports use Eastern wall time while FHIR uses UTC, so a decision at 11:30 pm on Dec 31 Eastern is already Jan 1 in UTC.

- Reporting year: 2026
- True requests: 312
- Seed: 606

Files: fhir_pas.ndjson, portal_export.csv, fax_ocr.txt, call_center_log.csv, appeals.csv. truth.json is the answer key and is never read by the reconciler.
