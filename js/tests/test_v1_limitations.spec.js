// js/tests/test_v1_limitations.spec.js
// Tests for the v1 limitations fixed after the initial 7-suite release.
//
// What was fixed (2026-07-21):
//   1. Capital gains are NO LONGER folded into the slab tax / GTI
//      for slab / rebate / surcharge / cess math. They are now
//      computed separately on Schedule CG (Section 111A at 15% flat,
//      Section 112A at 10% above ₹1L exemption, Section 112 at 20%
//      with indexation), and ADDED to the tax before surcharge.
//      The 87A rebate applies ONLY to the slab-tax portion, not to
//      the schedule CG tax (this is the actual IT Act treatment).
//
//   2. 234B and 234C interest on advance-tax shortfalls is now
//      computed. 234A (late filing) is out of scope. The interest
//      is NOT added to `total_tax_liability` (it's reported
//      separately in the ITR computation schedule as "Interest
//      payable"). It's available in the result as `interest_234`.
//
//   3. Per-year STCL/LTCL buckets with 8-year expiry: the workbook
//      gains `stcl_buckets` and `ltcl_buckets` arrays. When present,
//      the engine filters out buckets whose 8-year window has
//      expired (relative to the workbook's AY). When absent, the
//      engine falls back to the lump-sum `stcl_brought_forward` /
//      `ltcl_brought_forward` fields (backward compatible).

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const engine = require("../tax_engine.js");

// ============================================================
// Schedule CG tax (separate from slab tax)
// ============================================================

test("Section 111A: ₹1.5L STCG → ₹22,500 tax at flat 15%, even with low ordinary income", () => {
  // The famous Benchmark 13: this is the v1 limitation fix.
  // Previously the engine folded STCG into GTI; with GTI=1.5L and
  // 87A rebate (≤5L), tax was 0. Now STCG is taxed at 15% flat
  // and the rebate does NOT apply to it.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 150000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.gti, 150000);
  // Slab tax on ordinary income (0) = 0
  assert.equal(r.pre_rebate_tax, 0);
  // Schedule CG tax: 1.5L × 15% = 22,500
  assert.equal(r.schedule_cg.stcg_111a_tax, 22500);
  // 4% cess = 900, total = 22,500 + 900 = 23,400
  assert.equal(r.cess, 900);
  assert.equal(r.total_tax_rounded, 23400);
});

test("Section 112A: ₹2L LTCG → ₹10,000 tax at 10% above ₹1L exemption", () => {
  // Benchmark 12: also fixed. Previously GTI=1L, 87A made it 0.
  // Now: 1L (post-exemption) × 10% = 10,000.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 200000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.gti, 100000);                 // 2L - 1L exemption
  assert.equal(r.pre_rebate_tax, 0);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 10000);
  // 4% cess = 400, total = 10,000 + 400 = 10,400
  assert.equal(r.cess, 400);
  assert.equal(r.total_tax_rounded, 10400);
});

test("Section 112A: ₹80K LTCG fully exempt (below ₹1L threshold)", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 80000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.gti, 0);
  assert.equal(r.schedule_cg.ltcg_112a_taxable, 0);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 0);
  assert.equal(r.total_tax_rounded, 0);
});

test("Schedule CG: combined STCG + LTCG taxed independently", () => {
  // 1L STCG 111A + 3L LTCG 112A → 1L*15% + 2L*10% = 15K + 20K = 35K
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.ltcg_112a = 300000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.schedule_cg.stcg_111a_tax, 15000);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 20000);
  // Total schedule CG tax = 35K, no surcharge (GTI = 3L < 50L)
  assert.equal(r.schedule_cg.total_schedule_cg_tax, 35000);
  assert.equal(r.surcharge, 0);
  assert.equal(r.cess, 1400);                  // 4% × 35K
  assert.equal(r.total_tax_rounded, 36400);
});

test("Schedule CG: STCL brought forward reduces STCG 111A first", () => {
  // 1L STCG 111A + 50K STCL brought forward → 50K STCG taxable × 15% = 7,500
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_brought_forward = 50000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.cg.stcl_used, 50000);
  assert.equal(r.schedule_cg.stcg_111a_taxable, 50000);
  assert.equal(r.schedule_cg.stcg_111a_tax, 7500);
  // 4% cess = 300, total = 7,500 + 300 = 7,800
  assert.equal(r.cess, 300);
  assert.equal(r.total_tax_rounded, 7800);
});

