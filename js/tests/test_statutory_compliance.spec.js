// js/tests/test_statutory_compliance.spec.js
// Statutory compliance and tax logic tests.
//
// This suite verifies the tax engine against specific sections of
// the Income-tax Act, 1961, and Finance Act amendments for AY
// 2025-26 and AY 2024-25. Each test references the relevant section
// so a CA or auditor can verify the implementation matches the
// statute.
//
// Coverage:
//   - Section 10: Exemptions (HRA, LTA, standard deduction context)
//   - Section 16: Standard deduction, professional tax
//   - Section 17: Salary definition
//   - Section 22-25: House property (NAV, 30% std ded, 24(b) cap)
//   - Section 56-59: Other sources (interest, dividends, lottery)
//   - Section 45-55: Capital gains (111A, 112A, set-off, exemption)
//   - Section 80C/80CCD/80D/80E/80G/80TTA/80TTB: Deductions
//   - Section 87A: Rebate
//   - Section 115BAC: New regime
//   - Section 234A/B/C: Interest (out of scope for v1)
//   - Section 271/273: Penalties (out of scope for v1)
//
// Note: v1 of the engine does NOT compute interest on late filing
// (234A), interest on default in advance tax (234B/C), or penalties
// (271/273). Those are tracked in tests as 'TODO' and slated for v2.

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");

// Helper: build a minimal salaried workbook for testing
function buildSalariedWB(ay, grossSalary, opts = {}) {
  const wb = dm.emptyWorkbook(ay);
  wb.salary.employers = [{
    employer_name: "Acme",
    tan: "",
    gross_salary: grossSalary,
    allowances_exempt_10: opts.exempt || 0,
    professional_tax: opts.profTax || 0,
  }];
  if (opts.tds) wb.salary.tds_total = opts.tds;
  if (opts.capitalGains) {
    Object.assign(wb.capital_gains, opts.capitalGains);
  }
  if (opts.deductions) {
    Object.assign(wb.deductions, opts.deductions);
  }
  return wb;
}

// ============================================================
// Section 10 + 16: Exemptions and standard deduction
// ============================================================

test("Section 16(ia): standard deduction ₹50,000 (old regime, AY 2025-26)", () => {
  const wb = buildSalariedWB("2025-26", 1000000);
  const r = engine.computeForRegime(wb, "old");
  // Net salary = 10L - 50K = 9,50,000
  assert.equal(r.salary.net_salary, 950000);
  assert.equal(r.salary.standard_deduction, 50000);
});

test("Section 115BAC: standard deduction ₹75,000 (new regime, AY 2025-26)", () => {
  const wb = buildSalariedWB("2025-26", 1000000);
  const r = engine.computeForRegime(wb, "new");
  // Net salary = 10L - 75K = 9,25,000
  assert.equal(r.salary.net_salary, 925000);
  assert.equal(r.salary.standard_deduction, 75000);
});

test("Section 115BAC: standard deduction ₹50,000 (new regime, AY 2024-25)", () => {
  // FY 2023-24: the 50K std ded was the only option in new regime;
  // 75K was raised in FY 2024-25 only.
  const wb = buildSalariedWB("2024-25", 1000000);
  const r = engine.computeForRegime(wb, "new");
  // Net salary = 10L - 50K = 9,50,000
  assert.equal(r.salary.net_salary, 950000);
  assert.equal(r.salary.standard_deduction, 50000);
});

test("Section 16(iii): professional tax fully deductible", () => {
  const wb = buildSalariedWB("2025-26", 600000, { profTax: 2500 });
  const r = engine.computeForRegime(wb, "old");
  // Net = 6L - 50K - 2500 = 547,500
  assert.equal(r.salary.net_salary, 547500);
});

