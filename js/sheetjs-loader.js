// js/sheetjs-loader.js
// SheetJS (xlsx.js) loader for v1: reads xlsx files in the browser.
//
// v1 used the backend (Python) to parse broker Tax P&L files.
// v1.1+ does it client-side. SheetJS is ~900KB minified; we load
// it from a CDN on demand so the page stays light for users who
// don't need it.
//
// Why SheetJS?
//   - The most widely-used browser xlsx parser (MIT-licensed,
//     no signup, no telemetry).
//   - Reads both .xlsx (Office Open XML) and the older .xls
//     (BIFF) binary format.
//   - Returns workbook data as plain JS objects we can iterate.
//
// API: window.SheetJSLoader
//   - preload(): fetch the script from the CDN; returns Promise<bool>
//   - readWorkbook(file): read a File → { SheetNames, Sheets }
//   - isLoaded(): bool
//
// Mirrors the PDFJS_STUB pattern in js/pdfjs-stub.js for symmetry.

(function () {
  "use strict";

  let loadPromise = null;

  /**
   * Load SheetJS from the CDN. Returns a Promise that resolves to
   * the XLSX global, or null if the load failed.
   *
   * Uses SheetJS 0.20.3 from cdn.sheetjs.com (the official CDN,
   * set up by the SheetJS maintainers). Version is pinned so
   * future SheetJS changes don't break our parser.
   *
   * SheetJS exposes a global `XLSX` object after the script loads.
   */
  function loadSheetJs() {
    if (typeof window === "undefined") return Promise.resolve(null);
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      if (typeof document === "undefined" || !document.createElement) {
        resolve(null);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      script.async = true;
      script.onload = () => {
        if (!window.XLSX) {
          reject(new Error("SheetJS script loaded but window.XLSX is undefined"));
          return;
        }
        resolve(window.XLSX);
      };
      script.onerror = () => reject(new Error(
        "Failed to load SheetJS from CDN. Check your network connection."
      ));
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  /**
   * Read an xlsx file as a SheetJS workbook.
   * @param {File} file
   * @returns {Promise<Object>}  SheetJS workbook
   */
  async function readWorkbook(file) {
    if (!file) throw new Error("No file provided");
    const XLSX = await loadSheetJs();
    if (!XLSX) {
      throw new Error(
        "SheetJS not available. The CDN could not be reached. " +
        "Try again with internet access, or enter the cap-gains totals manually."
      );
    }
    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsArrayBuffer(file);
    });
    // XLSX.read accepts ArrayBuffer directly
    return XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  }

  /**
   * Read all rows of a single sheet as an array of objects
   * (header name → cell value).
   * @param {Object} workbook  SheetJS workbook
   * @param {string} sheetName
   * @returns {Array<Object>}
   */
  function readSheetAsObjects(workbook, sheetName) {
    if (!workbook || !workbook.Sheets || !workbook.Sheets[sheetName]) return [];
    const XLSX = window.XLSX;
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: null,           // empty cells become null (not undefined)
      raw: false,              // format numbers as strings (preserves ₹, %)
    });
  }

  /**
   * Find a sheet by fuzzy-matching its name. Used because the same
   * logical sheet might be named "Equity", "equity ", "Stocks", etc.
   * across different broker exports.
   * @param {Object} workbook
   * @param {string[]} keywords  All keywords must appear (case-insensitive)
   * @returns {string|null}  Sheet name, or null if no match
   */
  function findSheet(workbook, keywords) {
    if (!workbook || !workbook.SheetNames) return null;
    const lower = keywords.map((k) => k.toLowerCase());
    for (const name of workbook.SheetNames) {
      const n = name.toLowerCase();
      if (lower.every((k) => n.includes(k))) return name;
    }
    return null;
  }

  // ============================================================
  // Public API
  // ============================================================

  window.SheetJSLoader = {
    async preload() {
      try {
        await loadSheetJs();
        return true;
      } catch (e) {
        if (typeof console !== "undefined") {
          console.warn("SheetJS preload failed:", e.message);
        }
        return false;
      }
    },
    isLoaded() {
      return typeof window !== "undefined" && !!window.XLSX;
    },
    readWorkbook,
    readSheetAsObjects,
    findSheet,
  };
})();
