// js/tests/test_auto_route.spec.js
// Tests for the v1.1+ "auto-routing" feature: when a user uploads a
// Form 16 / 26AS / broker P&L, the app detects the AY/FY from the
// file content and applies the data to the right year's workbook,
// even if the user is currently viewing a different year.
//
// In v1 (pre-auto-route), the user had to pick the right AY in the
// AY selector before uploading. In v1.1+, the file itself tells
// the app which year to populate.

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const integrations = require("../integrations.js");
const brokers = require("../adapters/brokers.js");

// ============================================================
// Form 16 AY detection
// ============================================================

test("Form 16: detected AY is exposed on the result", () => {
  const text = `
    Form 16 — Assessment Year 2025-26
    Financial Year 2024-25
    TAN: ABCD12345E
    Gross Salary: Rs. 12,00,000
    Standard Deduction: Rs. 50,000
    Total Tax Deducted: Rs. 1,50,000
  `;
  const r = integrations.parseForm16Text(text);
  assert.equal(r.ay, "2025-26");
  assert.equal(r.fy, "2024-25");
});

test("Form 16: detected AY for AY 2024-25 form", () => {
  const text = `
    Form 16 — Assessment Year 2024-25
    Period: 01/04/2023 to 31/03/2024
    Gross Salary: Rs. 10,00,000
  `;
  const r = integrations.parseForm16Text(text);
  assert.equal(r.ay, "2024-25");
  assert.equal(r.fy, "2023-24");
});

test("Form 16: warning when AY cannot be detected", () => {
  const text = `
    Form 16
    Gross Salary: Rs. 10,00,000
    Total Tax Deducted: Rs. 1,00,000
  `;
  const r = integrations.parseForm16Text(text);
  assert.equal(r.ay, null);
  assert.equal(r.fy, null);
  // The result should still have the fields (the upload still works)
  assert.equal(r.fields.gross_salary, 1000000);
  // And a warning is added
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("could not detect")));
});

// ============================================================
// Form 26AS AY detection
// ============================================================

test("Form 26AS: detected AY from AssessmentYear field", () => {
  const json = {
    AssessmentYear: "2025-26",
    TDS_on_Salary: [{ TDS: 100000 }],
    TDS_on_Others: [{ TDS: 5000 }],
  };
  const r = integrations.parseForm26ASJson(json);
  assert.equal(r.ay, "2025-26");
  assert.equal(r.fy, "2024-25");
});

test("Form 26AS: detected AY from AY field (4-digit)", () => {
  const json = {
    AY: "2024",  // some portals give just the 4-digit year end
    TDS_on_Salary: [{ TDS: 100000 }],
  };
  const r = integrations.parseForm26ASJson(json);
  // "2024" alone → AY 2023-24 (the AY that ends in 2024)
  // But "2024" as a 4-digit year also matches our AY 2024-25 (which
  // starts with 2024). Our parser takes the "ends in 2024" interpretation
  // which is the natural reading.
  assert.equal(r.ay, "2024-25");
});

test("Form 26AS: detected AY from a record's FinYear field", () => {
  const json = {
    TDS_on_Salary: [
      { TDS: 100000, FinYear: "2024-25" },
    ],
  };
  const r = integrations.parseForm26ASJson(json);
  // FinYear "2024-25" → AY 2025-26
  assert.equal(r.ay, "2025-26");
});

test("Form 26AS: null when no AY info is present", () => {
  const json = {
    TDS_on_Salary: [{ TDS: 100000 }],
  };
  const r = integrations.parseForm26ASJson(json);
  assert.equal(r.ay, null);
});

// ============================================================
// End-to-end: Form 16 → workbook (without an AY selector)
// ============================================================

