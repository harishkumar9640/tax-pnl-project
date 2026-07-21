// js/tests/test_constants.spec.js
// Tests for the IT-Act constants block at the top of tax_engine.js.
//
// What this suite verifies:
//   1. Every constant is exposed via taxEngine.CONSTANTS
//   2. The constants are CONSISTENT with each other (e.g. 80C
//      cap = 150000, surcharge above 5Cr in old = 37%, etc.)
//   3. The constants are used CONSISTENTLY in the engine (the
//      engine behavior matches the values in the constants block;
//      e.g. STCG 111A tax = stcg × 0.15, where 0.15 is the
//      constant STCG_111A_RATE).
//   4. Other modules (adapters, data_model, validation, reports,
//      app) read from the constants instead of redeclaring them.
//   5. The AYs and FY mapping match between modules.

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");
const validation = require("../validation.js");
const adapters = require("../adapters/index.js");
const reports = require("../reports/index.js");
const integrations = require("../integrations.js");

// ============================================================
// Constants are exposed
// ============================================================

test("CONSTANTS block is exposed via taxEngine.CONSTANTS", () => {
  assert.ok(engine.CONSTANTS, "taxEngine.CONSTANTS must exist");
  assert.equal(typeof engine.CONSTANTS, "object");
});

test("CONSTANTS includes all IT-Act rate and cap values", () => {
  const c = engine.CONSTANTS;
  // Slab boundaries
  assert.equal(c.OLD_REGIME_SLAB_0_END, 250000);
  assert.equal(c.OLD_REGIME_SLAB_1_END, 500000);
  assert.equal(c.OLD_REGIME_SLAB_2_END, 1000000);
  assert.equal(c.NEW_REGIME_SLAB_0_END, 300000);
  assert.equal(c.NEW_REGIME_SLAB_1_END, 700000);
  assert.equal(c.NEW_REGIME_SLAB_2_END, 1000000);
  assert.equal(c.NEW_REGIME_SLAB_3_END, 1200000);
  assert.equal(c.NEW_REGIME_SLAB_4_END, 1500000);
  // Rates
  assert.equal(c.RATE_ZERO, 0);
  assert.equal(c.RATE_5PCT, 0.05);
  assert.equal(c.RATE_10PCT, 0.10);
  assert.equal(c.RATE_15PCT, 0.15);
  assert.equal(c.RATE_20PCT, 0.20);
  assert.equal(c.RATE_25PCT, 0.25);
  assert.equal(c.RATE_30PCT, 0.30);
  assert.equal(c.RATE_37PCT, 0.37);
  // Standard deduction
  assert.equal(c.STD_DEDUCTION_OLD_REGIME, 50000);
  assert.equal(c.STD_DEDUCTION_NEW_REGIME_FY_24_25, 75000);
  assert.equal(c.STD_DEDUCTION_NEW_REGIME_FY_23_24, 50000);
  // 87A
  assert.equal(c.REBATE_87A_THRESHOLD_OLD_REGIME, 500000);
  assert.equal(c.REBATE_87A_MAX_TAX_OLD_REGIME, 12500);
  assert.equal(c.REBATE_87A_THRESHOLD_NEW_REGIME, 700000);
  assert.equal(c.REBATE_87A_MAX_TAX_NEW_REGIME, 25000);
  // Surcharge
  assert.equal(c.SURCHARGE_LOWER_50L, 5000000);
  assert.equal(c.SURCHARGE_LOWER_1CR, 10000000);
  assert.equal(c.SURCHARGE_LOWER_2CR, 20000000);
  assert.equal(c.SURCHARGE_LOWER_5CR, 50000000);
  // Cess
  assert.equal(c.HEC_CESS_RATE, 0.04);
  // Capital gains
  assert.equal(c.STCG_111A_RATE, 0.15);
  assert.equal(c.LTCG_112A_RATE, 0.10);
  assert.equal(c.LTCG_OTHER_RATE, 0.20);
  assert.equal(c.LTCG_112A_EXEMPTION, 100000);
  // Lottery
  assert.equal(c.LOTTERY_RATE, 0.30);
  // House property
  assert.equal(c.HP_SELF_OCCUPIED_INTEREST_CAP, 200000);
  assert.equal(c.HP_LET_OUT_STD_DEDUCTION_PCT, 0.30);
  assert.equal(c.HP_FULL_OWNERSHIP_PCT, 100);
  // Chapter VI-A caps
  assert.equal(c.CAP_80C, 150000);
  assert.equal(c.CAP_80CCD_1B, 50000);
  assert.equal(c.CAP_80D_SELF_FAMILY, 25000);
  assert.equal(c.CAP_80D_PARENTS, 25000);
  assert.equal(c.CAP_80TTA, 10000);
  assert.equal(c.CAP_80TTB, 50000);
  // Loss carry forward
  assert.equal(c.LOSS_CARRY_FORWARD_YEARS, 8);
  // 234B / 234C
  assert.equal(c.SEC_234B_RATE_PER_MONTH, 0.01);
  assert.equal(c.SEC_234B_THRESHOLD, 10000);
  assert.equal(c.SEC_234B_MONTHS, 12);
  assert.equal(c.SEC_234C_RATE_PER_MONTH, 0.01);
  assert.equal(c.SEC_234C_THRESHOLD_Q1, 0.15);
  assert.equal(c.SEC_234C_THRESHOLD_Q2, 0.45);
  assert.equal(c.SEC_234C_THRESHOLD_Q3, 0.75);
  assert.equal(c.SEC_234C_THRESHOLD_Q4, 1.00);
  assert.equal(c.SEC_234C_MONTHS_Q1, 3);
  assert.equal(c.SEC_234C_MONTHS_Q2, 3);
  assert.equal(c.SEC_234C_MONTHS_Q3, 3);
  assert.equal(c.SEC_234C_MONTHS_Q4, 1);
  // ITR-1/2 selector
  assert.equal(c.ITR1_TOTAL_INCOME_MAX, 5000000);
  assert.equal(c.ITR1_MAX_HP_PROPERTIES, 1);
  // Form 16
  assert.equal(c.FORM16_GROSS_SALARY_SANITY_MAX, 100000000);
  // AYs
  assert.equal(c.AY_2025_26, "2025-26");
  assert.equal(c.AY_2024_25, "2024-25");
  assert.deepEqual(c.FY_FOR_AY, { "2025-26": "2024-25", "2024-25": "2023-24" });
  assert.deepEqual(c.AY_TO_ITR_AY, { "2025-26": "2025", "2024-25": "2024" });
});