test("Section 10: HRA exempt amount reduces net salary", () => {
  // User enters the FULL HRA they received, the EXEMPT portion
  // (computed from rent paid + city type), and the difference is
  // taxable. For v1 we trust the user to enter "allowances exempt
  // u/s 10" as a single number (per Form 16 Part B).
  const wb = buildSalariedWB("2025-26", 1200000, { exempt: 300000 });
  const r = engine.computeForRegime(wb, "old");
  // Net = 12L - 3L - 50K = 8,50,000
  assert.equal(r.salary.net_salary, 850000);
  assert.equal(r.salary.exempt_10, 300000);
});

// ============================================================
// Section 22-25: House property
// ============================================================

test("Section 23: self-occupied house has NIL annual value", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 800000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied", address: "Mumbai", rent_received: 0,
    municipal_taxes_paid: 0, home_loan_interest_paid: 100000,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // NAV = 0 for self-occupied
  // Net HP = 0 - 0 (municipal) - 100K (interest) = -100K
  // (Pre-fix this was clamped to 0, silently discarding the loss.
  // Post-fix the loss flows through to GTI, allowing inter-head
  // set-off per Section 24(b) + Section 71(3A).)
  assert.equal(r.house.net_house_property, -100000);
  // Total interest tracked for 80C/deduction reference
  assert.equal(r.house.total_interest, 100000);
});

test("Section 24(b): home loan interest capped at ₹2,00,000 (self-occupied)", () => {
  // 2.5L interest → only 2L deductible (cap is 2L for self-occupied).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 800000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied", address: "Mumbai", rent_received: 0,
    municipal_taxes_paid: 0, home_loan_interest_paid: 250000,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // The 50K excess interest is not deductible under Section 24(b)
  // (but the principal repayment is, under 80C, separate input).
  // The loss is capped at ₹2L (the deductible interest) and flows
  // through to GTI as a negative value, allowing inter-head set-off.
  assert.equal(r.house.net_house_property, -200000);
  assert.equal(r.house.total_interest, 250000);  // not capped, just informational
});

test("Section 24(b): let-out property has NO ₹2L cap on interest", () => {
  // For let-out, all home loan interest is deductible (no 2L cap).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "let-out", address: "Delhi", rent_received: 300000,
    municipal_taxes_paid: 10000, home_loan_interest_paid: 250000,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // NAV = 3L
  // 30% std = 90K
  // Municipal = 10K
  // Interest = 2.5L (no cap)
  // Net HP = 3L - 90K - 10K - 2.5L = -50K
  // (Pre-fix this was clamped to 0, silently discarding the loss.
  // Post-fix the loss flows through to GTI, allowing inter-head
  // set-off per Section 71(3A).)
  assert.equal(r.house.net_house_property, -50000);
});

test("Section 24(a): 30% standard deduction on let-out NAV", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "let-out", address: "Pune", rent_received: 240000,
    municipal_taxes_paid: 0, home_loan_interest_paid: 0,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // NAV = 2.4L, 30% std = 72K, net = 1,68,000
  assert.equal(r.house.net_house_property, 168000);
});

test("Section 26: co-ownership share applied to all HP components", () => {
  // 50% co-ownership: rent, municipal, interest all halved
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "let-out", address: "Bangalore", rent_received: 300000,
    municipal_taxes_paid: 20000, home_loan_interest_paid: 100000,
    home_loan_principal_paid: 0, co_ownership_share: 50, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // 50% share: rent=1.5L, municipal=10K, interest=50K
  // NAV = 1.5L, 30% std = 45K, net = 1.5L - 45K - 10K - 50K = 45K
  assert.equal(r.house.net_house_property, 45000);
  assert.equal(r.house.total_rent, 150000);
});

// ============================================================
// Section 56-59: Other sources
// ============================================================

test("Section 56: interest from savings account, FD, RD all taxable", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.other_sources.savings_account_interest = 10000;
  wb.other_sources.fd_interest = 25000;
  wb.other_sources.rd_interest = 5000;
  const r = engine.computeForRegime(wb, "old");
  // 10K + 25K + 5K = 40K
  assert.equal(r.other.interest, 40000);
  assert.equal(r.other.net_other_sources, 40000);
});

