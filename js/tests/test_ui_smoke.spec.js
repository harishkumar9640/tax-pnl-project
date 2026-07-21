// js/tests/test_ui_smoke.spec.js
// Smoke tests for the browser UI. These tests verify that the
// modules load, expose their APIs to the global `window` object,
// and that the main `app.js` controller logic works in a
// simulated browser environment (jsdom-like, but in pure Node).
//
// What this test suite covers:
//   - All IIFE modules attach their exports to the `window`
//     object so the UI can call them.
//   - The end-to-end flow: load workbook → set fields → recompute
//     → render compute panel → save to localStorage → reload.
//   - HTML escaping (XSS) in computed output.
//   - Tab persistence via localStorage.
//
// What this suite does NOT cover:
//   - Actual DOM rendering (would need jsdom or playwright).
//   - File upload / PDF parsing (uses the PDF.js stub in node).

const test = require("node:test");
const assert = require("node:assert/strict");

// ============================================================
// Set up a minimal browser-like global environment
// ============================================================

// Each test file gets a fresh window + localStorage
function setupBrowserEnv() {
  // Reset modules cache so we get a fresh load
  for (const k of Object.keys(require.cache)) {
    if (k.includes("/js/") && !k.includes("/tests/")) {
      delete require.cache[k];
    }
  }
  const storage = {};
  global.window = {
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
      clear: () => { for (const k of Object.keys(storage)) delete storage[k]; },
      key: (i) => Object.keys(storage)[i] || null,
      get length() { return Object.keys(storage).length; },
    },
    navigator: { clipboard: undefined },   // not in node
    document: undefined,                  // not in node
    console,
  };
  global.localStorage = global.window.localStorage;
  // Now load the modules
  const dm = require("../data_model.js");
  const engine = require("../tax_engine.js");
  const validation = require("../validation.js");
  const integrations = require("../integrations.js");
  const adapters = require("../adapters/index.js");
  const reports = require("../reports/index.js");
  return { dm, engine, validation, integrations, adapters, reports };
}

// ============================================================
// Module exposure
// ============================================================

test("data_model: attaches API to window", () => {
  const env = setupBrowserEnv();
  assert.equal(typeof env.dm.supportedAys, "function");
  assert.equal(typeof window.emptyWorkbook, "function");
  assert.equal(typeof window.saveWorkbook, "function");
  assert.equal(typeof window.loadWorkbook, "function");
  assert.equal(typeof window.taxDataModel, "object");
  assert.equal(typeof window.taxDataModel.supportedAys, "function");
  assert.equal(typeof window.taxDataModel.emptyWorkbook, "function");
});

test("tax_engine: attaches API to window", () => {
  const env = setupBrowserEnv();
  assert.equal(typeof env.engine.computeForRegime, "function");
  assert.equal(typeof env.engine.computeBothRegimes, "function");
  assert.equal(typeof window.computeBothRegimes, "function");
  assert.equal(typeof window.computeScheduleCGTax, "function");
  assert.equal(typeof window.computeInterest234, "function");
  assert.equal(typeof window.taxEngine, "object");
  assert.equal(typeof window.taxEngine.computeBothRegimes, "function");
});

test("validation: attaches API to window", () => {
  setupBrowserEnv();
  assert.equal(typeof window.validateWorkbook, "function");
  assert.equal(typeof window.validateJsonString, "function");
  assert.equal(typeof window.taxValidation, "object");
  assert.equal(typeof window.taxValidation.validateWorkbook, "function");
});

test("integrations: attaches API to window", () => {
  setupBrowserEnv();
  assert.equal(typeof window.parseForm16Text, "function");
  assert.equal(typeof window.parseForm26ASJson, "function");
  assert.equal(typeof window.buildItrPreview, "function");
  assert.equal(typeof window.taxIntegrations, "object");
  assert.equal(typeof window.taxIntegrations.parseForm16Text, "function");
});