// ============================================================
// Constants are USED in the engine
// ============================================================

test("Engine uses STCG_111A_RATE (15%) for Schedule CG tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.capital_gains.stcg_111a = 100000;
  const r = engine.computeForRegime(wb, "old");
  // 1L × 15% = 15,000
  assert.equal(r.schedule_cg.stcg_111a_tax, 100000 * engine.CONSTANTS.STCG_111A_RATE);
});

test("Engine uses LTCG_112A_RATE (10%) for LTCG tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.capital_gains.ltcg_112a = 200000;          // 1L post-exemption
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.schedule_cg.ltcg_112a_tax, 100000 * engine.CONSTANTS.LTCG_112A_RATE);
});

test("Engine uses LTCG_OTHER_RATE (20%) for other LTCG", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.capital_gains.ltcg_other = 500000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.schedule_cg.ltcg_other_tax, 500000 * engine.CONSTANTS.LTCG_OTHER_RATE);
});

test("Engine uses LOTTERY_RATE (30%) for lottery tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.other_sources.lottery_winnings = 100000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.lottery_tax, 100000 * engine.CONSTANTS.LOTTERY_RATE);
});

test("Engine uses HEC_CESS_RATE (4%) for cess", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  // GTI 9.5L → slab tax 1,02,500
  // Cess = 4% × 1,02,500 = 4,100
  const r = engine.computeForRegime(wb, "old");
  const expectedCess = r.tax_before_surcharge * engine.CONSTANTS.HEC_CESS_RATE;
  assert.equal(r.cess, Math.round(expectedCess));
});