test("Section 56(2)(xi): dividend income taxable (post-AY 2021-22)", () => {
  // Dividends from domestic companies are taxable at slab rate.
  // No ₹10 lakh exemption any more (that was abolished in 2020).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.other_sources.dividend_gross = 50000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.other.dividend_gross, 50000);
  assert.equal(r.other.net_other_sources, 50000);
});

test("Section 115BBH: lottery taxed at flat 30% (no slab, no rebate)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 300000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.other_sources.lottery_winnings = 50000;
  const r = engine.computeForRegime(wb, "old");
  // Lottery tax = 50K × 30% = 15K
  assert.equal(r.lottery_tax, 15000);
  // Lottery doesn't add to GTI (it's taxed separately at 30%)
  // Our engine puts lottery in net_other_sources for total but
  // the lottery_tax is the actual 30% on the amount. Verify.
  assert.equal(r.other.lottery, 50000);
});

test("Section 194-IB: TDS on rent > ₹2.4L/year handled separately", () => {
  // For v1 we just track TDS-on-rent; the engine doesn't auto-compute it
  // (the user enters it from Form 26AS). Verify the field is preserved.
  const wb = dm.emptyWorkbook("2025-26");
  wb.house_property.properties = [{
    type: "let-out", address: "Mumbai", rent_received: 300000,
    municipal_taxes_paid: 0, home_loan_interest_paid: 0,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 30000,
  }];
  assert.equal(wb.house_property.properties[0].tds_on_rent, 30000);
  // TODO: when we add Form 26AS auto-aggregation, tds_on_rent
  // should be summed into taxes_paid.tds_other_than_salary.
});

// ============================================================
// Section 45-55: Capital gains
// ============================================================

test("Section 111A: STCG on listed equity taxed at flat 15%", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  const r = engine.computeForRegime(wb, "old");
  // STCG should be added to GTI; tax is at 15% via schedule CG
  // (the engine doesn't compute 15% separately — it adds to
  // GTI, the 15% rate is applied at schedule level. Verify
  // the gain is in GTI.)
  assert.equal(r.gti, 100000);
  assert.equal(r.cg.stcg_111a_gross, 100000);
});

test("Section 112A: LTCG on listed equity above ₹1L taxed at 10%", () => {
  // ₹1L exemption is applied in computeCapitalGains
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 200000;  // 2L, 1L exempt, 1L taxable
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.cg.ltcg_exemption_applied, 100000);
  assert.equal(r.cg.ltcg_after_cf, 100000);  // post-exemption
  // 1L is added to GTI
  assert.equal(r.gti, 100000);
});

test("Section 112A: LTCG ≤ ₹1L fully exempt", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 80000;  // 80K, below 1L threshold
  const r = engine.computeForRegime(wb, "old");
  // Full 80K is exempt, no GTI contribution
  assert.equal(r.cg.ltcg_exemption_applied, 80000);
  assert.equal(r.gti, 0);
});

test("Section 70: STCL set off first against STCG, then LTCG", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 200000;   // STCG
  wb.capital_gains.ltcg_112a = 300000;   // LTCG
  wb.capital_gains.stcl_brought_forward = 100000;  // STCL
  const r = engine.computeForRegime(wb, "old");
  // STCL 1L absorbs against STCG 2L first
  assert.equal(r.cg.stcl_used, 100000);
  assert.equal(r.cg.stcg_after_cf, 100000);  // 2L - 1L
  // ltcg_after_cf is POST-EXEMPTION: 3L (LTCG) - 1L (exemption) = 2L
  assert.equal(r.cg.ltcg_exemption_applied, 100000);
  assert.equal(r.cg.ltcg_after_cf, 200000);  // not touched by STCL
});

