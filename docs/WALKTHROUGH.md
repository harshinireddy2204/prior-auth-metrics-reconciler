# Step-by-step walkthrough

Everything below is for Windows (PowerShell). Commands work the same on macOS and Linux.

## Step 1. Install Node.js (one time)

The project runs on Node.js 20 or newer. Check whether it is installed:

```powershell
node -v
```

If you see an error, install the LTS version, then close and reopen PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

(Or download the LTS installer from https://nodejs.org.) Run `node -v` again; it should print v20 or higher.

## Step 2. Install the project's packages (one time)

```powershell
cd "C:\Users\Public\harshini\Prior Auth Metrics Reconciler"
npm install
```

This creates a `node_modules` folder. It is in `.gitignore`, so it never goes to GitHub.

## Step 3. Run the tests

```powershell
npm test
```

You should see `# pass 36` and `# fail 0` at the end. What the 36 tests cover:

| Test file | What it proves |
|---|---|
| `test/units.test.ts` | Time zone conversion (including Daylight Saving and New Year's Eve), every date format in the exports, NPI checksum, OCR repair of member IDs and codes, fax page extraction, and the metric arithmetic on hand-checked numbers |
| `test/matching.test.ts` | One test per real intake situation: fax then portal resubmission, status calls, same patient months later, request after a denial, mistyped member ID, different doctor, conflicting decisions, closed duplicates, appeal linking |
| `test/scenarios.test.ts` | Generates all 8 scenarios and checks the reconciled numbers against the answer key. If a code change makes matching worse, this fails |
| `test/llm.test.ts` | The Ollama fax reader, against a fake server: request shape, validation of the model's answer, and what happens when Ollama is down |
| `test/mcp.test.ts` | Starts the real MCP server and calls every tool like an AI assistant would |

To run one file: `npx tsx --test test/matching.test.ts`

## Step 4. Run every scenario and open the report

```powershell
npm run demo
start output\07-realistic\report.html
```

`npm run demo` regenerates the input data for all 8 scenarios (same seed, so the same data every time), reconciles each one, prints a summary table per scenario, and writes `output\SUMMARY.md`.

In the report, use the buttons at the top right to jump between scenarios. The sections, top to bottom:

1. **Headline cards**: requests if each channel reports separately vs after reconciliation, the median time shift, year-flip count, review queue size.
2. **Four channels in, one count out**: how many records came from each channel.
3. **One request, seen by several systems**: an example picked automatically. In `07-realistic` it is request `C00408`: a fax with an OCR-garbled member ID (`M241934SZ`, repaired), an NPI that failed its checksum, a portal resubmission a day later, and a priority conflict between the two.
4. **The metrics CMS asks for**: naive vs reconciled vs answer key. Green means it matches the key, orange means it does not. Click any row, then any request ID, to see its source records.
5. **Human review queue**: click a card to filter, click an item to open that request.
6. **Matching accuracy**: precision, recall, exact rebuilds, appeal linking, fax field accuracy.
7. **Look up any request**: type `C00408`, `fax:FX-000113`, a member ID, or an auth number like `A2026-000473`.

## Step 5. Test each scenario on its own

Run one scenario:

```powershell
npm run reconcile -- --scenario 03-ocr-noise
```

(The `--` passes the flags through npm. You can also write the name without the number: `--scenario ocr-noise`.)

What to look for in each:

| Scenario | Command | What to check |
|---|---|---|
| Clean baseline | `--scenario 01-clean` | All three columns identical, review queue empty. Proves the metric math itself |
| Cross-channel resubmissions | `--scenario 02-double-entry` | Naive counts 332 requests, reconciled 296 = key. Status calls listed as ignored |
| OCR and keying noise | `--scenario 03-ocr-noise` | Open `data\scenarios\03-ocr-noise\fax_ocr.txt` and look at the garbled IDs, then find the same request in the report with its repairs listed |
| Channels disagree | `--scenario 04-conflicts` | 51 review items: every decision or priority disagreement is listed, none silently resolved |
| Appeals and look-alikes | `--scenario 05-appeals-extensions` | A patient asking again after a denial stays a separate request; appeals without an auth number are still linked |
| Year end and time zones | `--scenario 06-year-boundary` | Naive standard median is 60.0 h vs 71.7 h true; 20 decisions flip year in UTC |
| Realistic | `--scenario 07-realistic` | The demo numbers: 2,196 naive vs 2,031 reconciled vs 2,013 key |
| Look-alikes (hard) | `--scenario 08-look-alikes` | Recall drops to 68.5% on purpose; the review queue lists the doubtful pairs with the reason (different provider NPI) |

## Step 6. Trace any number from the command line

```powershell
npm run explain -- --case C00408
npm run explain -- --record fax:FX-000113
npm run explain -- --metric expedited.deniedPct
npm run explain -- --scenario 04-conflicts --metric standard.approvedPct
```

`--metric` prints the definition, numerator and denominator, the first request IDs behind it, and traces one of them back to its source records. Metric keys: `standard.total`, `standard.approvedPct`, `standard.deniedPct`, `standard.approvedAfterAppealPct`, `standard.meanHours`, `standard.medianHours`, `standard.withinTimeframePct`, the same seven with `expedited.`, `all.extendedApprovedPct`, `excluded.withdrawn`, `excluded.pending`.

## Step 7. Break it on purpose (good for showing you understand the trade-offs)

Shrink the matching window from 21 days to 1:

```powershell
npm run reconcile -- --scenario 02-double-entry --window 1
```

Recall falls from 100% to 61.5% and the count drifts back toward naive, because resubmissions that arrive more than a day later are no longer recognized.

Switch the reporting period from decision date to receipt date:

```powershell
npm run reconcile -- --scenario 06-year-boundary --basis receipt
```

Different requests fall into 2026, which is why the period rule needs a compliance decision.

Make your own scenario: open `src\synth\scenarios.ts`, copy a block, give it a new `name` and `seed`, change the probabilities (for example `pResubmit: 0.6` or `pOcrNoise: 0.8`), save, then run `npm run demo`. Your scenario appears in the report navigation and in the tests automatically. Run `npm test` to see whether the tool still meets its accuracy thresholds.

The output of each run goes to `output\<scenario>\` (`report.html`, `metrics.json`, `cases.csv`, `review_queue.csv`). `cases.csv` and `review_queue.csv` open in Excel.

## Step 8 (optional). Read fax pages with a local LLM

You already have Ollama installed. Pull a model and run in hybrid mode (rules first, LLM only for pages the rules could not fully read):

```powershell
ollama pull qwen2.5:7b
npm run reconcile -- --scenario 03-ocr-noise --fax hybrid --model qwen2.5:7b
```

The summary prints how many pages went to the LLM. Compare the "Fax extraction accuracy" line in the report with the rules-only run. `--fax llm` sends every inbound page to the model (slower). If Ollama is not running, the run still finishes with the rules result and a warning.

This path has only been tested against a mocked Ollama response, so this step is also the first real benchmark. Note the accuracy numbers you get; they are a good addition to the README.

## Step 9 (optional). Connect the MCP server to Claude Desktop

Build once:

```powershell
npm run build
```

In Claude Desktop open Settings, then Developer, then Edit Config, and add this to `claude_desktop_config.json` (keep anything already there):

```json
{
  "mcpServers": {
    "prior-auth-reconciler": {
      "command": "node",
      "args": ["C:\\Users\\Public\\harshini\\Prior Auth Metrics Reconciler\\dist\\mcp\\server.js"]
    }
  }
}
```

Restart Claude Desktop. Then try:

- "Use prior-auth-reconciler to get the metrics for 07-realistic and explain why naive and reconciled differ."
- "Explain how expedited.deniedPct was computed and show me one request behind it."
- "What is in the review queue for 04-conflicts? Group it by type."
- "Trace request C00408."

The five tools are `list_scenarios`, `get_metrics`, `explain_metric`, `get_request` and `review_queue`. Each accepts a scenario name or the full path of a folder with your own exports.

## Step 10. Run it on other data

Put files with these names and columns in one folder (any channel can be missing):

| File | Columns |
|---|---|
| `fhir_pas.ndjson` | one FHIR Bundle per line: `Claim` (use = preauthorization), `Patient`, optional `ClaimResponse` |
| `portal_export.csv` | portal_ref, submitted_at, member_id, member_dob, provider_npi, cpt_code, urgency, status, status_updated_at, auth_number, extension_taken |
| `fax_ocr.txt` | pages starting `=== FAX PAGE <id> \| RECEIVED <date time> ===` (or `SENT` for notices) |
| `call_center_log.csv` | call_id, call_start, member_id, member_dob, provider_npi, cpt_code, service_note, urgency, disposition, auth_number, um_decided_at, agent_note |
| `appeals.csv` | appeal_id, received_at, original_auth_number, member_id, cpt_code, priority, outcome, decided_at |

```powershell
npm run reconcile -- --input "C:\path\to\exports" --year 2026
```

Outputs go to a `reconciler-output` folder inside the input folder (or `--out <folder>`). The scenario files in `data\scenarios\` are working examples of every format.

## Step 11. Push to GitHub

1. On github.com create a new repository named `prior-auth-metrics-reconciler`. Leave "Add a README" unchecked.
2. In PowerShell:

```powershell
cd "C:\Users\Public\harshini\Prior Auth Metrics Reconciler"
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Move-Item setup\ci.yml .github\workflows\ci.yml
git init
git add .
git commit -m "Prior Auth Metrics Reconciler: CMS-0057-F metrics across fax, portal, phone and FHIR"
git branch -M main
git remote add origin https://github.com/harshinireddy2204/prior-auth-metrics-reconciler.git
git push -u origin main
```

The `Move-Item` line puts the GitHub Actions workflow in place, so GitHub runs the type check and all tests on Windows and Linux (Node 20 and 22) on every push and shows a green check on the repo. After the first push, open the Actions tab to confirm it passes.

3. On the repo page, add a description ("Reconciles prior auth requests across fax, portal, phone and FHIR and computes CMS-0057-F metrics with full lineage") and topics: `fhir`, `cms-0057`, `prior-authorization`, `healthcare-interoperability`, `typescript`, `mcp`.

Optional: to let people open the demo report without downloading, turn on GitHub Pages (Settings, Pages, deploy from branch `main`, folder `/root`). The report is then at `https://harshinireddy2204.github.io/prior-auth-metrics-reconciler/output/07-realistic/report.html`.
