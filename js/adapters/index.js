// js/adapters/index.js
// Export adapters for the ITR Workbook.
//
// What this module does in v1:
//   - selectItrForm(workbook): pick ITR-1 or ITR-2 based on income
//     sources + filing status.
//   - toItrJson(workbook, taxResult): export as a clean JSON that
//     the user can copy into the ITR utility (or save as a file).
//   - toFile(blob, filename): trigger a browser download.
//   - toClipboard(text): copy text to clipboard (with fallback).
//
// What this module does NOT do (yet):
//   - Direct e-filing to the IT portal (requires DSC/Aadhaar OTP,
//     out of scope for v1 — privacy-first offline app).
//   - Full ITR JSON schema (which is enormous: ~50 KB of rules).
//   - XML export (ITR utility takes JSON or manual input; XML
//     export can be added in v2 if the user wants it).
//
// v1 is for "copy to the ITR utility" workflows and for review by
// a CA before manual filing.

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxAdapters = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // IT-Act constants (re-exported from tax_engine for convenience)
  // ============================================================
  // These values are defined ONCE in tax_engine.js — the single
  // source of truth. We re-import them here so this module can
  // reference named constants (e.g. ITR1_TOTAL_INCOME_MAX) instead
  // of hardcoding `5000000` or `50e5` in business logic.
  const taxEngine = (typeof window !== "undefined" && window.taxEngine)
    || (typeof require !== "undefined" && require("../tax_engine.js"));
  const C = (taxEngine && taxEngine.CONSTANTS) || {};
  // Fall back to literal values if the engine is not loaded (defensive).
  const ITR1_TOTAL_INCOME_MAX = C.ITR1_TOTAL_INCOME_MAX || 5000000;
  const ITR1_MAX_HP_PROPERTIES = C.ITR1_MAX_HP_PROPERTIES || 1;

  // UI timings (not IT-Act; module-local configuration)
  const DOWNLOAD_CLEANUP_MS = 100;  // delay before revoking the download URL

  // ============================================================
  // ITR-1 vs ITR-2 selector
  // ============================================================
  //
  // ITR-1 (Sahaj): for resident individuals with income from
  //   salary, one house property, other sources (interest, etc.),
  //   and total income ≤ ₹50L. NOT for: business income, capital
  //   gains, foreign income, NRI, more than 1 HP.
  //
  // ITR-2: for individuals / HUFs WITHOUT business income but
  //   who have capital gains, more than 1 HP, foreign income,
  //   or are NRI.
  //
  // ITR-3 / ITR-4 are out of scope (business income).

  /**
   * Select the ITR form (1 or 2) for a given workbook.
   * Personal info (filing_status) is now in the profile, not the workbook.
   * @param {Object} wb
   * @param {Object} [profile]  The global profile (PAN, filing_status, etc.)
   * @returns {"ITR-1"|"ITR-2"|"ITR-3 (out of scope)"}
   */
  function selectItrForm(wb, profile) {
    if (!wb) return "ITR-1";
    // Backward compat: if the workbook still has personal data
    // (e.g. legacy tests), use it.
    const p = profile || wb.personal || {};
    // NRI → ITR-2
    if (p.filing_status === "nri") return "ITR-2";
    // RNOR (Resident but Not Ordinarily Resident) → ITR-2
    if (p.filing_status === "rnor") return "ITR-2";
    // More than ITR1_MAX_HP_PROPERTIES house properties → ITR-2
    const hpCount = (wb.house_property && wb.house_property.properties)
      ? wb.house_property.properties.length : 0;
    if (hpCount > ITR1_MAX_HP_PROPERTIES) return "ITR-2";
    // Any capital gains → ITR-2
    const cg = wb.capital_gains || {};
    const hasCG = (cg.stcg_111a || 0) + (cg.ltcg_112a || 0)
                + (cg.stcg_other || 0) + (cg.ltcg_other || 0) > 0;
    if (hasCG) return "ITR-2";
    // Total income > ITR-1 upper limit → ITR-2
    if (wb._gti && wb._gti > ITR1_TOTAL_INCOME_MAX) return "ITR-2";
    return "ITR-1";
  }

  // ============================================================
  // JSON export
  // ============================================================

  /**
   * Export the workbook + tax result as a clean, human-readable
   * JSON object. The shape is intentionally flat-ish so the user
   * can paste it into the ITR utility or share with a CA.
   * @param {Object} wb
   * @param {Object} taxResult  From computeBothRegimes(wb)
   * @param {Object} [profile]  Global profile (PAN, name, etc.) — optional,
   *   for backward compat. If not provided, the function looks at
   *   wb.personal (legacy v1 shape).
   * @returns {Object}
   */
  function toItrJson(wb, taxResult, profile) {
    if (!wb) throw new Error("workbook is required");
    if (!taxResult || !taxResult.old || !taxResult.new) {
      throw new Error("taxResult is required (use computeBothRegimes)");
    }
    // Personal info source: explicit profile arg > legacy wb.personal > empty
    const p = profile || wb.personal || {};
    const rec = taxResult.recommendation;
    const chosen = rec === "old" ? "old" : (rec === "new" ? "new" : "tie");
    // For a "tie", default to whichever the user has opted into
    // (p.new_regime) or "old" if unspecified.
    const chosenRegime = chosen === "tie"
      ? (p && p.new_regime ? "new" : "old")
      : chosen;
    const chosenResult = chosenRegime === "old" ? taxResult.old : taxResult.new;

    return {
      _meta: {
        generator: "ITRready v1",
        generated_at: new Date().toISOString(),
        ay: wb.ay,
        fy: wb.fy,
        itr_form: selectItrForm(wb, p),
        regime_chosen: chosenRegime,
        regime_recommendation: rec,
        regime_savings: taxResult.savings,
      },
      personal_info: {
        pan: p.pan,
        name: p.name,
        dob: p.dob,
        aadhaar_last4: p.aadhaar_last4,
        mobile: p.mobile,
        email: p.email,
        filing_status: p.filing_status,
        address: p.address,
        bank_for_refund: {
          // Mask the full account number in the export; only the
          // last 4 digits are visible. The user can fill the full
          // number in the ITR utility directly.
          account_number_masked: maskAccount(p.bank_for_refund && p.bank_for_refund.account_number),
          ifsc: p.bank_for_refund && p.bank_for_refund.ifsc,
          bank_name: p.bank_for_refund && p.bank_for_refund.bank_name,
          account_type: p.bank_for_refund && p.bank_for_refund.account_type,
        },
      },
      income_heads: {
        salary: chosenResult.salary,
        house_property: chosenResult.house,
        other_sources: chosenResult.other,
        capital_gains: chosenResult.cg,
      },
      deductions: chosenResult.deductions,
      computation: {
        gross_total_income: chosenResult.gti,
        gross_total_income_ordinary: chosenResult.gti_ordinary,
        total_deductions: chosenResult.deductions.total_deductions,
        taxable_income: chosenResult.taxable_income,
        slab_tax: chosenResult.tax_after_rebate,
        rebate_87a: chosenResult.rebate_87a,
        schedule_cg_tax: chosenResult.schedule_cg,
        tax_before_surcharge: chosenResult.tax_before_surcharge,
        surcharge: chosenResult.surcharge,
        surcharge_rate: chosenResult.surcharge_rate,
        cess: chosenResult.cess,
        lottery_tax: chosenResult.lottery_tax,
        interest_234: chosenResult.interest_234,
        total_tax_liability: chosenResult.total_tax_liability,
      },
      taxes_paid: {
        tds_salary: (wb.salary && wb.salary.tds_total) || 0,
        tds_other_than_salary: (wb.taxes_paid && wb.taxes_paid.tds_other_than_salary) || 0,
        advance_tax: (wb.taxes_paid && wb.taxes_paid.advance_tax) || 0,
        self_assessment_tax: (wb.taxes_paid && wb.taxes_paid.self_assessment_tax) || 0,
        tcs: (wb.taxes_paid && wb.taxes_paid.tcs) || 0,
        total: chosenResult.tds_total,
      },
      result: {
        net_payable: chosenResult.net_payable,
        refund_due: chosenResult.refund_due,
        tax_payable: chosenResult.tax_payable,
        status: chosenResult.result,
        total_tax_rounded: chosenResult.total_tax_rounded,
        refund_due_rounded: chosenResult.refund_due_rounded,
        tax_payable_rounded: chosenResult.tax_payable_rounded,
      },
      regime_comparison: {
        old: {
          total_tax_rounded: taxResult.old.total_tax_rounded,
          tax_payable: taxResult.old.tax_payable_rounded,
          refund_due: taxResult.old.refund_due_rounded,
        },
        new: {
          total_tax_rounded: taxResult.new.total_tax_rounded,
          tax_payable: taxResult.new.tax_payable_rounded,
          refund_due: taxResult.new.refund_due_rounded,
        },
      },
    };
  }

  /**
   * Mask a bank account number, showing only the last 4 digits.
   * E.g. "1234567890" → "******7890"
   */
  function maskAccount(acct) {
    if (!acct || typeof acct !== "string") return "";
    const last4 = acct.slice(-4);
    if (acct.length <= 4) return last4;
    return "*".repeat(acct.length - 4) + last4;
  }

  // ============================================================
  // File download (browser)
  // ============================================================

  /**
   * Trigger a browser download of the given text as a file.
   * @param {string} text  The file contents
   * @param {string} filename  e.g. "itr-2025-26.json"
   * @param {string} mimeType  e.g. "application/json" (default)
   * @returns {boolean} true if download was triggered
   */
  function toFile(text, filename, mimeType) {
    if (typeof document === "undefined") return false;  // not in browser
    const mt = mimeType || "application/octet-stream";
    const blob = new Blob([text], { type: mt });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, DOWNLOAD_CLEANUP_MS);
    return true;
  }

  /**
   * Convenience: export the workbook as a JSON file download.
   * @param {Object} wb
   * @param {Object} taxResult
   * @returns {boolean} true if download was triggered
   */
  function downloadItrJson(wb, taxResult) {
    const obj = toItrJson(wb, taxResult);
    const text = JSON.stringify(obj, null, 2);
    const filename = `itr-${wb.ay}-${selectItrForm(wb).toLowerCase()}.json`;
    return toFile(text, filename, "application/json");
  }

  // ============================================================
  // Clipboard
  // ============================================================

  /**
   * Copy text to the system clipboard. Uses the modern
   * navigator.clipboard API with a fallback to document.execCommand.
   * @param {string} text
   * @returns {Promise<boolean>} resolves to true on success
   */
  async function toClipboard(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // fall through to legacy method
      }
    }
    // Legacy fallback (works in older browsers / non-secure contexts)
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    }
    return false;
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    selectItrForm,
    toItrJson,
    toFile,
    downloadItrJson,
    toClipboard,
    maskAccount,
  };
});