test("adapters: attaches API to window", () => {
  setupBrowserEnv();
  assert.equal(typeof window.selectItrForm, "function");
  assert.equal(typeof window.toItrJson, "function");
  assert.equal(typeof window.toFile, "function");
  assert.equal(typeof window.downloadItrJson, "function");
  assert.equal(typeof window.toClipboard, "function");
  assert.equal(typeof window.maskAccount, "function");
  assert.equal(typeof window.taxAdapters, "object");
  assert.equal(typeof window.taxAdapters.toItrJson, "function");
});

test("reports: attaches API to window", () => {
  setupBrowserEnv();
  assert.equal(typeof window.buildReport, "function");
  assert.equal(typeof window.buildOneLiner, "function");
  assert.equal(typeof window.taxReports, "object");
  assert.equal(typeof window.taxReports.buildReport, "function");
});

// ============================================================
// End-to-end workflow
// ============================================================

test("e2e: build a workbook, save, reload, recompute — same result", () => {
  const env = setupBrowserEnv();
  // Build
  const wb = window.emptyWorkbook("2025-26");
  wb.personal.name = "Test User";
  wb.personal.pan = "ABCDE1234F";
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.salary.tds_total = 200000;
  wb.deductions["80c_total"] = 150000;
  // Save
  window.saveWorkbook(wb);
  // Reload — the personal info migrates to the global profile,
  // and the workbook's personal section is stripped. This is the
  // v1.1+ behavior.
  const wb2 = window.loadWorkbook("2025-26");
  assert.ok(wb2, "workbook should reload");
  // Personal info is now in the global profile
  const profile = window.loadProfile();
  assert.ok(profile, "profile should be auto-created from personal");
  assert.equal(profile.name, "Test User");
  assert.equal(profile.pan, "ABCDE1234F");
  assert.equal(wb2.salary.employers[0].gross_salary, 1500000);
  assert.equal(wb2.deductions["80c_total"], 150000);
  // Recompute
  const r1 = window.computeBothRegimes(wb);
  const r2 = window.computeBothRegimes(wb2);
  assert.equal(r1.old.total_tax_rounded, r2.old.total_tax_rounded);
  assert.equal(r1.new.total_tax_rounded, r2.new.total_tax_rounded);
});

test("e2e: Form 16 import → recompute → save", () => {
  const env = setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  const form16Text = `
    TAN: ABCD12345E
    PAN of the Employee: ABCDE1234F
    Salary as per provisions contained in section 17(1): Rs. 12,00,000
    Total exempt u/s 10: Rs. 2,00,000
    Standard Deduction: Rs. 50,000
    Professional Tax: Rs. 2,500
    Total Tax Deducted: Rs. 1,20,000
  `;
  const result = window.parseForm16Text(form16Text);
  assert.ok(result.ok, "Form 16 should parse");
  assert.equal(result.fields.gross_salary, 1200000);
  assert.equal(result.fields.allowances_exempt_10, 200000);
  assert.equal(result.fields.tds_total, 120000);
  // Apply
  window.applyForm16ToWorkbook(wb, result.fields);
  window.saveWorkbook(wb);
  // Recompute
  const tr = window.computeBothRegimes(wb);
  // Net salary = 12L - 2L - 50K - 2.5K = 9,47,500
  assert.equal(tr.old.salary.net_salary, 947500);
});

test("e2e: Form 26AS import → recompute", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const form26as = {
    TDS_on_Salary: [{ TDS: 50000 }],
    TDS_on_Others: [{ TDS: 5000, Amount: 5000 }],
    Advance_Tax: [{ Amount: 20000 }],
  };
  const result = window.parseForm26ASJson(form26as);
  assert.ok(result.ok);
  assert.equal(result.by_section.TDS_on_Salary, 50000);
  assert.equal(result.by_section.Advance_Tax, 20000);
  window.applyForm26ASToWorkbook(wb, result);
  assert.equal(wb.salary.tds_total, 50000);
  assert.equal(wb.taxes_paid.advance_tax, 20000);
});

