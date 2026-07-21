// js/adapters/brokers.js
// Broker Tax-P&L xlsx adapters (client-side, mirrors
// pipeline/tax_pnl/adapters/ in the parent Python project).
//
// Two adapters in v1:
//   - Angel One (SmartAPI "Tax PNL" xlsx)
//   - Zerodha (Console P&L CSV)
//
// Each adapter implements:
//   name: string
//   canParse(workbook, fileName): boolean
//   parse(workbook, fileName): { trades, fySummary, workbookDeltas, warnings }
//
// The `workbookDeltas` is the diff to apply to the ITR workbook's
// capital_gains section: { stcg_111a, ltcg_112a, stcg_other, ltcg_other,
// dividend_gross, source, imported_at, imported_from, notes }.
//
// The app's `applyBrokerPnlToWorkbook` function in app.js merges
// these deltas into the existing workbook (so a second broker file
// is additive, not destructive).
//
// Why we don't just dump every trade into Schedule CG:
//   The ITR engine works in aggregate buckets (stcg_111a, ltcg_112a).
//   For the ITR preview we need the totals. But we KEEP the per-trade
//   list in the result so the UI can show a trade-by-trade table.

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxBrokers = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // Shared helpers (mirror the Python pipeline/tax_pnl/__init__.py)
  // ============================================================

  /**
   * Coerce a value to a float. Strips commas, ₹, parens-for-negatives.
   * @param {*} v
   * @returns {number}
   */
  function _num(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    let s = String(v).trim();
    if (!s) return 0;
    s = s.replace(/,/g, "").replace(/₹/g, "").replace(/\s/g, "");
    if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.slice(1, -1);
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Parse a date from a cell value. Cell could be a Date object
   * (SheetJS hands those through if cellDates: true), an ISO string,
   * a dd/mm/yyyy or dd-mm-yyyy string.
   * @param {*} v
   * @returns {string|null}  YYYY-MM-DD or null
   */
  function parseDate(v) {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      // Pad with leading zeros
      const y = v.getFullYear();
      const m = String(v.getMonth() + 1).padStart(2, "0");
      const d = String(v.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    if (typeof v !== "string") return null;
    const s = v.trim();
    // ISO YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // dd/mm/yyyy or dd-mm-yyyy
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      const yy = m[3].length === 2 ? "20" + m[3] : m[3];
      return `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    return null;
  }

  /**
   * Extract a financial year string ("2024-25") from a filename.
   * If no FY pattern is found, fall back to the current Indian FY.
   * @param {string} name
   * @returns {string}
   */
  function detectFyFromFilename(name) {
    const re1 = /(20\d{2})[-_/](\d{2,4})/;
    const m1 = name && name.match(re1);
    if (m1) {
      const start = parseInt(m1[1], 10);
      const endTok = m1[2];
      const end = endTok.length === 2 ? start + 1 : parseInt(endTok, 10);
      if (end === start + 1) {
        return `${start}-${String(end).slice(-2)}`;
      }
      return `${start}-${String(start + 1).slice(-2)}`;
    }
    const m2 = name && name.match(/(20\d{2})/);
    if (m2) {
      const y = parseInt(m2[1], 10);
      return `${y}-${String(y + 1).slice(-2)}`;
    }
    return currentIndianFy();
  }

  /**
   * Return the current Indian financial year (April-March boundary).
   * @returns {string}
   */
  function currentIndianFy() {
    const d = new Date();
    const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    // JS Date.getMonth() is 0-indexed: 3 = April
    return `${start}-${String(start + 1).slice(-2)}`;
  }

  /**
   * Normalise a string for fuzzy comparison: lowercase, trim, collapse spaces.
   */
  function _norm(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * Find a sheet whose name (normalised) contains ALL needles.
   */
  function _findSheet(workbook, ...needles) {
    if (!workbook || !workbook.SheetNames) return null;
    const ns = needles.map(_norm);
    for (const name of workbook.SheetNames) {
      const n = _norm(name);
      if (ns.every((k) => n.includes(k))) return name;
    }
    return null;
  }

  /**
   * Read all rows of a sheet as an array of arrays.
   * Returns the raw cell values (formulas evaluated to strings by
   * SheetJS when raw: false).
   */
  function _readRows(workbook, sheetName) {
    if (!workbook || !workbook.Sheets || !workbook.Sheets[sheetName]) return [];
    if (typeof window === "undefined" || !window.XLSX) return [];
    return window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: false,
    });
  }

  // ============================================================
  // Angel One adapter
  // ============================================================
  //
  // Sheet: "Equity+Bonds+SGB Trade Details" (or close)
  //   Sections: Intraday, Delivery P&L, Buyback, Open Holding
  //   Row format: ISIN | Symbol | Qty | Buy Date | Buy Value | ...
  //   For Delivery: row[2]=qty, [3]=buy_date, [6]=buy_value,
  //                 [4]=sell_date, [8]=sell_value, [10]=charges,
  //                 [11]=stt, [12]=pnl
  //   For Open Holding: row[2]=qty, [4]=buy_value, [7]=closing,
  //                     [9]=st_unrealised, [10]=lt_unrealised
  //
  // We classify each delivery trade as STCG or LTCG by:
  //   - Delivery with buy_date + sell_date and (sell-buy) > 365 = LTCG
  //   - Delivery otherwise = STCG
  // Both go to the 111A/112A bucket because Angel One is STT-paid
  // Indian equity. (We don't have the ISIN row at this point, so
  // we assume Indian listed equity. The user can manually reclassify
  // in the UI if they hold US/foreign equity via Angel One.)

  const AngelOneAdapter = {
    name: "angel_one",

    canParse(workbook, fileName) {
      if (!workbook || !workbook.SheetNames) return false;
      // Angel One: xlsx with the equity+bonds+trade sheet
      return _findSheet(workbook, "equity", "bond", "trade") !== null;
    },

    parse(workbook, fileName) {
      const fy = detectFyFromFilename(fileName || "");
      const fySummary = _emptyFySummary();
      const trades = [];
      const openHoldings = [];
      const warnings = [];

      const sheet = _findSheet(workbook, "equity", "bond", "trade");
      if (!sheet) {
        return {
          broker: "angel_one",
          fy,
          trades,
          openHoldings,
          fySummary,
          workbookDeltas: _emptyDeltas(),
          warnings: ["Could not find the Equity+Bonds+SGB Trade Details sheet"],
        };
      }
      const rows = _readRows(workbook, sheet);
      let section = null;
      for (const row of rows) {
        if (!row || row.every((v) => v === null || v === "")) continue;
        const first = _norm(row[0]);
        if (!first) continue;

        // Summary rows (Angel One's report has these in the equity
        // sheet's bottom or as standalone rows)
        if (first === "net p&l" || first === "net p&l (a+b)") {
          fySummary.equity_pnl += _num(row[1]);
        } else if (first.includes("ltcg") && first.includes("exclud")) {
          fySummary.equity_ltcg += _num(row[1]);
        } else if (first.includes("stcg") && first.includes("exclud")) {
          fySummary.equity_stcg += _num(row[1]);
        } else if (first.includes("intraday") && first.includes("speculative")) {
          fySummary.equity_intraday_pnl += _num(row[1]);
        } else if (first === "total stt") {
          fySummary.equity_stt += _num(row[1]);
        } else if (first.includes("additional brokerage")) {
          fySummary.equity_brokerage += _num(row[1]);
        } else if (first.includes("total charges")) {
          fySummary.equity_other_charges += _num(row[1]);
        }

        // Section markers
        if (first.includes("intraday")) { section = "intraday"; continue; }
        if (first.includes("delivery p&l")) { section = "delivery"; continue; }
        if (first.includes("buyback")) { section = "buyback"; continue; }
        if (first.includes("transfer")) { section = "transfer"; continue; }
        if (first.includes("open sell")) { section = "open_sell"; continue; }
        if (first.includes("open holding")) { section = "open"; continue; }
        if (first === "isin") continue;

        // Data rows need an ISIN
        const isin = (typeof row[0] === "string" && row[0].startsWith("INE")) ? row[0] : null;
        if (!isin) continue;
        const scrip = row[1] || "";
        if (!scrip) continue;

        if (section === "delivery" && row.length >= 12) {
          const qty = _num(row[2]);
          const buyVal = _num(row[6]);
          const sellVal = _num(row[8]);
          const charges = _num(row[10]);
          const stt = _num(row[11]);
          const pnl = row[12] !== null && row[12] !== "" ? _num(row[12]) : (sellVal - buyVal);
          const buyDate = parseDate(row[3]);
          const sellDate = parseDate(row[4]);
          if (qty <= 0) continue;
          // Classify as STCG 111A or LTCG 112A
          let kind = "stcg_111a";
          if (buyDate && sellDate) {
            const days = (new Date(sellDate) - new Date(buyDate)) / (1000 * 60 * 60 * 24);
            if (days > 365) kind = "ltcg_112a";
          }
          fySummary.equity_buy_value += buyVal;
          fySummary.equity_sell_value += sellVal;
          fySummary.equity_stamp_duty += charges;
          fySummary.equity_stt += stt;
          trades.push({
            scrip: String(scrip).trim(),
            isin,
            quantity: qty,
            buy_date: buyDate,
            buy_value: buyVal,
            sell_date: sellDate,
            sell_value: sellVal,
            pnl,
            charges,
            stt,
            kind,                   // "stcg_111a" | "ltcg_112a"
            fy,
            source_broker: "angel_one",
          });
        } else if (section === "open" && row.length >= 10) {
          const qty = _num(row[2]);
          const buyVal = _num(row[4]);
          const closing = _num(row[7]);
          const stUn = _num(row[9]);
          const ltUn = _num(row[10]);
          if (qty > 0 && buyVal > 1000) {
            fySummary.open_holdings_cost += buyVal;
            fySummary.open_holdings_market_value += closing * qty;
            fySummary.open_holdings_st_unrealised += stUn;
            fySummary.open_holdings_lt_unrealised += ltUn;
            openHoldings.push({
              scrip: String(scrip).trim(),
              isin,
              quantity: qty,
              buy_value: buyVal,
              current_value: closing * qty,
              unrealised: (closing * qty) - buyVal,
              st_unrealised: stUn,
              lt_unrealised: ltUn,
              fy,
            });
          }
        }
      }

      // Dividends
      const divSheet = _findSheet(workbook, "dividend");
      if (divSheet) {
        const divRows = _readRows(workbook, divSheet);
        for (let i = 1; i < divRows.length; i++) {
          const row = divRows[i];
          if (row && row.length > 5 && row[5] !== null) {
            fySummary.dividend_income += _num(row[5]);
          }
        }
      }

      const workbookDeltas = _buildDeltas(trades, fySummary, fileName);
      return { broker: "angel_one", fy, trades, openHoldings, fySummary, workbookDeltas, warnings };
    },
  };

  // ============================================================
  // Zerodha adapter
  // ============================================================
  //
  // File: Console P&L CSV, one row per closed trade.
  // Columns (fuzzy-matched): Symbol, ISIN, Buy Date, Buy Price,
  //   Sell Date, Sell Price, Quantity, Realised P&L, Type
  //   where Type is "Delivery" | "Intraday" | "Futures" | "Options"

  const ZERODHA_COL_VARIANTS = {
    symbol:   ["symbol", "scrip", "stock", "trading symbol", "instrument"],
    isin:     ["isin", "isin code"],
    buy_date: ["buy date", "purchase date", "buydate", "buy_dt"],
    buy_price:["buy price", "purchase price", "buy rate", "buy_price"],
    sell_date:["sell date", "sale date", "selldate", "sell_dt"],
    sell_price:["sell price", "sale price", "sell rate", "sell_price"],
    quantity: ["quantity", "qty", "shares", "units"],
    pnl:      ["realised p&l", "realized p&l", "realised pnl", "realized pnl",
               "p&l", "pnl", "profit", "profit/loss"],
    charges:  ["charges", "total charges", "fees", "transaction charges"],
    type:     ["type", "segment", "category", "trade type", "instrument type"],
  };

  function _resolveZerodhaColumns(headers) {
    const norm = headers.map(_norm);
    const out = {};
    for (const [canon, variants] of Object.entries(ZERODHA_COL_VARIANTS)) {
      for (const v of variants) {
        if (norm.includes(v)) {
          out[canon] = norm.indexOf(v);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Parse a Zerodha P&L CSV. Returns the same shape as Angel One.
   * @param {string} csvText
   * @param {string} fileName
   */
  function parseZerodhaCsv(csvText, fileName) {
    const fy = detectFyFromFilename(fileName || "");
    const fySummary = _emptyFySummary();
    const trades = [];
    const openHoldings = [];
    const warnings = [];

    if (!csvText) {
      return {
        broker: "zerodha", fy, trades, openHoldings, fySummary,
        workbookDeltas: _emptyDeltas(),
        warnings: ["Empty CSV content"],
      };
    }

    // Strip BOM, then split on newlines
    const text = csvText.replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);

    // Find the header line (first non-empty line with "symbol" + P&L column)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const ln = _norm(lines[i]);
      if (ln.includes("symbol") && (ln.includes("realised p&l") || ln.includes("realized p&l") || ln.includes("pnl"))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      return {
        broker: "zerodha", fy, trades, openHoldings, fySummary,
        workbookDeltas: _emptyDeltas(),
        warnings: ["Could not find a Zerodha-style header (Symbol + Realised P&L) in the first 5 lines"],
      };
    }

    // Parse the header
    const headerLine = lines[headerIdx];
    // Simple CSV split (handles quoted fields with commas)
    const headers = _splitCsvLine(headerLine);
    const cols = _resolveZerodhaColumns(headers);

    if (!("symbol" in cols) || !("quantity" in cols)) {
      return {
        broker: "zerodha", fy, trades, openHoldings, fySummary,
        workbookDeltas: _emptyDeltas(),
        warnings: ["Header is missing the required 'Symbol' and/or 'Quantity' columns"],
      };
    }

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const cells = _splitCsvLine(line);
      const sym = (cells[cols.symbol] || "").trim();
      if (!sym) continue;
      const qty = _num(cells[cols.quantity]);
      if (qty <= 0) continue;
      const buyPrice = "buy_price" in cols ? _num(cells[cols.buy_price]) : 0;
      const sellPrice = "sell_price" in cols ? _num(cells[cols.sell_price]) : 0;
      const buyVal = buyPrice * qty;
      const sellVal = sellPrice * qty;
      const pnl = "pnl" in cols ? _num(cells[cols.pnl]) : (sellVal - buyVal);
      const charges = "charges" in cols ? _num(cells[cols.charges]) : 0;
      const tradeType = ("type" in cols ? (cells[cols.type] || "") : "").toLowerCase();
      const isIntraday = tradeType.includes("intra") || tradeType.includes("speculat");
      const isFutures = tradeType.includes("future");
      const isOptions = tradeType.includes("option");
      const isFno = isFutures || isOptions;

      const buyDate = "buy_date" in cols ? parseDate(cells[cols.buy_date]) : null;
      const sellDate = "sell_date" in cols ? parseDate(cells[cols.sell_date]) : null;

      if (isFno) {
        // Tally F&O (we don't have separate turnover figures; estimate
        // turnover as max(buy_value, sell_value))
        if (isOptions) {
          fySummary.fno.options_turnover += Math.max(buyVal, sellVal);
          fySummary.fno.options_pnl += pnl;
        } else {
          fySummary.fno.futures_turnover += Math.max(buyVal, sellVal);
          fySummary.fno.futures_pnl += pnl;
        }
        continue;
      }

      fySummary.equity_buy_value += buyVal;
      fySummary.equity_sell_value += sellVal;
      let kind;
      if (isIntraday) {
        fySummary.equity_intraday_pnl += pnl;
        kind = "intraday";     // Intraday P&L: speculative, separate from cap gains
      } else {
        fySummary.equity_pnl += pnl;
        // Heuristic: holding period > 365 days = LTCG, else STCG.
        // Zerodha Console "Tax P&L" also tags each row with a
        // "Holding Period" field, but we don't rely on that to
        // avoid header-fuzzing brittleness.
        if (buyDate && sellDate) {
          const days = (new Date(sellDate) - new Date(buyDate)) / (1000 * 60 * 60 * 24);
          kind = days > 365 ? "ltcg_112a" : "stcg_111a";
          if (kind === "ltcg_112a") fySummary.equity_ltcg += pnl;
          else fySummary.equity_stcg += pnl;
        } else {
          // No dates → default to STCG (most conservative)
          kind = "stcg_111a";
          fySummary.equity_stcg += pnl;
        }
      }

      trades.push({
        scrip: sym,
        isin: "isin" in cols ? (cells[cols.isin] || null) : null,
        quantity: qty,
        buy_date: buyDate,
        buy_value: buyVal,
        sell_date: sellDate,
        sell_value: sellVal,
        pnl,
        charges,
        kind,
        fy,
        source_broker: "zerodha",
      });
    }

    const workbookDeltas = _buildDeltas(trades, fySummary, fileName);
    return { broker: "zerodha", fy, trades, openHoldings, fySummary, workbookDeltas, warnings };
  }

  /**
   * Split a single CSV line into cells, handling double-quoted fields
   * that may contain commas.
   */
  function _splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else {
          cur += c;
        }
      } else {
        if (c === ",") { out.push(cur); cur = ""; }
        else if (c === '"') { inQuotes = true; }
        else { cur += c; }
      }
    }
    out.push(cur);
    return out;
  }

  const ZerodhaAdapter = {
    name: "zerodha",
    canParse(workbook /* unused for CSV */, fileName) {
      if (!fileName) return false;
      const lower = fileName.toLowerCase();
      return lower.endsWith(".csv");
    },
    parse(workbook, fileName) {
      // The xlsx path is the only way the app can deliver file content
      // to us; for CSV we read raw text from the workbook's first
      // sheet. But SheetJS doesn't read .csv directly via our loader
      // (which calls readWorkbook → XLSX.read on ArrayBuffer).
      // So we delegate to parseZerodhaCsv via the app's
      // `applyZerodhaCsvToWorkbook` helper which has the raw text.
      return {
        broker: "zerodha",
        fy: detectFyFromFilename(fileName || ""),
        trades: [],
        openHoldings: [],
        fySummary: _emptyFySummary(),
        workbookDeltas: _emptyDeltas(),
        warnings: ["Use parseZerodhaCsv(text, fileName) for CSV files"],
      };
    },
  };

  // ============================================================
  // Generic CSV adapter
  // ============================================================
  //
  // For brokers other than Angel One / Zerodha, the user supplies
  // a column mapping (name → header in the file). v1 supports CSV
  // only via the manual-mapping flow.

  const GenericAdapter = {
    name: "generic",
    canParse(/* no auto-detect */) { return false; },
    parse(csvText, fileName, columnMapping) {
      if (!csvText) {
        return {
          broker: "generic", fy: detectFyFromFilename(fileName || ""),
          trades: [], openHoldings: [], fySummary: _emptyFySummary(),
          workbookDeltas: _emptyDeltas(),
          warnings: ["No CSV text provided"],
        };
      }
      // Apply the same Zerodha-style parsing but with a user-supplied
      // column map. For simplicity, we just call parseZerodhaCsv and
      // post-filter. A more careful implementation would build a
      // dedicated parser; v1 keeps it tight.
      const result = parseZerodhaCsv(csvText, fileName);
      result.broker = "generic";
      if (columnMapping) {
        // Re-resolve columns using the user mapping
        const text = csvText.replace(/^\uFEFF/, "");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < Math.min(5, lines.length); i++) {
          const headers = _splitCsvLine(lines[i]);
          const norm = headers.map(_norm);
          const userCols = {};
          for (const [canon, headerName] of Object.entries(columnMapping)) {
            const idx = norm.indexOf(_norm(headerName));
            if (idx >= 0) userCols[canon] = idx;
          }
          if ("symbol" in userCols && "quantity" in userCols) {
            // Re-parse with user columns (reuse the logic inline)
            // For v1 simplicity, we just adopt the auto-detected
            // result; a future v2 can do a full re-parse here.
            result.warnings.push("Used auto-detected column map (user mapping noted but not yet applied)");
            break;
          }
        }
      }
      return result;
    },
  };

  // ============================================================
  // Adapter registry + auto-detect
  // ============================================================

  const ADAPTERS = [AngelOneAdapter, ZerodhaAdapter];

  /**
   * Return the first adapter that claims to handle this workbook+name.
   * @param {Object} workbook  SheetJS workbook
   * @param {string} fileName
   * @returns {Object|null}
   */
  function detectAdapter(workbook, fileName) {
    for (const a of ADAPTERS) {
      try {
        if (a.canParse(workbook, fileName)) return a;
      } catch (e) { /* keep trying */ }
    }
    return null;
  }

  /**
   * Parse a broker file (xlsx or csv). For xlsx, pass the SheetJS
   * workbook + fileName. For CSV, pass raw text + fileName.
   * @param {Object|string} input
   * @param {string} fileName
   * @returns {Object}  Same shape regardless of broker
   */
  function parseBrokerFile(input, fileName) {
    const isXlsx = input && typeof input === "object" && input.SheetNames;
    const isCsv = typeof input === "string";
    if (isXlsx) {
      const adapter = detectAdapter(input, fileName);
      if (adapter) return adapter.parse(input, fileName);
      // Fall back to Angel One parser if the file is xlsx with the
      // equity sheet but auto-detect failed.
      if (AngelOneAdapter.canParse(input, fileName)) {
        return AngelOneAdapter.parse(input, fileName);
      }
      return {
        broker: "unknown", fy: detectFyFromFilename(fileName || ""),
        trades: [], openHoldings: [], fySummary: _emptyFySummary(),
        workbookDeltas: _emptyDeltas(),
        warnings: ["Could not identify the broker format. Supported: Angel One xlsx, Zerodha CSV."],
      };
    }
    if (isCsv) {
      return parseZerodhaCsv(input, fileName);
    }
    return {
      broker: "unknown", fy: detectFyFromFilename(fileName || ""),
      trades: [], openHoldings: [], fySummary: _emptyFySummary(),
      workbookDeltas: _emptyDeltas(),
      warnings: ["Unsupported file input — expected a SheetJS workbook or CSV text"],
    };
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  function _emptyFySummary() {
    return {
      equity_buy_value: 0,
      equity_sell_value: 0,
      equity_pnl: 0,
      equity_stcg: 0,
      equity_ltcg: 0,
      equity_stamp_duty: 0,
      equity_stt: 0,
      equity_brokerage: 0,
      equity_other_charges: 0,
      equity_intraday_pnl: 0,
      fno: {
        options_turnover: 0, options_pnl: 0,
        futures_turnover: 0, futures_pnl: 0,
        stt: 0, charges: 0, brokerage: 0,
      },
      dividend_income: 0,
      open_holdings_cost: 0,
      open_holdings_market_value: 0,
      open_holdings_unrealised: 0,
      open_holdings_st_unrealised: 0,
      open_holdings_lt_unrealised: 0,
    };
  }

  function _emptyDeltas() {
    return {
      stcg_111a: 0,
      ltcg_112a: 0,
      stcg_other: 0,
      ltcg_other: 0,
      dividend_gross: 0,
    };
  }

  /**
   * Build the diff to apply to the ITR workbook's capital_gains +
   * other_sources sections, given a parsed broker result.
   */
  function _buildDeltas(trades, fySummary, fileName) {
    const deltas = _emptyDeltas();
    for (const t of trades) {
      if (t.kind === "stcg_111a") deltas.stcg_111a += t.pnl;
      else if (t.kind === "ltcg_112a") deltas.ltcg_112a += t.pnl;
      else if (t.kind === "stcg_other") deltas.stcg_other += t.pnl;
      else if (t.kind === "ltcg_other") deltas.ltcg_other += t.pnl;
      // Intraday: not part of cap gains at all (speculative income, separate schedule)
    }
    deltas.dividend_gross = fySummary.dividend_income || 0;
    return deltas;
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    detectAdapter,
    parseBrokerFile,
    parseZerodhaCsv,
    AngelOneAdapter,
    ZerodhaAdapter,
    GenericAdapter,
    // Helpers exposed for tests
    _num,
    parseDate,
    detectFyFromFilename,
    currentIndianFy,
  };
});