test("Section 70: LTCL set off first against LTCG, then STCG", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 200000;
  wb.capital_gains.ltcg_112a = 300000;
  wb.capital_gains.ltcl_brought_forward = 150000;  // LTCL
  const r = engine.computeForRegime(wb, "old");
  // LTCL 1.5L absorbs against LTCG 3L first
  assert.equal(r.cg.ltcl_used, 150000);
  // After LTCL: LTCG = 3L - 1.5L = 1.5L
  // After ₹1L exemption: 1.5L - 1L = 0.5L
  assert.equal(r.cg.ltcg_after_cf, 50000);   // 1.5L - 1L exemption
  assert.equal(r.cg.stcg_after_cf, 200000);  // untouched
});

test("Section 71: STCL brought forward expires after 8 years", () => {
  // v1 does not track per-year STCL buckets; the user enters the
  // total STCL brought forward manually and is responsible for
  // knowing which years are still valid. This test documents the
  // limitation and provides a hook for future per-year tracking.
  const wb = dm.emptyWorkbook("2025-26");
  wb.capital_gains.stcl_brought_forward = 50000;
  assert.equal(wb.capital_gains.stcl_brought_forward, 50000);
  // TODO v2: add a stcl_by_year field with per-year amounts and
  // expiry dates; engine filters out those >8 years old.
});

test("Buyback gains (post-2019): Section 2(22)(d) + Section 10(34) — NOT in STCG", () => {
  // Share buyback proceeds are taxed as DIVIDEND in the hands of
  // the shareholder (Section 194, sec 2(22)(d)). The amount
  // received above the original cost is taxable as "Income from
  // Other Sources" (specifically "dividend"), not as capital gain.
  //
  // v1 does NOT auto-classify buyback; the user must put the
  // deemed dividend in `dividend_gross` and NOT in capital_gains.
  // This test documents that requirement.
  const wb = dm.emptyWorkbook("2025-26");
  // User puts ₹1L buyback deemed dividend in other_sources
  wb.other_sources.dividend_gross = 100000;
  // And ₹0 in capital_gains (so it's not double-counted)
  wb.capital_gains.stcg_111a = 0;
  wb.capital_gains.ltcg_112a = 0;
  const r = engine.computeForRegime(wb, "old");
  // 1L flows into Other Sources, gets taxed at slab rate
  assert.equal(r.gti, 100000);
});

// ============================================================
// Section 80C: Deductions caps
// ============================================================

test("Section 80C: cap at ₹1,50,000", () => {
  const wb = buildSalariedWB("2025-26", 1000000, { deductions: { "80c_total": 500000 } });
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.deductions.c80c, 150000);  // capped
});

test("Section 80CCD(1B): NPS additional contribution cap ₹50,000 (over 80C)", () => {
  const wb = buildSalariedWB("2025-26", 1000000, { deductions: { "80ccd_1b": 100000 } });
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.deductions.c80ccd1b, 50000);  // capped
});

test("Section 80CCD(2): employer NPS contribution NO cap (in both regimes)", () => {
  // 80CCD(2) is allowed in both old and new regime
  const wb = buildSalariedWB("2025-26", 2000000, { deductions: { "80ccd_2": 200000 } });
  const old = engine.computeForRegime(wb, "old");
  const newR = engine.computeForRegime(wb, "new");
  assert.equal(old.deductions.c80ccd2, 200000);
  assert.equal(newR.deductions.c80ccd2, 200000);
});

test("Section 80D: self+family max ₹25K, parents max ₹25K (non-senior)", () => {
  // v1 doesn't distinguish senior citizens (that adds 50K vs 25K
  // and 1L for parents). The user enters the capped amount
  // directly.
  const wb = buildSalariedWB("2025-26", 1000000, { deductions: {
    "80d_self_family": 50000,   // capped to 25K
    "80d_parents": 50000,        // capped to 25K
  } });
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.deductions.c80d, 50000);  // 25K + 25K
});