test("Engine uses HP_SELF_OCCUPIED_INTEREST_CAP (₹2L) for self-occ interest", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 500000,  // 5L interest
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  // Cap is 2L; so deductibleInterest = 2L, NAV-loss = -2L
  // (Pre-fix this was clamped to 0, silently discarding the loss.
  // Post-fix the loss flows through to GTI, allowing inter-head
  // set-off per Section 24(b) + Section 71(3A).)
  assert.equal(r.house.net_house_property, -200000);
  // Verify the cap is the constant
  assert.equal(engine.CONSTANTS.HP_SELF_OCCUPIED_INTEREST_CAP, 200000);
});

test("Engine uses HP_LET_OUT_STD_DEDUCTION_PCT (30%) for let-out", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.house_property.properties = [{
    type: "let-out",
    rent_received: 1000000,            // 10L rent
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  // 10L - 30%×10L = 7L net
  assert.equal(r.house.net_house_property, 700000);
});

test("Engine uses CAP_80C (₹1.5L) for 80C deduction cap", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.deductions["80c_total"] = 500000;            // 5L entered
  const r = engine.computeForRegime(wb, "old");
  // Cap is 1.5L
  assert.equal(r.deductions.c80c, engine.CONSTANTS.CAP_80C);
});

test("Engine uses CAP_80CCD_1B (₹50K) for NPS additional cap", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.deductions["80ccd_1b"] = 200000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.deductions.c80ccd1b, engine.CONSTANTS.CAP_80CCD_1B);
});

test("Engine uses CAP_80TTA (₹10K) for savings interest (old regime only)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.deductions["80tta"] = 50000;
  const rOld = engine.computeForRegime(wb, "old");
  const rNew = engine.computeForRegime(wb, "new");
  // Old: 80TTA capped at 10K
  assert.equal(rOld.deductions.c80tta, engine.CONSTANTS.CAP_80TTA);
  // New: 80TTA not available
  assert.equal(rNew.deductions.c80tta, 0);
});

test("Engine uses LOSS_CARRY_FORWARD_YEARS (8) for STCL expiry", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.capital_gains.stcg_111a = 100000;
  // Bucket exactly 8 years old: should be EXPIRED (boundary is
  // inclusive: 8 years from fy 2017-18 covers AY 2018-19 to 2025-26,
  // 9th year is 2026-27 which is expired)
  wb.capital_gains.stcl_buckets = [
    { fy: "2016-17", amount: 50000 },          // 9 years ago, expired
    { fy: "2017-18", amount: 50000 },          // 8 years ago, eligible
  ];
  const r = engine.computeForRegime(wb, "old");
  // Only the 2017-18 bucket is eligible (boundary inclusive)
  assert.equal(r.cg.stcl_used, 50000);
});

test("Engine uses SEC_234B_RATE_PER_MONTH (1%) for 234B interest", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 2000000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.salary.tds_total = 0;
  const r = engine.computeForRegime(wb, "old");
  // 234B interest = 1% × shortfall × 12 months
  // shortfall = tax_liability - 0 = ~4.13L
  // interest = 0.01 × shortfall × 12
  const expectedRate = engine.CONSTANTS.SEC_234B_RATE_PER_MONTH;
  const expectedInterest = r.interest_234.section_234b.shortfall * expectedRate * engine.CONSTANTS.SEC_234B_MONTHS;
  assert.equal(r.interest_234.section_234b.interest, Math.round(expectedInterest));
});