test("Schedule CG: LTCL reduces LTCG 112A first", () => {
  // 3L LTCG 112A + 1L LTCL → 2L LTCG post-CF → 1L taxable (post-1L exemption) × 10% = 10K
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 300000;
  wb.capital_gains.ltcl_brought_forward = 100000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.cg.ltcl_used, 100000);
  // 3L - 1L LTCL = 2L; 2L - 1L exemption = 1L taxable
  assert.equal(r.schedule_cg.ltcg_112a_taxable, 100000);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 10000);
  // 4% cess = 400, total = 10,000 + 400 = 10,400
  assert.equal(r.cess, 400);
  assert.equal(r.total_tax_rounded, 10400);
});

test("Schedule CG: other LTCG (Section 112) at 20%", () => {
  // 5L other LTCG → 5L × 20% = 1L
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_other = 500000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.schedule_cg.ltcg_other_tax, 100000);
  // 4% cess = 4,000, total = 1,00,000 + 4,000 = 1,04,000
  assert.equal(r.cess, 4000);
  assert.equal(r.total_tax_rounded, 104000);
});

test("Schedule CG: surcharge applies to (slab + schedule CG) tax", () => {
  // 1Cr LTCG 112A → 99L taxable × 10% = 9.9L schedule CG tax
  // GTI = 99L → surcharge 10% bracket applies
  // Total tax before surcharge: 9.9L (no salary, no deductions)
  // Surcharge: 10% × 9.9L = 99K
  // Cess: 4% × (9.9L + 99K) = 4.0K+3.96K = 39,960
  // Total: 9,90000 + 99000 + 39960 = 10,38,960
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 10000000;        // 1Cr
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.gti, 9900000);                  // 1Cr - 1L exemption
  assert.equal(r.schedule_cg.ltcg_112a_tax, 990000);
  // Surcharge rate: 10% (50L < GTI=99L ≤ 1Cr)
  assert.equal(r.surcharge_rate, 0.10);
  assert.equal(r.surcharge, 99000);
  assert.equal(r.cess, 43560);                   // 4% × (990000 + 99000)
  // Total: 990000 + 99000 + 43560 = 11,32,560
  assert.equal(r.total_tax_rounded, 1132560);
});

test("Schedule CG: 87A rebate does NOT zero out schedule CG tax", () => {
  // Use 4.5L salary (GTI ordinary = 4.5L) + 2L LTCG 112A (1L
  // post-exemption). GTI = 5.5L, just above the 5L 87A threshold,
  // so 87A does NOT apply. But the slab tax (10K) is on ordinary
  // income only, and schedule CG tax (10K) is on LTCG, and they
  // are SEPARATE. Pre-fix: the engine folded CG into GTI, and the
  // GTI was 5.5L > 5L, so no rebate — but the test was designed
  // to demonstrate the separate treatment. Now the schedule CG
  // tax is 10K regardless of 87A applicability.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 500000,                        // 5L - 50K std = 4.5L
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 200000;
  const r = engine.computeForRegime(wb, "old");
  // GTI = 4.5L + 1L (LTCG post-exemption) = 5.5L
  assert.equal(r.gti, 550000);
  // Pre-rebate tax on ordinary 4.5L: 5% × 2L = 10,000
  assert.equal(r.pre_rebate_tax, 10000);
  // 87A: GTI 5.5L > 5L threshold → no rebate
  assert.equal(r.rebate_87a, 0);
  assert.equal(r.tax_after_rebate, 10000);
  // Schedule CG tax: 1L × 10% = 10,000
  assert.equal(r.schedule_cg.ltcg_112a_tax, 10000);
  // 4% cess on (10K + 10K) = 800
  assert.equal(r.cess, 800);
  assert.equal(r.total_tax_rounded, 20800);
});

