// js/adapters/bank_interest.js
// Bank interest certificate parser. Handles three flavours:
//   1. Savings account interest certificate (single annual figure)
//   2. FD (Fixed Deposit) interest certificate (one row per FD)
//   3. RD (Recurring Deposit) interest certificate
//   4. Bank statement CSV (HDFC, ICICI, SBI exports) with interest
//      credit lines identified by description
//
// Output shape (uniform across the four flavours):
//   {
//     ok: true,
//     ay: "2025-26",   // detected AY
//     fy: "2024-25",
//     entries: [
//       { kind: "savings"|"fd"|"rd"|"dividend"|"other",
//         bank: string, account_or_fd_no: string,
//         amount: number, period: string,
//         tds_deducted: number  // optional
//       },
//       ...
//     ],
//     total: number,    // sum of all amounts
//     errors: [],
//     warnings: []
//   }
//
// Scope notes:
//   - Dividend income: many bank statements show "dividend" credits.
//     We tag them kind: "dividend" and route them to
//     other_sources.dividend_gross.
//   - "TDS on interest" lines: we capture the TDS deducted in
//     entries[].tds_deducted (not summed; the user can add it to
//     the 26AS parser's TDS on interest).
//   - Interest certificates from banks: SBI, HDFC, ICICI, Axis, Kotak,
//     Yes Bank, IndusInd, PNB, Canara, Union Bank. (All major PSU
//     and private banks.)

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxBankInterest = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // Local helpers
  // ============================================================
  const BANK_NAMES = [
    "hdfc", "icici", "sbi", "state bank of india", "axis", "kotak",
    "yes bank", "indusind", "lic housing finance", "pnb", "punjab national",
    "canara", "union bank", "bank of baroda", "bob", "idfc first",
    "federal bank", "south indian bank", "karur vysya", "dbs",
    "citibank", "hsbc", "standard chartered", "deutsche", "rbl",
    "bandhan", "au small finance", "ujjivan", "equitas",
  ];

  const FORM16_MIN_ACCEPTED_AMOUNT = 50;  // lower than Form 16; FD interest can be small

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

  // Find an amount on the SAME line as a label, or on the next line.
  // Unlike findAmountAfter, this is more selective: the label must be
  // reasonably close to the number on the same line (e.g. "Interest
  // paid: Rs. 12,345"). It rejects pure numbers like account numbers.
  // We use this for bank interest certificates where the layout is
  // "Label: amount" and we don't want to match e.g. "Account Number:
  // 1234567890" because of the trailing zeros.
  function findAmountOnLabelLine(text, label) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      if (!lower.includes(label.toLowerCase())) continue;
      // Try the same line first
      const num = parseIndianNumber(line);
      if (num !== null && num >= FORM16_MIN_ACCEPTED_AMOUNT) {
        // Sanity check: if the line ALSO has a long digit run that
        // doesn't look like an amount (e.g. account number), prefer
        // the currency-tagged or shorter number
        const matches = [...line.matchAll(/(?:rs\.?|₹|inr|\$|£)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)/gi)];
        if (matches.length > 1) {
          // Multiple numbers on this line; pick the one with a currency
          // marker, or the shortest one that looks like an amount
          const withCurrency = matches.find((m) => /rs\.?|₹|inr|\$|£/i.test(m[0]));
          if (withCurrency) {
            const n = parseFloat(withCurrency[1].replace(/,/g, ""));
            if (Number.isFinite(n) && n >= FORM16_MIN_ACCEPTED_AMOUNT) return n;
          }
          // Otherwise pick the smallest amount-looking number (account
          // numbers tend to be longer digit runs)
          const amountCandidates = matches
            .map((m) => ({ raw: m[1], value: parseFloat(m[1].replace(/,/g, "")) }))
            .filter((c) => Number.isFinite(c.value) && c.value >= FORM16_MIN_ACCEPTED_AMOUNT);
          if (amountCandidates.length > 0) {
            amountCandidates.sort((a, b) => a.value - b.value);
            return amountCandidates[0].value;
          }
        }
        return num;
      }
      // Try the next line
      if (i + 1 < lines.length) {
        const num2 = parseIndianNumber(lines[i + 1]);
        if (num2 !== null && num2 >= FORM16_MIN_ACCEPTED_AMOUNT) {
          return num2;
        }
      }
    }
    return null;
  }

  // ============================================================
  // AY detection (mirrors form16a)
  // ============================================================
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
    // Period pattern: 01/04/2024 to 31/03/2025
    const periodRe = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s*(?:to|[-–])\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/i;
    m = norm.match(periodRe);
    if (m) {
      const startYear = parseInt(m[3], 10);
      const endYear = parseInt(m[6], 10);
      if (endYear === startYear + 1) {
        const fy = `${startYear}-${String(endYear).slice(-2)}`;
        const fyInfo = findFy(fy);
        if (fyInfo) return fyInfo.ay;
      }
    }
    return null;
  }

  function detectBankName(text) {
    const lower = text.toLowerCase();
    for (const b of BANK_NAMES) {
      if (lower.includes(b)) return b.toUpperCase();
    }
    return "";
  }

  // ============================================================
  // parseBankInterestText — text/PDF input
  // ============================================================
  //
  // Detects whether the text is a savings interest certificate
  // (one number) or a multi-FD statement (multiple numbers).
  // v1 is conservative: if we find more than one interest amount,
  // we treat it as multi-FD; otherwise single savings.

  function parseBankInterestText(text, fileName) {
    if (typeof text !== "string" || text.trim() === "") {
      return {
        ok: false,
        entries: [],
        total: 0,
        errors: ["Text is empty"],
        ay: null,
        fy: null,
      };
    }
    const warnings = [];
    const errors = [];
    const entries = [];
    const lower = text.toLowerCase();
    const bank = detectBankName(text);

    // --- Type detection ---
    // Savings interest cert: contains "savings account" + "interest"
    // AND only one amount, no "FD" / "fixed deposit"
    // FD cert: contains "fixed deposit" or "FD" with one or more
    //   interest lines
    // RD cert: contains "recurring deposit" or "RD"
    // Multi-row statement: many numbers + period headers

    const isMultiFd = /fixed\s+deposit|\bFD\b.*\binterest|fd\s+no\.?|deposit\s+no\.?/i.test(text)
      && (text.match(/interest/gi) || []).length > 1;
    const isRd = /recurring\s+deposit|\bRD\b.*\binterest/i.test(text);
    const isSavings = /savings\s+account|savings\s+bank\s+account/i.test(text)
      && (text.match(/interest/gi) || []).length === 1;

    // --- Detect AY ---
    const detectedAy = detectAyFromText(text);
    let detectedFy = null;
    if (detectedAy) {
      const ayInfo = findAy(detectedAy);
      if (ayInfo) detectedFy = ayInfo.fy;
    }
    if (!detectedAy) {
      warnings.push("Could not detect AY from text. Will need manual AY selection.");
    }

    // --- Total interest (single-row layout) ---
    if (isSavings || (!isMultiFd && !isRd)) {
      // Find the single interest amount. Use the label-line finder
      // (not findAmountAfter) so we don't accidentally match an
      // account number that's nearby in the text.
      const interestAmount = findAmountOnLabelLine(text, "Interest paid")
        || findAmountOnLabelLine(text, "Interest Credited")
        || findAmountOnLabelLine(text, "Total Interest")
        || findAmountOnLabelLine(text, "Interest")
        || 0;
      if (interestAmount === 0) {
        errors.push("No interest amount found in savings interest certificate");
        return { ok: false, entries, total: 0, errors, warnings, ay: detectedAy, fy: detectedFy };
      }
      // TDS deducted
      const tdsDeducted = findAmountAfter(text, "TDS") || 0;
      // Account number (best effort)
      const acMatch = text.match(/(?:account|a\/c)\s*(?:no|number)?[.\s:]*([0-9]{9,18})/i);
      entries.push({
        kind: "savings",
        bank: bank || "",
        account_or_fd_no: acMatch ? acMatch[1] : "",
        amount: interestAmount,
        period: detectedFy ? `FY ${detectedFy}` : "",
        tds_deducted: tdsDeducted,
      });
    } else if (isRd) {
      // RD: usually one or more RDs, each with its own interest
      // Find all "RD" + amount pairs
      const rdMatches = text.matchAll(/RD\s*(?:no|number)?[.\s:]*([0-9A-Z]+)?[^\d]*([\d,]+(?:\.\d+)?)/gi);
      for (const m of rdMatches) {
        const amt = parseFloat(m[2].replace(/,/g, ""));
        if (Number.isFinite(amt) && amt >= FORM16_MIN_ACCEPTED_AMOUNT) {
          entries.push({
            kind: "rd",
            bank: bank || "",
            account_or_fd_no: m[1] || "",
            amount: amt,
            period: detectedFy ? `FY ${detectedFy}` : "",
            tds_deducted: 0,
          });
        }
      }
      if (entries.length === 0) {
        // Fallback: total interest on a single RD
        const interestAmount = findAmountAfter(text, "Interest")
          || findAmountAfter(text, "Total Interest") || 0;
        if (interestAmount > 0) {
          entries.push({
            kind: "rd",
            bank: bank || "",
            account_or_fd_no: "",
            amount: interestAmount,
            period: detectedFy ? `FY ${detectedFy}` : "",
            tds_deducted: 0,
          });
        } else {
          errors.push("RD certificate but no interest amount found");
          return { ok: false, entries, total: 0, errors, warnings, ay: detectedAy, fy: detectedFy };
        }
      }
    } else {
      // Multi-FD statement
      // Try to find FD-number + interest pairs
      // Pattern: "FD No: XXXX | Interest: Rs. 12,345" or similar
      const fdMatches = text.matchAll(/FD\s*(?:no|number)?[.\s:]*([0-9A-Z]+)[^\d]*?interest[^\d]*([\d,]+(?:\.\d+)?)/gi);
      for (const m of fdMatches) {
        const amt = parseFloat(m[2].replace(/,/g, ""));
        if (Number.isFinite(amt) && amt >= FORM16_MIN_ACCEPTED_AMOUNT) {
          entries.push({
            kind: "fd",
            bank: bank || "",
            account_or_fd_no: m[1] || "",
            amount: amt,
            period: detectedFy ? `FY ${detectedFy}` : "",
            tds_deducted: 0,
          });
        }
      }
      if (entries.length === 0) {
        // Fallback: find all "interest" lines with amounts
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (/interest/i.test(lines[i])) {
            const num = parseIndianNumber(lines[i]);
            if (num !== null && num >= FORM16_MIN_ACCEPTED_AMOUNT) {
              entries.push({
                kind: "fd",
                bank: bank || "",
                account_or_fd_no: "",
                amount: num,
                period: detectedFy ? `FY ${detectedFy}` : "",
                tds_deducted: 0,
              });
            }
          }
        }
      }
      if (entries.length === 0) {
        errors.push("FD statement but no interest amounts found");
        return { ok: false, entries, total: 0, errors, warnings, ay: detectedAy, fy: detectedFy };
      }
    }

    const total = entries.reduce((s, e) => s + e.amount, 0);
    return {
      ok: true,
      entries,
      total,
      errors: [],
      warnings,
      ay: detectedAy,
      fy: detectedFy,
    };
  }

  // ============================================================
  // parseBankInterestCsv — CSV with date/description/amount
  // ============================================================
  //
  // Looks for credit lines (positive amounts in bank statement)
  // whose description contains "interest" or "dividend".
  // Sums them by category.

  function parseBankInterestCsv(text, fileName) {
    if (typeof text !== "string" || text.trim() === "") {
      return {
        ok: false, entries: [], total: 0,
        errors: ["CSV text is empty"],
        ay: null, fy: null,
      };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return {
        ok: false, entries: [], total: 0,
        errors: ["CSV has fewer than 2 lines"],
        ay: null, fy: null,
      };
    }
    // Detect headers
    const headerLine = lines[0].toLowerCase();
    const hasDate = /date/.test(headerLine);
    const hasDesc = /description|narration|particulars|details/.test(headerLine);
    const hasAmount = /amount|credit|deposit/.test(headerLine);
    if (!hasDate || !hasDesc || !hasAmount) {
      return {
        ok: false, entries: [], total: 0,
        errors: ["CSV doesn't have expected columns (date, description, amount)"],
        ay: null, fy: null,
      };
    }
    // Find column indices
    const headers = splitCsvLine(lines[0]);
    const dateIdx = headers.findIndex((h) => /date/i.test(h));
    const descIdx = headers.findIndex((h) => /description|narration|particulars|details/i.test(h));
    const amountIdx = headers.findIndex((h) => /amount|credit|deposit/i.test(h));
    // For statements with separate "withdrawal" and "deposit" columns,
    // prefer the deposit/credit column
    const creditIdx = headers.findIndex((h) => /^(credit|deposit|cr)$/i.test(h.trim()));
    const effectiveAmountIdx = creditIdx >= 0 ? creditIdx : amountIdx;

    const entries = [];
    const bank = detectBankName(lines.slice(0, Math.min(10, lines.length)).join("\n"));
    const errors = [];
    const warnings = [];

    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      if (row.length < 3) continue;
      const desc = (row[descIdx] || "").toLowerCase();
      const isInterest = /interest/i.test(desc);
      const isDividend = /dividend/i.test(desc);
      if (!isInterest && !isDividend) continue;
      const amtStr = (row[effectiveAmountIdx] || "").replace(/,/g, "").replace(/[^\d.\-]/g, "");
      const amt = parseFloat(amtStr);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      entries.push({
        kind: isDividend ? "dividend" : "savings",
        bank: bank || "",
        account_or_fd_no: "",
        amount: amt,
        period: (row[dateIdx] || "") + "",
        tds_deducted: 0,
      });
    }

    if (entries.length === 0) {
      return {
        ok: false, entries: [], total: 0,
        errors: ["No interest or dividend credit lines found in CSV"],
        ay: null, fy: null,
      };
    }

    // Try to detect AY from the date range
    let detectedAy = null;
    let detectedFy = null;
    const dates = entries.map((e) => e.period).filter((d) => /\d{4}/.test(d));
    if (dates.length > 0) {
      // Use the year from the latest date — if it's April-March FY
      // and falls in months 4-12, FY is (year)-(year+1). If months 1-3,
      // FY is (year-1)-(year).
      const latest = dates[dates.length - 1];
      const m = latest.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
      if (m) {
        const month = parseInt(m[1], 10);
        let year = parseInt(m[3], 10);
        if (year < 100) year += 2000;
        let fy;
        if (month >= 4) fy = `${year}-${String(year + 1).slice(-2)}`;
        else fy = `${year - 1}-${String(year).slice(-2)}`;
        const fyInfo = findFy(fy);
        if (fyInfo) { detectedAy = fyInfo.ay; detectedFy = fyInfo.fy; }
      }
    }

    const total = entries.reduce((s, e) => s + e.amount, 0);
    return {
      ok: true,
      entries,
      total,
      errors: [],
      warnings,
      ay: detectedAy,
      fy: detectedFy,
    };
  }

  // ============================================================
  // parseBankInterestJson — JSON export of a bank statement
  // ============================================================
  //
  // Bank apps like HDFC, ICICI, SBI often allow JSON export
  // (or JSON download from the "Download statement" link).
  // Expected shape (one of):
  //   { "transactions": [{ "date", "description", "amount", "type" }] }
  //   { "Transactions": [{ "TxnDate", "Narration", "Amount", "DrCr" }] }
  //
  // The parser is liberal about field names.

  function parseBankInterestJson(json, fileName) {
    if (!json || typeof json !== "object") {
      return { ok: false, entries: [], total: 0, errors: ["Not a JSON object"], ay: null, fy: null };
    }
    // Find the transactions array
    const txs = json.transactions || json.Transactions || json.TxnList
      || json.Statement || json.Transactions;
    if (!Array.isArray(txs) || txs.length === 0) {
      return { ok: false, entries: [], total: 0,
        errors: ["No transactions array found in JSON"],
        ay: null, fy: null };
    }
    // Normalize field names
    const entries = [];
    const bank = detectBankName(JSON.stringify(json).slice(0, 2000));
    for (const tx of txs) {
      const desc = String(tx.description || tx.Description || tx.narration || tx.Narration || tx.particulars || "");
      const isInterest = /interest/i.test(desc);
      const isDividend = /dividend/i.test(desc);
      if (!isInterest && !isDividend) continue;
      const amt = +tx.amount || +tx.Amount || +tx.credit || +tx.Credit || +tx.Deposit || 0;
      if (amt <= 0) continue;
      const date = tx.date || tx.Date || tx.TxnDate || tx.TransactionDate || "";
      entries.push({
        kind: isDividend ? "dividend" : "savings",
        bank: bank || "",
        account_or_fd_no: tx.account || tx.Account || "",
        amount: amt,
        period: String(date),
        tds_deducted: 0,
      });
    }
    if (entries.length === 0) {
      return { ok: false, entries: [], total: 0,
        errors: ["No interest or dividend transactions found in JSON"],
        ay: null, fy: null };
    }
    // Detect AY from date range (same as CSV path)
    let detectedAy = null;
    let detectedFy = null;
    const dates = entries.map((e) => e.period).filter((d) => /\d{4}/.test(d));
    if (dates.length > 0) {
      const latest = dates[dates.length - 1];
      const m = String(latest).match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
      if (m) {
        const month = parseInt(m[1], 10);
        let year = parseInt(m[3], 10);
        if (year < 100) year += 2000;
        let fy;
        if (month >= 4) fy = `${year}-${String(year + 1).slice(-2)}`;
        else fy = `${year - 1}-${String(year).slice(-2)}`;
        const fyInfo = findFy(fy);
        if (fyInfo) { detectedAy = fyInfo.ay; detectedFy = fyInfo.fy; }
      }
    }
    const total = entries.reduce((s, e) => s + e.amount, 0);
    return { ok: true, entries, total, errors: [], warnings: [], ay: detectedAy, fy: detectedFy };
  }

  // CSV line splitter that handles quoted fields
  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  return {
    parseBankInterestText,
    parseBankInterestCsv,
    parseBankInterestJson,
    // Exposed for tests
    _internal: { parseIndianNumber, findAmountAfter, findAmountOnLabelLine,
                 detectAyFromText, detectBankName, splitCsvLine, BANK_NAMES },
  };
});