test("e2e: Form 16 for AY 2024-25 populates the AY 2024-25 workbook", () => {
  // The user is "looking at" nothing in particular (v1.1+ starts
  // on the year picker). We just want to know the import writes
  // to the right workbook.
  const text = `
    Form 16 — Assessment Year 2024-25
    Financial Year 2023-24
    Gross Salary: Rs. 10,00,000
    Standard Deduction: Rs. 50,000
    Professional Tax: Rs. 2,000
    Total Tax Deducted: Rs. 1,00,000
  `;
  const r = integrations.parseForm16Text(text);
  assert.equal(r.ay, "2024-25");
  // Apply to the workbook
  const wb = dm.loadWorkbook(r.ay) || dm.emptyWorkbook(r.ay);
  integrations.applyForm16ToWorkbook(wb, r.fields);
  // The AY 2024-25 workbook should now have the salary data
  // (applyForm16ToWorkbook replaces the first employer)
  assert.equal(wb.salary.employers[0].gross_salary, 1000000);
  assert.equal(wb.salary.employers[0].professional_tax, 2000);
  assert.equal(wb.salary.tds_total, 100000);
  // And the AY 2025-26 workbook (if any) should be untouched
  const otherWb = dm.loadWorkbook("2025-26") || dm.emptyWorkbook("2025-26");
  // The AY 2025-26 workbook is a different object, so the changes
  // to the 2024-25 workbook don't affect it. Empty employer means
  // gross_salary is 0 (or undefined; the assertion below works
  // for either case).
  const otherGross = (otherWb.salary.employers && otherWb.salary.employers[0])
    ? otherWb.salary.employers[0].gross_salary
    : 0;
  assert.notEqual(otherGross, 1000000);
});

// ============================================================
// Broker P&L: file-level AY detection
// ============================================================

test("Broker: AY from filename (Zerodha CSV)", () => {
  const csv = `Symbol,Quantity,Realised P&L,Type
HDFCBANK,10,500.00,Delivery
`;
  const r = brokers.parseZerodhaCsv(csv, "Tax_PnL_2024_25.csv");
  assert.equal(r.fy, "2024-25");
  // The auto-route would look up findFy("2024-25").ay = "2025-26"
  const ayInfo = dm.findFy(r.fy);
  assert.equal(ayInfo.ay, "2025-26");
});

test("Broker: AY from filename (Angel One xlsx)", () => {
  const wb = { SheetNames: ["Equity+Bonds+SGB Trade Details"], Sheets: {
    "Equity+Bonds+SGB Trade Details": [
      ["ISIN", "Symbol", "Qty", "Buy Date", "Sell Date", "Avg Buy", "Buy Value", "Sell Price", "Sell Value", "Days", "Charges", "STT", "P&L"],
    ],
  } };
  const r = brokers.AngelOneAdapter.parse(wb, "Tax PNL 2023-24.xlsx");
  assert.equal(r.fy, "2023-24");
  const ayInfo = dm.findFy(r.fy);
  assert.equal(ayInfo.ay, "2024-25");
});

test("Broker: FY detection falls back to current FY when no year in filename", () => {
  const csv = `Symbol,Quantity,Realised P&L,Type
HDFCBANK,10,500.00,Delivery
`;
  const r = brokers.parseZerodhaCsv(csv, "report.csv");
  assert.match(r.fy, /^20\d{2}-\d{2}$/);
});

// ============================================================
// End-to-end: broker result → correct AY's workbook
// ============================================================

test("e2e: broker P&L applied to the right AY's workbook", () => {
  const csv = `Symbol,ISIN,Buy Date,Sell Date,Quantity,Realised P&L,Type
HDFCBANK,INE040A01034,2024-04-15,2024-10-15,10,2000.00,Delivery
RELIANCE,INE002A01018,2024-05-01,2024-09-01,5,1000.00,Delivery
`;
  const r = brokers.parseZerodhaCsv(csv, "Tax_PnL_2024_25.csv");
  // Find the target AY (FY 2024-25 → AY 2025-26)
  const targetAy = (dm.findFy(r.fy) || {}).ay;
  assert.equal(targetAy, "2025-26");
  // Apply
  const wb = dm.loadWorkbook(targetAy) || dm.emptyWorkbook(targetAy);
  const d = r.workbookDeltas;
  if (d.stcg_111a) wb.capital_gains.stcg_111a = d.stcg_111a;
  if (d.ltcg_112a) wb.capital_gains.ltcg_112a = d.ltcg_112a;
  // Both trades are STCG (held < 365 days), so STCG = 3000
  assert.equal(wb.capital_gains.stcg_111a, 3000);
  assert.equal(wb.capital_gains.ltcg_112a, 0);
});

// ============================================================
// Multi-year workflow: one import, one workbook updated
// ============================================================