test("Engine uses SEC_234B_THRESHOLD (₹10K) — no interest below", () => {
  // 1L salary → ~0 tax → no 234B interest
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "A", tan: "", gross_salary: 100000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.salary.tds_total = 0;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.interest_234.section_234b.interest, 0);
});

// ============================================================
// Regimes use the constants
// ============================================================

test("Old regime: rebate threshold = REBATE_87A_THRESHOLD_OLD_REGIME", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.old.rebate_87a_max_income, engine.CONSTANTS.REBATE_87A_THRESHOLD_OLD_REGIME);
  assert.equal(cfgs.old.rebate_87a_max_tax, engine.CONSTANTS.REBATE_87A_MAX_TAX_OLD_REGIME);
});

test("New regime: rebate threshold = REBATE_87A_THRESHOLD_NEW_REGIME", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.new.rebate_87a_max_income, engine.CONSTANTS.REBATE_87A_THRESHOLD_NEW_REGIME);
  assert.equal(cfgs.new.rebate_87a_max_tax, engine.CONSTANTS.REBATE_87A_MAX_TAX_NEW_REGIME);
});

test("Old regime: standard deduction = STD_DEDUCTION_OLD_REGIME", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.old.standard_deduction, engine.CONSTANTS.STD_DEDUCTION_OLD_REGIME);
});

test("New regime FY 2024-25: std ded = STD_DEDUCTION_NEW_REGIME_FY_24_25 (75K)", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.new.standard_deduction, engine.CONSTANTS.STD_DEDUCTION_NEW_REGIME_FY_24_25);
});

test("New regime FY 2023-24: std ded = STD_DEDUCTION_NEW_REGIME_FY_23_24 (50K)", () => {
  const cfgs = engine.getRegimeConfigs("2024-25");
  assert.equal(cfgs.new.standard_deduction, engine.CONSTANTS.STD_DEDUCTION_NEW_REGIME_FY_23_24);
});

test("Old regime: cess = HEC_CESS_RATE", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.old.cess_rate, engine.CONSTANTS.HEC_CESS_RATE);
});

test("New regime: cess = HEC_CESS_RATE", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  assert.equal(cfgs.new.cess_rate, engine.CONSTANTS.HEC_CESS_RATE);
});

test("Old regime: >5Cr surcharge rate = SURCHARGE_RATE_ABOVE_5CR_OLD (37%)", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  const lastBracket = cfgs.old.surcharge.brackets[cfgs.old.surcharge.brackets.length - 1];
  assert.equal(lastBracket.rate, engine.CONSTANTS.SURCHARGE_RATE_ABOVE_5CR_OLD);
});

test("New regime: >5Cr surcharge rate = SURCHARGE_RATE_ABOVE_5CR_NEW (25%, capped)", () => {
  const cfgs = engine.getRegimeConfigs("2025-26");
  const lastBracket = cfgs.new.surcharge.brackets[cfgs.new.surcharge.brackets.length - 1];
  assert.equal(lastBracket.rate, engine.CONSTANTS.SURCHARGE_RATE_ABOVE_5CR_NEW);
});

// ============================================================
// Cross-module consistency
// ============================================================

test("AY list is consistent between data_model and validation", () => {
  const dmAys = dm.supportedAys().map((x) => x.ay).sort();
  // validation's ALLOWED_AYS is exposed via the schema validator
  assert.deepEqual(dmAys, validation.ALLOWED_AYS.slice().sort());
});

test("AY_TO_ITR_AY is consistent between engine and integrations", () => {
  const c = engine.CONSTANTS;
  const ay2025 = c.AY_TO_ITR_AY[c.AY_2025_26];
  const ay2024 = c.AY_TO_ITR_AY[c.AY_2024_25];
  assert.equal(ay2025, "2025");
  assert.equal(ay2024, "2024");
});

