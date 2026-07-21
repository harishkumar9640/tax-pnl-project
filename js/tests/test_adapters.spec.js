// js/tests/test_adapters.spec.js
// Tests for the export adapters (js/adapters/index.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");
const adapters = require("../adapters/index.js");

// ============================================================
// ITR form selector
// ============================================================

test("selectItrForm: resident, single HP, no CG → ITR-1", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  const profile = dm.emptyProfile();
  profile.filing_status = "resident";
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-1");
});

test("selectItrForm: NRI → ITR-2", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.filing_status = "nri";
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-2");
});

test("selectItrForm: RNOR → ITR-2", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.filing_status = "rnor";
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-2");
});

test("selectItrForm: 2+ house properties → ITR-2", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.filing_status = "resident";
  wb.house_property.properties = [
    { type: "self-occupied", co_ownership_share: 100 },
    { type: "let-out", rent_received: 240000, co_ownership_share: 100 },
  ];
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-2");
});

test("selectItrForm: any capital gains → ITR-2", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.filing_status = "resident";
  wb.capital_gains.stcg_111a = 50000;          // any CG → ITR-2
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-2");
});

test("selectItrForm: GTI > 50L → ITR-2", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.filing_status = "resident";
  wb._gti = 60e5;
  assert.equal(adapters.selectItrForm(wb, profile), "ITR-2");
});

// ============================================================
// JSON export
// ============================================================

test("toItrJson: required top-level fields", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.name = "Test User";
  profile.pan = "ABCDE1234F";
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  const tr = engine.computeBothRegimes(wb);
  const json = adapters.toItrJson(wb, tr, profile);
  assert.ok(json._meta);
  assert.equal(json._meta.ay, "2025-26");
  assert.equal(json._meta.itr_form, "ITR-1");
  assert.equal(json.personal_info.pan, "ABCDE1234F");
  assert.equal(json.personal_info.name, "Test User");
  assert.ok(json.computation);
  assert.ok(json.computation.gross_total_income > 0);
  assert.ok(json.taxes_paid);
  assert.ok(json.regime_comparison);
  assert.ok(json.regime_comparison.old);
  assert.ok(json.regime_comparison.new);
});

test("toItrJson: bank account is masked", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.bank_for_refund.account_number = "1234567890";
  const tr = engine.computeBothRegimes(wb);
  const json = adapters.toItrJson(wb, tr, profile);
  assert.equal(json.personal_info.bank_for_refund.account_number_masked, "******7890");
  assert.equal(json.personal_info.bank_for_refund.account_number_masked.length, 10);
});

test("toItrJson: regime_chosen follows recommendation", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0 }];
  // With 15L salary and no 80C, new regime wins.
  const tr = engine.computeBothRegimes(wb);
  const json = adapters.toItrJson(wb, tr);
  // The chosen result should match the recommendation
  if (tr.recommendation === "new") {
    assert.equal(json._meta.regime_chosen, "new");
    assert.equal(json.computation.total_tax_liability, tr.new.total_tax_liability);
  } else if (tr.recommendation === "old") {
    assert.equal(json._meta.regime_chosen, "old");
    assert.equal(json.computation.total_tax_liability, tr.old.total_tax_liability);
  }
});

test("toItrJson: schedule_cg tax is included", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.capital_gains.stcg_111a = 200000;
  const tr = engine.computeBothRegimes(wb);
  const json = adapters.toItrJson(wb, tr);
  assert.ok(json.computation.schedule_cg_tax);
  assert.equal(json.computation.schedule_cg_tax.stcg_111a_tax, 30000);
});

test("toItrJson: tie → uses user's new_regime preference", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const profile = dm.emptyProfile();
  profile.new_regime = true;                // user prefers new
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  // Zero income → both regimes → 0. Tie.
  const tr = engine.computeBothRegimes(wb);
  if (tr.recommendation === "tie") {
    const json = adapters.toItrJson(wb, tr, profile);
    assert.equal(json._meta.regime_chosen, "new");
  }
});

test("toItrJson: missing taxResult throws", () => {
  const wb = dm.emptyWorkbook("2025-26");
  assert.throws(() => adapters.toItrJson(wb, null));
  assert.throws(() => adapters.toItrJson(wb, {}));
});

test("toItrJson: missing workbook throws", () => {
  assert.throws(() => adapters.toItrJson(null, {}));
});

// ============================================================
// maskAccount
// ============================================================

test("maskAccount: 10-digit number → ******7890", () => {
  assert.equal(adapters.maskAccount("1234567890"), "******7890");
});

test("maskAccount: 4-digit number → unchanged", () => {
  assert.equal(adapters.maskAccount("1234"), "1234");
});

test("maskAccount: empty / non-string → empty", () => {
  assert.equal(adapters.maskAccount(""), "");
  assert.equal(adapters.maskAccount(null), "");
  assert.equal(adapters.maskAccount(undefined), "");
  assert.equal(adapters.maskAccount(12345), "");
});

test("maskAccount: 5-digit number → *1234", () => {
  assert.equal(adapters.maskAccount("51234"), "*1234");
});

// ============================================================
// toFile / toClipboard
// ============================================================

test("toFile: not in browser → returns false", () => {
  // We're in Node here; no `document` global.
  // (If document is defined in this test env, this test is a no-op.)
  if (typeof document === "undefined") {
    const result = adapters.toFile("hello", "test.txt");
    assert.equal(result, false);
  }
});

test("downloadItrJson: builds a valid JSON string for a workbook", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.personal.name = "Test User";
  wb.personal.pan = "ABCDE1234F";
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  const tr = engine.computeBothRegimes(wb);
  const obj = adapters.toItrJson(wb, tr);
  const text = JSON.stringify(obj, null, 2);
  // Round-trip: parse it back
  const parsed = JSON.parse(text);
  assert.equal(parsed._meta.ay, "2025-26");
  assert.equal(parsed.personal_info.pan, "ABCDE1234F");
});

test("toClipboard: returns a promise (browser fallback path)", async () => {
  // We don't have a real clipboard in Node, but the function
  // should return a promise (it can resolve to false in Node).
  if (typeof navigator === "undefined") {
    const p = adapters.toClipboard("test");
    assert.ok(p instanceof Promise);
    const result = await p;
    // In Node: returns false. In a real browser with clipboard API
    // it would be true.
    assert.equal(typeof result, "boolean");
  }
});
