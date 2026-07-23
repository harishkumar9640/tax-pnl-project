// js/adapters/form16a.js
// Form 16A parser: TDS on salary certificate issued quarterly
// by the employer. Different from Form 16 (which is the annual
// summary). Form 16A is one certificate per quarter per employer.
//
// What Form 16A contains (text-extracted from a typical PDF):
//   - TAN of the deductor (employer)
//   - PAN of the deductee (employee)
//   - Name of employee
//   - Amount paid / credited
//   - TDS amount
//   - Quarter (Q1, Q2, Q3, Q4)
//   - Assessment Year
//
// v1 scope: extract TAN, employee PAN, AY, total TDS across all
// quarters in the document. Multi-quarter certificates (e.g. one
// PDF with all 4 quarters consolidated) are summed. Single-quarter
// certificates are accepted as-is.
//
// The output is a Form 16A-shaped object that the bulk_import
// module can route to salary.tds.

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxForm16A = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // Local helpers (mirrored from integrations.js; the duplicate
  // is intentional to keep this module independently testable)
  // ============================================================

  const FORM16_MIN_ACCEPTED_AMOUNT = 100;

  function parseIndianNumber(text) {
    if (text === null || text === undefined) return null;
    const s = String(text);
    const NUMBER = String.raw`\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?`;
    const currencyMatch = s.match(new RegExp(`(?:Rs\\.?|₹|INR|\\$|£)\\s*(${NUMBER})`));
    if (currencyMatch) {
      const n = parseFloat(currencyMatch[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
    const standaloneMatch = s.match(new RegExp(`(${NUMBER})`));
    if (standaloneMatch) {
      const n = parseFloat(standaloneMatch[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function findAmountAfter(text, label, lookAhead = 3) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase().trim();
      if (line.startsWith(label.toLowerCase())) {
        for (let j = i; j < Math.min(i + 2, lines.length); j++) {
          const num = parseIndianNumber(lines[j]);
          if (num !== null && num >= FORM16_MIN_ACCEPTED_AMOUNT) return num;
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (line.includes(label.toLowerCase())) {
        for (let j = i; j < Math.min(i + lookAhead, lines.length); j++) {
          const num = parseIndianNumber(lines[j]);
          if (num !== null && num >= FORM16_MIN_ACCEPTED_AMOUNT) return num;
        }
      }
    }
    return null;
  }

  // ============================================================
  // AY detection (mirrored from integrations.js — kept independent
  // so form16a can be tested in isolation)
  // ============================================================
  //
  // Form 16A is always for a specific AY. Common patterns:
  //   "Assessment Year 2025-26"
  //   "AY 2025-26"
  //   "F.Y. 2024-25" (rare, but happens)

  const AY_2025_26 = "2025-26";
  const AY_2024_25 = "2024-25";
  function findAy(ayStr) {
    return ayStr === AY_2025_26 || ayStr === AY_2024_25
      ? { ay: ayStr, fy: ayStr === AY_2025_26 ? "2024-25" : "2023-24" }
      : null;
  }
  function findFy(fyStr) {
    if (fyStr === "2024-25") return { ay: "2025-26", fy: "2024-25" };
    if (fyStr === "2023-24") return { ay: "2024-25", fy: "2023-24" };
    return null;
  }

  function detectAyFromText(text) {
    if (!text || typeof text !== "string") return null;
    const norm = text.toLowerCase();
    const ayRe = /\b(?:a\.?\s*y\.?|assessment\s+year|a\/y)\s*[:\-_/]?\s*(\d{4})\s*[_\-\/]?\s*(\d{2,4})\b/i;
    let m = norm.match(ayRe);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2].length === 2 ? start + 1 : parseInt(m[2], 10);
      if (end === start + 1) {
        const ay = `${start}-${String(end).slice(-2)}`;
        if (findAy(ay)) return ay;
        if (findFy(ay)) return findFy(ay).ay;
      }
    }
    const fyRe = /\b(?:f\.?\s*y\.?|financial\s+year|income\s+year|year\s+ending|year\s+ended)\s*[:\-_/]?\s*(\d{4})\s*[_\-\/]?\s*(\d{2,4})\b/i;
    m = norm.match(fyRe);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2].length === 2 ? start + 1 : parseInt(m[2], 10);
      if (end === start + 1) {
        const fy = `${start}-${String(end).slice(-2)}`;
        const fyInfo = findFy(fy);
        if (fyInfo) return fyInfo.ay;
        const ayInfo = findAy(fy);
        if (ayInfo) return ayInfo.ay;
      }
    }
    return null;
  }

  // ============================================================
  // parseForm16AText — main entry
  // ============================================================
  //
  // @param {string} pdfText
  // @returns {Object} { ok, fields, warnings, errors, ay, fy }
  //
  // fields shape (mirrors Form 16's, minus gross_salary and
  // allowances which Form 16A doesn't carry):
  //   {
  //     employer: { tan: string, name: string },
  //     employee: { pan: string, name: string },
  //     tds_total: number,           // sum of all quarters in the document
  //     tds_quarterly: { Q1, Q2, Q3, Q4 },
  //     amount_paid: number,         // total amount paid (sum across quarters)
  //   }

  function parseForm16AText(pdfText) {
    if (typeof pdfText !== "string" || pdfText.trim() === "") {
      return {
        ok: false,
        fields: null,
        warnings: [],
        errors: ["PDF text is empty — was the PDF scanned? v1 supports text-based PDFs only."],
      };
    }
    const warnings = [];
    const fields = {
      employer: { tan: "", name: "" },
      employee: { pan: "", name: "" },
      tds_total: 0,
      tds_quarterly: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 },
      amount_paid: 0,
    };

    // --- Employer TAN ---
    const tanMatch = pdfText.match(/TAN[^\n]*?([A-Z]{4}\d{5}[A-Z])/i);
    if (tanMatch) fields.employer.tan = tanMatch[1].toUpperCase();
    else warnings.push("TAN not found in Form 16A");

    // --- Employee PAN ---
    const panMatch = pdfText.match(/PAN of (?:the )?(?:Employee|Deductee)[^\n]*?([A-Z]{5}\d{4}[A-Z])/i)
                  || pdfText.match(/\b([A-Z]{5}\d{4}[A-Z])\b/);
    if (panMatch) fields.employee.pan = panMatch[1].toUpperCase();
    else warnings.push("Employee PAN not found in Form 16A");

    // --- Total TDS across all quarters ---
    // Form 16A: look for "Total Tax Deducted" or "TDS" near the
    // summary section.
    fields.tds_total = findAmountAfter(pdfText, "Total Tax Deducted")
                    || findAmountAfter(pdfText, "Total TDS")
                    || findAmountAfter(pdfText, "TDS")
                    || 0;
    if (fields.tds_total === 0) warnings.push("TDS total not found");

    // --- Total amount paid ---
    fields.amount_paid = findAmountAfter(pdfText, "Amount paid")
                      || findAmountAfter(pdfText, "Total Amount")
                      || 0;

    // --- Quarterly TDS (Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar) ---
    // Different layouts put the quarter in different places:
    //   - Inline: "Q1 ... Rs. 30,000"
    //   - Tabular: "Q1 | Apr-Jun | Rs. 30,000"
    //   - Per-row: "Quarter ending 30-Jun-2024: Rs. 30,000"
    //
    // We try the inline Q1/Q2/Q3/Q4 pattern first, then fall back
    // to "quarter ending <date>" lookups.
    const qMatch = pdfText.match(/Q[1-4][^0-9]*([\d,]+(?:\.\d+)?)/gi);
    if (qMatch) {
      for (let i = 0; i < Math.min(4, qMatch.length); i++) {
        const num = parseIndianNumber(qMatch[i]);
        if (num !== null) fields.tds_quarterly[`Q${i + 1}`] = num;
      }
    } else {
      // Try "quarter ending DD-Mon-YYYY" pattern
      const qe = pdfText.match(/quarter\s+ending[^\n]*?(\d{1,2})[\/\-\.]\w+[\/\-\.](\d{4})[^\n]*?([\d,]+(?:\.\d+)?)/gi);
      if (qe) {
        for (const row of qe) {
          const dateMatch = row.match(/(\d{1,2})[\/\-\.]\w+[\/\-\.](\d{4})/);
          if (!dateMatch) continue;
          const month = parseInt(dateMatch[1], 10);
          const year = parseInt(dateMatch[2], 10);
          let q = 0;
          // Indian FY quarters: Q1=Apr-Jun(months 4-6), Q2=Jul-Sep(7-9), Q3=Oct-Dec(10-12), Q4=Jan-Mar(1-3)
          if (month >= 4 && month <= 6) q = 1;
          else if (month >= 7 && month <= 9) q = 2;
          else if (month >= 10 && month <= 12) q = 3;
          else if (month >= 1 && month <= 3) q = 4;
          if (q === 0) continue;
          const num = parseIndianNumber(row);
          if (num !== null && num >= FORM16_MIN_ACCEPTED_AMOUNT) {
            fields.tds_quarterly[`Q${q}`] = num;
          }
        }
      }
    }

    // If we found quarterly but no total, sum the quarters
    if (fields.tds_total === 0) {
      fields.tds_total = fields.tds_quarterly.Q1 + fields.tds_quarterly.Q2
        + fields.tds_quarterly.Q3 + fields.tds_quarterly.Q4;
    }

    // --- AY detection ---
    const detectedAy = detectAyFromText(pdfText);
    let detectedFy = null;
    if (detectedAy) {
      const ayInfo = findAy(detectedAy);
      if (ayInfo) detectedFy = ayInfo.fy;
    }
    if (!detectedAy) {
      warnings.push("Could not detect the Assessment Year from the Form 16A text. " +
        "The user will need to pick the AY manually.");
    }

    return {
      ok: true,
      fields,
      warnings,
      errors: [],
      ay: detectedAy,
      fy: detectedFy,
    };
  }

  return {
    parseForm16AText,
    // Exposed for tests
    _internal: { parseIndianNumber, findAmountAfter, detectAyFromText },
  };
});
