# ITR Workbook (Personal ITR-1 / ITR-2 checker)

A privacy-first, **client-side** ITR workbook for Indian taxpayers.
Files never leave the browser. Same architecture as the static
Tax P&L app — no backend, no npm install required to use the app,
no analytics, no third-party calls. Deployable to Vercel/Netlify
as a static site.

**Project path on this machine:** `webapp-itr-workbook/` (under the
portfolio-tracker repo).

## What it does (v1.1+)

- **Multi-year support**: AY 2025-26 (FY 2024-25) and AY 2024-25
  (FY 2023-24). Year-picker dashboard as the home — click a
  year card to drill in.
- **Auto-routing uploads**: Form 16 / 26AS / broker P&L
  auto-detect the AY from file content and write to the right
  year's workbook. No more picking the AY first.
- **Profile is global**: PAN, name, address, bank, mobile — used
  across all year workbooks. Stored separately so you enter
  these once.
- **Inputs per year**: salary (multi-employer), house property
  (self-occupied + let-out), other sources (interest,
  dividends, lottery), capital gains (STCG 111A / LTCG 112A
  / STCL / LTCL with per-year 8-year expiry buckets),
  deductions (80C, 80CCD, 80D, 80E, 80G, 80TTA, 80TTB),
  TDS / advance tax.
- **Computes**: both old regime (default 1961 IT Act slabs) and
  new regime (Section 115BAC, FY 2024-25 with 75K std ded + 7L
  rebate). Side-by-side comparison, recommends the cheaper one.
- **Schedule CG handled correctly** (the v1 limitation of
  "folding cap gains into the slab tax" is fixed): 111A STCG
  taxed at flat 15%, 112A LTCG at 10% above ₹1L exemption,
  other LTCG at 20% w/ indexation, 87A rebate applies to
  ordinary income only.
- **234B / 234C interest** on advance-tax shortfalls is computed
  (reported separately, NOT added to total tax liability).
- **Per-year STCL/LTCL buckets** with 8-year expiry filter —
  buckets whose window has expired are auto-excluded.
- **Outputs**: printable summary report (text), ITR preview JSON
  (for pasting into the official ITR utility), and a side-by-side
  tax preview. Bank account numbers are masked in the export.
- **Form 16 PDF parser** (text-based PDFs in v1; scanned PDFs need
  OCR, out of scope).
- **Form 26AS JSON parser** for TDS reconciliation.
- **All-years comparison view** — see AY 2025-26 vs AY 2024-25
  side-by-side on one screen.
- **Real PDF.js** loaded from CDN for actual PDF parsing of
  Form 16 (not just text files).
- **Broker P&L xlsx/csv import** (Angel One / Zerodha) — auto-routes
  to the right AY based on the filename or file content.

## Out of scope (v1.1+)

- Business income (ITR-3 / ITR-4)
- Foreign income (Schedule FSI / FA)
- Crypto / VDA taxation
- Direct e-filing integration (DSC / Aadhaar OTP)
- 234A interest (late filing return) and 271/273 penalties
- Scanned Form 16 PDFs (need OCR)
- 3rd AY (e.g. AY 2023-24) — would require adding regime configs.
  Data model is N-ready; engine caps at 2.

## Project layout