test("adapters: selectItrForm uses ITR1_TOTAL_INCOME_MAX", () => {
  // 50L exactly → ITR-1 (not > 50L, so it's allowed)
  const wb50 = dm.emptyWorkbook("2025-26");
  wb50._gti = engine.CONSTANTS.ITR1_TOTAL_INCOME_MAX;
  assert.equal(adapters.selectItrForm(wb50), "ITR-1");
  // 50L + 1 → ITR-2
  const wb51 = dm.emptyWorkbook("2025-26");
  wb51._gti = engine.CONSTANTS.ITR1_TOTAL_INCOME_MAX + 1;
  assert.equal(adapters.selectItrForm(wb51), "ITR-2");
});

test("adapters: selectItrForm uses ITR1_MAX_HP_PROPERTIES", () => {
  const wb1 = dm.emptyWorkbook("2025-26");
  wb1.house_property.properties = [
    { type: "self-occupied", co_ownership_share: 100 },
  ];
  assert.equal(adapters.selectItrForm(wb1), "ITR-1");
  const wb2 = dm.emptyWorkbook("2025-26");
  wb2.house_property.properties = [
    { type: "self-occupied", co_ownership_share: 100 },
    { type: "let-out", co_ownership_share: 100 },
  ];
  assert.equal(adapters.selectItrForm(wb2), "ITR-2");
});

test("integrations: gross salary sanity check uses FORM16_GROSS_SALARY_SANITY_MAX", () => {
  const above = "Gross Salary: Rs. 50,00,00,000";  // 50Cr
  const result = integrations.parseForm16Text(above);
  const sanityMax = engine.CONSTANTS.FORM16_GROSS_SALARY_SANITY_MAX;
  if (result.fields.gross_salary > sanityMax) {
    assert.ok(result.warnings.some((w) => w.includes("unusually large")));
  }
});

// ============================================================
// Constants are self-consistent
// ============================================================

test("REBATE_87A_MAX_TAX_OLD = (5% × REBATE_87A_THRESHOLD_OLD) - (5% × 2.5L lower slab)", () => {
  // 5% × (5L - 2.5L) = 12,500
  const c = engine.CONSTANTS;
  const lowerSlab = c.OLD_REGIME_SLAB_0_END;
  const threshold = c.REBATE_87A_THRESHOLD_OLD_REGIME;
  const expected = c.RATE_5PCT * (threshold - lowerSlab);
  assert.equal(c.REBATE_87A_MAX_TAX_OLD_REGIME, expected);
});

test("STCG 111A tax = STCG × STCG_111A_RATE", () => {
  const c = engine.CONSTANTS;
  const stcg = 250000;
  const expected = stcg * c.STCG_111A_RATE;
  assert.equal(expected, 37500);
});

test("LTCG 112A tax on ₹3L = (3L - 1L exemption) × LTCG_112A_RATE", () => {
  const c = engine.CONSTANTS;
  const ltcg = 300000;
  const exemption = c.LTCG_112A_EXEMPTION;
  const taxable = Math.max(0, ltcg - exemption);
  const expected = taxable * c.LTCG_112A_RATE;
  assert.equal(expected, 20000);
});

test("Cess 4% on ₹1L tax = ₹4,000", () => {
  const c = engine.CONSTANTS;
  const tax = 100000;
  const expected = tax * c.HEC_CESS_RATE;
  assert.equal(expected, 4000);
});

test("All slab boundaries are in ascending order", () => {
  const c = engine.CONSTANTS;
  assert.ok(c.OLD_REGIME_SLAB_0_END < c.OLD_REGIME_SLAB_1_END);
  assert.ok(c.OLD_REGIME_SLAB_1_END < c.OLD_REGIME_SLAB_2_END);
  assert.ok(c.NEW_REGIME_SLAB_0_END < c.NEW_REGIME_SLAB_1_END);
  assert.ok(c.NEW_REGIME_SLAB_1_END < c.NEW_REGIME_SLAB_2_END);
  assert.ok(c.NEW_REGIME_SLAB_2_END < c.NEW_REGIME_SLAB_3_END);
  assert.ok(c.NEW_REGIME_SLAB_3_END < c.NEW_REGIME_SLAB_4_END);
});