test("Schedule CG: 87A does NOT rebate schedule CG tax even when GTI is below 5L", () => {
  // 4L salary (3.5L net) + 1.5L LTCG 112A (50K taxable).
  // GTI = 3.5L + 50K = 4L < 5L → 87A applies to the slab tax
  // (which is 5K), reducing it to 0. But the schedule CG tax of
  // 5K is NOT rebated (87A only applies to ordinary income).
  // Pre-fix: everything was in GTI, 87A zeroed the total. Now
  // 87A zeros only the slab tax; schedule CG tax is preserved.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 400000,                        // 4L - 50K = 3.5L
    allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 150000;           // 50K post-exemption
  const r = engine.computeForRegime(wb, "old");
  // GTI = 3.5L + 50K = 4L
  assert.equal(r.gti, 400000);
  // Pre-rebate slab tax: 5% × 1L (3.5L - 2.5L) = 5,000
  assert.equal(r.pre_rebate_tax, 5000);
  // 87A: GTI 4L ≤ 5L → rebate up to 12.5K; rebate 5K of slab tax
  assert.equal(r.rebate_87a, 5000);
  assert.equal(r.tax_after_rebate, 0);
  // Schedule CG tax: 50K × 10% = 5,000 (NOT rebated)
  assert.equal(r.schedule_cg.ltcg_112a_tax, 5000);
  // 4% cess on (0 + 5K) = 200
  assert.equal(r.cess, 200);
  assert.equal(r.total_tax_rounded, 5200);
});

test("computeScheduleCGTax: direct API call returns breakdown", () => {
  const cg = { stcg_111a: 100000, ltcg_112a: 200000 };
  const t = engine.computeScheduleCGTax(cg);
  assert.equal(t.stcg_111a_tax, 15000);
  assert.equal(t.ltcg_112a_tax, 10000);          // 1L taxable × 10%
  assert.equal(t.total_schedule_cg_tax, 25000);
});

// ============================================================
// Section 234B / 234C interest
// ============================================================

test("234B: zero interest when advance + TDS covers the tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 1500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // TDS exactly covers the tax (15L - 50K std = 14.5L GTI;
  // tax ≈ 2,82,500; user pays 3L TDS, so surplus, no 234B).
  wb.salary.tds_total = 300000;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.interest_234.section_234b.interest, 0);
  assert.equal(r.interest_234.total_234, 0);
});

test("234B: 1% per month interest when TDS falls short of tax by >₹10K", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 2000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // TDS = 1L; tax will be around 4.5L. Shortfall ~3.5L > 10K.
  // 234B = 1% × 3.5L × 12 months = 42,000
  wb.salary.tds_total = 100000;
  const r = engine.computeForRegime(wb, "old");
  // Total tax should be substantial. 19.5L GTI:
  //   0-2.5L: 0, 2.5-5L: 12.5K, 5-10L: 100K, 10-19.5L: 30%*9.5L = 285K
  //   = 397,500 + 4% cess = 413,400
  assert.ok(r.total_tax_liability > 400000, `tax should be > 4L, got ${r.total_tax_liability}`);
  // 234B shortfall = 413400 - 100000 = 313400
  // Interest = 1% × 313400 × 12 = 37,608
  assert.equal(r.interest_234.section_234b.shortfall, 313400);
  assert.equal(r.interest_234.section_234b.months, 12);
  assert.equal(r.interest_234.section_234b.interest, 37608);
});

test("234B: no interest when shortfall < ₹10K", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 100000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // 1L salary: 50K net salary; no tax. 234B: no shortfall.
  wb.salary.tds_total = 0;
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.interest_234.section_234b.interest, 0);
});

test("234C: per-installment interest on advance-tax shortfalls", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 2000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // No TDS, no advance tax → all 4 installments short.
  // Tax ~4.13L. Each installment is 15/45/75/100% of (tax - TDS - TCS).
  // Without any payments, every installment is short.
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.interest_234.section_234c.per_installment.length, 4);
  // Each installment has a non-zero interest (because no payments)
  for (const inst of r.interest_234.section_234c.per_installment) {
    assert.ok(inst.interest > 0, `installment ${inst.installment} should have interest > 0`);
  }
  assert.ok(r.interest_234.section_234c.total > 0);
});