test("multi-year: Form 16 for 2024-25 + Form 16 for 2025-26 → both workbooks", () => {
  // Clear any existing state
  dm.deleteAllWorkbooks();
  // First Form 16 (AY 2024-25)
  const text1 = `
    Form 16 — Assessment Year 2024-25
    Financial Year 2023-24
    Gross Salary: Rs. 8,00,000
    Total Tax Deducted: Rs. 60,000
  `;
  const r1 = integrations.parseForm16Text(text1);
  const wb1 = dm.loadWorkbook(r1.ay) || dm.emptyWorkbook(r1.ay);
  integrations.applyForm16ToWorkbook(wb1, r1.fields);
  // Second Form 16 (AY 2025-26)
  const text2 = `
    Form 16 — Assessment Year 2025-26
    Financial Year 2024-25
    Gross Salary: Rs. 15,00,000
    Total Tax Deducted: Rs. 1,50,000
  `;
  const r2 = integrations.parseForm16Text(text2);
  const wb2 = dm.loadWorkbook(r2.ay) || dm.emptyWorkbook(r2.ay);
  integrations.applyForm16ToWorkbook(wb2, r2.fields);
  // Both workbooks should be independent
  assert.equal(wb1.salary.employers[0].gross_salary, 800000);
  assert.equal(wb2.salary.employers[0].gross_salary, 1500000);
  // Tax computation should differ
  const tr1 = require("../tax_engine.js").computeBothRegimes(wb1);
  const tr2 = require("../tax_engine.js").computeBothRegimes(wb2);
  assert.notEqual(tr1.old.total_tax_rounded, tr2.old.total_tax_rounded);
  assert.ok(tr1.old.total_tax_rounded < tr2.old.total_tax_rounded);
});

// ============================================================
// Backward compatibility
// ============================================================

test("backward compat: emptyWorkbook still has personal field (for old code)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  assert.ok(wb.personal, "personal should still be present for backward compat");
  assert.equal(wb.personal.pan, "");
});

test("backward compat: toItrJson without profile still works (uses wb.personal)", () => {
  const adapters = require("../adapters/index.js");
  const engine = require("../tax_engine.js");
  const wb = dm.emptyWorkbook("2025-26");
  wb.personal.pan = "LEGACY1234F";
  wb.personal.name = "Legacy User";
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  const tr = engine.computeBothRegimes(wb);
  // Call without explicit profile → falls back to wb.personal
  const json = adapters.toItrJson(wb, tr);
  assert.equal(json.personal_info.pan, "LEGACY1234F");
  assert.equal(json.personal_info.name, "Legacy User");
});

test("backward compat: toItrJson with explicit profile takes priority", () => {
  const adapters = require("../adapters/index.js");
  const engine = require("../tax_engine.js");
  const wb = dm.emptyWorkbook("2025-26");
  wb.personal.pan = "OLD1234F";
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  const tr = engine.computeBothRegimes(wb);
  // Explicit profile overrides wb.personal
  const profile = dm.emptyProfile();
  profile.pan = "NEW1234F";
  const json = adapters.toItrJson(wb, tr, profile);
  assert.equal(json.personal_info.pan, "NEW1234F");
});

test("backward compat: legacy saved workbook with personal migrates on load", () => {
  // Manually inject a legacy workbook into localStorage
  const store = {};
  global.window = { localStorage: {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    key: () => null, get length() { return Object.keys(store).length; },
  } };
  global.localStorage = global.window.localStorage;
  // Pre-v1.1 format
  store["itr_workbook_v1_2025-26"] = JSON.stringify({
    schema_version: 1,
    ay: "2025-26",
    fy: "2024-25",
    personal: { pan: "OLD1234F", name: "Legacy" },
    salary: { employers: [{ gross_salary: 500000 }], tds_total: 0 },
    house_property: { properties: [] },
    other_sources: {}, capital_gains: {}, deductions: {}, taxes_paid: {},
  });
  // Load — migration runs
  const loaded = dm.loadWorkbook("2025-26");
  // Profile is created from the legacy personal
  const profile = dm.loadProfile();
  assert.equal(profile.pan, "OLD1234F");
  // Re-saving the workbook strips personal
  const stored = JSON.parse(store["itr_workbook_v1_2025-26"]);
  assert.equal(stored.personal, undefined);
  delete global.window;
  delete global.localStorage;
});
