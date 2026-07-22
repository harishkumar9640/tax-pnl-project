// js/tax_engine.js
// Indian income-tax computation engine for AY 2025-26 (FY 2024-25)
// and AY 2024-25 (FY 2023-24).
//
// What this module does:
//   - Takes a workbook (see data_model.js) and returns the full tax
//     computation: gross total income, deductions, taxable income,
//     slab-wise tax, rebate u/s 87A, surcharge, 4% H&E cess, and the
//     final tax payable / refund due.
//   - Computes BOTH the old regime (default 1961 IT Act slabs) and
//     the new regime (Section 115BAC, post-Finance-Act-2020).
//   - Applies the standard deduction (auto for new regime, opt-in
//     for old).
//   - Applies the ₹1,00,000 LTCG exemption (Section 112A) before
//     computing the 10% LTCG tax.
//   - Sets off STCL against STCG, then STCL against LTCG (per
//     Section 70 read with the proviso to Section 10(38)).
//   - Applies rebate u/s 87A: full rebate up to ₹5L (old) / ₹7L
//     (new) of total income.
//   - Applies marginal relief on surcharge (Section 89 read with
//     the Finance Act): for incomes just above a surcharge threshold
//     (₹50L, ₹1Cr, ₹2Cr, ₹5Cr), the surcharge is reduced so that
//     total tax (slab + surcharge + cess) does not exceed the
//     tax at the threshold + the income above the threshold.
//
// What this module does NOT do (yet):
//   - Business income (ITR-3/4) — not in v1
//   - Foreign income (Schedule FSI / FA) — not in v1
//   - Crypto / VDA — not in v1
//   - Tax on accumulated balance in recognised provident fund
//     (Section 111A proviso) — not in v1
//   - Schedule CG line-by-line for each scrip (uses aggregate
//     numbers from the workbook; the user imports from the
//     static app or types the totals in).

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxEngine = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // IT-Act constants — single source of truth
  // ============================================================
  //
  // Every number in this engine is a value defined by the Indian
  // Income-tax Act, 1961 (as amended by the Finance Act). These
  // are NOT implementation choices — they are the law. They are
  // declared once here, named by the section / purpose they
  // implement, and referenced from every other place in the
  // engine.
  //
  // When a Finance Act amendment changes a value, ONLY this
  // block needs to change. Slab schedules, caps, and rates
  // below reference these constants via the `*_REGIME_*`
  // objects.
  //
  // References to the Act are inline (e.g. "Section 80C",
  // "Section 112A(2)") so a CA can verify each value.
  // ============================================================

  // --- Slab boundaries (rounded rupee amounts) ---
  // Old regime slabs (default 1961 IT Act)
  const OLD_REGIME_SLAB_0_END     = 250000;     // 0 - 2.5L: 0%
  const OLD_REGIME_SLAB_1_END     = 500000;     // 2.5L - 5L: 5%
  const OLD_REGIME_SLAB_2_END     = 1000000;    // 5L - 10L: 20%
  // 10L+: 30% (no upper bound; surplus continues at 30%)

  // New regime slabs (Section 115BAC, post Finance Act 2024)
  const NEW_REGIME_SLAB_0_END     = 300000;     // 0 - 3L: 0%
  const NEW_REGIME_SLAB_1_END     = 700000;     // 3L - 7L: 5%
  const NEW_REGIME_SLAB_2_END     = 1000000;    // 7L - 10L: 10%
  const NEW_REGIME_SLAB_3_END     = 1200000;    // 10L - 12L: 15%
  const NEW_REGIME_SLAB_4_END     = 1500000;    // 12L - 15L: 20%
  // 15L+: 30%

  // --- Slab rates ---
  const RATE_ZERO    = 0.00;
  const RATE_5PCT    = 0.05;
  const RATE_10PCT   = 0.10;
  const RATE_15PCT   = 0.15;
  const RATE_20PCT   = 0.20;
  const RATE_25PCT   = 0.25;
  const RATE_30PCT   = 0.30;
  const RATE_37PCT   = 0.37;   // Special surcharge bracket (old regime only)

  // --- Standard deduction (Section 16(ia)) ---
  const STD_DEDUCTION_OLD_REGIME          = 50000;     // Old regime
  const STD_DEDUCTION_NEW_REGIME_FY_24_25 = 75000;     // New regime, FY 2024-25 onwards
  const STD_DEDUCTION_NEW_REGIME_FY_23_24 = 50000;     // New regime, FY 2023-24

  // --- Rebate u/s 87A ---
  const REBATE_87A_THRESHOLD_OLD_REGIME          = 500000;   // tax=0 if total income ≤ ₹5L
  const REBATE_87A_MAX_TAX_OLD_REGIME            = 12500;    // max rebate (= 5% × 2.5L)
  const REBATE_87A_THRESHOLD_NEW_REGIME          = 700000;   // tax=0 if total income ≤ ₹7L
  const REBATE_87A_MAX_TAX_NEW_REGIME            = 25000;    // max rebate (= 5% × 5L - 5% × 3L)

  // --- Surcharge brackets (Section 68 of Finance Act, etc.) ---
  // Lower / upper bounds apply to TOTAL income. Rate applies to tax.
  const SURCHARGE_LOWER_50L  = 5000000;     // ₹50L
  const SURCHARGE_LOWER_1CR  = 10000000;    // ₹1Cr
  const SURCHARGE_LOWER_2CR  = 20000000;    // ₹2Cr
  const SURCHARGE_LOWER_5CR  = 50000000;    // ₹5Cr
  // Surcharge rates by bracket (applied on tax)
  //   0 - 50L: 0% (implicit; no surcharge)
  //   50L - 1Cr: 10%
  //   1Cr - 2Cr: 15%
  //   2Cr - 5Cr: 25%
  //   > 5Cr: 25% in new regime, 37% in old regime (when not a
  //          "capital gains dominated" taxpayer)
  const SURCHARGE_RATE_BELOW_1CR      = 0.10;
  const SURCHARGE_RATE_BELOW_2CR      = 0.15;
  const SURCHARGE_RATE_BELOW_5CR      = 0.25;
  const SURCHARGE_RATE_ABOVE_5CR_OLD  = 0.37;
  const SURCHARGE_RATE_ABOVE_5CR_NEW  = 0.25;  // capped at 25% in new regime

  // --- Health & Education Cess (Section 4) ---
  const HEC_CESS_RATE = 0.04;   // 4% on (tax + surcharge)

  // --- Capital gains rates (Section 111A, 112, 112A) ---
  const STCG_111A_RATE    = 0.15;   // Section 111A: STCG on listed equity w/ STT
  const LTCG_112A_RATE    = 0.10;   // Section 112A: LTCG on listed equity w/ STT
  const LTCG_OTHER_RATE   = 0.20;   // Section 112: other LTCG (with indexation)

  // --- Capital gains exemption (Section 112A(2)) ---
  const LTCG_112A_EXEMPTION = 100000;  // ₹1L exemption on 112A LTCG

  // --- Lottery / crossword (Section 115BBH) ---
  const LOTTERY_RATE = 0.30;   // flat 30% on lottery / crossword / etc.

  // --- House property (Section 22-25) ---
  const HP_SELF_OCCUPIED_INTEREST_CAP = 200000;   // Section 24(b): max ₹2L for self-occ
  const HP_LET_OUT_STD_DEDUCTION_PCT  = 0.30;     // Section 24(a): 30% of NAV
  const HP_FULL_OWNERSHIP_PCT         = 100;      // default co-ownership = 100%

  // --- Chapter VI-A deduction caps ---
  const CAP_80C                  = 150000;   // Section 80C
  const CAP_80CCD_1B             = 50000;    // Section 80CCD(1B): NPS additional
  // 80D caps: ₹25K for non-senior, ₹50K for senior (60+).
  // Per Section 80D, the cap doubles when the insured is a senior
  // citizen. v1 derives "senior" from the profile's DOB. v1 does
  // NOT track per-person age for the parents bucket; the user
  // should toggle the senior flag to reflect the oldest insured
  // person in each bucket.
  const CAP_80D_SELF_FAMILY      = 25000;    // Section 80D self/family
  const CAP_80D_SELF_FAMILY_SENIOR = 50000;  // §80D doubles for seniors
  const CAP_80D_PARENTS          = 25000;    // Section 80D parents
  const CAP_80D_PARENTS_SENIOR   = 50000;    // §80D doubles for seniors
  // 80CCD(2): no cap (employer NPS)
  // 80E: no cap (education loan)
  // 80G: depends on donee; we sum the two sub-fields
  // 80TTA: non-senior savings interest (₹10K). For seniors, 80TTB
  // applies (₹50K) and 80TTA does not.
  // 80TTB: senior-only interest deduction (Section 80TTB).
  const CAP_80TTA                = 10000;    // §80TTA: non-senior savings int
  const CAP_80TTB                = 50000;    // §80TTB: senior interest
  // Age threshold for senior-citizen status under §80D, §80TTB.
  // Per Section 80D / 80TTB: 60 years and above.
  const SENIOR_CITIZEN_AGE       = 60;

  // --- STCL / LTCL 8-year expiry (Section 71) ---
  const LOSS_CARRY_FORWARD_YEARS = 8;        // Section 71: 8 AYs from loss AY

  // --- Section 234B / 234C (interest on advance-tax defaults) ---
  const SEC_234B_RATE_PER_MONTH     = 0.01;   // 1% per month
  const SEC_234B_THRESHOLD          = 10000;  // ₹10K — no interest below this
  const SEC_234B_MONTHS             = 12;     // v1 conservative (Apr → Mar of AY)
  const SEC_234C_RATE_PER_MONTH     = 0.01;   // 1% per month
  // 234C cumulative thresholds (% of assessed tax minus TDS/TCS)
  const SEC_234C_THRESHOLD_Q1       = 0.15;   // 15-Jun: 15%
  const SEC_234C_THRESHOLD_Q2       = 0.45;   // 15-Sep: 45%
  const SEC_234C_THRESHOLD_Q3       = 0.75;   // 15-Dec: 75%
  const SEC_234C_THRESHOLD_Q4       = 1.00;   // 15-Mar: 100%
  // 234C interest periods (months)
  const SEC_234C_MONTHS_Q1          = 3;      // 15-Jun → 15-Sep = 3 months
  const SEC_234C_MONTHS_Q2          = 3;      // 15-Sep → 15-Dec
  const SEC_234C_MONTHS_Q3          = 3;      // 15-Dec → 15-Mar
  const SEC_234C_MONTHS_Q4          = 1;      // 15-Mar → filing

  // --- ITR-1 / ITR-2 selector thresholds (adapters.js) ---
  const ITR1_TOTAL_INCOME_MAX = 5000000;   // ITR-1 upper limit: ₹50L
  const ITR1_MAX_HP_PROPERTIES = 1;        // ITR-1: 1 house property

  // --- Form 16 sanity check (integrations.js) ---
  const FORM16_GROSS_SALARY_SANITY_MAX = 100000000;  // ₹10Cr — flag if higher

  // --- Supported AYs ---
  const AY_2025_26 = "2025-26";
  const AY_2024_25 = "2024-25";
  const FY_FOR_AY = { [AY_2025_26]: "2024-25", [AY_2024_25]: "2023-24" };
  // 4-digit ITR assessment year code (e.g. "2025-26" → "2025")
  const AY_TO_ITR_AY = { [AY_2025_26]: "2025", [AY_2024_25]: "2024" };

  // ============================================================
  // Slab schedules — assembled from the constants above
  // ============================================================
  // (The actual slab/cess/rebate/surcharge config objects are built
  //  from these constants further below in `getRegimeConfigs`.)

  // AY 2025-26 (FY 2024-25) — old regime
  // Rebate u/s 87A makes tax nil for income up to ₹5,00,000.
  const OLD_REGIME_2024_25 = {
    label: "Old regime (default)",
    slabs: [
      { upto: OLD_REGIME_SLAB_0_END, rate: RATE_ZERO },
      { upto: OLD_REGIME_SLAB_1_END, rate: RATE_5PCT },
      { upto: OLD_REGIME_SLAB_2_END, rate: RATE_20PCT },
      { upto: Infinity,              rate: RATE_30PCT },
    ],
    standard_deduction: STD_DEDUCTION_OLD_REGIME,        // Section 16(ia)
    rebate_87a_max_income: REBATE_87A_THRESHOLD_OLD_REGIME,
    rebate_87a_max_tax: REBATE_87A_MAX_TAX_OLD_REGIME,
    surcharge: {
      // Brackets apply to total income. Rate applies to tax.
      brackets: [
        { lower: 0,                 upper: SURCHARGE_LOWER_50L, rate: RATE_ZERO  },
        { lower: SURCHARGE_LOWER_50L, upper: SURCHARGE_LOWER_1CR, rate: SURCHARGE_RATE_BELOW_1CR },
        { lower: SURCHARGE_LOWER_1CR, upper: SURCHARGE_LOWER_2CR, rate: SURCHARGE_RATE_BELOW_2CR },
        { lower: SURCHARGE_LOWER_2CR, upper: SURCHARGE_LOWER_5CR, rate: SURCHARGE_RATE_BELOW_5CR },
        { lower: SURCHARGE_LOWER_5CR, upper: Infinity,           rate: SURCHARGE_RATE_ABOVE_5CR_OLD, note: "37% if income > ₹5 Cr" },
      ],
    },
    cess_rate: HEC_CESS_RATE,         // 4% Health & Education Cess
  };

  // AY 2025-26 (FY 2024-25) — new regime (Section 115BAC)
  // 6-slab structure post Finance Act 2024 (effective FY 2024-25).
  const NEW_REGIME_2024_25 = {
    label: "New regime (Section 115BAC)",
    slabs: [
      { upto: NEW_REGIME_SLAB_0_END, rate: RATE_ZERO },
      { upto: NEW_REGIME_SLAB_1_END, rate: RATE_5PCT },
      { upto: NEW_REGIME_SLAB_2_END, rate: RATE_10PCT },
      { upto: NEW_REGIME_SLAB_3_END, rate: RATE_15PCT },
      { upto: NEW_REGIME_SLAB_4_END, rate: RATE_20PCT },
      { upto: Infinity,              rate: RATE_30PCT },
    ],
    standard_deduction: STD_DEDUCTION_NEW_REGIME_FY_24_25,
    rebate_87a_max_income: REBATE_87A_THRESHOLD_NEW_REGIME,
    rebate_87a_max_tax: REBATE_87A_MAX_TAX_NEW_REGIME,
    surcharge: {
      brackets: [
        { lower: 0,                 upper: SURCHARGE_LOWER_50L, rate: RATE_ZERO  },
        { lower: SURCHARGE_LOWER_50L, upper: SURCHARGE_LOWER_1CR, rate: SURCHARGE_RATE_BELOW_1CR },
        { lower: SURCHARGE_LOWER_1CR, upper: SURCHARGE_LOWER_2CR, rate: SURCHARGE_RATE_BELOW_2CR },
        { lower: SURCHARGE_LOWER_2CR, upper: SURCHARGE_LOWER_5CR, rate: SURCHARGE_RATE_BELOW_5CR },
        { lower: SURCHARGE_LOWER_5CR, upper: Infinity,           rate: SURCHARGE_RATE_ABOVE_5CR_NEW, note: "Capped at 25% in new regime" },
      ],
    },
    cess_rate: HEC_CESS_RATE,
  };

  // AY 2024-25 (FY 2023-24) — new regime, FY 2023-24 (different
  // standard deduction than FY 2024-25; same slab structure as
  // Section 115BAC post-2024). Finance Act 2023 made the new
  // regime the default for salaried individuals.
  const NEW_REGIME_2023_24 = {
    label: "New regime (Section 115BAC)",
    slabs: NEW_REGIME_2024_25.slabs,   // same slab structure
    standard_deduction: STD_DEDUCTION_NEW_REGIME_FY_23_24,
    rebate_87a_max_income: REBATE_87A_THRESHOLD_NEW_REGIME,
    rebate_87a_max_tax: REBATE_87A_MAX_TAX_NEW_REGIME,
    surcharge: NEW_REGIME_2024_25.surcharge,
    cess_rate: HEC_CESS_RATE,
  };

  /**
   * Return the regime configs that apply for a given AY.
   */
  function getRegimeConfigs(ay) {
    if (ay === AY_2025_26) {
      return { old: OLD_REGIME_2024_25, new: NEW_REGIME_2024_25 };
    }
    if (ay === AY_2024_25) {
      // For AY 2024-25, the new regime was the default. We still
      // let the user see the old regime comparison.
      return { old: OLD_REGIME_2024_25, new: NEW_REGIME_2023_24 };
    }
    throw new Error(`No tax slabs defined for AY ${ay}`);
  }

  // ============================================================
  // Formatters
  // ============================================================

  function fmtRs(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return "₹0";
    const sign = n < 0 ? "-" : "";
    return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  /**
   * Derive senior-citizen status from a date of birth.
   * Returns true if the person is 60+ years old on AY start
   * (April 1 of the first year of the assessment year).
   * Per Section 80D / 80TTB: senior = 60 years or above.
   *
   * @param {string} dob  ISO YYYY-MM-DD (or null/empty)
   * @param {string} [ay] Assessment year like "2025-26". Defaults
   *   to the current date if not provided.
   * @returns {boolean}
   */
  function isSeniorCitizen(dob, ay) {
    if (!dob || typeof dob !== "string") return false;
    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return false;
    // AY 2025-26 → reference date is April 1, 2025.
    // AY 2024-25 → April 1, 2024. Etc.
    let refYear;
    if (ay && typeof ay === "string") {
      const m = ay.match(/^(\d{4})/);
      refYear = m ? parseInt(m[1], 10) : new Date().getFullYear();
    } else {
      refYear = new Date().getFullYear();
    }
    const refDate = new Date(refYear, 3, 1);   // April 1 of the AY start year
    let age = refDate.getFullYear() - birth.getFullYear();
    const monthDiff = refDate.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && refDate.getDate() < birth.getDate())) {
      age -= 1;
    }
    return age >= SENIOR_CITIZEN_AGE;
  }

  /**
   * Derive senior-citizen status from a profile object (which
   * has a `dob` field). Returns false if profile is null or
   * has no DOB.
   */
  function isProfileSenior(profile, ay) {
    if (!profile || !profile.dob) return false;
    return isSeniorCitizen(profile.dob, ay);
  }

  // ============================================================
  // Step 1: Compute gross total income by head
  // ============================================================

  /**
   * Salary head (Section 15-17).
   * Net salary = Gross - exempt u/s 10 - Standard Deduction
   *            - Professional Tax (deductible u/s 16(iii))
   * Note: HRA exemption is computed separately below because it
   * depends on rent paid + city type, which the workbook doesn't
   * currently collect. For v1 we trust the user to enter the
   * "allowances exempt u/s 10" total from their Form 16 Part B.
   */
  function computeNetSalary(salary, regime) {
    if (!salary.employers || salary.employers.length === 0) {
      return { net_salary: 0, gross_salary: 0, exempt_10: 0, std_deduction: 0, prof_tax: 0 };
    }
    let gross = 0, exempt = 0, profTax = 0;
    for (const e of salary.employers) {
      gross += +e.gross_salary || 0;
      exempt += +e.allowances_exempt_10 || 0;
      profTax += +e.professional_tax || 0;
    }
    // Standard deduction is the same for all employers combined
    const stdDed = regime.standard_deduction;
    const net = Math.max(0, gross - exempt - stdDed - profTax);
    return {
      gross_salary: gross,
      exempt_10: exempt,
      standard_deduction: stdDed,
      professional_tax: profTax,
      net_salary: net,
    };
  }

  /**
   * House Property head (Section 22-25).
   * For self-occupied: net annual value (NAV) = 0, only home loan
   *   interest under Section 24(b) is deductible, capped at ₹2L.
   * For let-out / deemed-let-out: NAV = rent received (or higher
   *   of municipal valuation, but for simplicity v1 uses rent
   *   received directly). Deductions: 30% standard deduction,
   *   municipal taxes paid, home loan interest.
   */
  function computeNetHouseProperty(hp) {
    if (!hp.properties || hp.properties.length === 0) {
      return { net_house_property: 0, total_rent: 0, total_municipal_taxes: 0, total_interest: 0 };
    }
    let totalIncome = 0, totalRent = 0, totalMunicipal = 0, totalInterest = 0;
    for (const p of hp.properties) {
      // Co-ownership share defaults to 100% (full ownership)
      const share = (+p.co_ownership_share || HP_FULL_OWNERSHIP_PCT) / 100;
      const rent = (+p.rent_received || 0) * share;
      const municipal = (+p.municipal_taxes_paid || 0) * share;
      const interest = (+p.home_loan_interest_paid || 0) * share;
      totalRent += rent;
      totalMunicipal += municipal;
      totalInterest += interest;
      if (p.type === "self-occupied") {
        // Section 24(b): NAV = 0, deduct interest up to ₹2L
        const deductibleInterest = Math.min(interest, HP_SELF_OCCUPIED_INTEREST_CAP);
        totalIncome += (0 - municipal - deductibleInterest);
      } else {
        // Let-out: Section 24(a) 30% std deduction + municipal + interest
        const std = rent * HP_LET_OUT_STD_DEDUCTION_PCT;
        totalIncome += (rent - std - municipal - interest);
      }
    }
    // IMPORTANT: do NOT clamp totalIncome at 0 here. Per Section 24(b)
    // and Section 71(3A) of the IT Act, a loss from house property
    // (e.g. home-loan interest on a self-occupied property) is
    // allowed to be set off against income from other heads
    // (salary, other sources) in the same year, up to ₹2 lakh per
    // year for self-occupied. Clamping the value to 0 here would
    // silently discard the most common tax break for salaried
    // people with home loans.
    //
    // The downstream `taxable_income = Math.max(0, gtiOrdinary - deductions)`
    // correctly floors the final result, so a negative GTI just
    // results in zero taxable income (and zero tax), which is the
    // correct legal outcome.
    //
    // NOTE: Section 71(3A) caps the inter-head set-off at ₹2 lakh
    // per year for house-property loss, with any excess carrying
    // forward 8 years. v1 does not implement this cap (nor the
    // carry-forward), so a let-out property with very high interest
    // could generate a loss larger than ₹2L and flow the entire
    // amount into GTI. This is a generous interpretation; full
    // §71(3A) compliance requires per-year loss buckets for HP
    // losses, analogous to the STCL/LTCL buckets already supported
    // for capital gains. Tracked for v1.2.
    return {
      net_house_property: totalIncome,
      total_rent: totalRent,
      total_municipal_taxes: totalMunicipal,
      total_interest: totalInterest,
    };
  }

  /**
   * Other Sources head (Section 56-59).
   * Lottery / crossword winnings are taxed at 30% flat (Section
   * 115BBH) and do NOT benefit from the basic exemption or slab
   * rates. For v1 we keep it simple and aggregate everything.
   */
  function computeNetOtherSources(os) {
    const interest = (+os.savings_account_interest || 0)
                  + (+os.fd_interest || 0)
                  + (+os.rd_interest || 0);
    const dividendGross = (+os.dividend_gross || 0);
    const other = (os.other_misc || []).reduce(
      (s, x) => s + (+x.amount || 0), 0
    );
    const familyPension = +os.family_pension || 0;
    // Lottery taxed at flat 30% — handled separately in the
    // computation (we add it to total income but tax it at 30% flat)
    const lottery = +os.lottery_winnings || 0;
    return {
      interest: interest,
      dividend_gross: dividendGross,
      other: other,
      family_pension: familyPension,
      lottery: lottery,
      // Total income from this head (lottery excluded for slab calc)
      net_other_sources: interest + dividendGross + other + familyPension,
    };
  }

  /**
   * Compute the effective brought-forward STCL/LTCL by filtering
   * per-year buckets whose 8-year window has NOT expired
   * (Section 71, LOSS_CARRY_FORWARD_YEARS).
   * If `stcl_buckets` is empty, fall back to `stcl_brought_forward`
   * (backward compat). Each bucket is { fy: "2020-21", amount: N }.
   * The expiry is computed relative to the workbook's AY:
   * a bucket with fy ending in 2020-21 expires after AY 2028-29.
   */
  function effectiveBroughtForwardLosses(cg, ay) {
    const ayEnd = +(ay.split("-")[0]);    // "2025-26" → 2025
    const isEligible = (fy) => {
      if (!fy) return true;
      const fyEnd = +(fy.split("-")[0]);
      // Bucket's fy ends in fyEnd (e.g. 2020-21 → 2020). The bucket
      // is set-off eligible in the AY immediately after the loss AY
      // and for LOSS_CARRY_FORWARD_YEARS AYs total.
      return ayEnd >= fyEnd + 1 && ayEnd <= fyEnd + LOSS_CARRY_FORWARD_YEARS;
    };
    let stcl = 0, ltcl = 0;
    if (Array.isArray(cg.stcl_buckets) && cg.stcl_buckets.length > 0) {
      for (const b of cg.stcl_buckets) {
        if (isEligible(b.fy)) stcl += +b.amount || 0;
      }
    } else {
      stcl = +cg.stcl_brought_forward || 0;
    }
    if (Array.isArray(cg.ltcl_buckets) && cg.ltcl_buckets.length > 0) {
      for (const b of cg.ltcl_buckets) {
        if (isEligible(b.fy)) ltcl += +b.amount || 0;
      }
    } else {
      ltcl = +cg.ltcl_brought_forward || 0;
    }
    return { stcl, ltcl, eligible: stcl + ltcl > 0 };
  }

  /**
   * Capital Gains head (Section 45-55).
   * For v1, the workbook just carries the totals. The user imports
   * them from the static Tax P&L app or types them in.
   * The key bit of math: ₹1L LTCG exemption under Section 112A.
   * @param {Object} cg  The capital_gains sub-section of a workbook
   * @param {string} [ay]  AY for 8-year expiry filter (default: "2025-26")
   */
  function computeCapitalGains(cg, ay) {
    // Apply brought-forward losses BEFORE computing tax
    const stcg111aBeforeCF = +cg.stcg_111a || 0;
    const ltcg112aBeforeCF = +cg.ltcg_112a || 0;
    const stcgOther = +cg.stcg_other || 0;
    const ltcgOther = +cg.ltcg_other || 0;

    // Set-off order (per Section 70):
    //   STCL brought forward can be set off against STCG first,
    //   then against LTCG.
    //   LTCL brought forward can be set off against LTCG first,
    //   then against STCG.
    // For v1 we do the straightforward set-off: first available
    // STCL against STCG (any kind), then LTCL against LTCG, then
    // any remaining against the other head.
    // If per-year buckets are present, they replace the lump-sum
    // brought_forward field (filtering out 8-year-expired buckets).
    const broughtFwd = effectiveBroughtForwardLosses(cg, ay || AY_2025_26);
    const stcl = Math.max(0, broughtFwd.stcl);
    const ltcl = Math.max(0, broughtFwd.ltcl);

    const totalStcgBeforeCF = stcg111aBeforeCF + stcgOther;
    const totalLtcgBeforeCF = ltcg112aBeforeCF + ltcgOther;

    // STCL absorbs STCG first
    const stclVsStcg = Math.min(stcl, totalStcgBeforeCF);
    const stclRemaining = stcl - stclVsStcg;
    const stclVsLtcg = Math.min(stclRemaining, totalLtcgBeforeCF);

    const stcgAfterCF = totalStcgBeforeCF - stclVsStcg;
    const ltcgAfterCF = totalLtcgBeforeCF - stclVsLtcg;

    // LTCL absorbs LTCG first
    const ltclVsLtcg = Math.min(ltcl, ltcgAfterCF);
    const ltclRemaining = ltcl - ltclVsLtcg;
    const ltclVsStcg = Math.min(ltclRemaining, stcgAfterCF);

    const finalStcg = stcgAfterCF - ltclVsStcg;
    const finalLtcg = ltcgAfterCF - ltclVsLtcg;

    // Section 112A(2): ₹1L exemption on 112A LTCG
    const ltcgExemption = Math.min(finalLtcg, LTCG_112A_EXEMPTION);
    const taxableLtcg112a = Math.max(0, finalLtcg - ltcgExemption);

    return {
      stcg_111a_gross: stcg111aBeforeCF,
      stcg_other_gross: stcgOther,
      ltcg_112a_gross: ltcg112aBeforeCF,
      ltcg_other_gross: ltcgOther,
      stcl_used: stclVsStcg + stclVsLtcg,
      ltcl_used: ltclVsLtcg + ltclVsStcg,
      stcl_remaining: Math.max(0, stcl - (stclVsStcg + stclVsLtcg)),
      ltcl_remaining: Math.max(0, ltcl - (ltclVsLtcg + ltclVsStcg)),
      stcg_after_cf: Math.max(0, finalStcg),
      ltcg_exemption_applied: ltcgExemption,
      ltcg_after_cf: taxableLtcg112a,        // after ₹1L exemption
      // Net total for the head
      net_capital_gains: Math.max(0, finalStcg) + taxableLtcg112a,
    };
  }

  /**
   * Compute capital-gains tax on the schedule-CG amounts.
   * This is COMPUTED SEPARATELY from the slab tax (per IT Act):
   *   - Section 111A STCG: flat 15%
   *   - Section 112A LTCG: 10% above ₹1L (exemption already
   *     applied inside `computeCapitalGains` → `ltcg_after_cf`)
   *   - Section 112 "other" LTCG: 20% with indexation
   *   - Other STCG: at slab rate (folded into slab tax for v1;
   *     Schedule CG shows the breakdown)
   *
   * Returns a breakdown { stcg_111a_tax, ltcg_112a_tax, total }
   * plus the final per-bucket amounts.
   *
   * Implementation: this function is SELF-CONTAINED — it does not
   * depend on prior call to `computeCapitalGains`. It re-derives
   * the post-CF, post-exemption amounts from the gross inputs +
   * brought-forward losses (using the per-year buckets with
   * 8-year expiry filter, falling back to lump-sum fields). This
   * keeps the schedule CG math independent of the order in which
   * engine functions are called.
   *
   * @param {Object} cg The capital_gains sub-section
   * @param {string} [ay] AY for 8-year expiry filter (default: "2025-26")
   */
  function computeScheduleCGTax(cg, ay) {
    const stcg111aGross = +cg.stcg_111a || 0;
    const stcgOtherGross = +cg.stcg_other || 0;
    const ltcg112aGross = +cg.ltcg_112a || 0;
    const ltcgOtherGross = +cg.ltcg_other || 0;
    const broughtFwd = effectiveBroughtForwardLosses(cg, ay || AY_2025_26);
    const stcl = Math.max(0, broughtFwd.stcl);
    const ltcl = Math.max(0, broughtFwd.ltcl);

    // STCL set-off: first against STCG 111A, then STCG other
    const stclVs111a = Math.min(stcl, stcg111aGross);
    const stclRemaining1 = Math.max(0, stcl - stclVs111a);
    const stclVsOther = Math.min(stclRemaining1, stcgOtherGross);
    const stclRemaining = Math.max(0, stclRemaining1 - stclVsOther);
    const stcg111aTaxable = Math.max(0, stcg111aGross - stclVs111a);
    const stcgOtherTaxable = Math.max(0, stcgOtherGross - stclVsOther);

    // LTCL set-off: first against LTCG 112A, then LTCG other, then STCG
    // (per IT Act, LTCL can be set off against any capital gain)
    const ltclVs112a = Math.min(ltcl, ltcg112aGross);
    const ltclRemaining1 = Math.max(0, ltcl - ltclVs112a);
    const ltclVsOther = Math.min(ltclRemaining1, ltcgOtherGross);
    const ltclRemaining2 = Math.max(0, ltclRemaining1 - ltclVsOther);
    const ltcg112aPostCF = Math.max(0, ltcg112aGross - ltclVs112a);
    const ltcgOtherTaxable = Math.max(0, ltcgOtherGross - ltclVsOther);
    // Any LTCL remaining spills onto STCG (111A first, then other)
    const ltclVsStcg111a = Math.min(ltclRemaining2, stcg111aTaxable);
    const ltclRemaining3 = Math.max(0, ltclRemaining2 - ltclVsStcg111a);
    const ltclVsStcgOther = Math.min(ltclRemaining3, stcgOtherTaxable);
    const stcg111aTaxableNet = Math.max(0, stcg111aTaxable - ltclVsStcg111a);
    const stcgOtherTaxableNet = Math.max(0, stcgOtherTaxable - ltclVsStcgOther);

    // Section 112A(2): ₹1L exemption on post-CF 112A LTCG
    const ltcg112aExemption = Math.min(ltcg112aPostCF, LTCG_112A_EXEMPTION);
    const ltcg112aTaxable = Math.max(0, ltcg112aPostCF - ltcg112aExemption);

    // Capital-gains tax rates (Section 111A / 112A / 112)
    const stcg111aTax = stcg111aTaxableNet * STCG_111A_RATE;
    const ltcg112aTax = ltcg112aTaxable * LTCG_112A_RATE;
    const ltcgOtherTax = ltcgOtherTaxable * LTCG_OTHER_RATE;
    // Other STCG is at slab rate; v1 keeps it in the slab tax.
    const stcgOtherTax = 0;

    return {
      stcg_111a_taxable: stcg111aTaxableNet,
      ltcg_112a_taxable: ltcg112aTaxable,
      ltcg_112a_exemption: ltcg112aExemption,
      stcg_other_taxable: stcgOtherTaxableNet,
      ltcg_other_taxable: ltcgOtherTaxable,
      stcg_111a_tax: stcg111aTax,
      ltcg_112a_tax: ltcg112aTax,
      stcg_other_tax: stcgOtherTax,
      ltcg_other_tax: ltcgOtherTax,
      total_schedule_cg_tax: stcg111aTax + ltcg112aTax + ltcgOtherTax,
      _stcl_unused: stclRemaining,
      _ltcl_unused: Math.max(0, ltclRemaining3 - ltclVsStcgOther),
    };
  }

  /**
   * Compute Section 234B and 234C interest on advance tax
   * shortfalls. v1 best-effort; does not handle 234A (late
   * filing return), 234BA (updated return), or TDS defaults.
   *
   * 234B: 1% per month on the amount by which assessed tax
   *       exceeds self-assessment tax + advance tax paid, when
   *       that shortfall > ₹10,000.
   * 234C: 1% per month (3 months for Dec, simple interest) on
   *       shortfall in each advance-tax installment:
   *         15-Jun: 15% of assessed tax (net of TDS)
   *         15-Sep: 45% of assessed tax
   *         15-Dec: 75% of assessed tax
   *         15-Mar: 100% of assessed tax
   *       Interest is on the shortfall in each bucket.
   *
   * For v1 we compute 234B and 234C interest as standalone
   * numbers that the user can review, but we do NOT add them
   * to `total_tax_liability` (they appear separately in the ITR
   * computation schedule as "Interest payable").
   *
   * @param {number} totalTaxLiability  Pre-234B/234C tax
   * @param {Object} wb  Workbook (for TDS / advance tax paid)
   * @returns {Object} { section_234b, section_234c, total_234, months_234b, months_234c_per_quarter }
   */
  function computeInterest234(totalTaxLiability, wb) {
    const tp = wb && wb.taxes_paid ? wb.taxes_paid : {};
    const sp = wb && wb.salary ? wb.salary : {};
    const tdsSalary = +sp.tds_total || 0;
    const tdsOther = +tp.tds_other_than_salary || 0;
    const tcs = +tp.tcs || 0;
    const advancePaid = +tp.advance_tax || 0;
    const selfAssessmentPaid = +tp.self_assessment_tax || 0;

    // 234B: SEC_234B_RATE_PER_MONTH on shortfall when assessed tax
    // - (advance + self-assessment tax) > SEC_234B_THRESHOLD.
    // Months: from Apr of AY to date of filing, capped at the ITR
    // due date. For v1 we don't know filing date, so we use a
    // conservative SEC_234B_MONTHS (12) months.
    const totalPaidBeforeFiling = tdsSalary + tdsOther + tcs + advancePaid + selfAssessmentPaid;
    const shortfall234B = Math.max(0, totalTaxLiability - totalPaidBeforeFiling);
    const is234BApplicable = shortfall234B > SEC_234B_THRESHOLD;
    const months234B = is234BApplicable ? SEC_234B_MONTHS : 0;
    const interest234B = (is234BApplicable ? shortfall234B : 0)
                       * SEC_234B_RATE_PER_MONTH * months234B;

    // 234C: per-installment shortfalls
    // The "assessed tax minus TDS minus TCS" is the denominator
    // for the 15/45/75/100% cumulative thresholds.
    const denom = Math.max(0, totalTaxLiability - tdsSalary - tdsOther - tcs);
    const cumThresholds = [
      SEC_234C_THRESHOLD_Q1,
      SEC_234C_THRESHOLD_Q2,
      SEC_234C_THRESHOLD_Q3,
      SEC_234C_THRESHOLD_Q4,
    ];
    const monthsPerInstallment = [
      SEC_234C_MONTHS_Q1,
      SEC_234C_MONTHS_Q2,
      SEC_234C_MONTHS_Q3,
      SEC_234C_MONTHS_Q4,
    ];
    const cumulativePaid = tdsSalary + tdsOther + tcs + advancePaid + selfAssessmentPaid;
    let prevThresholdAmount = 0;
    let interest234C = 0;
    const perInstallment = [];
    for (let i = 0; i < 4; i++) {
      const cumulativeThreshold = denom * cumThresholds[i];
      const installmentDue = cumulativeThreshold - prevThresholdAmount;
      const installmentPaid = Math.max(0, cumulativePaid - prevThresholdAmount);
      const installmentShortfall = Math.max(0, installmentDue - installmentPaid);
      const installmentInterest = installmentShortfall
                               * SEC_234C_RATE_PER_MONTH
                               * monthsPerInstallment[i];
      perInstallment.push({
        installment: i + 1,
        cumulative_due: Math.round(cumulativeThreshold),
        cumulative_paid: Math.round(cumulativePaid),
        shortfall: Math.round(installmentShortfall),
        interest: Math.round(installmentInterest),
        months: monthsPerInstallment[i],
      });
      interest234C += installmentInterest;
      prevThresholdAmount = cumulativeThreshold;
    }

    return {
      section_234b: {
        shortfall: Math.round(shortfall234B),
        months: months234B,
        interest: Math.round(interest234B),
      },
      section_234c: {
        total: Math.round(interest234C),
        per_installment: perInstallment,
      },
      total_234: Math.round(interest234B + interest234C),
    };
  }

  /**
   * Deductions under Chapter VI-A. Many sections cap at certain
   * amounts; we apply the caps here.
   * Also: some sections are only available in the OLD regime
   * (80TTA, 80TTB). 80CCD(2) is available in both.
   *
   * Senior-citizen status (per Section 80D / 80TTB: 60+) is
   * derived from the profile's DOB. When the user is 60+:
   *   - 80D self+family cap = ₹50K (was ₹25K for non-senior)
   *   - 80D parents cap = ₹50K (was ₹25K for non-senior)
   *   - 80TTB is available (₹50K); 80TTA is replaced by 80TTB
   *   - 80TTA is not available (seniors use 80TTB instead)
   * When the user is under 60:
   *   - 80D caps stay at ₹25K
   *   - 80TTB is gated off (Section 80TTB is senior-only)
   *   - 80TTA is available (₹10K)
   *
   * v1 does not track per-person age for the parents bucket.
   * The senior flag here reflects the user's own age, not the
   * parents'. For families where parents are senior but the
   * user is not, the user should manually adjust the 80D_parents
   * field against the senior cap.
   */
  function computeDeductions(deductions, regimeKind, profile, ay) {
    const isSenior = isProfileSenior(profile, ay);
    const capSelf = isSenior ? CAP_80D_SELF_FAMILY_SENIOR : CAP_80D_SELF_FAMILY;
    const capParents = isSenior ? CAP_80D_PARENTS_SENIOR : CAP_80D_PARENTS;
    const c80c = Math.min(+deductions["80c_total"] || 0, CAP_80C);
    const c80ccd1b = Math.min(+deductions["80ccd_1b"] || 0, CAP_80CCD_1B);
    const c80ccd2 = +deductions["80ccd_2"] || 0;            // 80CCD(2) has no cap
    const c80d = Math.min(+deductions["80d_self_family"] || 0, capSelf)
               + Math.min(+deductions["80d_parents"] || 0, capParents);
    // 80D caps above reflect senior status derived from profile.dob.
    const c80e = +deductions["80e"] || 0;                  // no cap
    const c80g = (+deductions["80g_50pct"] || 0)
               + (+deductions["80g_100pct"] || 0);          // cap depends on donee
    let c80tta = 0;
    let c80ttb = 0;
    if (regimeKind === "old") {
      // 80TTA and 80TTB are mutually exclusive per Section 80TTB:
      // seniors use 80TTB (₹50K cap), non-seniors use 80TTA (₹10K cap).
      if (isSenior) {
        // Senior: 80TTB only. Ignore 80TTA (which the user may have
        // entered by mistake or for a non-senior family member).
        c80ttb = Math.min(+deductions["80ttb"] || 0, CAP_80TTB);
      } else {
        // Non-senior: 80TTA only. 80TTB is senior-only and is
        // gated off even if the user enters a value.
        c80tta = Math.min(+deductions["80tta"] || 0, CAP_80TTA);
      }
    }
    const total = c80c + c80ccd1b + c80ccd2 + c80d + c80e + c80g + c80tta + c80ttb;
    return {
      c80c, c80ccd1b, c80ccd2, c80d, c80e, c80g, c80tta, c80ttb,
      total_deductions: total,
      // Expose the effective caps so the UI can show "applied
      // ₹50K cap (senior)" vs "applied ₹25K cap (non-senior)".
      is_senior_citizen: isSenior,
      cap_80d_self_family: capSelf,
      cap_80d_parents: capParents,
    };
  }

  // ============================================================
  // Step 2: Apply slab rates to the taxable income
  // ============================================================

  /**
   * Compute income tax on a given taxable income using the slab
   * schedule. Returns the tax amount (pre-rebate, pre-cess).
   * Handles the "lower of (a) tax on full income at slab rates
   * and (b) tax on (income - threshold) + max tax below threshold"
   * for marginal relief, but the rebate u/s 87A is applied
   * separately below.
   */
  function computeSlabTax(taxableIncome, regime) {
    if (taxableIncome <= 0) return 0;
    let tax = 0;
    let prev = 0;
    for (const slab of regime.slabs) {
      if (taxableIncome > slab.upto) {
        tax += (slab.upto - prev) * slab.rate;
        prev = slab.upto;
      } else {
        tax += (taxableIncome - prev) * slab.rate;
        return tax;
      }
    }
    return tax;
  }

  /**
   * Apply rebate u/s 87A. If total income ≤ threshold, tax becomes
   * zero (the rebate pays for the entire tax up to the cap).
   * Marginal relief: if tax > total_income - threshold, tax is
   * capped at the excess. (Important when income is just above
   * the threshold.)
   *
   * Returns the POST-rebate tax amount. The rebate applied is
   * (pre-rebate tax) - (returned value).
   */
  function applyRebate87A(tax, totalIncome, regime) {
    if (totalIncome <= regime.rebate_87a_max_income) {
      // Full rebate (up to the cap): tax reduced to zero.
      // (If tax > max_tax for some reason — shouldn't happen for
      //  incomes at the threshold, but defensive — the cap kicks in.)
      const rebate = Math.min(tax, regime.rebate_87a_max_tax);
      return tax - rebate;
    }
    // Marginal relief: tax should not exceed totalIncome - threshold
    const excess = totalIncome - regime.rebate_87a_max_income;
    if (tax > excess) {
      return excess;
    }
    return tax;
  }

  /**
   * Apply surcharge. Surcharge is a percentage of the (post-rebate)
   * tax, depending on total income.
   * For the special 37% surcharge (old regime only), it applies
   * when income > ₹5 Cr AND capital gains are < 25% of total income.
   * v1 implements the standard brackets and ignores the 37% cap.
   */
  function computeSurcharge(tax, totalIncome, regime) {
    // Below ₹50L: no surcharge (Section 68 thresholds start at 50L)
    if (totalIncome <= SURCHARGE_LOWER_50L) return { rate: 0, amount: 0 };
    for (const b of regime.surcharge.brackets) {
      if (totalIncome > b.lower && totalIncome <= b.upper) {
        const amount = tax * b.rate;
        return { rate: b.rate, amount };
      }
    }
    // Above the highest bracket — use the last one
    const last = regime.surcharge.brackets[regime.surcharge.brackets.length - 1];
    return { rate: last.rate, amount: tax * last.rate };
  }

  /**
   * Apply Health & Education Cess.
   */
  function computeCess(taxWithSurcharge, regime) {
    return taxWithSurcharge * regime.cess_rate;
  }

  /**
   * Apply marginal relief on surcharge (Section 89 read with the
   * surcharge brackets).
   *
   * Without marginal relief, a taxpayer whose income is just
   * above a surcharge threshold (₹50L, ₹1Cr, ₹2Cr, ₹5Cr) would
   * pay a disproportionate amount of surcharge on their entire
   * income. Marginal relief caps the *total tax* so that:
   *
   *     total_tax ≤ tax_at_threshold + (income - threshold)
   *
   * Equivalently, the surcharge itself is reduced so the total
   * tax (slab + surcharge + cess) equals the cap.
   *
   * Legal basis: Section 89 + Finance Act surcharge brackets. The
   * relief applies at every threshold crossed (₹50L, ₹1Cr, ₹2Cr,
   * ₹5Cr). In practice, only the *lowest* crossed threshold
   * matters — once income is well past ₹50L, the cap becomes
   * tax_at_threshold + (income - 50L), but at higher incomes the
   * tax_at_threshold grows faster and the cap becomes less
   * binding. The implementation below applies the cap at the
   * lowest crossed threshold, which is the correct legal
   * interpretation (per the IT Department's circular on §89).
   *
   * Note: in the old regime, surcharges above ₹5Cr are 37% (if
   * cap gains < 25% of total income) or 25%. v1 doesn't
   * distinguish — the cap is still computed correctly.
   *
   * @param {number} taxBeforeSurcharge  Slab tax + Schedule CG tax
   * @param {number} totalIncome         GTI (including cap gains)
   * @param {Object} regime              Regime config
   * @param {Object} surchargeResult     { rate, amount } from computeSurcharge
   * @param {number} cess                Computed cess
   * @returns {Object} { rate, amount, original_rate, original_amount, marginal_relief_applied, cap_excess }
   */
  function applyMarginalRelief(taxBeforeSurcharge, totalIncome, regime, surchargeResult, cess) {
    // If the surcharge is zero, no relief is needed.
    if (surchargeResult.rate === 0 || surchargeResult.amount === 0) {
      return {
        rate: surchargeResult.rate,
        amount: surchargeResult.amount,
        original_rate: surchargeResult.rate,
        original_amount: surchargeResult.amount,
        marginal_relief_applied: false,
        cap_excess: 0,
      };
    }

    // Find the LOWEST crossed threshold. The marginal relief
    // applies at the threshold the taxpayer just crossed (the
    // lowest one above which their income is), per CBDT circular
    // on Section 89. The relief caps total tax at
    //   tax_at_that_threshold + (income - that_threshold)
    // For ₹50L income: lowest crossed is ₹50L. For ₹1Cr income,
    // the lowest crossed is still ₹50L (the cap is calculated
    // against the 50L threshold, not the 1Cr one).
    const thresholds = regime.surcharge.brackets
      .map((b) => b.lower)
      .filter((l) => l > 0)        // exclude the implicit 0-50L bracket
      .sort((a, b) => a - b);
    let threshold = null;
    for (const t of thresholds) {
      if (totalIncome > t) {
        // First crossed threshold wins.
        threshold = t;
        break;
      }
    }
    if (threshold === null) {
      // No threshold crossed — no relief.
      return {
        rate: surchargeResult.rate,
        amount: surchargeResult.amount,
        original_rate: surchargeResult.rate,
        original_amount: surchargeResult.amount,
        marginal_relief_applied: false,
        cap_excess: 0,
      };
    }

    // tax at threshold: slab tax on the threshold income + 0% surcharge
    // + cess on the threshold tax. Schedule CG is not added to
    // "tax at threshold" — it's not a function of salary income.
    // The legal position: marginal relief caps total tax at
    // (slab_tax_at_threshold + surcharge_at_threshold + cess + excess_income).
    // Since surcharge is 0 at exactly the threshold, the cap simplifies
    // to slabTax(threshold) × 1.04 + excess_income.
    const slabAtThreshold = computeSlabTax(threshold, regime);
    const cessAtThreshold = slabAtThreshold * regime.cess_rate;
    const taxAtThreshold = slabAtThreshold + cessAtThreshold;
    // Note: in v1 we don't add Schedule CG to "tax at threshold"
    // because the user may have CG independent of their threshold-
    // crossing. The cap is conservative — adding CG to the threshold
    // would also be defensible (the relief would be slightly less
    // generous). v1.2 may revisit this with the actual Finance Act
    // wording.

    // Cap: tax at threshold + income above threshold
    const excessIncome = totalIncome - threshold;
    const maxTotalTax = taxAtThreshold + excessIncome;
    // Current total tax (with full surcharge + cess)
    const currentTotalTax = taxBeforeSurcharge + surchargeResult.amount + cess;

    if (currentTotalTax <= maxTotalTax) {
      // No relief needed — surcharge is already under the cap.
      return {
        rate: surchargeResult.rate,
        amount: surchargeResult.amount,
        original_rate: surchargeResult.rate,
        original_amount: surchargeResult.amount,
        marginal_relief_applied: false,
        cap_excess: 0,
      };
    }

    // Apply relief: reduce the surcharge so total tax = maxTotalTax.
    // We want: slab + CG + new_surcharge + cess = maxTotalTax
    // where cess = 0.04 × (slab + CG + new_surcharge).
    // Let S = slab + CG + new_surcharge. Then S × 1.04 = maxTotalTax,
    // so S = maxTotalTax / 1.04. Therefore:
    //   new_surcharge = maxTotalTax / 1.04 - (slab + CG)
    //                 = maxTotalTax / 1.04 - taxBeforeSurcharge
    // Note: the formula (maxTotalTax - taxBeforeSurcharge) / 1.04
    // is INCORRECT — it would divide taxBeforeSurcharge by 1.04 too.
    const surchargeAtCap = (maxTotalTax / 1.04) - taxBeforeSurcharge;
    const newSurcharge = Math.max(0, surchargeAtCap);
    // New effective rate (for display)
    const newRate = taxBeforeSurcharge > 0 ? newSurcharge / taxBeforeSurcharge : 0;

    return {
      rate: newRate,
      amount: newSurcharge,
      original_rate: surchargeResult.rate,
      original_amount: surchargeResult.amount,
      marginal_relief_applied: true,
      cap_excess: currentTotalTax - maxTotalTax,
    };
  }

  // ============================================================
  // Top-level: compute everything for a workbook
  // ============================================================

  /**
   * Compute the full tax picture for one workbook, under one regime.
   * @param {Object} wb The workbook (data_model.js)
   * @param {"old"|"new"} regimeKind
   * @returns {Object} Detailed computation
   */
  function computeForRegime(wb, regimeKind, profile) {
    // Defensive: if wb is null/undefined or has no ay, build an
    // empty AY 2025-26 workbook inline (so callers don't have to
    // null-check). Mirrors data_model.emptyWorkbook for AY 2025-26.
    if (!wb || !wb.ay) {
      const dm = (typeof window !== "undefined" && window.taxDataModel) ||
                  (typeof require !== "undefined" && require("./data_model.js"));
      if (dm && typeof dm.emptyWorkbook === "function") {
        wb = dm.emptyWorkbook(AY_2025_26);
      } else {
        // Fallback: minimal empty shape (shouldn't happen in practice)
        wb = {
          ay: AY_2025_26,
          salary: { employers: [], tds_total: 0 },
          house_property: { properties: [] },
          other_sources: {},
          capital_gains: {},
          deductions: {},
          taxes_paid: {},
        };
      }
    }
    const ay = wb.ay;
    const cfgs = getRegimeConfigs(ay);
    const regime = regimeKind === "new" ? cfgs.new : cfgs.old;

    // --- Step 1: gross income by head ---
    const salary = computeNetSalary(wb.salary, regime);
    const house = computeNetHouseProperty(wb.house_property);
    const other = computeNetOtherSources(wb.other_sources);
    const cg = computeCapitalGains(wb.capital_gains, ay);

    // Gross total income (includes capital gains per IT Act)
    const gti = salary.net_salary
              + house.net_house_property
              + other.net_other_sources
              + cg.net_capital_gains;

    // GTI excluding capital gains (the "ordinary income" that
    // flows into the slab tax). Per IT Act, capital gains are
    // taxed on a SEPARATE schedule (Schedule CG), NOT at slab
    // rates, and the 87A rebate does not apply to schedule CG.
    const gtiOrdinary = gti - cg.net_capital_gains;

    // --- Step 2: deductions ---
    // Deductions (Chapter VI-A) can ONLY be claimed against
    // ordinary income, not against capital gains. So we apply
    // them to gtiOrdinary only.
    const deductions = computeDeductions(wb.deductions, regimeKind, profile, ay);
    // Section 80CCD(2) — employer NPS — is deducted from salary, not
    // from GTI. For v1 we keep it in Chapter VI-A total for
    // simplicity. (The exact treatment: 80CCD(2) is allowed over
    // and above 80C, 80CCD(1), 80CCD(1B). We've already capped 80C
    // and 80CCD(1B). 80CCD(2) is uncapped.)

    // Taxable ordinary income (cannot be negative)
    const taxableIncome = Math.max(0, gtiOrdinary - deductions.total_deductions);

    // --- Step 3: slab tax (only on ordinary income) ---
    let tax = computeSlabTax(taxableIncome, regime);

    // --- Step 4: special tax on lottery winnings ---
    // 30% flat, no rebate, no slab benefit
    const lotteryTax = other.lottery * LOTTERY_RATE;  // Section 115BBH

    // --- Step 5: rebate 87A (applied to the slab tax only) ---
    // Per IT Act, 87A rebate applies to slab-tax income (ordinary
    // income). It does NOT rebate schedule CG tax. The threshold
    // check uses GTI (which includes capital gains) per the
    // Finance Act wording.
    const preRebateTax = tax;
    tax = applyRebate87A(tax, gti, regime);
    const rebate87a = preRebateTax - tax;

    // --- Step 6: schedule CG tax (added to slab tax BEFORE
    //     surcharge, per IT Act) ---
    const scheduleCG = computeScheduleCGTax(wb.capital_gains, ay);
    const taxBeforeSurcharge = tax + scheduleCG.total_schedule_cg_tax;

    // --- Step 7: surcharge ---
    // Surcharge rate is driven by TOTAL income (incl. CG).
    // We compute the raw surcharge first, then apply marginal
    // relief (Section 89) which may reduce it for incomes just
    // above a threshold (₹50L, ₹1Cr, ₹2Cr, ₹5Cr).
    const surchargeRaw = computeSurcharge(taxBeforeSurcharge, gti, regime);
    // Compute cess on the (potentially-not-yet-relieved) total first
    // so applyMarginalRelief can compare against the cap correctly.
    const cessRaw = computeCess(taxBeforeSurcharge + surchargeRaw.amount, regime);
    const surcharge = applyMarginalRelief(
      taxBeforeSurcharge, gti, regime, surchargeRaw, cessRaw
    );

    // --- Step 8: cess on (tax + schedule CG + (relieved) surcharge) ---
    // After marginal relief, the surcharge is smaller, so the
    // cess is smaller too. Recompute.
    const cess = computeCess(taxBeforeSurcharge + surcharge.amount, regime);

    // --- Step 9: final tax before TDS adjustment ---
    const totalTaxLiability = taxBeforeSurcharge + surcharge.amount + cess + lotteryTax;

    // --- Step 10: 234B/234C interest (separate from total tax
    //     liability; not added here) ---
    const interest234 = computeInterest234(totalTaxLiability, wb);

    // --- Step 11: TDS / advance tax / self-assessment tax ---
    const tds = computeTotalTds(wb);

    // Tax payable or refund (against the regular tax only;
    // 234B/234C are added to self-assessment demand later)
    const netPayable = totalTaxLiability - tds;
    const result = netPayable >= 0 ? "payable" : "refund";
    const absAmount = Math.abs(netPayable);

    return {
      regime: regimeKind,
      regime_label: regime.label,
      // Income by head
      salary,
      house,
      other,
      cg,
      gti,
      gti_ordinary: gtiOrdinary,
      deductions,
      taxable_income: taxableIncome,
      // Tax computation
      pre_rebate_tax: preRebateTax,
      rebate_87a: rebate87a,
      tax_after_rebate: tax,
      schedule_cg: scheduleCG,
      tax_before_surcharge: taxBeforeSurcharge,
      // The surcharge RATE reported here is the legislative
      // bracket rate (e.g. 10% for ₹50L-1Cr). The effective rate
      // (after marginal relief) is reported in `effective_surcharge_rate`.
      // The AMOUNT is the post-relief amount (the actual ₹ added to tax).
      surcharge_rate: surcharge.original_rate,
      surcharge: surcharge.amount,
      // Marginal relief details (Section 89) — when the taxpayer's
      // income is just above a surcharge threshold, the surcharge
      // is reduced so total tax doesn't exceed the cap.
      effective_surcharge_rate: surcharge.rate,
      surcharge_original_amount: surcharge.original_amount,
      marginal_relief_applied: surcharge.marginal_relief_applied,
      marginal_relief_savings: surcharge.marginal_relief_applied
        ? surcharge.original_amount - surcharge.amount
        : 0,
      cess,
      lottery_tax: lotteryTax,
      total_tax_liability: totalTaxLiability,
      // 234 interest (informational; not in total_tax_liability)
      interest_234: interest234,
      // TDS / payments
      tds_total: tds,
      net_payable: netPayable,
      result: result,
      refund_due: result === "refund" ? absAmount : 0,
      tax_payable: result === "payable" ? absAmount : 0,
      // Round to whole rupees (ITR rounds)
      total_tax_rounded: Math.round(totalTaxLiability),
      refund_due_rounded: result === "refund" ? Math.round(absAmount) : 0,
      tax_payable_rounded: result === "payable" ? Math.round(absAmount) : 0,
    };
  }

  /**
   * Sum all TDS / advance tax / self-assessment tax paid.
   */
  function computeTotalTds(wb) {
    const tp = wb.taxes_paid || {};
    const sp = wb.salary || {};
    return (+sp.tds_total || 0)
         + (+tp.tds_other_than_salary || 0)
         + (+tp.advance_tax || 0)
         + (+tp.self_assessment_tax || 0)
         + (+tp.tcs || 0);
  }

  /**
   * Compute tax under BOTH regimes and return both side-by-side.
   * @param {Object} wb
   * @returns {{old: Object, new: Object, recommendation: "old"|"new", savings: number}}
   */
  function computeBothRegimes(wb, profile) {
    const oldResult = computeForRegime(wb, "old", profile);
    const newResult = computeForRegime(wb, "new", profile);
    const diff = oldResult.total_tax_rounded - newResult.total_tax_rounded;
    return {
      old: oldResult,
      new: newResult,
      recommendation: diff > 0 ? "new" : (diff < 0 ? "old" : "tie"),
      savings: Math.abs(diff),
    };
  }

  // ============================================================
  // Schedule CG builder (for ITR preview)
  // ============================================================

  /**
   * Build the Schedule CG line items from the workbook's capital
   * gains. For v1, since the workbook stores aggregate numbers,
   * we generate one summary row per (head, gain/loss) combination.
   * When the user imports from the static app in a future version,
   * this will generate per-trade rows.
   */
  function buildScheduleCG(cg) {
    const rows = [];
    if (cg.stcg_111a && cg.stcg_111a !== 0) {
      rows.push({
        section: "Ai",  // 111A short-term
        description: "Short-term capital gain on listed equity (Section 111A)",
        amount: cg.stcg_111a,
        tax_rate: "15%",
      });
    }
    if (cg.ltcg_112a && cg.ltcg_112a !== 0) {
      rows.push({
        section: "Bii",  // 112A long-term
        description: "Long-term capital gain on listed equity (Section 112A), post-₹1L exemption",
        amount: cg.ltcg_112a,
        tax_rate: "10% above ₹1L",
      });
    }
    if (cg.stcg_other && cg.stcg_other !== 0) {
      rows.push({
        section: "Aiv",
        description: "Other short-term capital gain (slab rate)",
        amount: cg.stcg_other,
        tax_rate: "slab",
      });
    }
    if (cg.ltcg_other && cg.ltcg_other !== 0) {
      rows.push({
        section: "Biv",
        description: "Other long-term capital gain (Section 112, 20% with indexation)",
        amount: cg.ltcg_other,
        tax_rate: "20% w/ indexation",
      });
    }
    return rows;
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    getRegimeConfigs,
    // Senior-citizen helpers (Section 80D / 80TTB)
    isSeniorCitizen,
    isProfileSenior,
    // Head-level
    computeNetSalary,
    computeNetHouseProperty,
    computeNetOtherSources,
    computeCapitalGains,
    computeDeductions,
    // Tax-level
    computeSlabTax,
    applyRebate87A,
    computeSurcharge,
    computeCess,
    computeTotalTds,
    // Top-level
    computeForRegime,
    computeBothRegimes,
    // Schedule preview
    buildScheduleCG,
    // v1 limitations FIXED in 2026-07-21+
    computeScheduleCGTax,
    computeInterest234,
    effectiveBroughtForwardLosses,
    // IT-Act constants (single source of truth — all rates, caps,
    // thresholds, and supported AYs). Other modules (adapters,
    // reports, app) read these instead of redeclaring them.
    CONSTANTS: {
      // Slab boundaries
      OLD_REGIME_SLAB_0_END, OLD_REGIME_SLAB_1_END, OLD_REGIME_SLAB_2_END,
      NEW_REGIME_SLAB_0_END, NEW_REGIME_SLAB_1_END, NEW_REGIME_SLAB_2_END,
      NEW_REGIME_SLAB_3_END, NEW_REGIME_SLAB_4_END,
      // Slab rates
      RATE_ZERO, RATE_5PCT, RATE_10PCT, RATE_15PCT, RATE_20PCT, RATE_25PCT, RATE_30PCT, RATE_37PCT,
      // Standard deduction
      STD_DEDUCTION_OLD_REGIME,
      STD_DEDUCTION_NEW_REGIME_FY_24_25,
      STD_DEDUCTION_NEW_REGIME_FY_23_24,
      // Rebate 87A
      REBATE_87A_THRESHOLD_OLD_REGIME, REBATE_87A_MAX_TAX_OLD_REGIME,
      REBATE_87A_THRESHOLD_NEW_REGIME, REBATE_87A_MAX_TAX_NEW_REGIME,
      // Surcharge
      SURCHARGE_LOWER_50L, SURCHARGE_LOWER_1CR, SURCHARGE_LOWER_2CR, SURCHARGE_LOWER_5CR,
      SURCHARGE_RATE_BELOW_1CR, SURCHARGE_RATE_BELOW_2CR, SURCHARGE_RATE_BELOW_5CR,
      SURCHARGE_RATE_ABOVE_5CR_OLD, SURCHARGE_RATE_ABOVE_5CR_NEW,
      // Cess
      HEC_CESS_RATE,
      // Capital gains
      STCG_111A_RATE, LTCG_112A_RATE, LTCG_OTHER_RATE, LTCG_112A_EXEMPTION,
      // Lottery
      LOTTERY_RATE,
      // House property
      HP_SELF_OCCUPIED_INTEREST_CAP, HP_LET_OUT_STD_DEDUCTION_PCT, HP_FULL_OWNERSHIP_PCT,
      // Chapter VI-A caps
      // Chapter VI-A caps (80D has separate senior/non-senior caps;
      // 80TTA and 80TTB are mutually exclusive per §80TTB)
      CAP_80C, CAP_80CCD_1B,
      CAP_80D_SELF_FAMILY, CAP_80D_SELF_FAMILY_SENIOR,
      CAP_80D_PARENTS, CAP_80D_PARENTS_SENIOR,
      CAP_80TTA, CAP_80TTB,
      // Senior-citizen age threshold (per Section 80D / 80TTB)
      SENIOR_CITIZEN_AGE,
      // Loss carry forward
      LOSS_CARRY_FORWARD_YEARS,
      // 234B / 234C
      SEC_234B_RATE_PER_MONTH, SEC_234B_THRESHOLD, SEC_234B_MONTHS,
      SEC_234C_RATE_PER_MONTH,
      SEC_234C_THRESHOLD_Q1, SEC_234C_THRESHOLD_Q2, SEC_234C_THRESHOLD_Q3, SEC_234C_THRESHOLD_Q4,
      SEC_234C_MONTHS_Q1, SEC_234C_MONTHS_Q2, SEC_234C_MONTHS_Q3, SEC_234C_MONTHS_Q4,
      // ITR-1/2 selector
      ITR1_TOTAL_INCOME_MAX, ITR1_MAX_HP_PROPERTIES,
      // Form 16 sanity
      FORM16_GROSS_SALARY_SANITY_MAX,
      // AYs
      AY_2025_26, AY_2024_25, FY_FOR_AY, AY_TO_ITR_AY,
    },
    // Constants (for inspection)
    REGIMES: { OLD_REGIME_2024_25, NEW_REGIME_2024_25, NEW_REGIME_2023_24 },
    fmtRs,
  };
});
