// js/tests/test_bulk_import.spec.js
// Tests for the v1.2+ bulk-import feature: drag-and-drop or
// multi-select files, auto-classify, parse, surface conflicts,
// and apply to the right year's workbook.
//
// What's tested:
//   - classifyByExtension by file extension
//   - sniffJsonKind detects Form 26AS, AIS, and bank statement JSON
//   - sniffCsvKind detects Zerodha + bank statement CSVs
//   - sniffTextKind detects Form 16, Form 16A, bank interest
//   - parseFile for Form 16A (PDF/TXT) — full pipeline
//   - parseFile for bank interest (PDF/TXT/CSV/JSON)
//   - parseBulk dedup within a batch (by content hash)
//   - detectConflicts against an existing workbook
//   - detectCrossFileConflicts for multi-file same-AY disagreements
//   - applyBatch mutates the right workbooks
//   - Conflict resolution: 'existing' / 'incoming' / 'sum'
//   - Row-level apply for each section (salary, salary.tds,
//     taxes_paid, other_sources, capital_gains)

const test = require("node:test");
const assert = require("node:assert/strict");

const dm = require("../data_model.js");
const bulk = require("../bulk_import.js");
const form16a = require("../adapters/form16a.js");
const bankInterest = require("../adapters/bank_interest.js");

// ============================================================
// classifyByExtension
// ============================================================

test("classifyByExtension: json", () => {
  assert.equal(bulk.classifyByExtension("form26as.json"), "json");
  assert.equal(bulk.classifyByExtension("AIS.JSON"), "json");
});
test("classifyByExtension: xlsx", () => {
  assert.equal(bulk.classifyByExtension("Tax PNL 2024-25.xlsx"), "xlsx");
  // .xls (legacy Excel) is also returned as "xlsx" — SheetJS handles both
  assert.equal(bulk.classifyByExtension("PnL.xls"), "xlsx");
});
test("classifyByExtension: csv", () => {
  assert.equal(bulk.classifyByExtension("console_pnl.csv"), "csv");
});
test("classifyByExtension: pdf", () => {
  assert.equal(bulk.classifyByExtension("Form16.pdf"), "pdf");
});
test("classifyByExtension: txt", () => {
  assert.equal(bulk.classifyByExtension("form16.txt"), "txt");
});
test("classifyByExtension: unknown", () => {
  assert.equal(bulk.classifyByExtension("data.docx"), "unknown");
  assert.equal(bulk.classifyByExtension(""), "unknown");
});

// ============================================================
// sniffJsonKind
// ============================================================

test("sniffJsonKind: Form 26AS", async () => {
  const json = JSON.stringify({
    AssessmentYear: "2025-26",
    TDS_on_Salary: [{ TDS: 100000 }],
    TDS_on_Others: [{ TDS: 5000 }],
  });
  const r = await bulk.sniffJsonKind(json);
  assert.equal(r.kind, "form26as");
  assert.ok(r.confidence > 0.5);
});

test("sniffJsonKind: AIS (Annual Information Statement)", async () => {
  const json = JSON.stringify({
    AIS: { AssessmentYear: "2025-26" },
    TDS_on_Salary: [{ TDS: 100000 }],
  });
  const r = await bulk.sniffJsonKind(json);
  assert.equal(r.kind, "ais");
  assert.ok(r.confidence > 0.5);
});

test("sniffJsonKind: bank statement with transactions array", async () => {
  const json = JSON.stringify({
    transactions: [
      { date: "2024-09-30", description: "Interest credited", amount: 1234.50, type: "credit" },
    ],
  });
  const r = await bulk.sniffJsonKind(json);
  assert.equal(r.kind, "bank_interest");
});

test("sniffJsonKind: unknown JSON", async () => {
  const json = JSON.stringify({ foo: "bar" });
  const r = await bulk.sniffJsonKind(json);
  assert.equal(r.kind, "unknown");
  assert.equal(r.confidence, 0);
});

test("sniffJsonKind: invalid JSON", async () => {
  const r = await bulk.sniffJsonKind("not json {");
  assert.equal(r.kind, "unknown");
});

// ============================================================
// sniffCsvKind
// ============================================================

test("sniffCsvKind: Zerodha Console P&L", () => {
  const header = "Symbol,Buy Date,Sell Date,Buy Price,Sell Price,Quantity,Realised P&L";
  const r = bulk.sniffCsvKind(header);
  assert.equal(r.kind, "broker_pnl");
  assert.equal(r.broker, "zerodha");
});