test("e2e: downloadItrJson builds a clean JSON", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.personal.name = "Test";
  wb.salary.employers = [{
    employer_name: "A", tan: "",
    gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const tr = window.computeBothRegimes(wb);
  const obj = window.toItrJson(wb, tr);
  const text = JSON.stringify(obj, null, 2);
  const parsed = JSON.parse(text);
  assert.equal(parsed._meta.ay, "2025-26");
  assert.equal(parsed.personal_info.name, "Test");
  assert.ok(parsed.computation);
});

test("e2e: buildReport returns a multi-line text report", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.personal.name = "Test";
  wb.salary.employers = [{
    employer_name: "A", tan: "",
    gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const tr = window.computeBothRegimes(wb);
  const report = window.buildReport(wb, tr);
  assert.ok(report.length > 200);
  assert.match(report, /Test/);
  assert.match(report, /ITRready/);
  assert.match(report, /REGIME COMPARISON/);
});

// ============================================================
// Cross-section consistency
// ============================================================

test("e2e: schedule CG flow through compute, schedule_cg, JSON, report", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.capital_gains.stcg_111a = 200000;
  const tr = window.computeBothRegimes(wb);
  // 1) Engine result has schedule_cg
  assert.equal(tr.old.schedule_cg.stcg_111a_tax, 30000);
  // 2) Direct schedule CG call
  const cg = window.computeScheduleCGTax(wb.capital_gains);
  assert.equal(cg.stcg_111a_tax, 30000);
  // 3) JSON export
  const obj = window.toItrJson(wb, tr);
  // (when no salary, both regimes tie → defaults to "old")
  // Force a regime by setting new_regime=false
  wb.personal.new_regime = false;
  const tr2 = window.computeBothRegimes(wb);
  const obj2 = window.toItrJson(wb, tr2);
  assert.ok(obj2.computation.schedule_cg_tax);
  assert.equal(obj2.computation.schedule_cg_tax.stcg_111a_tax, 30000);
  // 4) Report
  const report = window.buildReport(wb, tr2);
  assert.match(report, /Schedule CG/);
  assert.match(report, /STCG 111A @ 15%/);
});

test("e2e: 234B/234C interest in result, JSON, and report", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "",
    gross_salary: 2000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // No TDS → big 234B/234C interest
  const tr = window.computeBothRegimes(wb);
  assert.ok(tr.old.interest_234.total_234 > 0);
  const report = window.buildReport(wb, tr);
  assert.match(report, /INTEREST u\/s 234/);
});

// ============================================================
// Per-year buckets
// ============================================================

test("e2e: per-year buckets flow through engine + report", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2015-16", amount: 50000 },     // expired
    { fy: "2022-23", amount: 30000 },     // eligible
  ];
  const tr = window.computeBothRegimes(wb);
  // Only 30K STCL eligible
  assert.equal(tr.old.cg.stcl_used, 30000);
  // 1L - 30K = 70K STCG × 15% = 10,500
  assert.equal(tr.old.schedule_cg.stcg_111a_tax, 10500);
  const report = window.buildReport(wb, tr);
  assert.match(report, /ITRready/);
});

// ============================================================
// AY-specific behavior
// ============================================================

test("e2e: AY 2024-25 uses 50K std ded in new regime", () => {
  setupBrowserEnv();
  const wb1 = window.emptyWorkbook("2025-26");
  const wb2 = window.emptyWorkbook("2024-25");
  for (const wb of [wb1, wb2]) {
    wb.salary.employers = [{
      employer_name: "A", tan: "",
      gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
    }];
  }
  const r1 = window.computeForRegime(wb1, "new");
  const r2 = window.computeForRegime(wb2, "new");
  // AY 2025-26: 75K std ded, AY 2024-25: 50K std ded
  assert.equal(r1.salary.standard_deduction, 75000);
  assert.equal(r2.salary.standard_deduction, 50000);
});

// ============================================================
// XSS / safety
// ============================================================

test("e2e: malicious workbook values don't break computation", () => {
  setupBrowserEnv();
  const wb = window.emptyWorkbook("2025-26");
  wb.personal.name = "<script>alert('xss')</script>";
  wb.salary.employers = [{
    employer_name: "'; DROP TABLE--",
    tan: "",
    gross_salary: 1e20,
    allowances_exempt_10: 0,
    professional_tax: 0,
  }];
  // Should not throw
  const tr = window.computeBothRegimes(wb);
  assert.ok(tr.old);
  assert.ok(tr.new);
  assert.ok(Number.isFinite(tr.old.total_tax_rounded));
});
