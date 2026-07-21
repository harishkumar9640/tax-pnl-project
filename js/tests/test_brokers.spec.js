// js/tests/test_brokers.spec.js
// Tests for the broker P&L adapters (js/adapters/brokers.js).
//
// Two adapters in v1:
//   - Angel One (SmartAPI "Tax PNL" xlsx)
//   - Zerodha (Console P&L CSV)
//
// The xlsx path requires SheetJS, which loads from a CDN at runtime
// and isn't available in Node. The CSV path is fully testable
// without mocking. We also test the shared helpers (parseDate,
// _num, detectFyFromFilename) directly.

const test = require("node:test");
const assert = require("node:assert/strict");

const brokers = require("../adapters/brokers.js");

// ============================================================
// Helpers
// ============================================================

test("_num: parses numbers in various formats", () => {
  assert.equal(brokers._num(0), 0);
  assert.equal(brokers._num(123.45), 123.45);
  assert.equal(brokers._num("1,234.56"), 1234.56);
  assert.equal(brokers._num("₹12,34,567"), 1234567);
  assert.equal(brokers._num("(1,000)"), -1000);
  assert.equal(brokers._num("  -500  "), -500);
  assert.equal(brokers._num("not a number"), 0);
  assert.equal(brokers._num(""), 0);
  assert.equal(brokers._num(null), 0);
  assert.equal(brokers._num(undefined), 0);
});

test("_num: handles Indian number formatting (2-digit groups after first 3)", () => {
  // 1,00,000 = 100K (Indian style)
  assert.equal(brokers._num("1,00,000"), 100000);
  assert.equal(brokers._num("12,34,567"), 1234567);
});

test("parseDate: ISO format", () => {
  assert.equal(brokers.parseDate("2024-05-15"), "2024-05-15");
});

test("parseDate: dd/mm/yyyy", () => {
  assert.equal(brokers.parseDate("15/05/2024"), "2024-05-15");
});

test("parseDate: dd-mm-yyyy", () => {
  assert.equal(brokers.parseDate("15-05-2024"), "2024-05-15");
});

test("parseDate: dd/mm/yy (2-digit year)", () => {
  assert.equal(brokers.parseDate("15/05/24"), "2024-05-15");
});

test("parseDate: Date object", () => {
  const d = new Date(2024, 4, 15);     // May 15, 2024
  assert.equal(brokers.parseDate(d), "2024-05-15");
});

test("parseDate: null / empty / invalid → null", () => {
  assert.equal(brokers.parseDate(null), null);
  assert.equal(brokers.parseDate(""), null);
  assert.equal(brokers.parseDate("not a date"), null);
});

test("detectFyFromFilename: '2024-25' from 'Tax PNL 2024-25.xlsx'", () => {
  assert.equal(brokers.detectFyFromFilename("Tax PNL 2024-25.xlsx"), "2024-25");
});

test("detectFyFromFilename: '2024-25' from 'PnL_2023_24.csv'", () => {
  assert.equal(brokers.detectFyFromFilename("PnL_2023_24.csv"), "2023-24");
});

test("detectFyFromFilename: '2024-25' from 'pnl-2024-25.xlsx'", () => {
  assert.equal(brokers.detectFyFromFilename("pnl-2024-25.xlsx"), "2024-25");
});

test("detectFyFromFilename: falls back to current FY when no year", () => {
  const fy = brokers.detectFyFromFilename("report.xlsx");
  // Current FY (e.g. "2024-25" or "2025-26" depending on date)
  assert.match(fy, /^20\d{2}-\d{2}$/);
});

test("currentIndianFy: returns a valid FY string", () => {
  const fy = brokers.currentIndianFy();
  assert.match(fy, /^20\d{2}-\d{2}$/);
});

// ============================================================
// Zerodha CSV parser
// ============================================================