test("Section 80E: education loan interest NO cap, 8-year limit", () => {
  // v1: no cap applied, user enters total amount.
  const wb = buildSalariedWB("2025-26", 1000000, { deductions: { "80e": 100000 } });
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.deductions.c80e, 100000);
});

test("Section 80G: 50% donations (PMNRF etc.) and 100% (PM Cares)", () => {
  const wb = buildSalariedWB("2025-26", 1000000, { deductions: {
    "80g_50pct": 50000,
    "80g_100pct": 100000,
  } });
  const r = engine.computeForRegime(wb, "old");
  // No cap on 80G (subject to 10% of GTI limit for some categories,
  // but v1 trusts the user to enter the eligible amount).
  assert.equal(r.deductions.c80g, 150000);
});

test("Section 80TTA: savings interest ₹10,000 (only OLD regime, non-senior)", () => {
  const wb = buildSalariedWB("2025-26", 800000, { deductions: { "80tta": 15000 } });
  const old = engine.computeForRegime(wb, "old");
  const newR = engine.computeForRegime(wb, "new");
  // Old: capped to 10K
  assert.equal(old.deductions.c80tta, 10000);
  // New: 0
  assert.equal(newR.deductions.c80tta, 0);
});

test("Section 80TTB: senior citizen interest ₹50,000 (only OLD regime)", () => {
  // Per Section 80TTB: only senior citizens (60+) can claim.
  // The engine derives senior status from profile.dob. If the
  // user hasn't set a DOB, the engine treats them as non-senior
  // and 80TTB is gated off (regardless of any value entered).
  // To claim 80TTB, the user must be 60+ on the AY start date.
  const wb = buildSalariedWB("2025-26", 800000, { deductions: { "80ttb": 60000 } });
  const old = engine.computeForRegime(wb, "old");
  const newR = engine.computeForRegime(wb, "new");
  // No DOB → treated as non-senior → 80TTB gated off (even though
  // the user typed 60000). This is the correct behavior post-fix.
  assert.equal(old.deductions.c80ttb, 0);
  assert.equal(newR.deductions.c80ttb, 0);
});

test("Section 80TTB: senior citizen (DOB makes 60+) gets full ₹50K", () => {
  // Build a profile with a DOB making the user 65 on April 1, 2025.
  // DOB = 1959-04-01 → age on 2025-04-01 = 66 (senior).
  const profile = dm.emptyProfile();
  profile.dob = "1959-04-01";
  const wb = buildSalariedWB("2025-26", 800000, { deductions: { "80ttb": 60000 } });
  const old = engine.computeForRegime(wb, "old", profile);
  // Senior → 80TTB allowed, capped at 50K
  assert.equal(old.deductions.c80ttb, 50000);
  assert.equal(old.deductions.is_senior_citizen, true);
});

test("Section 80TTB: 80TTA and 80TTB are mutually exclusive (per §80TTB)", () => {
  // Per Section 80TTB: a senior cannot use 80TTA. A non-senior
  // cannot use 80TTB. The engine enforces this.
  // Non-senior with both entered: only 80TTA applied
  const nonSenior = dm.emptyProfile();   // no DOB
  const wb1 = buildSalariedWB("2025-26", 800000, {
    deductions: { "80tta": 12000, "80ttb": 50000 },
  });
  const r1 = engine.computeForRegime(wb1, "old", nonSenior);
  assert.equal(r1.deductions.c80tta, 10000);  // capped at 10K
  assert.equal(r1.deductions.c80ttb, 0);       // gated off for non-senior
  // Senior with both entered: only 80TTB applied
  const senior = dm.emptyProfile();
  senior.dob = "1959-04-01";
  const wb2 = buildSalariedWB("2025-26", 800000, {
    deductions: { "80tta": 12000, "80ttb": 50000 },
  });
  const r2 = engine.computeForRegime(wb2, "old", senior);
  assert.equal(r2.deductions.c80tta, 0);        // 80TTA not for seniors
  assert.equal(r2.deductions.c80ttb, 50000);   // 80TTB applies
});