```
webapp-itr-workbook/
  index.html                          # single-page UI (year picker + form + profile + compare)
  styles.css                          # UI stylesheet
  package.json                        # test runner + npm dependencies
  js/
    data_model.js                     # Workbook shape + global Profile + migration
    tax_engine.js                     # Indian tax computation (both regimes)
    validation.js                     # JSON-schema-style validator
    integrations.js                   # Form 16, Form 26AS, ITR preview
    pdfjs-stub.js                     # real PDF.js wrapper (loads from CDN)
    sheetjs-loader.js                 # SheetJS wrapper (loads from CDN)
    app.js                            # UI controller (views, routing, auto-routing uploads)
    adapters/
      index.js                        # ITR-1/2 selector, JSON export, file download, clipboard
      brokers.js                      # Angel One + Zerodha xlsx/csv parsers
    reports/
      index.js                        # printable summary report
    tests/
      test_tax_engine.spec.js                 # 26 tests
      test_statutory_compliance.spec.js       # 48 tests
      test_schema_validation.spec.js          # 38 tests
      test_integrations.spec.js               # 28 tests
      test_security.spec.js                   # 27 tests
      test_functional_stability.spec.js       # 25 tests
      test_performance.spec.js                # 17 tests
      test_industry_benchmarking.spec.js      # 24 tests
      test_v1_limitations.spec.js             # 28 tests
      test_adapters.spec.js                   # 20 tests
      test_reports.spec.js                    # 25 tests
      test_ui_smoke.spec.js                   # 25 tests
      test_constants.spec.js                  # 38 tests
      test_brokers.spec.js                    # 35 tests
      test_multi_year.spec.js                 # 39 tests (profile split, AY detection, migration)
      test_auto_route.spec.js                 # 17 tests (upload → AY auto-routing)
```

## Running the tests

```bash
cd webapp-itr-workbook
npm install   # one-time
npm test      # 446 tests, ~280ms
```

## Browser usage (the UI)

Open `index.html` directly in a browser, or serve the directory
over any static web server. No build step. No backend.

**Three views:**

1. **Year picker (home)**: cards for each saved AY. Click "+ Add
   another year" to create a new one. Click "Compare all years"
   for the side-by-side view.
2. **Year form (drilled in)**: tabs for Salary, House property,
   Other sources, Capital gains, Deductions, Taxes paid, Imports.
   Profile is on a separate page (top bar).
3. **Profile (separate page)**: PAN, name, address, bank. Edit
   once; applies to all years.

**Auto-routing uploads**: upload Form 16 / 26AS / broker P&L
in any year view. The file's AY is auto-detected and the data
goes to the right year's workbook. If the file is for a different
AY than the one you're viewing, you'll see a "Switch to AY X"
button.

**Deployment**: Vercel / Netlify / GitHub Pages. Zero-config.

```bash
# From the webapp-itr-workbook/ directory:
npx vercel --prod
```

## Programmatic usage (Node REPL or library)

```js
const dm = require("./js/data_model.js");
const engine = require("./js/tax_engine.js");
const profile = dm.loadProfile() || dm.emptyProfile();
const wb = dm.loadWorkbook("2025-26") || dm.emptyWorkbook("2025-26");
wb.salary.employers = [{
  employer_name: "Acme",
  gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0,
}];
wb.deductions["80c_total"] = 150000;
wb.capital_gains.stcg_111a = 50000;

const result = engine.computeBothRegimes(wb, profile);
console.log("Old:", result.old.total_tax_rounded);
console.log("New:", result.new.total_tax_rounded);
console.log("Schedule CG:", result.old.schedule_cg.total_schedule_cg_tax);
console.log("234B:", result.old.interest_234.section_234b.interest);
console.log("Recommendation:", result.recommendation);

const adapters = require("./js/adapters/index.js");
const reports = require("./js/reports/index.js");
const itrJson = adapters.toItrJson(wb, result, profile);
const reportText = reports.buildReport(wb, result);
```

## Architecture decisions

- **No backend, no build step.** Same pattern as the static Tax
  P&L app. Loads from CDN (PDF.js, SheetJS).
- **localStorage only.** Profile is one key (`itr_workbook_v1_profile`).
  Each year workbook is its own key (`itr_workbook_v1_<ay>`).
  No IndexedDB, no service worker, no background sync.
- **Aadhaar stored as last 4 digits only** (privacy by design).
- **PAN, bank account, full Aadhaar numbers** are NEVER stored
  on any server. Bank account is masked (last 4 digits) in
  any JSON / text export.
- **No npm runtime dependencies** for the engine. Test runner
  uses Node's built-in `node:test` and `node:assert`.

## License

Same as the parent portfolio-tracker repo.