test("sniffCsvKind: bank statement CSV", () => {
  const header = "Txn Date,Description,Amount,Type";
  const r = bulk.sniffCsvKind(header);
  assert.equal(r.kind, "bank_interest");
});

test("sniffCsvKind: unknown CSV", () => {
  const r = bulk.sniffCsvKind("foo,bar,baz");
  assert.equal(r.kind, "unknown");
});

// ============================================================
// sniffTextKind
// ============================================================

test("sniffTextKind: Form 16", () => {
  const text = `
    Form 16
    TAN: ABCD12345E
    Gross Salary: Rs. 12,00,000
    Total Tax Deducted: Rs. 1,50,000
  `;
  const r = bulk.sniffTextKind(text);
  assert.equal(r.kind, "form16");
});

test("sniffTextKind: Form 16A", () => {
  const text = `
    Form 16A
    Certificate of TDS on Salary
    TAN: ABCD12345E
    PAN of Employee: ABCDE1234F
    Total Tax Deducted: Rs. 50,000
  `;
  const r = bulk.sniffTextKind(text);
  assert.equal(r.kind, "form16a");
});

test("sniffTextKind: bank interest certificate", () => {
  const text = `
    HDFC Bank Limited
    Interest Certificate
    Account Number: 1234567890
    Interest paid: Rs. 12,345
    Period: 01/04/2024 to 31/03/2025
  `;
  const r = bulk.sniffTextKind(text);
  assert.equal(r.kind, "bank_interest");
});

test("sniffTextKind: short text → unknown", () => {
  const r = bulk.sniffTextKind("short");
  assert.equal(r.kind, "unknown");
});

// ============================================================
// Form 16A parser
// ============================================================

test("Form 16A: detects AY and TDS total", () => {
  const text = `
    Form 16A — Certificate of TDS on Salary
    TAN: ABCD12345E
    PAN of Employee: ABCDE1234F
    Name: John Doe
    Assessment Year: 2025-26
    Total Tax Deducted: Rs. 1,50,000
  `;
  const r = form16a.parseForm16AText(text);
  assert.equal(r.ok, true);
  assert.equal(r.ay, "2025-26");
  assert.equal(r.fy, "2024-25");
  assert.equal(r.fields.employer.tan, "ABCD12345E");
  assert.equal(r.fields.employee.pan, "ABCDE1234F");
  assert.equal(r.fields.tds_total, 150000);
});

test("Form 16A: extracts quarterly TDS", () => {
  const text = `
    Form 16A
    TAN: ABCD12345E
    Q1: Rs. 30,000
    Q2: Rs. 40,000
    Q3: Rs. 35,000
    Q4: Rs. 45,000
  `;
  const r = form16a.parseForm16AText(text);
  assert.equal(r.ok, true);
  assert.equal(r.fields.tds_quarterly.Q1, 30000);
  assert.equal(r.fields.tds_quarterly.Q2, 40000);
  assert.equal(r.fields.tds_quarterly.Q3, 35000);
  assert.equal(r.fields.tds_quarterly.Q4, 45000);
});

test("Form 16A: empty text returns error", () => {
  const r = form16a.parseForm16AText("");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("Form 16A: missing AY produces warning", () => {
  const text = `
    Form 16A
    TAN: ABCD12345E
    Total Tax Deducted: Rs. 50,000
  `;
  const r = form16a.parseForm16AText(text);
  assert.equal(r.ok, true);
  assert.equal(r.ay, null);
  assert.ok(r.warnings.some((w) => /could not detect/i.test(w)));
});

// ============================================================
// Bank interest parser
// ============================================================

test("Bank interest: savings account", () => {
  const text = `
    HDFC Bank Limited
    Interest Certificate for Savings Account
    Account Number: 1234567890
    Interest paid: Rs. 12,345
    Period: 01/04/2024 to 31/03/2025
    Assessment Year: 2025-26
  `;
  const r = bankInterest.parseBankInterestText(text, "hdfc-savings.txt");
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].kind, "savings");
  assert.equal(r.entries[0].amount, 12345);
  assert.equal(r.entries[0].bank, "HDFC");
  assert.equal(r.total, 12345);
  assert.equal(r.ay, "2025-26");
});