test("234: interest_234 not included in total_tax_liability", () => {
  // Critical: 234B/234C interest is reported separately, not added
  // to the main tax figure. The IT portal collects it via the
  // "Int. payable u/s 234" line in Schedule IT, not Schedule SI.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 2000000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.salary.tds_total = 0;
  const r = engine.computeForRegime(wb, "old");
  // Even though 234 interest is non-zero, total_tax_liability
  // should be the basic tax + cess only.
  const expectedTaxLiab = r.tax_after_rebate + r.schedule_cg.total_schedule_cg_tax
                        + r.surcharge + r.cess + r.lottery_tax;
  assert.equal(r.total_tax_liability, expectedTaxLiab);
});

// ============================================================
// Per-year STCL/LTCL buckets with 8-year expiry
// ============================================================

test("STCL buckets: eligible bucket contributes to brought-forward", () => {
  // Bucket from FY 2022-23 (5 years ago) → AY 2025-26 should
  // still be eligible (within 8-year window).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2022-23", amount: 50000 },
  ];
  const r = engine.computeForRegime(wb, "old");
  // 50K STCL absorbs 50K of STCG → 50K taxable STCG × 15% = 7,500
  assert.equal(r.cg.stcl_used, 50000);
  assert.equal(r.schedule_cg.stcg_111a_taxable, 50000);
  assert.equal(r.schedule_cg.stcg_111a_tax, 7500);
  // 4% cess = 300, total = 7,500 + 300 = 7,800
  assert.equal(r.cess, 300);
  assert.equal(r.total_tax_rounded, 7800);
});

test("STCL buckets: 8-year-expired bucket is excluded", () => {
  // Bucket from FY 2015-16 (10 years ago in AY 2025-26) → expired.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2015-16", amount: 50000 },           // expired (>8y)
  ];
  const r = engine.computeForRegime(wb, "old");
  // No STCL usable → 1L STCG fully taxable × 15% = 15,000
  assert.equal(r.cg.stcl_used, 0);
  assert.equal(r.schedule_cg.stcg_111a_tax, 15000);
  // 4% cess = 600, total = 15,000 + 600 = 15,600
  assert.equal(r.cess, 600);
  assert.equal(r.total_tax_rounded, 15600);
});

test("STCL buckets: mix of eligible and expired buckets", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 200000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2010-11", amount: 100000 },          // expired (>8y)
    { fy: "2020-21", amount: 50000 },           // eligible (5y old)
  ];
  const r = engine.computeForRegime(wb, "old");
  // Only 50K eligible. 2L - 50K = 1.5L STCG × 15% = 22,500
  assert.equal(r.cg.stcl_used, 50000);
  assert.equal(r.schedule_cg.stcg_111a_taxable, 150000);
  assert.equal(r.schedule_cg.stcg_111a_tax, 22500);
});

test("STCL buckets: 8-year boundary (inclusive)", () => {
  // Bucket exactly 8 years old: fy 2017-18, AY 2025-26.
  // 2017-18 fy ends 2018-03. AY 2025-26 spans 2025-04 to 2026-03.
  // Per Finance Act, the bucket is set-off-eligible from the AY
  // IMMEDIATELY after the loss AY, for 8 AYs. So:
  //   Loss AY 2017-18 → set-off AY: 2018-19, 2019-20, ..., 2025-26
  //   (8 AYs total, inclusive).
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2017-18", amount: 50000 },           // exactly 8 AYs ago
  ];
  const r = engine.computeForRegime(wb, "old");
  // Should still be eligible
  assert.equal(r.cg.stcl_used, 50000);
});

test("STCL buckets: one past the boundary (expired)", () => {
  // Bucket 9 years old: fy 2016-17. AY 2025-26 is the 9th AY
  // after the loss AY → expired.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_buckets = [
    { fy: "2016-17", amount: 50000 },
  ];
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.cg.stcl_used, 0);
  assert.equal(r.schedule_cg.stcg_111a_tax, 15000);
});

test("STCL buckets: empty buckets falls back to lump-sum field", () => {
  // Backward compat: if stcl_buckets is empty but stcl_brought_forward
  // is set, the engine should still use the lump-sum value.
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.stcg_111a = 100000;
  wb.capital_gains.stcl_brought_forward = 50000;
  // stcl_buckets not set (undefined)
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.cg.stcl_used, 50000);
  assert.equal(r.schedule_cg.stcg_111a_tax, 7500);
});