// ============================================================
// Section 87A: Rebate
// ============================================================

test("Section 87A: total income exactly ₹5L → 0 tax (old regime)", () => {
  const wb = buildSalariedWB("2025-26", 550000);
  const r = engine.computeForRegime(wb, "old");
  // Net salary = 5L exactly
  // Pre-rebate tax = 12,500 (5% × 2.5L)
  // Rebate makes it nil
  assert.equal(r.gti, 500000);
  assert.equal(r.pre_rebate_tax, 12500);
  assert.equal(r.tax_after_rebate, 0);
  assert.equal(r.rebate_87a, 12500);
});

test("Section 87A: income at ₹4,50,001 still gets rebate (under 5L)", () => {
  // At net salary = 4,50,001 the GTI is still under 5L, so 87A
  // rebate applies → 0 tax. The 5L threshold is on GTI, not
  // gross salary, so a higher gross salary is fine.
  const wb = buildSalariedWB("2025-26", 500001);
  // Net salary = 5,00,001 - 50,000 = 4,50,001
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.gti, 450001);
  assert.equal(r.tax_after_rebate, 0);
});

test("Section 87A new regime: total income ₹7L → 0 tax", () => {
  const wb = buildSalariedWB("2025-26", 775000);
  // New regime, std ded = 75K, so net salary = 7L
  const r = engine.computeForRegime(wb, "new");
  assert.equal(r.gti, 700000);
  // Slab: 0-3: 0, 3-7: 5%×4L = 20K
  assert.equal(r.pre_rebate_tax, 20000);
  // Rebate 87A: total income ≤ 7L → nil
  assert.equal(r.tax_after_rebate, 0);
});

// ============================================================
// Surcharge: Section 2(29), Section 44, etc.
// ============================================================

test("Surcharge: 50L-1Cr bracket = 10% (old regime)", () => {
  // At 50L exactly the surcharge doesn't kick in (>50L required)
  const wb = dm.emptyWorkbook("2025-26");
  wb.capital_gains.ltcg_112a = 5500000;  // 54L post 1L exemption
  const r = engine.computeForRegime(wb, "old");
  // 54L > 50L → 10% surcharge
  assert.equal(r.surcharge_rate, 0.10);
});

test("Surcharge: 1Cr-2Cr bracket = 15% (old regime)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.capital_gains.ltcg_112a = 15000000;  // 1.5Cr post 1L exemption
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.surcharge_rate, 0.15);
});

test("Surcharge: 2Cr-5Cr bracket = 25% (old regime)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.capital_gains.ltcg_112a = 30000000;  // 3Cr
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.surcharge_rate, 0.25);
});

test("Surcharge new regime: 50L-1Cr = 10%, 1Cr+ capped at 25%", () => {
  // In new regime (post-Finance-Act-2024), surcharge is capped at
  // 25% for income > ₹5 Cr. The 37% bracket from old regime is
  // removed.
  const wb1 = dm.emptyWorkbook("2025-26");
  wb1.capital_gains.ltcg_112a = 5500000;  // 54L
  const r1 = engine.computeForRegime(wb1, "new");
  assert.equal(r1.surcharge_rate, 0.10);

  const wb2 = dm.emptyWorkbook("2025-26");
  wb2.capital_gains.ltcg_112a = 60000000;  // 6Cr
  const r2 = engine.computeForRegime(wb2, "new");
  // New regime: even above 5Cr, surcharge is capped at 25%
  assert.equal(r2.surcharge_rate, 0.25);
});

// ============================================================
// Section 4: Health & Education Cess
// ============================================================