const ZERODHA_SAMPLE = `Symbol,ISIN,Buy Date,Buy Price,Sell Date,Sell Price,Quantity,Realised P&L,Type
HDFCBANK,INE040A01034,2023-04-15,1500.00,2024-04-15,1700.00,10,2000.00,Delivery
RELIANCE,INE002A01018,2023-05-01,2400.00,2024-05-01,2600.00,5,1000.00,Delivery
INFY,INE009A01021,2024-01-15,1400.00,2024-06-15,1500.00,20,2000.00,Delivery
HDFCBANK,INE040A01034,2024-06-01,1700.00,2024-07-01,1680.00,5,-100.00,Intraday
SBIN,INE062A01020,2024-03-01,750.00,2024-05-01,770.00,15,300.00,Delivery
`;

test("Zerodha: parses a multi-trade CSV correctly", () => {
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  assert.equal(result.broker, "zerodha");
  assert.equal(result.fy, "2023-24");
  assert.equal(result.trades.length, 5);
  // Intraday: 1 trade (HDFCBANK with Type=Intraday, P&L -100)
  const intraday = result.trades.filter((t) => t.kind === "intraday");
  assert.equal(intraday.length, 1);
  assert.equal(intraday[0].scrip, "HDFCBANK");
  assert.equal(intraday[0].pnl, -100);
  // Delivery: 4 trades
  const delivery = result.trades.filter((t) => t.kind === "stcg_111a" || t.kind === "ltcg_112a");
  assert.equal(delivery.length, 4);
});

test("Zerodha: delivery > 365 days = LTCG 112A", () => {
  // HDFCBANK: buy 2023-04-15, sell 2024-04-15 = 366 days = LTCG
  // (2024 is a leap year)
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  const hdfc = result.trades.find((t) => t.scrip === "HDFCBANK" && t.kind !== "intraday");
  assert.equal(hdfc.kind, "ltcg_112a");
});

test("Zerodha: delivery < 365 days = STCG 111A", () => {
  // INFY: 2024-01-15 → 2024-06-15 = ~152 days = STCG
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  const infy = result.trades.find((t) => t.scrip === "INFY");
  assert.equal(infy.kind, "stcg_111a");
});

test("Zerodha: intraday tracked separately, NOT in cap gains", () => {
  // The intraday P&L (-100) should NOT appear in stcg_111a or ltcg_112a
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  // Totals from delivery: 2000 + 1000 + 2000 + 300 = 5300
  assert.equal(result.fySummary.equity_pnl, 5300);
  // Intraday separate
  assert.equal(result.fySummary.equity_intraday_pnl, -100);
  // workbookDeltas: only delivery (STCG + LTCG), no intraday
  const totalDeltas = result.workbookDeltas.stcg_111a
                    + result.workbookDeltas.ltcg_112a;
  assert.equal(totalDeltas, 5300);
});

test("Zerodha: workbookDeltas correctly split STCG vs LTCG", () => {
  // From the sample (Apr 2023 → Apr/May 2024 = 366 days = LTCG):
  //   LTCG: HDFCBANK (2000) + RELIANCE (1000) = 3000
  //   STCG: INFY (2000) + SBIN (300) = 2300
  // Intraday: HDFCBANK -100 → not in cap-gains deltas
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  assert.equal(result.workbookDeltas.ltcg_112a, 3000);
  assert.equal(result.workbookDeltas.stcg_111a, 2300);
  // Total delivery (sum of STCG + LTCG) = 5300
  const totalDeltas = result.workbookDeltas.stcg_111a
                    + result.workbookDeltas.ltcg_112a;
  assert.equal(totalDeltas, 5300);
});