test("Bank interest: multi-FD statement", () => {
  const text = `
    SBI
    Fixed Deposit Interest Statement
    FY 2024-25
    FD No: FD001  Interest: Rs. 5,000
    FD No: FD002  Interest: Rs. 7,500
    FD No: FD003  Interest: Rs. 3,200
    Total Interest: Rs. 15,700
  `;
  const r = bankInterest.parseBankInterestText(text, "sbi-fd.txt");
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries.every((e) => e.kind === "fd"), true);
  // The parser picks per-FD amounts (5000+7500+3200); the "Total
  // Interest" line is informational and not summed.
  assert.equal(r.total, 15700);
});

test("Bank interest: CSV with interest and dividend lines", () => {
  const csv = [
    "Date,Description,Amount,Type",
    "30/09/2024,Interest credited,1234.50,credit",
    "15/12/2024,Dividend received,2500.00,credit",
    "01/10/2024,ATM withdrawal,5000.00,debit",
  ].join("\n");
  const r = bankInterest.parseBankInterestCsv(csv, "statement.csv");
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  const savingsEntry = r.entries.find((e) => e.kind === "savings");
  const dividendEntry = r.entries.find((e) => e.kind === "dividend");
  assert.equal(savingsEntry.amount, 1234.50);
  assert.equal(dividendEntry.amount, 2500.00);
});

test("Bank interest: CSV without interest lines returns error", () => {
  const csv = [
    "Date,Description,Amount,Type",
    "01/10/2024,ATM withdrawal,5000.00,debit",
  ].join("\n");
  const r = bankInterest.parseBankInterestCsv(csv, "statement.csv");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no interest or dividend/i.test(e)));
});

test("Bank interest: JSON with transactions", () => {
  const json = {
    transactions: [
      { date: "2024-09-30", description: "Interest credited", amount: 1234.50, type: "credit" },
      { date: "2024-12-15", description: "Dividend received", amount: 2500.00, type: "credit" },
    ],
  };
  const r = bankInterest.parseBankInterestJson(json, "hdfc-statement.json");
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.total, 3734.50);
});

// ============================================================
// Content-hash dedup
// ============================================================

test("computeHash: same content → same hash", async () => {
  // Build two minimal File-like objects with the same content.
  // The hash is a non-crypto FNV-1a; for 4KB blocks it should
  // produce identical hashes for identical inputs.
  const file1 = makeFakeFile("test.pdf", "ABCD12345E\nForm 16\nGross: Rs. 5,00,000\n");
  const file2 = makeFakeFile("test2.pdf", "ABCD12345E\nForm 16\nGross: Rs. 5,00,000\n");
  const h1 = await bulk.computeHash(file1);
  const h2 = await bulk.computeHash(file2);
  assert.equal(h1, h2);
});

test("computeHash: different content → different hash", async () => {
  const file1 = makeFakeFile("test.pdf", "Form 16 with gross Rs. 5,00,000");
  const file2 = makeFakeFile("test.pdf", "Form 16 with gross Rs. 6,00,000");
  const h1 = await bulk.computeHash(file1);
  const h2 = await bulk.computeHash(file2);
  assert.notEqual(h1, h2);
});

// ============================================================
// parseBulk dedup
// ============================================================

test("parseBulk: duplicate files in batch are flagged", async () => {
  const f1 = makeFakeFile("test.json", JSON.stringify({ AssessmentYear: "2025-26", TDS_on_Salary: [{ TDS: 100000 }] }));
  const f2 = makeFakeFile("test-copy.json", JSON.stringify({ AssessmentYear: "2025-26", TDS_on_Salary: [{ TDS: 100000 }] }));
  const { rows } = await bulk.parseBulk([f1, f2]);
  // Both should be detected as Form 26AS
  assert.equal(rows[0].kind, "form26as");
  assert.equal(rows[1].kind, "form26as");
  // The second one is a duplicate of the first
  assert.equal(rows[0].duplicate, undefined);
  assert.equal(rows[1].duplicate, true);
  assert.ok(rows[1].warnings.some((w) => /duplicate/i.test(w)));
});

// ============================================================
// Conflict detection
// ============================================================

