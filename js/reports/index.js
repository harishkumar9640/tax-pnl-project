// js/reports/index.js
// Printable summary report for the ITR Workbook.
//
// Generates a plain-text summary of the workbook's tax computation
// in both regimes, with the recommendation, and the per-head
// breakdown. Suitable for:
//   - Review by the user before filing
//   - Sending to a CA (chartered accountant) for advice
//   - Printing as a hard copy for personal records
//   - Saving alongside the JSON export
//
// v1 is text-only. A future v2 may add an HTML report (with
// inline CSS) and a PDF generator.

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxReports = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // IT-Act constants (re-exported from tax_engine for convenience)
  // ============================================================
  // The deduction caps (150K for 80C, 50K for 80CCD(1B), etc.) are
  // defined ONCE in tax_engine.js. We re-import them here so the
  // report can show "cap ₹X" annotations without duplicating the
  // numbers.
  const taxEngine = (typeof window !== "undefined" && window.taxEngine)
    || (typeof require !== "undefined" && require("../tax_engine.js"));
  const C = (taxEngine && taxEngine.CONSTANTS) || {};
  // Fall back to literal values if the engine is not loaded.
  const CAP_80C         = C.CAP_80C         || 150000;
  const CAP_80CCD_1B    = C.CAP_80CCD_1B    || 50000;
  const CAP_80D_PARENTS = C.CAP_80D_PARENTS || 25000;
  const CAP_80TTA       = C.CAP_80TTA       || 10000;
  const CAP_80TTB       = C.CAP_80TTB       || 50000;
  // 80CCD(2), 80E, 80G have no cap (per IT Act)

  // ============================================================
  // Helpers
  // ============================================================

  function fmtRs(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return "₹0";
    const sign = n < 0 ? "-" : "";
    return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  function pct(n) {
    if (!Number.isFinite(n)) return "0%";
    return (n * 100).toFixed(2) + "%";
  }

  function rule(char, width) {
    return char.repeat(width || 60);
  }

  function pad(s, width, align) {
    s = String(s == null ? "" : s);
    if (s.length >= width) return s;
    const fill = " ".repeat(width - s.length);
    if (align === "right") return fill + s;
    if (align === "center") {
      const left = Math.floor((width - s.length) / 2);
      const right = width - s.length - left;
      return " ".repeat(left) + s + " ".repeat(right);
    }
    return s + fill;
  }

  // ============================================================
  // Section builders
  // ============================================================

  function buildHeader(wb) {
    const lines = [];
    lines.push(rule("="));
    lines.push(pad("ITRready — Tax Computation Summary", 60, "center"));
    lines.push(pad(`Assessment Year: ${wb.ay} (FY ${wb.fy})`, 60, "center"));
    lines.push(rule("="));
    lines.push("");
    return lines.join("\n");
  }

  function buildPersonalInfo(wb) {
    const p = wb.personal;
    const lines = [];
    lines.push("PERSONAL INFORMATION");
    lines.push(rule("-"));
    if (p.name)     lines.push(pad("Name", 20) + p.name);
    if (p.pan)      lines.push(pad("PAN", 20) + p.pan);
    if (p.dob)      lines.push(pad("Date of Birth", 20) + p.dob);
    if (p.aadhaar_last4) lines.push(pad("Aadhaar (last 4)", 20) + "**** **** " + p.aadhaar_last4);
    if (p.mobile)   lines.push(pad("Mobile", 20) + p.mobile);
    if (p.email)    lines.push(pad("Email", 20) + p.email);
    lines.push(pad("Filing status", 20) + (p.filing_status || "(unset)"));
    if (p.address && (p.address.line1 || p.address.city)) {
      const addr = [p.address.line1, p.address.line2, p.address.city, p.address.state, p.address.pincode]
        .filter(Boolean).join(", ");
      lines.push(pad("Address", 20) + addr);
    }
    if (p.bank_for_refund && p.bank_for_refund.account_number) {
      const masked = p.bank_for_refund.account_number.length > 4
        ? "******" + p.bank_for_refund.account_number.slice(-4)
        : p.bank_for_refund.account_number;
      lines.push(pad("Bank a/c (refund)", 20) + masked);
    }
    if (p.bank_for_refund && p.bank_for_refund.ifsc) {
      lines.push(pad("IFSC", 20) + p.bank_for_refund.ifsc);
    }
    lines.push("");
    return lines.join("\n");
  }

  function buildIncomeSummary(result) {
    const lines = [];
    lines.push("INCOME BY HEAD (" + result.regime_label + ")");
    lines.push(rule("-"));
    const s = result.salary;
    const h = result.house;
    const o = result.other;
    const cg = result.cg;
    lines.push(pad("Salary (net)", 30) + pad(fmtRs(s.net_salary), 20, "right"));
    if (s.gross_salary) {
      lines.push(pad("  Gross salary", 30) + pad(fmtRs(s.gross_salary), 20, "right"));
    }
    if (s.exempt_10) {
      lines.push(pad("  Less: exempt u/s 10", 30) + pad("-" + fmtRs(s.exempt_10), 20, "right"));
    }
    if (s.standard_deduction) {
      lines.push(pad("  Less: std deduction", 30) + pad("-" + fmtRs(s.standard_deduction), 20, "right"));
    }
    if (s.professional_tax) {
      lines.push(pad("  Less: prof tax", 30) + pad("-" + fmtRs(s.professional_tax), 20, "right"));
    }
    lines.push(pad("House property (net)", 30) + pad(fmtRs(h.net_house_property), 20, "right"));
    lines.push(pad("Other sources (net)", 30) + pad(fmtRs(o.net_other_sources), 20, "right"));
    if (o.lottery) {
      lines.push(pad("  (Lottery, taxed 30%)", 30) + pad(fmtRs(o.lottery), 20, "right"));
    }
    lines.push(pad("Capital gains (net)", 30) + pad(fmtRs(cg.net_capital_gains), 20, "right"));
    if (cg.stcg_111a_gross) {
      lines.push(pad("  STCG 111A", 30) + pad(fmtRs(cg.stcg_111a_gross), 20, "right"));
    }
    if (cg.ltcg_112a_gross) {
      lines.push(pad("  LTCG 112A (pre-exemption)", 30) + pad(fmtRs(cg.ltcg_112a_gross), 20, "right"));
    }
    if (cg.ltcg_exemption_applied) {
      lines.push(pad("  Less: ₹1L exemption", 30) + pad("-" + fmtRs(cg.ltcg_exemption_applied), 20, "right"));
    }
    lines.push(pad("GROSS TOTAL INCOME", 30) + pad(fmtRs(result.gti), 20, "right"));
    lines.push(pad("  of which ordinary (slab)", 30) + pad(fmtRs(result.gti_ordinary), 20, "right"));
    lines.push("");
    return lines.join("\n");
  }

  function buildDeductionsSection(d) {
    const lines = [];
    lines.push("DEDUCTIONS (Chapter VI-A)");
    lines.push(rule("-"));
    const rows = [
      ["80C", d.c80c, CAP_80C],
      ["80CCD(1B) — NPS", d.c80ccd1b, CAP_80CCD_1B],
      ["80CCD(2) — employer NPS", d.c80ccd2, Infinity],
      ["80D — health insurance", d.c80d, CAP_80D_PARENTS * 2],   // 25K self + 25K parents
      ["80E — education loan", d.c80e, Infinity],
      ["80G — donations", d.c80g, Infinity],
      ["80TTA — savings int", d.c80tta, CAP_80TTA],
      ["80TTB — senior int", d.c80ttb, CAP_80TTB],
    ];
    for (const [label, amount, cap] of rows) {
      if (amount > 0) {
        const capStr = cap === Infinity ? "" : " (cap " + fmtRs(cap) + ")";
        lines.push(pad(label + capStr, 30) + pad(fmtRs(amount), 20, "right"));
      }
    }
    lines.push(pad("TOTAL DEDUCTIONS", 30) + pad(fmtRs(d.total_deductions), 20, "right"));
    lines.push("");
    return lines.join("\n");
  }

  function buildTaxComputation(result) {
    const lines = [];
    lines.push("TAX COMPUTATION (" + result.regime_label + ")");
    lines.push(rule("-"));
    lines.push(pad("Taxable income (ordinary)", 30) + pad(fmtRs(result.taxable_income), 20, "right"));
    lines.push("");
    lines.push(pad("Slab tax (pre-rebate)", 30) + pad(fmtRs(result.pre_rebate_tax), 20, "right"));
    if (result.rebate_87a > 0) {
      lines.push(pad("Less: rebate u/s 87A", 30) + pad("-" + fmtRs(result.rebate_87a), 20, "right"));
    }
    lines.push(pad("Slab tax (post-rebate)", 30) + pad(fmtRs(result.tax_after_rebate), 20, "right"));
    lines.push("");
    const cg = result.schedule_cg;
    if (cg.total_schedule_cg_tax > 0) {
      lines.push("Schedule CG (separate from slab):");
      if (cg.stcg_111a_tax > 0) {
        lines.push(pad("  STCG 111A @ 15%", 30) + pad(fmtRs(cg.stcg_111a_tax), 20, "right"));
      }
      if (cg.ltcg_112a_tax > 0) {
        lines.push(pad("  LTCG 112A @ 10%", 30) + pad(fmtRs(cg.ltcg_112a_tax), 20, "right"));
      }
      if (cg.ltcg_other_tax > 0) {
        lines.push(pad("  LTCG other @ 20%", 30) + pad(fmtRs(cg.ltcg_other_tax), 20, "right"));
      }
      lines.push(pad("  Schedule CG total", 30) + pad(fmtRs(cg.total_schedule_cg_tax), 20, "right"));
      lines.push("");
    }
    lines.push(pad("Tax before surcharge", 30) + pad(fmtRs(result.tax_before_surcharge), 20, "right"));
    if (result.surcharge > 0) {
      lines.push(pad("Surcharge @ " + pct(result.surcharge_rate), 30) + pad(fmtRs(result.surcharge), 20, "right"));
    }
    lines.push(pad("Health & Education Cess @ 4%", 30) + pad(fmtRs(result.cess), 20, "right"));
    if (result.lottery_tax > 0) {
      lines.push(pad("Lottery tax @ 30%", 30) + pad(fmtRs(result.lottery_tax), 20, "right"));
    }
    lines.push(pad("TOTAL TAX LIABILITY", 30) + pad(fmtRs(result.total_tax_liability), 20, "right"));
    lines.push(pad("  (rounded)", 30) + pad(fmtRs(result.total_tax_rounded), 20, "right"));
    lines.push("");
    return lines.join("\n");
  }

  function buildInterest234(result) {
    const i = result.interest_234;
    if (!i || i.total_234 === 0) return "";
    const lines = [];
    lines.push("INTEREST u/s 234 (not in total tax; added at filing)");
    lines.push(rule("-"));
    if (i.section_234b.interest > 0) {
      lines.push(pad("234B — late payment", 30) + pad(fmtRs(i.section_234b.interest), 20, "right"));
      lines.push(pad("  shortfall", 30) + pad(fmtRs(i.section_234b.shortfall), 20, "right"));
      lines.push(pad("  months", 30) + pad(String(i.section_234b.months), 20, "right"));
    }
    if (i.section_234c.total > 0) {
      lines.push(pad("234C — advance tax shortfall", 30) + pad(fmtRs(i.section_234c.total), 20, "right"));
      for (const inst of i.section_234c.per_installment) {
        if (inst.interest > 0) {
          lines.push(pad("  installment " + inst.installment, 30) + pad(fmtRs(inst.interest), 20, "right"));
        }
      }
    }
    lines.push(pad("TOTAL 234 INTEREST", 30) + pad(fmtRs(i.total_234), 20, "right"));
    lines.push("");
    return lines.join("\n");
  }

  function buildTdsAdjustment(result, wb) {
    const lines = [];
    lines.push("TAXES PAID (TDS / Advance Tax / Self-Assessment)");
    lines.push(rule("-"));
    const tp = wb.taxes_paid || {};
    const sp = wb.salary || {};
    if (sp.tds_total) lines.push(pad("TDS on salary", 30) + pad(fmtRs(sp.tds_total), 20, "right"));
    if (tp.tds_other_than_salary) lines.push(pad("TDS on other than salary", 30) + pad(fmtRs(tp.tds_other_than_salary), 20, "right"));
    if (tp.advance_tax) lines.push(pad("Advance tax", 30) + pad(fmtRs(tp.advance_tax), 20, "right"));
    if (tp.self_assessment_tax) lines.push(pad("Self-assessment tax", 30) + pad(fmtRs(tp.self_assessment_tax), 20, "right"));
    if (tp.tcs) lines.push(pad("TCS", 30) + pad(fmtRs(tp.tcs), 20, "right"));
    lines.push(pad("TOTAL TAXES PAID", 30) + pad(fmtRs(result.tds_total), 20, "right"));
    lines.push("");
    if (result.result === "refund") {
      lines.push(pad("REFUND DUE", 30) + pad(fmtRs(result.refund_due_rounded), 20, "right"));
    } else {
      lines.push(pad("TAX PAYABLE", 30) + pad(fmtRs(result.tax_payable_rounded), 20, "right"));
    }
    lines.push("");
    return lines.join("\n");
  }

  function buildRegimeComparison(taxResult) {
    const lines = [];
    lines.push("REGIME COMPARISON");
    lines.push(rule("-"));
    lines.push(pad("", 30) + pad("OLD REGIME", 20, "right") + pad("NEW REGIME", 20, "right"));
    lines.push(pad("Tax (rounded)", 30)
      + pad(fmtRs(taxResult.old.total_tax_rounded), 20, "right")
      + pad(fmtRs(taxResult.new.total_tax_rounded), 20, "right"));
    lines.push(pad("Refund / (Payable)", 30)
      + pad(taxResult.old.result === "refund"
              ? "Refund " + fmtRs(taxResult.old.refund_due_rounded)
              : "Pay " + fmtRs(taxResult.old.tax_payable_rounded), 20, "right")
      + pad(taxResult.new.result === "refund"
              ? "Refund " + fmtRs(taxResult.new.refund_due_rounded)
              : "Pay " + fmtRs(taxResult.new.tax_payable_rounded), 20, "right"));
    lines.push("");
    const rec = taxResult.recommendation;
    if (rec === "tie") {
      lines.push(pad("RECOMMENDATION: Both regimes result in the same tax.", 60));
    } else {
      const which = rec === "old" ? "OLD" : "NEW";
      lines.push(pad("RECOMMENDATION: Choose the " + which + " regime", 60));
      lines.push(pad("(saves you " + fmtRs(taxResult.savings) + " vs the other regime).", 60));
    }
    lines.push("");
    return lines.join("\n");
  }

  function buildFooter() {
    const lines = [];
    lines.push(rule("="));
    lines.push(pad("Generated by ITRready v1", 60, "center"));
    lines.push(pad("This is a preview, not a filed ITR.", 60, "center"));
    lines.push(pad("Cross-check with a CA before filing.", 60, "center"));
    lines.push(pad("Generated at " + new Date().toISOString(), 60, "center"));
    lines.push(rule("="));
    return lines.join("\n");
  }

  // ============================================================
  // Top-level
  // ============================================================

  /**
   * Build the full text report.
   * @param {Object} wb
   * @param {Object} taxResult  From computeBothRegimes(wb)
   * @param {Object} [opts]  { recommended: "old"|"new"|"tie" (default: taxResult.recommendation) }
   * @returns {string}
   */
  function buildReport(wb, taxResult, opts) {
    if (!wb) throw new Error("workbook is required");
    if (!taxResult || !taxResult.old || !taxResult.new) {
      throw new Error("taxResult is required (use computeBothRegimes)");
    }
    const rec = (opts && opts.recommended) || taxResult.recommendation || "old";
    const chosenResult = rec === "new" ? taxResult.new : taxResult.old;
    return [
      buildHeader(wb),
      buildPersonalInfo(wb),
      buildIncomeSummary(chosenResult),
      buildDeductionsSection(chosenResult.deductions),
      buildTaxComputation(chosenResult),
      buildInterest234(chosenResult),
      buildTdsAdjustment(chosenResult, wb),
      buildRegimeComparison(taxResult),
      buildFooter(),
    ].join("\n");
  }

  /**
   * Build a short "executive summary" — just the bottom line.
   * Useful for the dashboard card.
   * @param {Object} taxResult
   * @returns {string} 1-line summary
   */
  function buildOneLiner(taxResult) {
    const diff = taxResult.old.total_tax_rounded - taxResult.new.total_tax_rounded;
    if (diff === 0) {
      return `Both regimes: ${taxResult.old.total_tax_rounded === 0 ? "₹0" : fmtRs(taxResult.old.total_tax_rounded)} tax. No regime difference.`;
    }
    const winner = diff > 0 ? "new" : "old";
    return `${winner === "new" ? "New" : "Old"} regime wins by ${fmtRs(Math.abs(diff))}.`;
  }

  return {
    buildReport,
    buildOneLiner,
    // Exposed for tests
    _internal: { fmtRs, pct, buildHeader, buildPersonalInfo,
                 buildIncomeSummary, buildDeductionsSection,
                 buildTaxComputation, buildInterest234,
                 buildTdsAdjustment, buildRegimeComparison, buildFooter },
  };
});
