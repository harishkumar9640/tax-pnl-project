// js/tests/test_house_property_loss.spec.js
// Regression tests for the house-property-loss bug.
//
// BUG (FIXED in v1.1+): computeNetHouseProperty clamped its result
// to Math.max(0, totalIncome), which silently discarded any HP
// loss. Per Section 24(b) + Section 71(3A) of the IT Act, a
// self-occupied home with home-loan interest is allowed to
// generate a loss that can be set off against income from other
// heads (salary, other sources). The clamp violated this and
// over-stated tax for any salaried person with a home loan.
//
// This test file exists so the bug can never silently regress.

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");

// ============================================================
// Self-occupied: home-loan interest creates a loss
// ============================================================

test("HP loss: self-occ ₹2L home loan → taxable income drops by ₹2L", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1200000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.salary.tds_total = 0;
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 200000,   // ₹2L
    municipal_taxes_paid: 0,
    co_ownership_share: 100,
  }];

  const baseline = dm.emptyWorkbook("2025-26");
  baseline.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1200000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  baseline.salary.tds_total = 0;

  const trWithLoan = engine.computeForRegime(wb, "old");
  const trNoLoan = engine.computeForRegime(baseline, "old");

  // Taxable income should be ₹2L lower with the home loan
  assert.equal(trWithLoan.taxable_income, trNoLoan.taxable_income - 200000,
    `taxable_income should drop by ₹2L when home loan is entered: got ${trWithLoan.taxable_income} (with loan) vs ${trNoLoan.taxable_income} (no loan)`);
});

test("HP loss: self-occ — concrete numbers from the bug report", () => {
  // ₹12L salary, ₹50k std ded, +₹2L home loan interest.
  // Expected taxable income: ₹9.5L (12L - 50K - 2L)
  // Pre-fix: ₹11.5L (loss silently discarded)
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1200000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 200000,
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  // Net salary = 12L - 50K = 11.5L
  assert.equal(r.salary.net_salary, 1150000);
  // HP loss flows through
  assert.equal(r.house.net_house_property, -200000,
    "HP net should be -₹2L (the home loan loss), not 0");
  // GTI = 11.5L - 2L = 9.5L
  assert.equal(r.gti, 950000,
    "GTI should be 11.5L - 2L = 9.5L");
  // Taxable income = 9.5L
  assert.equal(r.taxable_income, 950000,
    "taxable_income should be ₹9.5L with the home loan");
});

test("HP loss: self-occ — net_house_property is exposed as negative on the result", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 200000,
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  assert.ok(r.house.net_house_property < 0,
    "house.net_house_property should be negative for a self-occ with home loan");
});

// ============================================================
// Self-occ: cap on interest (Section 24(b)) still works
// ============================================================

test("HP loss: self-occ interest above ₹2L is capped at ₹2L (Section 24(b))", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 500000,  // ₹5L (above the cap)
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  // Per Section 24(b), the deduction is capped at ₹2L. So the
  // loss is ₹2L, not ₹5L.
  assert.equal(r.house.net_house_property, -200000,
    "loss should be capped at ₹2L (not the full ₹5L)");
});

// ============================================================
// Let-out: loss can also flow through (subject to §71(3A) cap)
// ============================================================

test("HP loss: let-out with high interest → loss flows into GTI", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Let-out with ₹2L rent, 30% std = ₹60K, ₹3L interest, ₹0 municipal
  // NAV = 2L, deductions = 60K + 0 + 3L = 3.6L → loss = -1.6L
  wb.house_property.properties = [{
    type: "let-out",
    rent_received: 200000,
    home_loan_interest_paid: 300000,
    municipal_taxes_paid: 0,
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  assert.ok(r.house.net_house_property < 0,
    "let-out with high interest should generate a loss");
  // Loss reduces GTI
  assert.ok(r.gti < r.salary.net_salary,
    "GTI should be reduced by the HP loss");
});

// ============================================================
// Multi-property: losses aggregate
// ============================================================

test("HP loss: two self-occ properties — losses sum", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 2000000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Two self-occ properties, each with ₹1.5L interest
  // → total loss = ₹3L, but each capped at ₹2L (so each gets the full 1.5L).
  // Total loss should be -3L.
  wb.house_property.properties = [
    { type: "self-occupied", home_loan_interest_paid: 150000, co_ownership_share: 100 },
    { type: "self-occupied", home_loan_interest_paid: 150000, co_ownership_share: 100 },
  ];
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.house.net_house_property, -300000,
    "two properties' losses should sum");
});