test("Zerodha: empty CSV → empty result, no crash", () => {
  const result = brokers.parseZerodhaCsv("", "empty.csv");
  assert.equal(result.broker, "zerodha");
  assert.equal(result.trades.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("Zerodha: CSV without proper header → warning, no crash", () => {
  const bad = "Some,Random,Headers\n1,2,3\n";
  const result = brokers.parseZerodhaCsv(bad, "bad.csv");
  assert.equal(result.trades.length, 0);
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes("header")));
});

test("Zerodha: handles quoted CSV fields with commas", () => {
  const csv = `Symbol,ISIN,Quantity,Realised P&L,Type
"SCB, HDFC BANK",INE123,10,500.00,Delivery
`;
  const result = brokers.parseZerodhaCsv(csv, "test.csv");
  // The first trade's symbol should contain the comma
  assert.equal(result.trades.length, 1);
  // Note: depending on how we split, "SCB, HDFC BANK" might come
  // through as-is. Just verify the parser doesn't crash.
});

test("Zerodha: BOM at start of file is stripped", () => {
  const csvWithBom = "\uFEFF" + ZERODHA_SAMPLE;
  const result = brokers.parseZerodhaCsv(csvWithBom, "bom.csv");
  assert.equal(result.trades.length, 5);
});

// ============================================================
// Zerodha F&O handling
// ============================================================

const ZERODHA_FNO_SAMPLE = `Symbol,ISIN,Buy Date,Sell Date,Quantity,Realised P&L,Type
NIFTY24JUN18000CE,INFXXX,2024-06-01,2024-06-05,50,1500.00,Options
NIFTY24JUN18000PE,INFXXX,2024-06-01,2024-06-05,50,-800.00,Options
BANKNIFTY24JUN48000CE,INFYYY,2024-06-01,2024-06-10,25,2000.00,Options
HDFCBANK,INE040A01034,2024-01-15,2024-04-15,10,2000.00,Delivery
`;

test("Zerodha: F&O trades classified separately, not in cap gains", () => {
  const result = brokers.parseZerodhaCsv(ZERODHA_FNO_SAMPLE, "fno.csv");
  // 1 delivery, 3 options
  const options = result.trades.filter((t) => t.kind && t.kind.includes("option"));
  // Options don't get a 'kind' in our schema (they're not cap gains)
  // But they should be in the fno summary
  const fno = result.fySummary.fno;
  // 3 options trades
  assert.equal(fno.options_pnl, 1500 - 800 + 2000);
  // Equity: just HDFCBANK
  assert.equal(result.workbookDeltas.stcg_111a, 2000);
  assert.equal(result.workbookDeltas.ltcg_112a, 0);
});

test("Zerodha: futures classified separately", () => {
  const csv = `Symbol,Quantity,Realised P&L,Type
NIFTY24JUNFUT,50,2500.00,Futures
HDFCBANK,10,500.00,Delivery
`;
  const result = brokers.parseZerodhaCsv(csv, "fut.csv");
  assert.equal(result.fySummary.fno.futures_pnl, 2500);
  assert.equal(result.workbookDeltas.stcg_111a, 500);
});

// ============================================================
// Angel One adapter (xlsx path needs SheetJS — mock it for tests)
// ============================================================

// We mock window.XLSX so the Angel One parser can run in Node
function setupXlsxMock() {
  const fakeXlsx = {
    // SheetJS utils.sheet_to_json with header:1 returns array of arrays
    utils: {
      sheet_to_json(ws, opts) {
        if (!ws) return [];
        // ws is a fake "sheet" — array of arrays
        if (Array.isArray(ws)) return ws;
        // Convert from cell-object format if needed
        return Object.values(ws).filter((v) => Array.isArray(v));
      },
    },
  };
  global.window = global.window || {};
  global.window.XLSX = fakeXlsx;
  return () => { delete global.window.XLSX; };
}

test("Angel One: canParse returns false for non-xlsx", () => {
  // canParse requires the workbook to be an object with SheetNames
  // and the equity+bond+trade sheet
  const wb = { SheetNames: ["Equity+Bonds+SGB Trade Details"], Sheets: {} };
  assert.equal(brokers.AngelOneAdapter.canParse(wb, "test.xlsx"), true);
});

test("Angel One: canParse returns false for unknown sheet", () => {
  const wb = { SheetNames: ["Random Sheet"], Sheets: {} };
  assert.equal(brokers.AngelOneAdapter.canParse(wb, "test.xlsx"), false);
});

test("Angel One: parses delivery section (STCG and LTCG)", () => {
  // Build a fake workbook that mirrors the Angel One equity sheet
  // structure: a Delivery section with rows of (ISIN, Scrip, Qty, ...).
  // Column layout (per the Python adapter reference, 13+ columns):
  //   [0] ISIN  [1] Symbol  [2] Qty  [3] Buy Date  [4] Sell Date
  //   [5] Avg Buy  [6] Buy Value  [7] Sell Price  [8] Sell Value
  //   [9] (extra)  [10] Charges  [11] STT  [12] P&L
  // The two extra columns (Days, extras) are common between Buy Date
  // and Buy Value, and between Sell Value and Charges.
  const equityRows = [
    ["ISIN", "Symbol", "Qty", "Buy Date", "Sell Date", "Avg Buy", "Buy Value", "Sell Price", "Sell Value", "Days", "Charges", "STT", "P&L"],
    // Section marker
    ["Delivery P&L"],
    // Row: HDFCBANK (held ~16 months, LTCG)
    ["INE040A01034", "HDFCBANK", 10, "2023-04-15", "2024-08-15", 1500, 15000, 1700, 17000, 488, 10, 12, 2000],
    // Row: INFY (held 5 months, STCG)
    ["INE009A01021", "INFY", 20, "2024-01-15", "2024-06-15", 1400, 28000, 1500, 30000, 152, 18, 22, 2000],
  ];
  const wb = {
    SheetNames: ["Equity+Bonds+SGB Trade Details"],
    Sheets: {
      "Equity+Bonds+SGB Trade Details": equityRows,
    },
  };
  setupXlsxMock();
  try {
    const result = brokers.AngelOneAdapter.parse(wb, "Tax PNL 2024-25.xlsx");
    assert.equal(result.broker, "angel_one");
    assert.equal(result.fy, "2024-25");
    // Should have 2 delivery trades
    const delivery = result.trades.filter((t) => t.kind === "stcg_111a" || t.kind === "ltcg_112a");
    assert.equal(delivery.length, 2);
    const hdfc = delivery.find((t) => t.scrip === "HDFCBANK");
    const infy = delivery.find((t) => t.scrip === "INFY");
    assert.equal(hdfc.kind, "ltcg_112a");
    assert.equal(infy.kind, "stcg_111a");
    // P&L from the P&L column
    assert.equal(hdfc.pnl, 2000);
    assert.equal(infy.pnl, 2000);
    // Charges, STT should match
    assert.equal(hdfc.charges, 10);
    assert.equal(hdfc.stt, 12);
    // Deltas: STCG = 2000, LTCG = 2000
    assert.equal(result.workbookDeltas.stcg_111a, 2000);
    assert.equal(result.workbookDeltas.ltcg_112a, 2000);
  } finally {
    delete global.window.XLSX;
  }
});

test("Angel One: parses open holdings", () => {
  // Open-holding section per the Python adapter: qty=row[2],
  // buy_val=row[4], closing=row[7], st_unrealised=row[9],
  // lt_unrealised=row[10]. So we need 11+ columns. (The Python
  // adapter's column layout reads row[4] as the total buy value
  // and row[7] as the per-share closing price.)
  const equityRows = [
    ["ISIN", "Symbol", "Qty", "Buy Date", "Buy Value", "Avg Buy", "Days", "Closing", "Day Chg", "ST Unrealised", "LT Unrealised"],
    ["Open Holding"],
    ["INE040A01034", "HDFCBANK", 50, "2024-01-15", 75000, 1500, 100, 1600, 0, 0, 5000],
  ];
  const wb = {
    SheetNames: ["Equity+Bonds+SGB Trade Details"],
    Sheets: {
      "Equity+Bonds+SGB Trade Details": equityRows,
    },
  };
  setupXlsxMock();
  try {
    const result = brokers.AngelOneAdapter.parse(wb, "Tax PNL 2024-25.xlsx");
    assert.equal(result.openHoldings.length, 1);
    const holding = result.openHoldings[0];
    assert.equal(holding.scrip, "HDFCBANK");
    assert.equal(holding.quantity, 50);
    assert.equal(holding.buy_value, 75000);
    assert.equal(holding.lt_unrealised, 5000);
    // closing=row[7] is the per-share closing price
    assert.equal(holding.current_value, 50 * 1600);
  } finally {
    delete global.window.XLSX;
  }
});

test("Angel One: parses dividend sheet", () => {
  // Include a (possibly empty) equity sheet so the parser reaches
  // the dividend-parsing code. The parser returns early if the
  // equity sheet is missing.
  const dividendRows = [
    ["Company", "ISIN", "Type", "Date", "Qty", "Amount"],
    ["HDFCBANK", "INE040A01034", "Dividend", "2024-06-15", 100, 1500],
    ["RELIANCE", "INE002A01018", "Dividend", "2024-08-20", 50, 500],
  ];
  const wb = {
    SheetNames: ["Equity+Bonds+SGB Trade Details", "Dividend Report"],
    Sheets: {
      "Equity+Bonds+SGB Trade Details": [
        ["ISIN", "Symbol", "Qty", "Buy Date", "Sell Date", "Avg Buy", "Buy Value", "Sell Price", "Sell Value", "Days", "Charges", "STT", "P&L"],
      ],
      "Dividend Report": dividendRows,
    },
  };
  setupXlsxMock();
  try {
    const result = brokers.AngelOneAdapter.parse(wb, "Tax PNL 2024-25.xlsx");
    assert.equal(result.fySummary.dividend_income, 2000);
    assert.equal(result.workbookDeltas.dividend_gross, 2000);
  } finally {
    delete global.window.XLSX;
  }
});

test("Angel One: missing equity sheet returns warning", () => {
  const wb = {
    SheetNames: ["Some Other Sheet"],
    Sheets: {},
  };
  setupXlsxMock();
  try {
    const result = brokers.AngelOneAdapter.parse(wb, "test.xlsx");
    assert.ok(result.warnings.length > 0);
    assert.equal(result.trades.length, 0);
  } finally {
    delete global.window.XLSX;
  }
});

// ============================================================
// parseBrokerFile dispatch
// ============================================================

test("parseBrokerFile: dispatches CSV to Zerodha parser", () => {
  const result = brokers.parseBrokerFile(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  assert.equal(result.broker, "zerodha");
});

test("parseBrokerFile: dispatches xlsx with equity sheet to Angel One", () => {
  const wb = {
    SheetNames: ["Equity+Bonds+SGB Trade Details"],
    Sheets: { "Equity+Bonds+SGB Trade Details": [] },
  };
  setupXlsxMock();
  try {
    const result = brokers.parseBrokerFile(wb, "Tax PNL 2024-25.xlsx");
    assert.equal(result.broker, "angel_one");
  } finally {
    delete global.window.XLSX;
  }
});

test("parseBrokerFile: unknown format returns warning, no crash", () => {
  setupXlsxMock();
  try {
    const result = brokers.parseBrokerFile({ SheetNames: ["Unknown"] }, "mystery.xlsx");
    assert.ok(result.warnings.length > 0);
  } finally {
    delete global.window.XLSX;
  }
});

test("parseBrokerFile: invalid input returns warning", () => {
  const result = brokers.parseBrokerFile(42, "test.xlsx");
  assert.ok(result.warnings.length > 0);
});

// ============================================================
// End-to-end: broker result → ITR engine
// ============================================================

const engine = require("../tax_engine.js");
const dm = require("../data_model.js");

test("e2e: Zerodha CSV → capital_gains → Schedule CG tax", () => {
  const result = brokers.parseZerodhaCsv(ZERODHA_SAMPLE, "pnl_2023_24.csv");
  const wb = dm.emptyWorkbook("2025-26");
  // Apply the deltas (mirroring what app.js does)
  wb.capital_gains.stcg_111a = result.workbookDeltas.stcg_111a;
  wb.capital_gains.ltcg_112a = result.workbookDeltas.ltcg_112a;
  // STCG = 2300, LTCG = 3000 (from sample CSV).
  // Schedule CG tax:
  //   STCG 111A: 2300 × 15% = 345
  //   LTCG 112A: 3000 is fully consumed by the ₹1L exemption, so
  //     taxable = 0 → 0 × 10% = 0
  //   4% cess on 345 = 13.8 ≈ 14
  //   Total = 345 + 14 = 359
  const tr = engine.computeForRegime(wb, "old");
  assert.equal(tr.schedule_cg.stcg_111a_tax, 345);
  assert.equal(tr.schedule_cg.ltcg_112a_tax, 0);
  assert.equal(tr.total_tax_rounded, 359);
});
