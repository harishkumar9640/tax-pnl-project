// js/tests/test_senior_citizen.spec.js
// Tests for senior-citizen handling in deductions (§80D, §80TTB).
//
// Background:
//   - Section 80D: cap is ₹25K for non-seniors, ₹50K for seniors (60+).
//   - Section 80TTA: only for non-seniors, cap ₹10K.
//   - Section 80TTB: only for seniors (60+), cap ₹50K.
//   - 80TTA and 80TTB are mutually exclusive (§80TTB was introduced
//     to replace 80TTA for seniors).
//
// The engine derives senior status from profile.dob. If no DOB
// is set, the user is treated as non-senior. v1 does not track
// per-person age for the parents bucket; the user should adjust
// the 80D_parents field against the senior cap if the parents
// covered are seniors but the user is not.

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");

// ============================================================
// isSeniorCitizen helper
// ============================================================

test("isSeniorCitizen: empty / null / invalid DOB → false", () => {
  assert.equal(engine.isSeniorCitizen(null), false);
  assert.equal(engine.isSeniorCitizen(""), false);
  assert.equal(engine.isSeniorCitizen(undefined), false);
  assert.equal(engine.isSeniorCitizen("not a date"), false);
});

test("isSeniorCitizen: 65-year-old on AY 2025-26 start → true", () => {
  // DOB = 1959-04-01 → on 2025-04-01 the user is exactly 66
  assert.equal(engine.isSeniorCitizen("1959-04-01", "2025-26"), true);
});

test("isSeniorCitizen: 59-year-old (just under 60) → false", () => {
  // DOB = 1965-04-02 → on 2025-04-01 the user is 59 (not yet 60)
  assert.equal(engine.isSeniorCitizen("1965-04-02", "2025-26"), false);
});

test("isSeniorCitizen: exact-60 boundary case", () => {
  // DOB = 1965-04-01 → on 2025-04-01 the user is exactly 60.
  // Section 80D / 80TTB: 60 years and above → senior.
  assert.equal(engine.isSeniorCitizen("1965-04-01", "2025-26"), true);
});

test("isSeniorCitizen: DOB 1964-12-31 → age 60 on 2025-04-01", () => {
  // Turned 60 on 2024-12-31 → already 60 by 2025-04-01
  assert.equal(engine.isSeniorCitizen("1964-12-31", "2025-26"), true);
});

test("isSeniorCitizen: 30-year-old → false (way under 60)", () => {
  assert.equal(engine.isSeniorCitizen("1995-06-15", "2025-26"), false);
});

test("isSeniorCitizen: AY boundary — 60 in AY 2024-25 is also senior in AY 2025-26", () => {
  // Once a senior, always a senior.
  assert.equal(engine.isSeniorCitizen("1960-01-01", "2024-25"), true);
  assert.equal(engine.isSeniorCitizen("1960-01-01", "2025-26"), true);
});

test("isProfileSenior: null profile → false", () => {
  assert.equal(engine.isProfileSenior(null, "2025-26"), false);
  assert.equal(engine.isProfileSenior(undefined, "2025-26"), false);
});

test("isProfileSenior: empty profile → false (no DOB)", () => {
  const p = dm.emptyProfile();
  assert.equal(engine.isProfileSenior(p, "2025-26"), false);
});

test("isProfileSenior: senior DOB → true", () => {
  const p = dm.emptyProfile();
  p.dob = "1960-01-01";
  assert.equal(engine.isProfileSenior(p, "2025-26"), true);
});

// ============================================================
// 80D caps: senior vs non-senior
// ============================================================

test("80D cap: non-senior — self+family capped at ₹25K, parents at ₹25K", () => {
  // No DOB → non-senior
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80d_self_family"] = 50000;   // user entered more than the cap
  wb.deductions["80d_parents"] = 50000;
  const r = engine.computeForRegime(wb, "old");
  // 80D total = 25K + 25K = 50K (capped)
  assert.equal(r.deductions.c80d, 50000);
  assert.equal(r.deductions.is_senior_citizen, false);
  assert.equal(r.deductions.cap_80d_self_family, 25000);
  assert.equal(r.deductions.cap_80d_parents, 25000);
});

test("80D cap: senior — self+family capped at ₹50K, parents at ₹50K", () => {
  // DOB makes the user 60+ on 2025-04-01
  const profile = dm.emptyProfile();
  profile.dob = "1960-01-01";
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80d_self_family"] = 80000;   // user entered more than the cap
  wb.deductions["80d_parents"] = 80000;
  const r = engine.computeForRegime(wb, "old", profile);
  // 80D total = 50K + 50K = 100K (capped at the senior cap)
  assert.equal(r.deductions.c80d, 100000);
  assert.equal(r.deductions.is_senior_citizen, true);
  assert.equal(r.deductions.cap_80d_self_family, 50000);
  assert.equal(r.deductions.cap_80d_parents, 50000);
});

test("80D cap: senior — if user entered LESS than the cap, use entered value", () => {
  // The cap is a maximum, not a minimum. If the senior entered
  // ₹20K for self+family, the engine should not bump it to ₹50K.
  const profile = dm.emptyProfile();
  profile.dob = "1960-01-01";
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80d_self_family"] = 20000;
  wb.deductions["80d_parents"] = 30000;
  const r = engine.computeForRegime(wb, "old", profile);
  assert.equal(r.deductions.c80d, 50000);  // 20K + 30K (not bumped)
});

