// js/data_model.js
// Core data model for the ITR Workbook.
//
// One workbook = one Assessment Year (AY). It contains all the
// information needed to compute tax under both old and new regimes
// and to preview the ITR-1/ITR-2 schedules.
//
// All data is stored in the browser (localStorage). Nothing is sent
// to any server. The model is intentionally serialisable as JSON
// so it can be exported, imported, and inspected.

(function (root, factory) {
  if (typeof window !== "undefined") {
    const api = factory();
    Object.assign(window, api);
    window.taxDataModel = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ============================================================
  // IT-Act constants (re-exported from tax_engine for convenience)
  // ============================================================
  // These are defined ONCE in tax_engine.js. We re-import them
  // here so this module can reference named constants instead of
  // hardcoding the values in business logic (e.g. the AYs the
  // workbook supports, the default co-ownership share).
  const taxEngine = (typeof window !== "undefined" && window.taxEngine)
    || (typeof require !== "undefined" && require("./tax_engine.js"));
  const C = (taxEngine && taxEngine.CONSTANTS) || {};
  // Fall back to literal values if the engine is not loaded.
  const AY_2025_26 = C.AY_2025_26 || "2025-26";
  const AY_2024_25 = C.AY_2024_25 || "2024-25";
  const FY_FOR_AY = C.FY_FOR_AY || { [AY_2025_26]: "2024-25", [AY_2024_25]: "2023-24" };
  const HP_FULL_OWNERSHIP_PCT = C.HP_FULL_OWNERSHIP_PCT || 100;
  // Default std deduction for an empty salary employer card
  const DEFAULT_STD_DEDUCTION = C.STD_DEDUCTION_OLD_REGIME || 50000;

  // ============================================================
  // Empty shapes — one factory per top-level section
  // ============================================================

  /**
   * Return the canonical list of AYs the workbook supports.
   * (Order: most recent first.)
   * @returns {Array<{ay: string, fy: string, label: string}>}
   */
  function supportedAys() {
    return [
      { ay: "2025-26", fy: "2024-25", label: "AY 2025-26 (FY 2024-25)" },
      { ay: "2024-25", fy: "2023-24", label: "AY 2024-25 (FY 2023-24)" },
    ];
  }

  /**
   * Get the default AY (the most recent one).
   */
  function defaultAy() {
    return supportedAys()[0].ay;
  }

  /**
   * Lookup helpers — find a supported AY by its `ay` or `fy` string.
   */
  function findAy(ayStr) {
    return supportedAys().find((x) => x.ay === ayStr) || null;
  }
  function findFy(fyStr) {
    return supportedAys().find((x) => x.fy === fyStr) || null;
  }

  /**
   * Detect an AY from arbitrary text. Looks for common Form 16 / 26AS
   * patterns. Returns the AY string (e.g. "2025-26") if found, or
   * null if not.
   *
   * Recognized patterns (case-insensitive, fuzzy):
   *   "Assessment Year 2025-26", "AY 2025-26", "A.Y. 2025-26"
   *   "Financial Year 2024-25", "FY 2024-25", "F.Y. 2024-25"
   *   "Year ending 31-Mar-2025", "year ended 31.03.2025"
   *   "Period: 01/04/2024 to 31/03/2025"
   *   "Income year 2024-25"
   *   "AY : 2025-26", "AY-2025-26", "AY_2025-26"
   *
   * Note: FY 2024-25 → AY 2025-26 (the year the return is filed for).
   *
   * @param {string} text
   * @returns {string|null}
   */
  function detectAyFromText(text) {
    if (!text || typeof text !== "string") return null;
    const norm = text.toLowerCase();
    // --- AY patterns first (most specific) ---
    // AY 2025-26, A.Y. 2025-26, AY : 2025-26, AY-2025-26
    const ayRe = /\b(?:a\.?\s*y\.?|assessment\s+year|a\/y)\s*[:\-_/]?\s*(\d{4})\s*[_\-\/]?\s*(\d{2,4})\b/i;
    let m = norm.match(ayRe);
    if (m) {
      const start = parseInt(m[1], 10);
      const endTok = m[2];
      const end = endTok.length === 2 ? start + 1 : parseInt(endTok, 10);
      if (end === start + 1) {
        const ay = `${start}-${String(end).slice(-2)}`;
        if (findAy(ay)) return ay;
        if (findFy(ay)) return findFy(ay).ay;   // user typed "2024-25" thinking it's the AY
      }
    }
    // --- FY patterns (FY 2024-25 → AY 2025-26) ---
    const fyRe = /\b(?:f\.?\s*y\.?|financial\s+year|income\s+year|year\s+ending|year\s+ended)\s*[:\-_/]?\s*(\d{4})\s*[_\-\/]?\s*(\d{2,4})\b/i;
    m = norm.match(fyRe);
    if (m) {
      const start = parseInt(m[1], 10);
      const endTok = m[2];
      const end = endTok.length === 2 ? start + 1 : parseInt(endTok, 10);
      if (end === start + 1) {
        const fy = `${start}-${String(end).slice(-2)}`;
        const fyEntry = findFy(fy);
        if (fyEntry) return fyEntry.ay;
        // Also accept if user gave us "2025-26" as the FY (some PDFs do this)
        const ayEntry = findAy(fy);
        if (ayEntry) return ayEntry.ay;
      }
    }
    // --- Period pattern: "01/04/2024 to 31/03/2025" → FY 2024-25 → AY 2025-26 ---
    const periodRe = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s*(?:to|[-–])\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/i;
    m = norm.match(periodRe);
    if (m) {
      const startYear = parseInt(m[3], 10);
      const endYear = parseInt(m[6], 10);
      if (endYear === startYear + 1) {
        const fy = `${startYear}-${String(endYear).slice(-2)}`;
        const fyEntry = findFy(fy);
        if (fyEntry) return fyEntry.ay;
      }
    }
    // --- "Year ending 31-Mar-2025" → FY 2024-25 → AY 2025-26 ---
    const yearEndingRe = /\byear\s+(?:ending|ended|ends)\s+(?:\d{1,2}[\/\-\.]\w+[\/\-\.]|\w+\s+\d{1,2}[,\s]+)?(\d{4})\b/i;
    m = norm.match(yearEndingRe);
    if (m) {
      const endYear = parseInt(m[1], 10);
      const fy = `${endYear - 1}-${String(endYear).slice(-2)}`;
      const fyEntry = findFy(fy);
      if (fyEntry) return fyEntry.ay;
    }
    return null;
  }

  /**
   * Profile (PAN, name, address, bank, etc.) — global, not per-year.
   * Stored in its own localStorage key. v1's data model had these
   * inside each workbook; v1.1+ splits them out so the same profile
   * is reused across all years.
   */
  function emptyProfile() {
    return {
      pan: "",
      name: "",
      dob: "",
      aadhaar_last4: "",
      address: {
        line1: "",
        line2: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      mobile: "",
      email: "",
      filing_status: "resident",
      residential_status_optional: false,
      bank_for_refund: {
        account_number: "",
        ifsc: "",
        bank_name: "",
        account_type: "savings",
      },
      new_regime: false,
    };
  }

  const PROFILE_STORAGE_KEY = "itr_workbook_v1_profile";

  function saveProfile(profile) {
    if (!profile || typeof profile !== "object") {
      throw new Error("saveProfile: profile object is required");
    }
    if (typeof localStorage !== "undefined" && localStorage) {
      try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      } catch (e) {
        console.warn("saveProfile: localStorage write failed:", e);
      }
    }
    return profile;
  }

  function loadProfile() {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw);
      return mergeProfileWithDefaults(saved);
    } catch (e) {
      console.error("Failed to parse profile:", e);
      return null;
    }
  }

  function mergeProfileWithDefaults(saved) {
    const base = emptyProfile();
    if (!saved || typeof saved !== "object") return base;
    for (const k of Object.keys(base)) {
      if (k in saved && saved[k] !== undefined) {
        base[k] = saved[k];
      }
    }
    // Recurse one level for nested address / bank_for_refund
    if (saved.address && typeof saved.address === "object") {
      for (const k of Object.keys(base.address)) {
        if (saved.address[k] !== undefined) {
          base.address[k] = saved.address[k];
        }
      }
    }
    if (saved.bank_for_refund && typeof saved.bank_for_refund === "object") {
      for (const k of Object.keys(base.bank_for_refund)) {
        if (saved.bank_for_refund[k] !== undefined) {
          base.bank_for_refund[k] = saved.bank_for_refund[k];
        }
      }
    }
    return base;
  }

  function deleteProfile() {
    if (typeof localStorage === "undefined" || !localStorage) return true;
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    return true;
  }

  /**
   * Create an empty personal info section.
   */
  function emptyPersonal() {
    return {
      pan: "",                 // 10-char PAN, e.g. "ABCDE1234F"
      name: "",
      dob: "",                 // ISO 'YYYY-MM-DD'
      aadhaar_last4: "",       // last 4 digits only (privacy)
      address: {
        line1: "",
        line2: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      mobile: "",
      email: "",
      filing_status: "resident",  // 'resident' | 'rnor' | 'nri'
      residential_status_optional: false,  // 6+ months in India in FY
      bank_for_refund: {
        account_number: "",
        ifsc: "",
        bank_name: "",
        account_type: "savings",
      },
      // Whether the user is opting for the new tax regime
      // (Section 115BAC). Defaults to false (old regime) for safety
      // — the user must explicitly opt-in.
      new_regime: false,
    };
  }

  /**
   * Create an empty salary section.
   */
  function emptySalary() {
    return {
      employers: [
        // One entry per employer (most people have one). Each
        // contains the values from that employer's Form 16 Part A
        // (TDS) and Part B (salary breakdown).
        // {
        //   employer_name: "",
        //   tan: "",
        //   gross_salary: 0,           // from Form 16 Part B Sec 17(1)
        //   allowances_exempt_10: 0,   // total of HRA, LTA, etc. exempt u/s 10
        //   hra_received: 0,           // sub-component for exemption calc
        //   hra_exempt_computed: 0,    // auto-computed (rents paid, etc.)
        //   lta_exempt: 0,             // sub-component
        //   standard_deduction: 50000,  // FY 2024-25 default
        //   professional_tax: 0,
        //   tds_deducted: 0,           // from Form 16 Part A
        // }
      ],
      // Total TDS on salary, summed across employers.
      tds_total: 0,
    };
  }

  /**
   * Create an empty house property section.
   */
  function emptyHouseProperty() {
    return {
      properties: [
        // {
        //   type: "self-occupied" | "let-out" | "deemed-let-out",
        //   address: "...",
        //   rent_received: 0,           // annual, gross of TDS
        //   municipal_taxes_paid: 0,   // for the year
        //   home_loan_interest_paid: 0, // Section 24(b): max ₹2L self-occ
        //   home_loan_principal_paid: 0, // goes to 80C, not HP
        //   co_ownership_share: 100,     // % (0-100)
        //   tds_on_rent: 0,             // Section 194-IB if >₹2.4L/yr
        // }
      ],
    };
  }

  /**
   * Create an empty "Other Sources" section.
   */
  function emptyOtherSources() {
    return {
      // Interest income
      savings_account_interest: 0,
      fd_interest: 0,
      rd_interest: 0,
      // Dividend income (gross, before TDS)
      dividend_gross: 0,
      dividend_tds: 0,           // TDS already deducted by the company
      // Other
      other_misc: [],            // [{label: "Royalty", amount: 0}, ...]
      // Lottery / crossword / etc. — taxed at 30% flat (Section 115BBH)
      lottery_winnings: 0,
      // Family pension (taxable as salary under Section 17(1))
      family_pension: 0,
    };
  }

  /**
   * Create an empty capital gains section.
   * Populated by importing from the static Tax P&L app's JSON export
   * OR by manual entry.
   */
  function emptyCapitalGains() {
    return {
      // ===== Equity (with STT, Section 111A / 112A) =====
      stcg_111a: 0,              // Short-term, listed equity w/ STT (15%)
      ltcg_112a: 0,              // Long-term, listed equity w/ STT (10% > ₹1L)
      // ===== Other STCG (non-111A, slab rate) =====
      stcg_other: 0,             // e.g. unlisted equity, debt MF <3yr
      // ===== Other LTCG (non-112A, 20% with indexation) =====
      ltcg_other: 0,             // e.g. unlisted shares, property, gold
      // ===== Carry forward losses from prior years =====
      stcl_brought_forward: 0,   // can set off against any STCG, then LTST
      ltcl_brought_forward: 0,   // can set off against any LTCG, then STCG
      // Per-year buckets for the 8-year expiry rule (Section 71).
      // Each entry: { fy: "2020-21", amount: 50000, expiry_ay: "2028-29" }
      // Engine picks buckets whose expiry_ay >= the current AY.
      stcl_buckets: [],          // array of { fy, amount, expiry_ay? }
      ltcl_buckets: [],
      // ===== Source / metadata =====
      source: "manual",          // 'manual' | 'static-app-import' | 'broker-csv'
      imported_at: null,         // ISO timestamp of last import
      imported_from: null,       // filename or app version
      notes: "",                 // user notes
    };
  }

  /**
   * Create an empty deductions section (Chapter VI-A).
   */
  function emptyDeductions() {
    return {
      // 80C: max ₹1.5L total
      "80c_total": 0,            // user types total; we don't need sub-categories
      // 80CCD(1B): NPS additional contribution (over 80C), max ₹50K
      "80ccd_1b": 0,             // employee NPS
      // 80CCD(2): employer NPS contribution (no cap)
      "80ccd_2": 0,
      // 80D: Health insurance
      "80d_self_family": 0,      // self+family, max ₹25K (₹50K if senior)
      "80d_parents": 0,          // parents, max ₹25K (₹50K if senior)
      // 80E: Education loan interest (no cap, 8 years)
      "80e": 0,
      // 80G: Donations (50% or 100% of amount depending on the org)
      "80g_50pct": 0,            // e.g. PMNRF, government funds
      "80g_100pct": 0,           // e.g. PM Cares (FY 2019-20 onwards 100%)
      // 80TTA: Savings interest (max ₹10K, only old regime, non-senior)
      "80tta": 0,
      // 80TTB: Interest for senior citizens (max ₹50K, old regime)
      "80ttb": 0,
      // Other sections (80CCG, 80DDB, 80E, 80EEA, 80EEB, etc.)
      // can be added later. Keep v1 focused on the top-8.
    };
  }

  /**
   * Create an empty "Taxes Paid" section.
   */
  function emptyTaxesPaid() {
    return {
      // TDS as per Form 26AS / AIS
      tds_salary: 0,             // (mirror of salary.tds_total for reference)
      tds_other_than_salary: 0,  // TDS on interest, rent, etc.
      // Advance tax paid (4 installments: 15-Jun, 15-Sep, 15-Dec, 15-Mar)
      advance_tax: 0,
      // Self-assessment tax paid before filing
      self_assessment_tax: 0,
      // TCS (Tax collected at source) — usually on foreign remittances
      tcs: 0,
      // Source / metadata
      source: "manual",
      form_26as_json_imported: null,
    };
  }

  /**
   * Create a full empty workbook for a given AY.
   * @param {string} ay Assessment year, e.g. "2025-26"
   */
  function emptyWorkbook(ay) {
    const ayInfo = findAy(ay);
    if (!ayInfo) {
      throw new Error(`Unsupported AY: ${ay}. Supported: ${supportedAys().map(x => x.ay).join(", ")}`);
    }
    // NOTE: v1.1+ profile is global (PAN, name, address, bank). The
    // `personal` field here is a backwards-compat mirror populated by
    // the app on every save (see app.js collectWorkbook). New code
    // should prefer `loadProfile()` / `saveProfile()` from the
    // data_model API.
    return {
      schema_version: 2,
      app: "ITRready",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ay: ayInfo.ay,
      fy: ayInfo.fy,
      personal: emptyPersonal(),
      salary: emptySalary(),
      house_property: emptyHouseProperty(),
      other_sources: emptyOtherSources(),
      capital_gains: emptyCapitalGains(),
      deductions: emptyDeductions(),
      taxes_paid: emptyTaxesPaid(),
    };
  }

  /**
   * Return the default workbook (most recent AY).
   */
  function emptyDefaultWorkbook() {
    return emptyWorkbook(defaultAy());
  }

  /**
   * Deep-merge: take the empty shape and overlay any user-provided
   * values. This means a workbook saved with one schema version can
   * be loaded after a future version adds new fields — the new
   * fields get their default empty values.
   */
  function mergeWithDefaults(saved) {
    const base = emptyWorkbook(saved.ay || defaultAy());
    if (!saved) return base;
    // Top-level fields (everything that's already in the base shape)
    for (const k of Object.keys(saved)) {
      if (k in base) base[k] = saved[k];
    }
    // Recurse one level for nested shapes
    // NOTE: 'personal' is still in this list for backward compat. New
    // code should write to the global profile (loadProfile/saveProfile),
    // but old code / tests may still put data in wb.personal. The
    // loadWorkbook migration strips `personal` from legacy saved data
    // by moving it to the profile.
    for (const section of ["personal", "salary", "house_property",
                            "other_sources", "capital_gains",
                            "deductions", "taxes_paid"]) {
      if (saved[section] && typeof saved[section] === "object") {
        for (const k of Object.keys(base[section])) {
          if (saved[section][k] !== undefined) {
            base[section][k] = saved[section][k];
          }
        }
      }
    }
    // Preserve metadata
    base.created_at = saved.created_at || base.created_at;
    base.updated_at = new Date().toISOString();
    base.schema_version = base.schema_version;
    return base;
  }

  // ============================================================
  // localStorage persistence
  // ============================================================

  const STORAGE_PREFIX = "itr_workbook_v1_";

  function storageKey(ay) {
    return STORAGE_PREFIX + ay;
  }

  /**
   * Save a workbook to localStorage. Returns the workbook on success.
   * In Node.js (no localStorage), this is a no-op (returns the workbook
   * unchanged). Tests can detect the save by spying on the function.
   */
  function saveWorkbook(workbook) {
    if (!workbook || !workbook.ay) {
      throw new Error("saveWorkbook: workbook.ay is required");
    }
    workbook.updated_at = new Date().toISOString();
    if (typeof localStorage !== "undefined" && localStorage) {
      try {
        localStorage.setItem(storageKey(workbook.ay), JSON.stringify(workbook));
      } catch (e) {
        // localStorage might be disabled (private mode, quota exceeded)
        // Don't crash — just log and return.
        console.warn("saveWorkbook: localStorage write failed:", e);
      }
    }
    return workbook;
  }

  /**
   * Load a workbook from localStorage. Returns the merged (with
   * defaults) workbook, or null if none exists. In Node.js
   * (no localStorage), always returns null.
   */
  function loadWorkbook(ay) {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    const raw = localStorage.getItem(storageKey(ay));
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw);
      // Migration: extract `personal` to the global profile. This
      // is a one-way operation — we move the personal into the
      // profile and re-save the workbook WITHOUT personal. We do
      // this only when:
      //   1. The saved workbook actually has a `personal` field
      //      (legacy v1 format), AND
      //   2. The personal has at least one non-empty field
      //      (so we don't migrate a fresh emptyWorkbook's empty
      //      personal and accidentally overwrite a real profile).
      if (saved && saved.personal && _hasRealPersonalData(saved.personal)) {
        const existingProfile = loadProfile();
        const profileIsEmpty = !existingProfile || !existingProfile.pan;
        if (profileIsEmpty) {
          saveProfile(saved.personal);
        }
        // Strip `personal` and re-save
        const { personal, ...rest } = saved;
        try {
          localStorage.setItem(storageKey(ay), JSON.stringify(rest));
        } catch (e) { /* ignore */ }
        return mergeWithDefaults(rest);
      }
      return mergeWithDefaults(saved);
    } catch (e) {
      console.error(`Failed to parse workbook for ${ay}:`, e);
      return null;
    }
  }

  /**
   * Returns true if the personal section has at least one non-empty
   * meaningful field. Used to decide whether to run the personal→profile
   * migration on load. (A fresh emptyWorkbook's personal is all empty
   * and shouldn't trigger the migration.)
   */
  function _hasRealPersonalData(p) {
    if (!p || typeof p !== "object") return false;
    // Check top-level fields
    const topFields = ["pan", "name", "dob", "aadhaar_last4", "mobile", "email"];
    for (const f of topFields) {
      if (p[f] && String(p[f]).trim() !== "") return true;
    }
    // Check address
    if (p.address) {
      for (const v of Object.values(p.address)) {
        if (v && String(v).trim() !== "") return true;
      }
    }
    // Check bank
    if (p.bank_for_refund) {
      for (const v of Object.values(p.bank_for_refund)) {
        if (v && String(v).trim() !== "") return true;
      }
    }
    return false;
  }

  /**
   * List all AYs that have a saved workbook.
   * Returns an array of AY strings, sorted ascending (oldest first).
   */
  function listSavedAys() {
    if (typeof localStorage === "undefined" || !localStorage) return [];
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        const ay = key.slice(STORAGE_PREFIX.length);
        result.push(ay);
      }
    }
    return result.sort();
  }

  /**
   * Migrate a legacy v1 workbook (which had `personal` inside) to the
   * new split format (no `personal`; profile lives separately).
   * Returns { workbook: migratedWb, profileExtracted: {…} }.
   * The caller is responsible for saving both pieces.
   */
  function migrateLegacyWorkbook(saved) {
    if (!saved || typeof saved !== "object") {
      return { workbook: saved, profileExtracted: null };
    }
    // If there's no `personal` field, this is already a new-format wb.
    if (!saved.personal) {
      return { workbook: saved, profileExtracted: null };
    }
    const profile = emptyProfile();
    // Copy all known profile fields from saved.personal
    for (const k of Object.keys(profile)) {
      if (saved.personal[k] !== undefined) {
        profile[k] = saved.personal[k];
      }
    }
    if (saved.personal.address) {
      for (const k of Object.keys(profile.address)) {
        if (saved.personal.address[k] !== undefined) {
          profile.address[k] = saved.personal.address[k];
        }
      }
    }
    if (saved.personal.bank_for_refund) {
      for (const k of Object.keys(profile.bank_for_refund)) {
        if (saved.personal.bank_for_refund[k] !== undefined) {
          profile.bank_for_refund[k] = saved.personal.bank_for_refund[k];
        }
      }
    }
    // Build the new workbook (without `personal`)
    const newWb = { ...saved };
    delete newWb.personal;
    return { workbook: newWb, profileExtracted: profile };
  }

  /**
   * Delete a workbook from localStorage. Returns true on success.
   */
  function deleteWorkbook(ay) {
    if (typeof localStorage === "undefined" || !localStorage) return true;
    localStorage.removeItem(storageKey(ay));
    return true;
  }

  /**
   * Delete ALL workbooks. Used by a "Reset all data" button.
   */
  function deleteAllWorkbooks() {
    if (typeof localStorage === "undefined" || !localStorage) return 0;
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) toDelete.push(key);
    }
    toDelete.forEach((k) => localStorage.removeItem(k));
    return toDelete.length;
  }

  // ============================================================
  // Validation (lightweight — runs in browser)
  // ============================================================

  /**
   * Validate a workbook. Returns { ok: bool, errors: [{field, msg}] }.
   * Lightweight — only checks critical fields.
   */
  function validateWorkbook(wb) {
    const errors = [];
    if (!findAy(wb.ay)) {
      errors.push({ field: "ay", msg: `Unknown AY: ${wb.ay}` });
    }
    if (wb.personal.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(wb.personal.pan)) {
      errors.push({ field: "personal.pan", msg: "PAN format invalid (expected AAAAA9999A)" });
    }
    if (wb.personal.dob && !/^\d{4}-\d{2}-\d{2}$/.test(wb.personal.dob)) {
      errors.push({ field: "personal.dob", msg: "DOB must be YYYY-MM-DD" });
    }
    if (wb.personal.bank_for_refund.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(wb.personal.bank_for_refund.ifsc)) {
      errors.push({ field: "bank.ifsc", msg: "IFSC format invalid (expected AAAA0XXXXXX)" });
    }
    return { ok: errors.length === 0, errors };
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    supportedAys,
    defaultAy,
    findAy,
    findFy,
    emptyPersonal,
    emptySalary,
    emptyHouseProperty,
    emptyOtherSources,
    emptyCapitalGains,
    emptyDeductions,
    emptyTaxesPaid,
    emptyWorkbook,
    emptyDefaultWorkbook,
    mergeWithDefaults,
    saveWorkbook,
    loadWorkbook,
    listSavedAys,
    deleteWorkbook,
    deleteAllWorkbooks,
    validateWorkbook,
    // Profile (global, not per-year) — v1.1+
    emptyProfile,
    saveProfile,
    loadProfile,
    deleteProfile,
    PROFILE_STORAGE_KEY,
    // AY detection from file content
    detectAyFromText,
    // Migration helper
    migrateLegacyWorkbook,
    STORAGE_PREFIX,
  };
});
