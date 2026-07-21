// js/pdfjs-stub.js
// PDF.js loader for v1: extracts text from a Form 16 PDF (or .txt).
//
// v1 (legacy) used a stub that read files as plain text — fine for
// .txt files but useless for real Form 16 PDFs (which are binary).
// v1.1+ uses real PDF.js loaded from a CDN.
//
// API: window.PDFJS_STUB.getDocumentText(file) -> Promise<string>
//
// Implementation:
//   1. If the file is a .txt → read as UTF-8 text (fast path, also
//      covers the v1 fallback for users without internet access on
//      first load).
//   2. If the file is a .pdf and pdfjsLib is loaded → extract text
//      page-by-page using pdfjsLib.getDocument().
//   3. If pdfjsLib isn't loaded (e.g. CDN unreachable) AND the file
//      is a PDF → throw a helpful error telling the user to either
//      wait for the CDN or save the PDF as .txt first.
//
// The same `PDFJS_STUB` global is kept for backward compatibility —
// app.js doesn't need to know whether the real PDF.js or the stub
// is in play.

(function () {
  "use strict";

  // Track the load promise so concurrent file uploads share one
  // network request for the PDF.js library.
  let pdfjsLoadPromise = null;

  /**
   * Load pdfjsLib from the CDN if not already loaded. Returns a
   * Promise that resolves to the pdfjsLib global.
   *
   * Uses PDF.js v3.11.174 from cdnjs (the last v3 release with
   * a non-module legacy build that's drop-in for the browser).
   * Version is pinned in the URL so future PDF.js changes don't
   * break the parser. The worker is also served from cdnjs at
   * the same version, ensuring worker compatibility.
   *
   * PDF.js v3 API surface used (stable since v3.0):
   *   pdfjsLib.GlobalWorkerOptions.workerSrc = "...";
   *   const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
   *   const page = await pdf.getPage(i);
   *   const tc = await page.getTextContent();
   *   const text = tc.items.map(it => it.str).join(" ");
   */
  function loadPdfJs() {
    if (typeof window === "undefined") return Promise.resolve(null);
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsLoadPromise) return pdfjsLoadPromise;
    pdfjsLoadPromise = new Promise((resolve, reject) => {
      // Guard: if document is missing (e.g. running in pure Node),
      // don't try to load anything.
      if (typeof document === "undefined" || !document.createElement) {
        resolve(null);
        return;
      }
      // Insert a <script> for the main pdfjsLib build
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.async = true;
      script.onload = () => {
        if (!window.pdfjsLib) {
          reject(new Error("PDF.js script loaded but window.pdfjsLib is undefined"));
          return;
        }
        // Configure the worker
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error(
        "Failed to load PDF.js from CDN. Check your network connection, " +
        "or save the PDF as .txt and upload that instead."
      ));
      document.head.appendChild(script);
    });
    return pdfjsLoadPromise;
  }

  /**
   * Detect if a File is a PDF (by MIME type or extension).
   * @param {File} file
   * @returns {boolean}
   */
  function isPdf(file) {
    if (!file) return false;
    if (file.type === "application/pdf") return true;
    const name = (file.name || "").toLowerCase();
    return name.endsWith(".pdf");
  }

  /**
   * Read a File as ArrayBuffer (for PDF.js).
   * @param {File} file
   * @returns {Promise<ArrayBuffer>}
   */
  function readArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read file as ArrayBuffer"));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Read a File as UTF-8 text.
   * @param {File} file
   * @returns {Promise<string>}
   */
  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read file as text"));
      reader.readAsText(file);
    });
  }

  /**
   * Extract text from a PDF ArrayBuffer using pdfjsLib.
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<string>}  Concatenated text of all pages
   */
  async function extractPdfText(arrayBuffer) {
    const pdfjsLib = await loadPdfJs();
    if (!pdfjsLib) {
      throw new Error(
        "PDF.js not available. If you uploaded a PDF, the CDN could not be reached. " +
        "Try saving the PDF as .txt and uploading that instead."
      );
    }
    // Copy the buffer (PDF.js transfers ownership of typed arrays)
    const bufferCopy = arrayBuffer.slice(0);
    const pdf = await pdfjsLib.getDocument({ data: bufferCopy }).promise;
    const lines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      // PDF.js returns text items with str, hasEOL, transform, etc.
      // Strategy: join each item's str with a space, then add a
      // newline at EOL markers. This preserves the visual structure
      // of the original Form 16 (which is mostly 1 line per item).
      let pageLine = "";
      for (const item of tc.items) {
        if (typeof item.str !== "string") continue;
        pageLine += item.str;
        if (item.hasEOL) {
          lines.push(pageLine);
          pageLine = "";
        } else {
          pageLine += " ";
        }
      }
      if (pageLine) lines.push(pageLine);
    }
    return lines.join("\n");
  }

  // ============================================================
  // Public API
  // ============================================================

  window.PDFJS_STUB = {
    /**
     * Extract text from a Form 16 file (PDF or .txt).
     * @param {File} file
     * @returns {Promise<string>}
     */
    async getDocumentText(file) {
      if (!file) throw new Error("No file provided");
      if (isPdf(file)) {
        const arrayBuffer = await readArrayBuffer(file);
        return extractPdfText(arrayBuffer);
      }
      // .txt or unknown — read as text
      return readText(file);
    },

    /**
     * Whether real PDF.js is loaded (true) or the legacy fallback
     * is in play (false). Useful for the UI to show a banner.
     * @returns {boolean}
     */
    isRealPdfJsLoaded() {
      return typeof window !== "undefined" && !!window.pdfjsLib;
    },

    /**
     * Pre-load PDF.js from the CDN. The app can call this on page
     * load so the first PDF upload is instant. Errors are swallowed;
     * the user can still try the .txt fallback.
     * @returns {Promise<boolean>}  true if loaded, false otherwise
     */
    async preload() {
      try {
        await loadPdfJs();
        return true;
      } catch (e) {
        // Don't crash the page if the CDN is unreachable; the user
        // can still upload .txt files. Just log.
        if (typeof console !== "undefined") {
          console.warn("PDF.js preload failed:", e.message);
        }
        return false;
      }
    },
  };
})();