test("LTCL buckets: works the same way as STCL", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  wb.capital_gains.ltcg_112a = 500000;          // 4L post-exemption
  wb.capital_gains.ltcl_buckets = [
    { fy: "2014-15", amount: 100000 },          // expired
    { fy: "2021-22", amount: 50000 },           // eligible
  ];
  const r = engine.computeForRegime(wb, "old");
  // Only 50K LTCL eligible. 5L - 50K = 4.5L → 3.5L post-exemption
  // → 3.5L × 10% = 35,000
  assert.equal(r.cg.ltcl_used, 50000);
  assert.equal(r.schedule_cg.ltcg_112a_taxable, 350000);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 35000);
});

test("effectiveBroughtForwardLosses: helper returns correct totals", () => {
  const cg = {
    stcl_buckets: [
      { fy: "2014-15", amount: 10000 },
      { fy: "2020-21", amount: 20000 },
      { fy: "2023-24", amount: 30000 },
    ],
    ltcl_buckets: [
      { fy: "2022-23", amount: 40000 },
    ],
  };
  const r = engine.effectiveBroughtForwardLosses(cg, "2025-26");
  // 2014-15 expired; 2020-21, 2023-24 eligible → 50K STCL
  assert.equal(r.stcl, 50000);
  assert.equal(r.ltcl, 40000);
  assert.equal(r.eligible, true);
});

test("effectiveBroughtForwardLosses: all-expired → eligible=false", () => {
  const cg = {
    stcl_buckets: [{ fy: "2010-11", amount: 10000 }],
  };
  const r = engine.effectiveBroughtForwardLosses(cg, "2025-26");
  assert.equal(r.stcl, 0);
  assert.equal(r.eligible, false);
});

// ============================================================
// AY 2024-25 (FY 2023-24) interaction
// ============================================================

test("AY 2024-25: schedule CG tax uses AY-specific slab? No — same 10/15/20% rates", () => {
  // Capital gains tax rates are regime-INDEPENDENT. Only the slab
  // structure and 87A threshold differ between AYs. So schedule
  // CG tax on the same numbers should be the same in AY 2024-25
  // and AY 2025-26.
  const wb1 = dm.emptyWorkbook("2025-26");
  const wb2 = dm.emptyWorkbook("2024-25");
  for (const wb of [wb1, wb2]) {
    wb.salary.employers = [{
      employer_name: "Acme", tan: "",
      gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
    }];
    wb.capital_gains.ltcg_112a = 200000;
  }
  const r1 = engine.computeForRegime(wb1, "old");
  const r2 = engine.computeForRegime(wb2, "old");
  assert.equal(r1.schedule_cg.ltcg_112a_tax, r2.schedule_cg.ltcg_112a_tax);
  assert.equal(r1.schedule_cg.ltcg_112a_tax, 10000);
});

// ============================================================
// Edge cases
// ============================================================

test("Schedule CG: empty workbook → 0 schedule CG tax", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 500000, allowances_exempt_10: 0, professional_tax: 0,
  }];
  const r = engine.computeForRegime(wb, "old");
  assert.equal(r.schedule_cg.stcg_111a_tax, 0);
  assert.equal(r.schedule_cg.ltcg_112a_tax, 0);
  assert.equal(r.schedule_cg.ltcg_other_tax, 0);
  assert.equal(r.schedule_cg.total_schedule_cg_tax, 0);
});

test("Schedule CG: negative net STCG (loss) → 0 tax on that head", () => {
  // 1L loss + 50K STCG 111A = net -50K (loss carryover, not tax-deductible this year)
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{
    employer_name: "Acme", tan: "",
    gross_salary: 0, allowances_exempt_10: 0, professional_tax: 0,
  }];
  // Negative STCG = user types -100K; we don't allow that on input
  // (validation rejects negative). So this test verifies the engine
  // handles the situation via set-off: if LTCL is large enough to
  // push STCG below zero, the engine clamps to 0.
  wb.capital_gains.stcg_111a = 50000;
  wb.capital_gains.ltcl_brought_forward = 100000;  // LTCL > STCG
  const r = engine.computeForRegime(wb, "old");
  // LTCL 1L: 50K absorbs STCG, 50K remaining → can absorb LTCG
  // (which is 0 here, so the remaining 50K just sits unused)
  assert.equal(r.schedule_cg.stcg_111a_taxable, 0);
  assert.equal(r.schedule_cg.stcg_111a_tax, 0);
});