test("detectConflicts: Form 16 vs existing gross_salary", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.salary.employers = [{ employer_name: "Old Co", tan: "AAAA00000A",
    gross_salary: 1000000, allowances_exempt_10: 0, professional_tax: 0 }];
  wb.salary.tds_total = 100000;
  const row = {
    ok: true,
    targetSection: "salary",
    parsed: {
      fields: { gross_salary: 1200000, tds_total: 150000 },
    },
    conflicts: [],
  };
  const conflicts = bulk.detectConflicts(row, wb);
  assert.equal(conflicts.length, 2);
  const grossConflict = conflicts.find((c) => c.field === "salary.employers[0].gross_salary");
  const tdsConflict = conflicts.find((c) => c.field === "salary.tds_total");
  assert.equal(grossConflict.existing, 1000000);
  assert.equal(grossConflict.incoming, 1200000);
  assert.equal(tdsConflict.existing, 100000);
  assert.equal(tdsConflict.incoming, 150000);
});

test("detectConflicts: no conflict when existing is zero", () => {
  const wb = dm.emptyWorkbook("2025-26");
  const row = {
    ok: true,
    targetSection: "salary",
    parsed: { fields: { gross_salary: 1200000, tds_total: 150000 } },
  };
  const conflicts = bulk.detectConflicts(row, wb);
  assert.equal(conflicts.length, 0);
});