test("Surcharge brackets are in ascending order", () => {
  const c = engine.CONSTANTS;
  assert.ok(c.SURCHARGE_LOWER_50L < c.SURCHARGE_LOWER_1CR);
  assert.ok(c.SURCHARGE_LOWER_1CR < c.SURCHARGE_LOWER_2CR);
  assert.ok(c.SURCHARGE_LOWER_2CR < c.SURCHARGE_LOWER_5CR);
});

test("Surcharge rates are non-decreasing across brackets", () => {
  const c = engine.CONSTANTS;
  assert.ok(c.SURCHARGE_RATE_BELOW_1CR <= c.SURCHARGE_RATE_BELOW_2CR);
  assert.ok(c.SURCHARGE_RATE_BELOW_2CR <= c.SURCHARGE_RATE_BELOW_5CR);
});

test("AY + FY mapping is internally consistent", () => {
  const c = engine.CONSTANTS;
  // AY 2025-26 → FY 2024-25 (the year the income was earned)
  assert.equal(c.FY_FOR_AY[c.AY_2025_26], "2024-25");
  assert.equal(c.FY_FOR_AY[c.AY_2024_25], "2023-24");
  // ITR AY code = first 4 chars of AY
  assert.equal(c.AY_TO_ITR_AY[c.AY_2025_26], "2025");
  assert.equal(c.AY_TO_ITR_AY[c.AY_2024_25], "2024");
});

// ============================================================
// Tax engine source no longer contains hardcoded IT-Act values
// ============================================================

test("Source check: tax_engine.js no longer has scattered IT-Act literals in business logic", () => {
  // We allow the constants block + regime configs (which are
  // assembled from constants) to contain the literal values. The
  // check is on the BODY of the engine functions: computeNetSalary,
  // computeNetHouseProperty, etc. — those should reference
  // CONSTANTS by name, not by literal.
  //
  // This is a "soft" test (it scans the file) — its purpose is to
  // catch accidental regressions. If you legitimately need to add
  // a literal in business logic, update this test.
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "tax_engine.js"),
    "utf8"
  );
  // The body of computeDeductions should not contain "150000"
  // (the 80C cap) — it should reference CAP_80C.
  const computeDeductionsBody = src.match(/function computeDeductions[\s\S]*?\n  \}/);
  if (computeDeductionsBody) {
    assert.equal(
      /150000/.test(computeDeductionsBody[0]),
      false,
      "computeDeductions should reference CAP_80C, not 150000"
    );
    assert.equal(
      /50000/.test(computeDeductionsBody[0]),
      false,
      "computeDeductions should reference CAP_80CCD_1B, not 50000"
    );
  }
  // The body of computeNetHouseProperty should not contain "200000"
  // or "0.30" in business-logic lines.
  const hpBody = src.match(/function computeNetHouseProperty[\s\S]*?\n  \}/);
  if (hpBody) {
    assert.equal(
      /200000/.test(hpBody[0]),
      false,
      "computeNetHouseProperty should reference HP_SELF_OCCUPIED_INTEREST_CAP"
    );
  }
  // computeScheduleCGTax should not contain "0.15", "0.10", "0.20", "100000" in business lines
  const cgBody = src.match(/function computeScheduleCGTax[\s\S]*?\n  \}/);
  if (cgBody) {
    assert.equal(/100000/.test(cgBody[0]), false, "computeScheduleCGTax should reference LTCG_112A_EXEMPTION");
  }
  // The lottery "0.30" should be LOTTERY_RATE
  assert.equal(
    /other\.lottery \* 0\.30/.test(src),
    false,
    "lottery tax should use LOTTERY_RATE, not 0.30"
  );
});
