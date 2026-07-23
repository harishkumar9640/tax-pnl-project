// js/bulk_import.js
// Bulk-import orchestration: take an array of File objects (from
// drag-and-drop or multi-select), classify each one, parse it with
// the right adapter, and return a "staging table" that the UI
// can render. The user reviews the staging table, resolves any
// conflicts, and clicks "Apply all" to commit the changes to the
// right year's workbooks.
//
// v1 supported parsers (one staging row per file):
//   - Form 16 PDF/TXT     → integrations.parseForm16Text
//   - Form 16A PDF/TXT    → adapters/form16a.parseForm16AText  (TDS on salary certificate)
//   - Form 26AS JSON      → integrations.parseForm26ASJson
//   - AIS JSON            → same parser as 26AS (IT department's two names for the same thing)
//   - Bank interest cert  → adapters/bank_interest.parseBankInterestText  (FD/RD/savings)
//   - Broker Tax P&L      → adapters/brokers.parseBrokerFile  (Angel One, Zerodha, Generic)
//
// What v1 does NOT support (planned for v2):
//   - Scanned/image PDFs (no OCR yet — user must OCR first or use TXT)
//   - House property rent receipts (manual entry in the form)
//   - Capital gains statements from Demat (CDS, NSDL) — the broker
//     P&L parser covers equity, but not the bond/debenture/SGB lines
//     that show up in a full Demat P&L
//
// All parsing happens client-side. No file ever leaves the browser.
//
// Each staging row looks like:
//   {
//     id: string,             // stable per-batch id (uuid-like, no crypto dep)
//     file: File,             // the original File object
//     filename: string,
//     kind: string,           // 'form16' | 'form16a' | 'form26as' | 'ais' |
//                             // 'bank_interest' | 'broker_pnl' | 'unknown'
//     ok: boolean,            // did the parser succeed?
//     errors: string[],       // fatal errors
//     warnings: string[],     // non-fatal warnings
//     targetAy: string|null,  // the AY this file applies to
//     targetFy: string|null,
//     targetSection: string,  // 'salary' | 'taxes_paid' | 'capital_gains' |
//                             // 'other_sources' | 'salary.tds'
//     parsed: Object|null,    // the parser's structured output
//     conflicts: Conflict[],  // populated when compared with workbook existing data
//     hash: string,           // SHA-256-like content hash for dedup (simple variant)
//   }
//
// A Conflict is:
//   {
//     field: string,          // workbook field path
//     existing: any,          // current value in the workbook
//     incoming: any,          // value from this file
//     resolution: 'existing' | 'incoming' | 'sum' | null,  // user picks
//     sources: string[],      // filenames contributing (for cross-file conflicts)
//   }

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.bulkImport = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // Lazy-loaded module references (avoid circular deps)
  // ============================================================
  function getIntegrations() {
    return (typeof window !== "undefined" && window.taxIntegrations)
      || (typeof require !== "undefined" && require("./integrations.js"));
  }
  function getBrokers() {
    return (typeof window !== "undefined" && window.taxBrokers)
      || (typeof require !== "undefined" && require("./adapters/brokers.js"));
  }
  function getDataModel() {
    return (typeof window !== "undefined" && window.taxDataModel)
      || (typeof require !== "undefined" && require("./data_model.js"));
  }
  function getForm16A() {
    return (typeof window !== "undefined" && window.taxForm16A)
      || (typeof require !== "undefined" && require("./adapters/form16a.js"));
  }
  function getBankInterest() {
    return (typeof window !== "undefined" && window.taxBankInterest)
      || (typeof require !== "undefined" && require("./adapters/bank_interest.js"));
  }
  function getSheetJSLoader() {
    return (typeof window !== "undefined" && window.SheetJSLoader)
      || null;  // only available in browser
  }
  function getPDFJSLib() {
    return (typeof window !== "undefined" && window.PDFJS_STUB)
      || null;
  }

  // ============================================================
  // Content-hash dedup (simple, non-crypto, good enough)
  // ============================================================
  //
  // We hash the first 4 KB of the file plus its size. This catches
  // exact-duplicate drops (same file dropped twice) and most
  // near-duplicates (e.g. the user accidentally selects the same
  // Form 16 from two different folders). It does NOT catch
  // semantic duplicates (e.g. two Form 16s from the same employer
  // covering the same period). For that, the user reviews the
  // staging table and removes the duplicate.
  //
  // We use FNV-1a 32-bit, a fast non-crypto hash, because crypto.subtle
  // is async and would complicate the drag-drop pipeline. Collision
  // probability for 4KB blocks is ~1 in 4 billion — fine for dedup.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  async function computeHash(file) {
    // For small files, hash the whole content. For large files,
    // hash the first 4 KB + size + filename. This is a dedup hash,
    // not a security hash.
    const size = file.size || 0;
    let head = "";
    if (size <= 16384) {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) head += String.fromCharCode(bytes[i]);
      } catch (e) {
        head = "";
      }
    } else {
      try {
        const slice = file.slice(0, 4096);
        const buf = await slice.arrayBuffer();
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) head += String.fromCharCode(bytes[i]);
      } catch (e) {
        head = "";
      }
    }
    return fnv1a(`${size}|${head}`);
  }

  // ============================================================
  // File classification — pick the right parser for a file
  // ============================================================
  //
  // Order of checks (most specific first):
  //   1. JSON content (peek inside) — Form 26AS / AIS / bank statement JSON exports
  //   2. xlsx/xls (SheetJS) — broker P&L
  //   3. csv — Zerodha Console P&L, or bank statement CSV
  //   4. pdf — Form 16 / Form 16A / bank interest certificate (text-extracted)
  //   5. txt — anything else (likely Form 16 from a non-PDF source)
  //
  // The classifier returns { kind, confidence } so the UI can warn
  // the user if a file matched with low confidence (e.g. "Looks like
  // a CSV but I can't find any expected columns — please verify").

  function classifyByExtension(name) {
    const lower = (name || "").toLowerCase();
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".pdf")) return "pdf";
    if (lower.endsWith(".txt")) return "txt";
    return "unknown";
  }

  // Sniff a JSON file's first chars to identify Form 26AS / AIS
  async function sniffJsonKind(text) {
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== "object") return { kind: "unknown", confidence: 0 };
      // 26AS / AIS detection: has section keys (case-insensitive)
      const sectionHints = [
        "TDS_on_Salary", "TDS_on_Others", "TDS_on_Sale_of_Assets",
        "Advance_Tax", "Self_Assessment_Tax", "TCS",
        "TDS_on_Rent", "TDS_on_Interest", "TDS_on_Dividend",
      ];
      const has26As = sectionHints.some((k) =>
        Object.keys(obj).some((ok) => ok.toLowerCase() === k.toLowerCase()
          || ok.toLowerCase().replace(/_/g, " ") === k.toLowerCase().replace(/_/g, " "))
      );
      if (has26As) {
        // Distinguish 26AS vs AIS: AIS has "AIS" or "Annual Information Statement" field
        const isAis = Object.keys(obj).some((k) => /ais|annual.information/i.test(k));
        return {
          kind: isAis ? "ais" : "form26as",
          confidence: 0.95,
        };
      }
      // Bank statement JSON (HDFC, ICICI, SBI exports look like
      // { "transactions": [{ "date", "description", "amount", "type" }] })
      if (Array.isArray(obj.transactions) || Array.isArray(obj.Transactions)) {
        return { kind: "bank_interest", confidence: 0.7 };
      }
      return { kind: "unknown", confidence: 0 };
    } catch (e) {
      return { kind: "unknown", confidence: 0 };
    }
  }

  // Sniff a CSV file's first line to identify its type
  function sniffCsvKind(text) {
    const firstLine = (text.split(/\r?\n/)[0] || "").toLowerCase();
    // Zerodha Console P&L headers
    if (firstLine.includes("symbol") && (firstLine.includes("buy") || firstLine.includes("sell"))) {
      return { kind: "broker_pnl", confidence: 0.85, broker: "zerodha" };
    }
    // Bank statement CSV (HDFC, ICICI, SBI)
    if ((firstLine.includes("date") && firstLine.includes("description") && firstLine.includes("amount"))
        || firstLine.includes("deposit") || firstLine.includes("withdrawal")
        || firstLine.includes("credit") || firstLine.includes("debit")) {
      return { kind: "bank_interest", confidence: 0.6 };
    }
    return { kind: "unknown", confidence: 0 };
  }

  // Sniff a PDF/TXT file's content for Form 16 / Form 16A / bank interest
  function sniffTextKind(text) {
    if (!text || text.length < 50) return { kind: "unknown", confidence: 0 };
    const lower = text.toLowerCase();
    // Form 16: contains "Form 16" and "TAN" and one of: "Gross Salary",
    // "section 17(1)", "Part A" or "Part B"
    const isForm16 = /form\s*16/.test(lower)
      && /tan[^\n]{0,20}[a-z]{4}\d{5}[a-z]/i.test(text)
      && (/gross\s*salary/.test(lower) || /section\s*17/.test(lower)
          || /part[\s_-]*a/.test(lower) || /part[\s_-]*b/.test(lower));
    if (isForm16) return { kind: "form16", confidence: 0.95 };
    // Form 16A: "Form 16A" or "TDS on Salary" + "Certificate" + TAN/employee pattern
    const isForm16A = /form\s*16\s*a/.test(lower)
      || (/certificate.*tds/i.test(text) && /tds\s*on\s*salary/i.test(text)
          && /tan[^\n]{0,20}[a-z]{4}\d{5}[a-z]/i.test(text));
    if (isForm16A) return { kind: "form16a", confidence: 0.9 };
    // Bank interest certificate: contains bank-like terms + interest amount
    // + period
    const bankHints = /(hdfc|icici|sbi|axis|kotak|yes\s*bank|indusind|lic|pnb|canara|union\s*bank)/i;
    const interestHints = /(interest\s*certificate|interest\s*paid|fd\s*interest|fixed\s*deposit|recurring\s*deposit|savings\s*interest)/i;
    if (bankHints.test(text) && interestHints.test(lower)) {
      return { kind: "bank_interest", confidence: 0.85 };
    }
    return { kind: "unknown", confidence: 0 };
  }

  // ============================================================
  // Per-file parse — returns a staging row
  // ============================================================
  //
  // parseFile returns a Promise<stagingRow>. It does NOT mutate any
  // workbook — it only produces a structured description of what
  // applying this file WOULD do. The UI then lets the user confirm
  // or edit before commit.

  async function parseFile(file) {
    const ext = classifyByExtension(file.name);
    const id = `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const baseRow = {
      id,
      file,
      filename: file.name || "(unnamed)",
      size: file.size || 0,
      kind: "unknown",
      kindConfidence: 0,
      ok: false,
      errors: [],
      warnings: [],
      targetAy: null,
      targetFy: null,
      targetSection: null,
      parsed: null,
      conflicts: [],
      hash: "",
      contentPreview: "",
    };

    // Compute dedup hash up front (cheap for small files; the first
    // 4KB slice for large files is also cheap)
    try {
      baseRow.hash = await computeHash(file);
    } catch (e) {
      baseRow.warnings.push(`Could not hash file: ${e.message}`);
    }

    try {
      if (ext === "json") {
        const text = await file.text();
        baseRow.contentPreview = text.slice(0, 200);
        const sniff = await sniffJsonKind(text);
        baseRow.kind = sniff.kind;
        baseRow.kindConfidence = sniff.confidence;
        if (sniff.kind === "form26as" || sniff.kind === "ais") {
          const integrations = getIntegrations();
          if (!integrations) throw new Error("integrations module not loaded");
          const json = JSON.parse(text);
          const result = integrations.parseForm26ASJson(json);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "taxes_paid";
          if (!result.ok) {
            baseRow.errors.push("26AS/AIS parser returned ok=false");
          }
        } else if (sniff.kind === "bank_interest") {
          const bank = getBankInterest();
          if (!bank) throw new Error("bank_interest module not loaded");
          const json = JSON.parse(text);
          const result = bank.parseBankInterestJson(json, file.name);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "other_sources";
        } else {
          baseRow.errors.push("Unrecognised JSON structure. Not a 26AS/AIS or bank statement export.");
        }
      } else if (ext === "xlsx" || ext === "xls") {
        // Most likely a broker P&L
        const sheetjs = getSheetJSLoader();
        if (!sheetjs || !sheetjs.readWorkbook) {
          // Fallback for non-browser (test) environments: try brokers
          // module directly with a fake workbook, but for v1 tests
          // skip browser-only code path
          baseRow.errors.push("SheetJS not available; cannot parse xlsx in this environment");
          return baseRow;
        }
        const workbook = await sheetjs.readWorkbook(file);
        const brokers = getBrokers();
        if (!brokers) throw new Error("brokers module not loaded");
        const result = brokers.parseBrokerFile(workbook, file.name);
        baseRow.kind = "broker_pnl";
        baseRow.kindConfidence = 0.9;
        baseRow.ok = !result.error;
        baseRow.errors = result.error ? [result.error] : [];
        baseRow.parsed = result;
        baseRow.targetSection = "capital_gains";
        if (result.fy) {
          const dataModel = getDataModel();
          const fyInfo = dataModel && dataModel.findFy && dataModel.findFy(result.fy);
          if (fyInfo) {
            baseRow.targetAy = fyInfo.ay;
            baseRow.targetFy = fyInfo.fy;
          } else {
            // FY outside the supported range — flag for manual AY
            baseRow.warnings.push(`File is for FY ${result.fy}, outside the default-supported AYs. Will need manual AY selection.`);
            baseRow.targetFy = result.fy;
          }
        }
      } else if (ext === "csv") {
        const text = await file.text();
        baseRow.contentPreview = text.slice(0, 200);
        const sniff = sniffCsvKind(text);
        baseRow.kind = sniff.kind;
        baseRow.kindConfidence = sniff.confidence;
        if (sniff.kind === "broker_pnl") {
          const brokers = getBrokers();
          if (!brokers) throw new Error("brokers module not loaded");
          const result = brokers.parseBrokerFile(text, file.name);
          baseRow.ok = !result.error;
          baseRow.errors = result.error ? [result.error] : [];
          baseRow.parsed = result;
          baseRow.targetSection = "capital_gains";
          if (result.fy) {
            const dataModel = getDataModel();
            const fyInfo = dataModel && dataModel.findFy && dataModel.findFy(result.fy);
            if (fyInfo) {
              baseRow.targetAy = fyInfo.ay;
              baseRow.targetFy = fyInfo.fy;
            } else {
              baseRow.warnings.push(`File is for FY ${result.fy}, outside the default-supported AYs.`);
              baseRow.targetFy = result.fy;
            }
          }
        } else if (sniff.kind === "bank_interest") {
          const bank = getBankInterest();
          if (!bank) throw new Error("bank_interest module not loaded");
          const result = bank.parseBankInterestCsv(text, file.name);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "other_sources";
        } else {
          baseRow.errors.push("Unrecognised CSV. Expected a Zerodha Console P&L or a bank statement with date/description/amount columns.");
        }
      } else if (ext === "pdf") {
        const pdfjs = getPDFJSLib();
        if (!pdfjs || !pdfjs.getDocumentText) {
          baseRow.errors.push("PDF.js not available; cannot parse PDF in this environment");
          return baseRow;
        }
        const text = await pdfjs.getDocumentText(file);
        const sniff = sniffTextKind(text);
        baseRow.kind = sniff.kind;
        baseRow.kindConfidence = sniff.confidence;
        baseRow.contentPreview = text.slice(0, 200);
        if (sniff.kind === "form16") {
          const integrations = getIntegrations();
          const result = integrations.parseForm16Text(text);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "salary";
        } else if (sniff.kind === "form16a") {
          const form16a = getForm16A();
          if (!form16a) throw new Error("form16a module not loaded");
          const result = form16a.parseForm16AText(text);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "salary.tds";
        } else if (sniff.kind === "bank_interest") {
          const bank = getBankInterest();
          if (!bank) throw new Error("bank_interest module not loaded");
          const result = bank.parseBankInterestText(text, file.name);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "other_sources";
        } else {
          baseRow.errors.push("PDF text doesn't match any known form. Expected Form 16, Form 16A, or a bank interest certificate.");
        }
      } else if (ext === "txt") {
        const text = await file.text();
        const sniff = sniffTextKind(text);
        baseRow.kind = sniff.kind;
        baseRow.kindConfidence = sniff.confidence;
        baseRow.contentPreview = text.slice(0, 200);
        if (sniff.kind === "form16") {
          const integrations = getIntegrations();
          const result = integrations.parseForm16Text(text);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "salary";
        } else if (sniff.kind === "bank_interest") {
          const bank = getBankInterest();
          if (!bank) throw new Error("bank_interest module not loaded");
          const result = bank.parseBankInterestText(text, file.name);
          baseRow.ok = result.ok;
          baseRow.errors = result.errors || [];
          baseRow.warnings = result.warnings || [];
          baseRow.parsed = result;
          baseRow.targetAy = result.ay || null;
          baseRow.targetFy = result.fy || null;
          baseRow.targetSection = "other_sources";
        } else {
          baseRow.errors.push("TXT file doesn't match any known form. Try a Form 16, Form 16A, or bank interest certificate.");
        }
      } else {
        baseRow.errors.push(`Unsupported file extension: .${ext}. Accepted: .pdf, .xlsx, .xls, .csv, .json, .txt`);
      }
    } catch (err) {
      baseRow.ok = false;
      baseRow.errors.push(`Parse failed: ${err.message || err}`);
    }

    return baseRow;
  }

  // ============================================================
  // Bulk parse — parse an array of files, return staging rows
  // ============================================================
  //
  // Returns Promise<{ rows: stagingRow[], dedup: { hash → rowId }[] }>.
  // Dedup: if two files in the batch have the same content hash,
  // the second one's parsed data is dropped, and a warning is added
  // to both rows. (The first one is kept as the canonical one.)

  async function parseBulk(files) {
    if (!Array.isArray(files)) files = [];
    const rows = await Promise.all(files.map((f) => parseFile(f)));
    // Dedupe within the batch by content hash
    const hashCounts = {};
    for (const r of rows) {
      if (!r.hash) continue;
      hashCounts[r.hash] = (hashCounts[r.hash] || 0) + 1;
    }
    const seenHash = {};
    for (const r of rows) {
      if (!r.hash) continue;
      if (seenHash[r.hash]) {
        r.warnings.push(`Duplicate of an earlier file in this batch (same content). Only the first will be applied.`);
        r.duplicate = true;
      } else {
        seenHash[r.hash] = true;
      }
    }
    return { rows, hashCounts };
  }

  // ============================================================
  // Conflict detection — compare parsed data against existing workbook
  // ============================================================
  //
  // For each staging row, check the corresponding fields in the
  // workbook for the target AY. If the new value differs from the
  // existing value (within ₹1), record a conflict. The UI uses this
  // to show a side-by-side comparison.
  //
  // Cross-file conflicts (e.g. Form 16 says TDS=150K and 26AS says
  // TDS=160K, both for the same AY) are detected separately by
  // grouping staging rows by (targetAy, field) and comparing.

  function detectConflicts(row, workbook) {
    if (!row.ok || !workbook) return [];
    const conflicts = [];
    const p = row.parsed;
    if (!p) return conflicts;
    if (row.targetSection === "salary" && p.fields) {
      // Form 16: gross salary, TDS total
      const f = p.fields;
      const emp = (workbook.salary && workbook.salary.employers || [])[0];
      if (emp && emp.gross_salary > 0 && Math.abs(emp.gross_salary - f.gross_salary) > 1) {
        conflicts.push({
          field: "salary.employers[0].gross_salary",
          existing: emp.gross_salary,
          incoming: f.gross_salary,
          sources: [row.filename],
        });
      }
      const existingTds = (workbook.salary && workbook.salary.tds_total) || 0;
      if (f.tds_total > 0 && existingTds > 0 && Math.abs(existingTds - f.tds_total) > 1) {
        conflicts.push({
          field: "salary.tds_total",
          existing: existingTds,
          incoming: f.tds_total,
          sources: [row.filename],
        });
      }
    } else if (row.targetSection === "salary.tds" && p.fields) {
      // Form 16A: TDS total
      const f = p.fields;
      const existingTds = (workbook.salary && workbook.salary.tds_total) || 0;
      if (f.tds_total > 0 && existingTds > 0 && Math.abs(existingTds - f.tds_total) > 1) {
        conflicts.push({
          field: "salary.tds_total",
          existing: existingTds,
          incoming: f.tds_total,
          sources: [row.filename],
        });
      }
    } else if (row.targetSection === "taxes_paid" && p.by_section) {
      // 26AS / AIS: TDS on other than salary, advance tax, etc.
      const b = p.by_section;
      const otherTds = (b.TDS_on_Others || 0) + (b.TDS_on_Rent || 0)
        + (b.TDS_on_Interest || 0) + (b.TDS_on_Dividend || 0)
        + (b.TDS_on_Other_Income || 0);
      const existingOther = (workbook.taxes_paid && workbook.taxes_paid.tds_other_than_salary) || 0;
      if (otherTds > 0 && existingOther > 0 && Math.abs(existingOther - otherTds) > 1) {
        conflicts.push({
          field: "taxes_paid.tds_other_than_salary",
          existing: existingOther,
          incoming: otherTds,
          sources: [row.filename],
        });
      }
      const adv = b.Advance_Tax || 0;
      const existingAdv = (workbook.taxes_paid && workbook.taxes_paid.advance_tax) || 0;
      if (adv > 0 && existingAdv > 0 && Math.abs(existingAdv - adv) > 1) {
        conflicts.push({
          field: "taxes_paid.advance_tax",
          existing: existingAdv,
          incoming: adv,
          sources: [row.filename],
        });
      }
    } else if (row.targetSection === "other_sources" && p.entries) {
      // Bank interest: savings, FD, RD
      for (const entry of p.entries) {
        const k = entry.kind;  // 'savings' | 'fd' | 'rd' | 'dividend' | 'other'
        const existingVal = (workbook.other_sources && workbook.other_sources[k === "fd" ? "fd_interest"
          : k === "rd" ? "rd_interest"
          : k === "savings" ? "savings_interest"
          : k === "dividend" ? "dividend_gross"
          : "other"]) || 0;
        if (entry.amount > 0 && existingVal > 0 && Math.abs(existingVal - entry.amount) > 1) {
          conflicts.push({
            field: `other_sources.${k}`,
            existing: existingVal,
            incoming: entry.amount,
            sources: [row.filename],
          });
        }
      }
    } else if (row.targetSection === "capital_gains" && p.workbookDeltas) {
      // Broker P&L
      const d = p.workbookDeltas;
      const cg = workbook.capital_gains || {};
      const fields = [
        ["stcg_111a", d.stcg_111a, cg.stcg_111a],
        ["ltcg_112a", d.ltcg_112a, cg.ltcg_112a],
        ["stcg_other", d.stcg_other, cg.stcg_other],
        ["ltcg_other", d.ltcg_other, cg.ltcg_other],
      ];
      for (const [name, incoming, existing] of fields) {
        if (incoming > 0 && existing > 0 && Math.abs(existing - incoming) > 1) {
          conflicts.push({
            field: `capital_gains.${name}`,
            existing,
            incoming,
            sources: [row.filename],
          });
        }
      }
    }
    return conflicts;
  }

  // Cross-file conflict detection: for the same (targetAy, field),
  // do multiple staged files disagree? Group them and produce a
  // single conflict per field with all sources.
  function detectCrossFileConflicts(rows) {
    // Group: { targetAy → { field → [{value, filename}] } }
    const groups = {};
    for (const r of rows) {
      if (!r.ok || r.duplicate) continue;
      const ay = r.targetAy;
      if (!ay) continue;
      if (!groups[ay]) groups[ay] = {};
      // For each "field" this row contributes, record its value
      const contribs = rowContributions(r);
      for (const c of contribs) {
        if (!groups[ay][c.field]) groups[ay][c.field] = [];
        groups[ay][c.field].push({ value: c.value, filename: r.filename });
      }
    }
    // For each group with >1 entries, check if values differ
    const crossConflicts = [];
    for (const [ay, fields] of Object.entries(groups)) {
      for (const [field, entries] of Object.entries(fields)) {
        if (entries.length < 2) continue;
        const vals = entries.map((e) => e.value).filter((v) => v > 0);
        if (vals.length < 2) continue;
        const max = Math.max(...vals);
        const min = Math.min(...vals);
        if (max - min > 1) {
          crossConflicts.push({
            ay,
            field,
            sources: entries,
            message: `${entries.length} files disagree on this field (range: ₹${min.toLocaleString("en-IN")} to ₹${max.toLocaleString("en-IN")})`,
          });
        }
      }
    }
    return crossConflicts;
  }

  // Helper: list the (field, value) pairs a row contributes.
  // Used by detectCrossFileConflicts.
  function rowContributions(row) {
    const out = [];
    const p = row.parsed;
    if (!p) return out;
    if (row.targetSection === "salary" && p.fields) {
      const f = p.fields;
      if (f.gross_salary > 0) out.push({ field: "salary.employers[0].gross_salary", value: f.gross_salary });
      if (f.tds_total > 0) out.push({ field: "salary.tds_total", value: f.tds_total });
    } else if (row.targetSection === "salary.tds" && p.fields) {
      if (p.fields.tds_total > 0) out.push({ field: "salary.tds_total", value: p.fields.tds_total });
    } else if (row.targetSection === "taxes_paid" && p.by_section) {
      const b = p.by_section;
      const otherTds = (b.TDS_on_Others || 0) + (b.TDS_on_Rent || 0)
        + (b.TDS_on_Interest || 0) + (b.TDS_on_Dividend || 0)
        + (b.TDS_on_Other_Income || 0);
      if (otherTds > 0) out.push({ field: "taxes_paid.tds_other_than_salary", value: otherTds });
      if (b.Advance_Tax > 0) out.push({ field: "taxes_paid.advance_tax", value: b.Advance_Tax });
      if (b.Self_Assessment_Tax > 0) out.push({ field: "taxes_paid.self_assessment_tax", value: b.Self_Assessment_Tax });
    } else if (row.targetSection === "other_sources" && p.entries) {
      for (const e of p.entries) {
        if (e.amount > 0) {
          const fieldKey = e.kind === "fd" ? "other_sources.fd_interest"
            : e.kind === "rd" ? "other_sources.rd_interest"
            : e.kind === "savings" ? "other_sources.savings_interest"
            : e.kind === "dividend" ? "other_sources.dividend_gross"
            : "other_sources.other";
          out.push({ field: fieldKey, value: e.amount });
        }
      }
    } else if (row.targetSection === "capital_gains" && p.workbookDeltas) {
      const d = p.workbookDeltas;
      if (d.stcg_111a > 0) out.push({ field: "capital_gains.stcg_111a", value: d.stcg_111a });
      if (d.ltcg_112a > 0) out.push({ field: "capital_gains.ltcg_112a", value: d.ltcg_112a });
      if (d.stcg_other > 0) out.push({ field: "capital_gains.stcg_other", value: d.stcg_other });
      if (d.ltcg_other > 0) out.push({ field: "capital_gains.ltcg_other", value: d.ltcg_other });
    }
    return out;
  }

  // ============================================================
  // Apply a single staging row to a workbook
  // ============================================================
  //
  // Mutates the workbook in-place. Caller is responsible for
  // calling window.taxDataModel.saveWorkbook(wb) after each
  // successful apply.

  function applyRow(row, wb, resolutions) {
    if (!row.ok || row.duplicate) {
      return { applied: false, reason: row.duplicate ? "duplicate" : (row.errors[0] || "not ok") };
    }
    const p = row.parsed;
    const r = resolutions || {};  // per-conflict resolutions
    if (row.targetSection === "salary" && p.fields) {
      const integrations = getIntegrations();
      // Check for gross_salary conflict
      const grossConflict = (row.conflicts || []).find((c) => c.field === "salary.employers[0].gross_salary");
      if (grossConflict) {
        // Resolution: 'existing' → keep; 'incoming' → overwrite; 'sum' → add (rare)
        if (r[grossConflict.field] === "existing") {
          // Don't overwrite; skip
        } else {
          integrations.applyForm16ToWorkbook(wb, p.fields);
        }
      } else {
        integrations.applyForm16ToWorkbook(wb, p.fields);
      }
      // TDS conflict
      const tdsConflict = (row.conflicts || []).find((c) => c.field === "salary.tds_total");
      if (tdsConflict) {
        if (r[tdsConflict.field] === "existing") {
          // Keep existing — Form 16 overwrote it; restore if we have it
          // (we don't have the previous value, so this is a no-op)
        } else if (r[tdsConflict.field] === "sum") {
          // Add: existing + incoming. We need to know existing.
          // We computed gross via applyForm16ToWorkbook which sets tds_total.
          // For simplicity, set tds_total to existing + incoming - already_set
          wb.salary.tds_total = tdsConflict.existing + tdsConflict.incoming;
        }
        // 'incoming' is the default from applyForm16ToWorkbook
      }
      return { applied: true, section: "salary" };
    } else if (row.targetSection === "salary.tds" && p.fields) {
      const f = p.fields;
      const tdsConflict = (row.conflicts || []).find((c) => c.field === "salary.tds_total");
      if (!tdsConflict || r[tdsConflict.field] !== "existing") {
        // Form 16A: just update TDS
        if (!wb.salary) wb.salary = {};
        if (r[tdsConflict && tdsConflict.field] === "sum" && tdsConflict) {
          wb.salary.tds_total = tdsConflict.existing + tdsConflict.incoming;
        } else {
          wb.salary.tds_total = f.tds_total;
        }
      }
      return { applied: true, section: "salary.tds" };
    } else if (row.targetSection === "taxes_paid" && p.by_section) {
      const integrations = getIntegrations();
      integrations.applyForm26ASToWorkbook(wb, p);
      // Handle conflict resolutions
      const otherConflict = (row.conflicts || []).find((c) => c.field === "taxes_paid.tds_other_than_salary");
      if (otherConflict && r[otherConflict.field] === "existing") {
        // Restore the existing value
        const b = p.by_section;
        const newOtherTds = (b.TDS_on_Others || 0) + (b.TDS_on_Rent || 0)
          + (b.TDS_on_Interest || 0) + (b.TDS_on_Dividend || 0)
          + (b.TDS_on_Other_Income || 0);
        const delta = newOtherTds - otherConflict.existing;
        wb.taxes_paid.tds_other_than_salary = otherConflict.existing;
        // The integration set this; undo the delta
        wb.taxes_paid.tds_other_than_salary = otherConflict.existing;
      } else if (otherConflict && r[otherConflict.field] === "sum") {
        const b = p.by_section;
        const newOtherTds = (b.TDS_on_Others || 0) + (b.TDS_on_Rent || 0)
          + (b.TDS_on_Interest || 0) + (b.TDS_on_Dividend || 0)
          + (b.TDS_on_Other_Income || 0);
        wb.taxes_paid.tds_other_than_salary = otherConflict.existing + newOtherTds;
      }
      return { applied: true, section: "taxes_paid" };
    } else if (row.targetSection === "other_sources" && p.entries) {
      if (!wb.other_sources) wb.other_sources = {};
      for (const entry of p.entries) {
        const fieldKey = entry.kind === "fd" ? "fd_interest"
          : entry.kind === "rd" ? "rd_interest"
          : entry.kind === "savings" ? "savings_interest"
          : entry.kind === "dividend" ? "dividend_gross"
          : "other";
        const conflict = (row.conflicts || []).find((c) => c.field === `other_sources.${entry.kind}`);
        if (conflict && r[conflict.field] === "existing") {
          // Skip — keep existing
        } else if (conflict && r[conflict.field] === "sum") {
          wb.other_sources[fieldKey] = conflict.existing + entry.amount;
        } else {
          // 'incoming' (default) or no conflict: overwrite (or set)
          wb.other_sources[fieldKey] = entry.amount;
        }
      }
      return { applied: true, section: "other_sources" };
    } else if (row.targetSection === "capital_gains" && p.workbookDeltas) {
      // Mirror the existing single-file applyBrokerDeltasToAy logic
      if (!wb.capital_gains) wb.capital_gains = {};
      const d = p.workbookDeltas;
      const applyField = (field, val, conflictField) => {
        if (!val || val <= 0) return;
        const conflict = (row.conflicts || []).find((c) => c.field === conflictField);
        if (conflict && r[conflict.field] === "existing") {
          // Skip
        } else if (conflict && r[conflict.field] === "sum") {
          wb.capital_gains[field] = conflict.existing + val;
        } else {
          wb.capital_gains[field] = val;
        }
      };
      applyField("stcg_111a", d.stcg_111a, "capital_gains.stcg_111a");
      applyField("ltcg_112a", d.ltcg_112a, "capital_gains.ltcg_112a");
      applyField("stcg_other", d.stcg_other, "capital_gains.stcg_other");
      applyField("ltcg_other", d.ltcg_other, "capital_gains.ltcg_other");
      if (d.dividend_gross && d.dividend_gross > 0) {
        if (!wb.other_sources) wb.other_sources = {};
        wb.other_sources.dividend_gross = (wb.other_sources.dividend_gross || 0) + d.dividend_gross;
      }
      wb.capital_gains.source = p.broker;
      wb.capital_gains.imported_at = new Date().toISOString();
      wb.capital_gains.imported_from = p.broker;
      return { applied: true, section: "capital_gains" };
    }
    return { applied: false, reason: "no matching section" };
  }

  // ============================================================
  // Apply a batch — group by target AY, then apply each row
  // ============================================================
  //
  // Returns { applied: [{ rowId, ay, section }], skipped: [{ rowId, reason }], errors: [...] }

  function applyBatch(rows, resolutionsByRow) {
    const dataModel = getDataModel();
    if (!dataModel) throw new Error("data_model not loaded");
    const results = { applied: [], skipped: [], errors: [] };
    // Group rows by targetAy so we load each workbook once
    const byAy = {};
    for (const r of rows) {
      if (!r.ok || r.duplicate) {
        results.skipped.push({ rowId: r.id, reason: r.duplicate ? "duplicate" : (r.errors[0] || "not ok") });
        continue;
      }
      if (!r.targetAy) {
        results.skipped.push({ rowId: r.id, reason: "no target AY detected" });
        continue;
      }
      if (!byAy[r.targetAy]) byAy[r.targetAy] = [];
      byAy[r.targetAy].push(r);
    }
    for (const [ay, ayRows] of Object.entries(byAy)) {
      let wb = dataModel.loadWorkbook(ay);
      if (!wb) wb = dataModel.emptyWorkbook(ay);
      for (const r of ayRows) {
        const resolutions = (resolutionsByRow && resolutionsByRow[r.id]) || {};
        try {
          const result = applyRow(r, wb, resolutions);
          if (result.applied) {
            results.applied.push({ rowId: r.id, ay, section: result.section });
          } else {
            results.skipped.push({ rowId: r.id, reason: result.reason });
          }
        } catch (err) {
          results.errors.push({ rowId: r.id, error: err.message || String(err) });
        }
      }
      dataModel.saveWorkbook(wb);
    }
    return results;
  }

  return {
    // File-level
    classifyByExtension,
    sniffJsonKind,
    sniffCsvKind,
    sniffTextKind,
    // Parsing
    parseFile,
    parseBulk,
    // Conflict detection
    detectConflicts,
    detectCrossFileConflicts,
    // Apply
    applyRow,
    applyBatch,
    // Utilities
    computeHash,
    fnv1a,
    // Exposed for tests
    _internal: { rowContributions },
  };
});