test("detectConflicts: bank interest savings vs existing", () => {
  const wb = dm.emptyWorkbook("2025-26");
  wb.other_sources.savings_interest = 5000;
  const row = {
    ok: true,
    targetSection: "other_sources",
    parsed: { entries: [{ kind: "savings", amount: 8000, bank: "HDFC", account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
  };
  const conflicts = bulk.detectConflicts(row, wb);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "other_sources.savings");
  assert.equal(conflicts[0].existing, 5000);
  assert.equal(conflicts[0].incoming, 8000);
});

test("detectCrossFileConflicts: Form 16 and 26AS agree → no conflict", () => {
  const rows = [
    {
      ok: true, duplicate: false, targetAy: "2025-26", targetSection: "salary",
      filename: "form16.pdf",
      parsed: { fields: { gross_salary: 1000000, tds_total: 150000 } },
    },
    {
      ok: true, duplicate: false, targetAy: "2025-26", targetSection: "taxes_paid",
      filename: "26as.json",
      parsed: { by_section: { TDS_on_Salary: 150000, Advance_Tax: 0, Self_Assessment_Tax: 0, TDS_on_Others: 0 } },
    },
  ];
  const conflicts = bulk.detectCrossFileConflicts(rows);
  // Both contribute to salary.tds_total (Form 16 via field, 26AS
  // doesn't directly; but 26AS contributes to taxes_paid.tds_other_than_salary,
  // not salary.tds_total). So no overlap → no cross-file conflict.
  assert.equal(conflicts.length, 0);
});

test("detectCrossFileConflicts: two files disagree on same field", () => {
  const rows = [
    {
      ok: true, duplicate: false, targetAy: "2025-26", targetSection: "salary",
      filename: "form16.pdf",
      parsed: { fields: { gross_salary: 1000000, tds_total: 150000 } },
    },
    {
      ok: true, duplicate: false, targetAy: "2025-26", targetSection: "salary.tds",
      filename: "form16a.pdf",
      parsed: { fields: { tds_total: 160000 } },
    },
  ];
  const conflicts = bulk.detectCrossFileConflicts(rows);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "salary.tds_total");
  assert.equal(conflicts[0].sources.length, 2);
  // Values 150000 and 160000 differ by >1
  assert.ok(conflicts[0].message.includes("1,50,000"));
  assert.ok(conflicts[0].message.includes("1,60,000"));
});

// ============================================================
// applyBatch
// ============================================================

test("applyBatch: applies Form 16 to target workbook", () => {
  installLocalStorageShim();
  try {
  // Build a fake row without going through full parseFile
  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "salary",
      filename: "form16.pdf",
      parsed: { fields: { gross_salary: 1000000, tds_total: 150000,
        employer: { tan: "AAAA00000A", name: "Test Co" },
        employee: { pan: "ABCDE1234F", name: "John" },
        allowances_exempt_10: 50000, professional_tax: 200,
        standard_deduction: 50000,
        deductions_claimed_by_employer: {} } },
      conflicts: [],
    },
  ];
  const results = bulk.applyBatch(rows, {});
  assert.equal(results.applied.length, 1);
  assert.equal(results.applied[0].ay, "2025-26");
  assert.equal(results.applied[0].section, "salary");
  // Check the workbook was saved
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.salary.employers[0].gross_salary, 1000000);
  assert.equal(wb.salary.tds_total, 150000);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: applies bank interest to other_sources", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc.txt",
      parsed: { entries: [{ kind: "savings", amount: 12345, bank: "HDFC",
        account_or_fd_no: "1234567890", period: "FY 2024-25", tds_deducted: 0 }] },
      conflicts: [],
    },
  ];
  bulk.applyBatch(rows, {});
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.other_sources.savings_interest, 12345);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: skipped when no target AY", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: null, targetFy: null,
      targetSection: "salary",
      filename: "form16.pdf",
      parsed: { fields: { gross_salary: 1000000, tds_total: 0 } },
    },
  ];
  const results = bulk.applyBatch(rows, {});
  assert.equal(results.applied.length, 0);
  assert.equal(results.skipped.length, 1);
  assert.ok(results.skipped[0].reason.includes("AY"));
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: skipped when row has errors", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: false, duplicate: false, id: "r1",
      errors: ["Could not parse"],
      targetAy: "2025-26",
    },
  ];
  const results = bulk.applyBatch(rows, {});
  assert.equal(results.applied.length, 0);
  assert.equal(results.skipped.length, 1);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: skipped when duplicate", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: true, duplicate: true, id: "r1",
      targetAy: "2025-26",
      targetSection: "salary",
      parsed: { fields: { gross_salary: 1000000, tds_total: 0 } },
    },
  ];
  const results = bulk.applyBatch(rows, {});
  assert.equal(results.applied.length, 0);
  assert.equal(results.skipped.length, 1);
  assert.equal(results.skipped[0].reason, "duplicate");
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: applies multiple files to same AY in one save", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "salary",
      filename: "form16.pdf",
      parsed: { fields: { gross_salary: 1000000, tds_total: 150000,
        employer: { tan: "", name: "" },
        employee: { pan: "", name: "" },
        allowances_exempt_10: 0, professional_tax: 0,
        standard_deduction: 0,
        deductions_claimed_by_employer: {} } },
      conflicts: [],
    },
    {
      ok: true, duplicate: false, id: "r2",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc.txt",
      parsed: { entries: [{ kind: "savings", amount: 12345, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
      conflicts: [],
    },
  ];
  const results = bulk.applyBatch(rows, {});
  assert.equal(results.applied.length, 2);
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.salary.employers[0].gross_salary, 1000000);
  assert.equal(wb.other_sources.savings_interest, 12345);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: applies files to different AYs independently", () => {
  installLocalStorageShim();
  try {
  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc-25.txt",
      parsed: { entries: [{ kind: "savings", amount: 10000, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
    },
    {
      ok: true, duplicate: false, id: "r2",
      targetAy: "2024-25", targetFy: "2023-24",
      targetSection: "other_sources",
      filename: "hdfc-24.txt",
      parsed: { entries: [{ kind: "savings", amount: 5000, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2023-24", tds_deducted: 0 }] },
    },
  ];
  bulk.applyBatch(rows, {});
  const wb25 = dm.loadWorkbook("2025-26");
  const wb24 = dm.loadWorkbook("2024-25");
  assert.equal(wb25.other_sources.savings_interest, 10000);
  assert.equal(wb24.other_sources.savings_interest, 5000);
  } finally { uninstallLocalStorageShim(); }
});

// ============================================================
// Conflict resolution in applyBatch
// ============================================================

test("applyBatch: 'existing' resolution keeps old value", () => {
  installLocalStorageShim();
  try {
  // Pre-populate workbook with a value
  const wb0 = dm.emptyWorkbook("2025-26");
  wb0.other_sources.savings_interest = 5000;
  dm.saveWorkbook(wb0);

  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc.txt",
      parsed: { entries: [{ kind: "savings", amount: 10000, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
      conflicts: [{ field: "other_sources.savings", existing: 5000, incoming: 10000, sources: ["hdfc.txt"] }],
    },
  ];
  bulk.applyBatch(rows, { r1: { "other_sources.savings": "existing" } });
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.other_sources.savings_interest, 5000);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: 'sum' resolution adds values", () => {
  installLocalStorageShim();
  try {
  const wb0 = dm.emptyWorkbook("2025-26");
  wb0.other_sources.savings_interest = 5000;
  dm.saveWorkbook(wb0);

  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc.txt",
      parsed: { entries: [{ kind: "savings", amount: 10000, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
      conflicts: [{ field: "other_sources.savings", existing: 5000, incoming: 10000, sources: ["hdfc.txt"] }],
    },
  ];
  bulk.applyBatch(rows, { r1: { "other_sources.savings": "sum" } });
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.other_sources.savings_interest, 15000);
  } finally { uninstallLocalStorageShim(); }
});

test("applyBatch: 'incoming' resolution (default) overwrites", () => {
  installLocalStorageShim();
  try {
  const wb0 = dm.emptyWorkbook("2025-26");
  wb0.other_sources.savings_interest = 5000;
  dm.saveWorkbook(wb0);

  const rows = [
    {
      ok: true, duplicate: false, id: "r1",
      targetAy: "2025-26", targetFy: "2024-25",
      targetSection: "other_sources",
      filename: "hdfc.txt",
      parsed: { entries: [{ kind: "savings", amount: 10000, bank: "HDFC",
        account_or_fd_no: "", period: "FY 2024-25", tds_deducted: 0 }] },
      conflicts: [{ field: "other_sources.savings", existing: 5000, incoming: 10000, sources: ["hdfc.txt"] }],
    },
  ];
  bulk.applyBatch(rows, { r1: { "other_sources.savings": "incoming" } });
  const wb = dm.loadWorkbook("2025-26");
  assert.equal(wb.other_sources.savings_interest, 10000);
  } finally { uninstallLocalStorageShim(); }
});

// ============================================================
// rowContributions helper
// ============================================================

test("rowContributions: Form 16 contributes gross + tds", () => {
  const row = {
    targetSection: "salary",
    parsed: { fields: { gross_salary: 1000000, tds_total: 150000 } },
  };
  const contribs = bulk._internal.rowContributions(row);
  assert.equal(contribs.length, 2);
  assert.ok(contribs.some((c) => c.field === "salary.employers[0].gross_salary" && c.value === 1000000));
  assert.ok(contribs.some((c) => c.field === "salary.tds_total" && c.value === 150000));
});

test("rowContributions: bank interest contributes per-entry", () => {
  const row = {
    targetSection: "other_sources",
    parsed: { entries: [
      { kind: "savings", amount: 5000 },
      { kind: "fd", amount: 10000 },
    ] },
  };
  const contribs = bulk._internal.rowContributions(row);
  assert.equal(contribs.length, 2);
  assert.ok(contribs.some((c) => c.field === "other_sources.savings_interest" && c.value === 5000));
  assert.ok(contribs.some((c) => c.field === "other_sources.fd_interest" && c.value === 10000));
});

test("rowContributions: empty parsed → empty list", () => {
  const row = { targetSection: "salary", parsed: null };
  const contribs = bulk._internal.rowContributions(row);
  assert.equal(contribs.length, 0);
});

// ============================================================
// Localstorage shim for tests that exercise applyBatch / saveWorkbook
// ============================================================
//
// The data_model.js uses localStorage directly. In Node there's no
// localStorage by default, so we shim it for tests that go through
// applyBatch (which calls dataModel.saveWorkbook → localStorage).
// Tests that don't call applyBatch (most classification + conflict
// tests) don't need this.

let _store;
function installLocalStorageShim() {
  _store = {};
  global.window = {
    localStorage: {
      getItem: (k) => _store[k] || null,
      setItem: (k, v) => { _store[k] = String(v); },
      removeItem: (k) => { delete _store[k]; },
      key: () => null,
      get length() { return Object.keys(_store).length; },
    },
  };
  global.localStorage = global.window.localStorage;
}
function uninstallLocalStorageShim() {
  delete global.window;
  delete global.localStorage;
  _store = null;
}

// ============================================================
// Helper: build a minimal File-like object for Node tests
// ============================================================
//
// In the browser, parseFile takes real File objects from <input> or
// drop events. In Node, we need a shim that has .name, .size, and
// .text() / .arrayBuffer() / .slice().

function makeFakeFile(name, content) {
  return {
    name,
    size: content.length,
    text: async () => content,
    arrayBuffer: async () => {
      const buf = new ArrayBuffer(content.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < content.length; i++) view[i] = content.charCodeAt(i);
      return buf;
    },
    slice: (start, end) => {
      const slice = content.slice(start, end);
      return {
        arrayBuffer: async () => {
          const buf = new ArrayBuffer(slice.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < slice.length; i++) view[i] = slice.charCodeAt(i);
          return buf;
        },
      };
    },
  };
}