// ============================================================
// Mixed: positive and negative properties
// ============================================================

test("HP loss: one profitable + one loss-making → net can be positive or negative", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Property 1: let-out with rent > expenses (profit)
  // Property 2: self-occ with home loan (loss)
  wb.house_property.properties = [
    {
      type: "let-out",
      rent_received: 600000,   // 6L
      home_loan_interest_paid: 0,
      municipal_taxes_paid: 0,
      co_ownership_share: 100,
    },
    {
      type: "self-occupied",
      home_loan_interest_paid: 200000,
      co_ownership_share: 100,
    },
  ];
  const r = engine.computeForRegime(wb, "old");
  // Net: 6L rent - 1.8L std (30%) - 0 - 0 = 4.2L (from let-out)
  //     + (0 - 0 - 2L) = -2L (from self-occ)
  //     = 2.2L
  assert.equal(r.house.net_house_property, 220000,
    "net HP should be ₹2.2L (profit minus loss)");
});

// ============================================================
// Tax impact: HP loss reduces tax
// ============================================================

test("HP loss: a self-occ with ₹2L interest saves tax at 20% slab", () => {
  // A salaried person with ₹15L gross salary and a ₹2L home-loan
  // interest on a self-occupied property should save roughly:
  //   - With loan:    12.5L GTI → 1,87,500 slab + 7,500 cess = 1,95,000
  //   - Without loan: 14.5L GTI → 2,47,500 slab + 9,900 cess = 2,57,400
  //   - Saving: ~₹62,400
  // That's a meaningful tax break (about ₹40-60K at the 20-30%
  // marginal rate, which is the home-loan benefit most salaried
  // taxpayers actually realize).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 200000,
    co_ownership_share: 100,
  }];
  const baseline = dm.emptyWorkbook("2025-26");
  baseline.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];

  const withLoan = engine.computeForRegime(wb, "old");
  const noLoan = engine.computeForRegime(baseline, "old");
  const taxSaving = noLoan.total_tax_liability - withLoan.total_tax_liability;
  // Sanity: pre-fix this would be 0 (the bug). Post-fix it's > ₹50K.
  assert.ok(taxSaving > 50000,
    `HP loss should save > ₹50K; got ₹${taxSaving}`);
  assert.ok(taxSaving < 80000,
    `tax saving looks reasonable (< ₹80K); got ₹${taxSaving}`);
  // The exact expected saving for this scenario is ₹62,400.
  assert.equal(taxSaving, 62400,
    `expected ₹62,400 saving for ₹2L home loan on ₹15L salary; got ₹${taxSaving}`);
});

// ============================================================
// End-to-end: GTI and taxable_income are consistent
// ============================================================

test("GTI = sum of heads (including negative HP)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 1500000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied",
    home_loan_interest_paid: 200000,
    co_ownership_share: 100,
  }];
  const r = engine.computeForRegime(wb, "old");
  // GTI should equal net_salary + net_house_property + net_other + net_cg
  const expected = r.salary.net_salary
                + r.house.net_house_property
                + r.other.net_other_sources
                + r.cg.net_capital_gains;
  assert.equal(r.gti, expected,
    "GTI should be the sum of all head net values, including negative HP");
});

test("taxable_income is never negative even when GTI is very negative", () => {
  // Edge case: large HP loss that exceeds other heads.
  // Salary 1L, HP loss 5L → GTI = -4L, but taxable_income is 0.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "A", tan: "", gross_salary: 100000,
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Self-occ with ₹2L interest (capped). Let-out with high interest
  // to push HP loss to 5L.
  wb.house_property.properties = [
    {
      type: "self-occupied",
      home_loan_interest_paid: 200000,   // capped at 2L
      co_ownership_share: 100,
    },
    {
      type: "let-out",
      rent_received: 100000,           // 1L rent
      home_loan_interest_paid: 500000, // 5L interest
      municipal_taxes_paid: 0,
      co_ownership_share: 100,
    },
  ];
  const r = engine.computeForRegime(wb, "old");
  // Net HP: -2L (self-occ) + (1L - 30K - 0 - 5L = -4.3L let-out) = -6.3L
  // (We don't implement §71(3A) cap in v1; full loss flows through.)
  // GTI = 50K (net salary) - 6.3L = -5.8L
  // taxable_income = Math.max(0, -5.8L - 0) = 0
  assert.equal(r.taxable_income, 0,
    "taxable_income should floor at 0 even with massive HP loss");
  assert.equal(r.total_tax_liability, 0);
});