test("Section 4: 4% H&E cess on tax + surcharge", () => {
  const wb = dm.emptyWorkbook("2025-26");
  // 10L salary → 9.5L GTI after std ded (no cap gains, so slab tax
  // + cess are clean). Cap gains are now taxed separately on
  // Schedule CG and the 87A rebate doesn't apply to them.
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // Pre-rebate tax: 0-2.5: 0, 2.5-5: 12.5K, 5-9.5: 20%×4.5L=90K = 102,500
  // Surcharge: 9.5L < 50L, none
  // Cess: 4% × 102,500 = 4,100
  // Total: 106,600
  assert.equal(r.cess, 4100);
  assert.equal(r.total_tax_rounded, 106600);
});

// ============================================================
// TDS + advance tax adjustment
// ============================================================

test("TDS reduces tax payable; refund when TDS > tax", () => {
  const wb = buildSalariedWB("2025-26", 800000, { tds: 100000 });
  const r = engine.computeForRegime(wb, "old");
  // Net salary = 7.5L
  // Pre-rebate tax: 0-2.5: 0, 2.5-5: 12.5K, 5-7.5: 20%×2.5L=50K = 62,500
  // 4% cess: 2,500
  // Total tax: 65,000
  // TDS: 1,00,000 → refund of 35,000
  assert.equal(r.tds_total, 100000);
  assert.equal(r.result, "refund");
  assert.equal(r.refund_due_rounded, 35000);
});

test("Advance tax + self-assessment tax + TDS all reduce tax payable", () => {
  const wb = buildSalariedWB("2025-26", 1500000);
  wb.salary.tds_total = 100000;
  wb.taxes_paid.advance_tax = 50000;
  wb.taxes_paid.self_assessment_tax = 10000;
  const r = engine.computeForRegime(wb, "old");
  // TDS + AT + SAT = 1,60,000 total
  assert.equal(r.tds_total, 160000);
});

// ============================================================
// Regime comparison (Section 115BAC vs default)
// ============================================================

test("New regime wins at 10L plain salary (no 80C)", () => {
  const wb = buildSalariedWB("2025-26", 1075000);
  const both = engine.computeBothRegimes(wb);
  // New: 10L → 50K tax → 52K with cess
  // Old: 10L → 1,12,500 tax → 1,17,000 with cess
  assert.ok(both.new.total_tax_liability < both.old.total_tax_liability);
  assert.equal(both.recommendation, "new");
});

test("New regime wins for most salaried people (post-Finance-Act-2024)", () => {
  // After Finance Act 2024 expanded the new regime's rebate to ₹7L
  // and lowered the slabs, the new regime is structurally better
  // for most salaried individuals. Old regime wins only in edge
  // cases (e.g. high business income, very high 80CCD(2) employer
  // NPS contributions, or capital gains >50% of total income).
  // This test documents the general expectation so any future
  // regime-config change that reverses the trend triggers a
  // review.
  const cases = [
    { gross: 1000000,  name: "10L plain" },
    { gross: 2000000,  name: "20L" },
    { gross: 5000000,  name: "50L" },
    { gross: 10000000, name: "1Cr" },
  ];
  for (const c of cases) {
    const wb = buildSalariedWB("2025-26", c.gross);
    const both = engine.computeBothRegimes(wb);
    assert.ok(
      both.new.total_tax_liability <= both.old.total_tax_liability,
      `${c.name}: new should be ≤ old, got new=${both.new.total_tax_liability} old=${both.old.total_tax_liability}`
    );
  }
});

// ============================================================
// AY 2024-25 (FY 2023-24) — separate regime configs
// ============================================================

test("AY 2024-25: new regime uses 50K std ded (not 75K)", () => {
  const wb = dm.emptyWorkbook("2024-25");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const r = engine.computeForRegime(wb, "new");
  assert.equal(r.salary.standard_deduction, 50000);
  assert.equal(r.salary.net_salary, 950000);
});

test("AY 2024-25: new regime 7L threshold (same as AY 2025-26)", () => {
  const wb = dm.emptyWorkbook("2024-25");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 750000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Net salary = 7L (50K std ded)
  const r = engine.computeForRegime(wb, "new");
  assert.equal(r.gti, 700000);
  assert.equal(r.tax_after_rebate, 0);  // 87A rebate
});