test("80D cap: senior status changes the cap — money-on-the-table test", () => {
  // Same workbook, two profiles (non-senior vs senior). The
  // difference is the 80D cap, which affects taxable income
  // and therefore total tax.
  //
  // For this scenario (₹10L salary, ₹50K 80D each):
  //   - Non-senior: 80D = 25K + 25K = 50K → taxable 9.5L
  //     Slab: 0 + 12.5K (2.5-5L) + 80K (5-9.5L @ 20%) = 92,500
  //     + 4% cess = 96,200
  //   - Senior: 80D = 50K + 50K = 100K → taxable 9.0L
  //     Slab: 0 + 12.5K + 70K (5-9L @ 20%) = 82,500
  //     + 4% cess = 85,800
  //   - Saving: ₹10,400
  //
  // Note: the 30% slab (>10L) doesn't apply here because GTI is
  // 9L-9.5L, which is still in the 20% bracket. The saving is
  // 20% of the extra ₹50K deduction = ₹10K, plus 4% cess = ₹400.
  const wb1 = dm.emptyWorkbook("2025-26");
  wb1.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1000000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb1.deductions["80d_self_family"] = 50000;   // user entered 50K
  wb1.deductions["80d_parents"] = 50000;
  const r1 = engine.computeForRegime(wb1, "old");   // non-senior
  const senior = dm.emptyProfile();
  senior.dob = "1960-01-01";
  const r2 = engine.computeForRegime(wb1, "old", senior);
  // Non-senior: capped at 25K + 25K = 50K.
  assert.equal(r1.deductions.c80d, 50000);
  // Senior: capped at 50K + 50K = 100K.
  assert.equal(r2.deductions.c80d, 100000);
  // Tax should be lower for the senior (₹10,400 less in this scenario)
  assert.ok(r2.total_tax_liability < r1.total_tax_liability);
  assert.equal(r1.total_tax_liability - r2.total_tax_liability, 10400,
    "Senior should save exactly ₹10,400 vs non-senior for this scenario");
});

// ============================================================
// 80TTA / 80TTB mutual exclusion
// ============================================================

test("80TTA / 80TTB: non-senior with 80TTB entered → gated off (pre-fix bug)", () => {
  // Per Section 80TTB, only seniors can claim 80TTB. The pre-fix
  // behavior allowed anyone to claim it. The fix gates it off.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80tta"] = 15000;
  wb.deductions["80ttb"] = 50000;
  const r = engine.computeForRegime(wb, "old");
  // Non-senior: 80TTA capped at 10K, 80TTB gated off
  assert.equal(r.deductions.c80tta, 10000);
  assert.equal(r.deductions.c80ttb, 0);
});

test("80TTA / 80TTB: senior with 80TTA entered → 80TTA gated off (pre-fix bug)", () => {
  // Per Section 80TTB, a senior cannot use 80TTA. The pre-fix
  // behavior allowed it. The fix gates 80TTA off for seniors.
  const profile = dm.emptyProfile();
  profile.dob = "1960-01-01";
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80tta"] = 15000;
  wb.deductions["80ttb"] = 50000;
  const r = engine.computeForRegime(wb, "old", profile);
  // Senior: 80TTA gated off, 80TTB applies
  assert.equal(r.deductions.c80tta, 0);
  assert.equal(r.deductions.c80ttb, 50000);
});

test("80TTA / 80TTB: senior with 80TTB > 50K → capped at 50K", () => {
  const profile = dm.emptyProfile();
  profile.dob = "1960-01-01";
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80ttb"] = 80000;   // user entered above the cap
  const r = engine.computeForRegime(wb, "old", profile);
  assert.equal(r.deductions.c80ttb, 50000);
});

// ============================================================
// Regime-independence
// ============================================================

test("80D / 80TTA / 80TTB caps are the same in NEW regime (no new-regime §80TTB)", () => {
  // New regime allows 80CCD(2) but NOT 80TTA / 80TTB / 80D for
  // some interpretations. The current engine code says 80TTA / 80TTB
  // are old-regime only. 80D is available in BOTH regimes.
  // This test documents the current behavior.
  const profile = dm.emptyProfile();
  profile.dob = "1960-01-01";
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 800000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80d_self_family"] = 30000;
  wb.deductions["80tta"] = 12000;
  wb.deductions["80ttb"] = 50000;
  const newR = engine.computeForRegime(wb, "new", profile);
  // 80D available in new regime: 30K (capped at senior 50K, so passes through)
  assert.equal(newR.deductions.c80d, 30000);
  // 80TTA / 80TTB: old-regime only
  assert.equal(newR.deductions.c80tta, 0);
  assert.equal(newR.deductions.c80ttb, 0);
});

// ============================================================
// Backward compat: existing tests still pass
// ============================================================

test("Backward compat: computeDeductions called with no profile → non-senior (existing tests)", () => {
  // Many existing tests call computeDeductions without passing
  // a profile. They should keep working — the default is
  // non-senior, which matches the pre-fix behavior for tests
  // that don't set a DOB.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.deductions["80c_total"] = 150000;
  const r = engine.computeForRegime(wb, "old");
  // 80C capped at 1.5L
  assert.equal(r.deductions.c80c, 150000);
});