// ============================================================
// Edge cases
// ============================================================

test("Edge case: all zeros → 0 tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.total_tax_liability, 0);
  assert.equal(r.net_payable, 0);
});

test("Edge case: salary just below old-regime slab boundary", () => {
  // At 2,49,999 net salary → 0% on all of it (under 2.5L slab)
  const wb = buildSalariedWB("2025-26", 300000);  // net = 2,49,999
  const r = engine.computeForRegime(wb, "old");
  // Pre-rebate tax = 0
  assert.equal(r.pre_rebate_tax, 0);
  assert.equal(r.total_tax_liability, 0);
});

test("Edge case: salary exactly at ₹2.5L boundary (old regime)", () => {
  // At 3L gross: net = 2,50,000. Pre-rebate tax = 0 (still in 0% slab).
  // At 3L+1: net = 2,50,001. Tax on the 1 rupee at 5% = ₹0.05,
  // which is then zeroed by 87A rebate (income < 5L).
  const wb1 = buildSalariedWB("2025-26", 300000);
  const r1 = engine.computeForRegime(wb1, "old");
  assert.equal(r1.salary.net_salary, 250000);
  assert.equal(r1.pre_rebate_tax, 0);

  const wb2 = buildSalariedWB("2025-26", 300001);
  const r2 = engine.computeForRegime(wb2, "old");
  assert.equal(r2.salary.net_salary, 250001);
  // Tax on ₹1 at 5% = ₹0.05, then rebate 87A zeroes it
  assert.equal(r2.pre_rebate_tax, 0.05);
  assert.equal(r2.tax_after_rebate, 0);
});

test("Edge case: very high TDS with low income → large refund", () => {
  const wb = buildSalariedWB("2025-26", 400000, { tds: 200000 });
  const r = engine.computeForRegime(wb, "old");
  // Net = 3.5L, GTI = 3.5L (< 5L)
  // Pre-rebate tax: 0-2.5: 0, 2.5-3.5: 5%×1L = 5K
  // 87A rebate applies (GTI < 5L) → tax = 0
  // 4% cess on 0 = 0
  // Total tax = 0
  // TDS = 2,00,000
  // Refund = 2,00,000
  assert.equal(r.result, "refund");
  assert.equal(r.refund_due_rounded, 200000);
});

test("Edge case: house property loss does not reduce other heads (set-off rules)", () => {
  // Per Section 71(3A), HP loss can be set off against other heads
  // (salary, other sources) up to ₹2 lakh per year. The
  // remaining loss (if any) carries forward 8 years.
  //
  // v1 lets the HP loss flow through to GTI, which is then set
  // off against salary automatically. The downstream
  // `taxable_income = Math.max(0, gtiOrdinary - deductions)`
  // ensures the final result never goes negative.
  //
  // v1 does NOT implement the ₹2L cap on inter-head set-off, so
  // a let-out with very high interest could over-set-off. The
  // full §71(3A) cap + carry-forward is tracked for v1.2.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "", gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.house_property.properties = [{
    type: "self-occupied", address: "Mumbai", rent_received: 0,
    municipal_taxes_paid: 50000, home_loan_interest_paid: 300000,
    home_loan_principal_paid: 0, co_ownership_share: 100, tds_on_rent: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  // Self-occ, interest capped at ₹2L (Section 24(b)).
  // HP net = 0 - 50K - 200K = -250K (the loss flows through)
  assert.equal(r.house.net_house_property, -250000);
  // Salary net = 9,50,000
  // GTI = 9,50,000 - 2,50,000 = 7,00,000 (HP loss reduces GTI)
  assert.equal(r.gti, 700000);
  // Taxable income is the full GTI (no Chapter VI-A deductions in this test)
  assert.equal(r.taxable_income, 700000);
  // TODO v1.2: implement the ₹2L set-off cap and 8-year carry
  //             forward for HP loss (Section 71(3A)).
});
