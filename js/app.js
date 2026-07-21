// js/app.js
// ITRready UI controller (v1.1+ multi-year).
//
// Architecture (top-level state):
//   - "views": years picker, year form, profile, compare. Each is a
//     top-level <section> in index.html. Only one is .active at a time.
//   - "currentAy": the AY the user is currently editing (null when
//     on the years picker or compare view).
//   - profile: cached from localStorage on init.
//
// Data flow:
//   - On the years picker, the app lists all saved AYs (from
//     dataModel.listSavedAys()) and shows a card per AY with a
//     summary (income, tax, refund/payable).
//   - Clicking a card loads that AY's workbook and switches to
//     the year form view.
//   - Uploads in the form view detect the file's AY and apply
//     to that AY's workbook. If it's a different AY than the one
//     being viewed, the user is offered a "switch to that AY" link.

(function () {
  "use strict";

  // ============================================================
  // IT-Act constants (re-exported from tax_engine for convenience)
  // ============================================================
  const C = (window.taxEngine && window.taxEngine.CONSTANTS) || {};
  const HP_FULL_OWNERSHIP_PCT = C.HP_FULL_OWNERSHIP_PCT || 100;
  const AY_2025_26 = C.AY_2025_26 || "2025-26";
  const AY_2024_25 = C.AY_2024_25 || "2024-25";
  const ITR1_TOTAL_INCOME_MAX = C.ITR1_TOTAL_INCOME_MAX || 5000000;
  const ITR1_MAX_HP_PROPERTIES = C.ITR1_MAX_HP_PROPERTIES || 1;
  const LTCG_112A_EXEMPTION = C.LTCG_112A_EXEMPTION || 100000;

  // UI timings
  const SAVE_DEBOUNCE_MS = 300;
  const SAVE_STATUS_DISPLAY_MS = 1200;
  const DOWNLOAD_CLEANUP_MS = 100;

  // ============================================================
  // State
  // ============================================================

  let currentAy = null;          // the AY currently being viewed (null on home)
  let currentView = "years";     // 'years' | 'year' | 'profile' | 'compare'
  let profile = null;             // cached profile (loaded on init)

  // ============================================================
  // Utilities
  // ============================================================

  function fmtRs(n) {
    if (!Number.isFinite(n)) return "₹0";
    const sign = n < 0 ? "-" : "";
    return sign + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function showSaveStatus(text, kind) {
    const el = document.getElementById("saveStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "save-status" + (kind ? " " + kind : "");
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ============================================================
  // View routing
  // ============================================================

  function showView(name) {
    currentView = name;
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const el = document.getElementById("view-" + name);
    if (el) el.classList.add("active");
    const viewLabel = document.getElementById("viewLabel");
    if (viewLabel) {
      const labels = {
        years: "Years",
        year: currentAy ? `AY ${currentAy}` : "Year",
        profile: "Profile",
        compare: "Compare",
      };
      viewLabel.textContent = labels[name] || "";
    }
  }

  // ============================================================
  // Year picker dashboard
  // ============================================================

  function renderYearCards() {
    const container = document.getElementById("yearCards");
    if (!container) return;
    container.innerHTML = "";
    // Saved years
    const savedAys = window.taxDataModel.listSavedAys();
    if (savedAys.length === 0) {
      // No saved years yet — show a single empty card prompting the user
      const ayInfo = window.taxDataModel.supportedAys()[0];
      container.appendChild(buildYearCard({
        ay: ayInfo.ay,
        fy: ayInfo.fy,
        label: ayInfo.label,
        grossTotalIncome: 0,
        totalTaxRounded: 0,
        isEmpty: true,
        isPayable: true,
      }));
    } else {
      for (const ay of savedAys) {
        const ayInfo = window.taxDataModel.findAy(ay) ||
                       { ay, fy: "?", label: "AY " + ay };
        const wb = window.taxDataModel.loadWorkbook(ay);
        const summary = computeSummary(wb, profile);
        container.appendChild(buildYearCard({
          ay,
          fy: ayInfo.fy,
          label: ayInfo.label,
          grossTotalIncome: summary.gti,
          totalTaxRounded: summary.totalTaxRounded,
          isEmpty: summary.isEmpty,
          isPayable: summary.netPayable > 0,
          netPayable: summary.netPayable,
        }));
      }
    }
  }

  function buildYearCard(data) {
    const card = document.createElement("div");
    card.className = "year-card" + (data.isEmpty ? " year-card-empty" : "");
    card.dataset.ay = data.ay;
    const statusLabel = data.isEmpty
      ? '<span class="year-card-status empty">No data yet</span>'
      : '<span class="year-card-status complete">Has data</span>';
    const mainMetric = data.isEmpty
      ? "Click to start"
      : (data.isPayable
          ? `Pay ${fmtRs(data.netPayable)}`
          : `Refund ${fmtRs(-data.netPayable)}`);
    const subMetric = data.isEmpty
      ? "Empty workbook"
      : `Tax ${fmtRs(data.totalTaxRounded)} · GTI ${fmtRs(data.grossTotalIncome)}`;
    card.innerHTML = `
      <div class="year-card-label">Assessment Year</div>
      <div class="year-card-title">${escapeHtml(data.ay)}</div>
      <div class="year-card-fy">${escapeHtml(data.fy || "")} · ${escapeHtml(data.label)}</div>
      <div class="year-card-metric">${escapeHtml(mainMetric)}</div>
      <div class="year-card-sub">${escapeHtml(subMetric)}</div>
      ${statusLabel}
      <button class="year-card-delete" data-action="delete-year" title="Delete this year's data">×</button>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.dataset && e.target.dataset.action === "delete-year") {
        e.stopPropagation();
        if (confirm(`Delete all data for AY ${data.ay}? This cannot be undone.`)) {
          window.taxDataModel.deleteWorkbook(data.ay);
          renderYearCards();
        }
        return;
      }
      switchToYear(data.ay);
    });
    return card;
  }

  function computeSummary(wb, profile) {
    if (!wb) return { gti: 0, totalTaxRounded: 0, isEmpty: true, netPayable: 0 };
    // Is the workbook empty? (no salary, no cap gains, no other income)
    const hasData = (
      (wb.salary.employers && wb.salary.employers.length > 0 && wb.salary.employers[0].gross_salary > 0) ||
      (wb.capital_gains.stcg_111a + wb.capital_gains.ltcg_112a +
       wb.capital_gains.stcg_other + wb.capital_gains.ltcg_other) > 0 ||
      (wb.other_sources.savings_account_interest + wb.other_sources.fd_interest +
       wb.other_sources.dividend_gross) > 0 ||
      (wb.house_property.properties && wb.house_property.properties.length > 0)
    );
    if (!hasData) {
      return { gti: 0, totalTaxRounded: 0, isEmpty: true, netPayable: 0 };
    }
    const tr = window.taxEngine.computeBothRegimes(wb, profile);
    const rec = tr.recommendation;
    const chosen = rec === "old" ? tr.old : (rec === "new" ? tr.new :
                  (profile && profile.new_regime ? tr.new : tr.old));
    return {
      gti: chosen.gti || 0,
      totalTaxRounded: chosen.total_tax_rounded || 0,
      isEmpty: false,
      netPayable: chosen.net_payable || 0,
      isPayable: (chosen.net_payable || 0) > 0,
    };
  }

  // ============================================================
  // Add-year flow
  // ============================================================

  function initAddYear() {
    const addBtn = document.getElementById("addYearBtn");
    const picker = document.getElementById("addYearPicker");
    const select = document.getElementById("addYearSelect");
    const confirm = document.getElementById("addYearConfirm");
    const cancel = document.getElementById("addYearCancel");
    if (!addBtn) return;
    addBtn.addEventListener("click", () => {
      // Populate the dropdown with all supported AYs minus the
      // already-saved ones (don't offer duplicates).
      const savedAys = window.taxDataModel.listSavedAys();
      const allAys = window.taxDataModel.supportedAys();
      const remaining = allAys.filter((x) => !savedAys.includes(x.ay));
      if (remaining.length === 0) {
        alert("You've already created workbooks for all supported AYs.");
        return;
      }
      select.innerHTML = "";
      for (const a of remaining) {
        const opt = document.createElement("option");
        opt.value = a.ay;
        opt.textContent = a.label;
        select.appendChild(opt);
      }
      picker.style.display = "flex";
    });
    confirm.addEventListener("click", () => {
      const ay = select.value;
      if (!ay) return;
      // Create an empty workbook and save it
      const wb = window.taxDataModel.emptyWorkbook(ay);
      window.taxDataModel.saveWorkbook(wb);
      picker.style.display = "none";
      renderYearCards();
      // Switch to the new year
      switchToYear(ay);
    });
    cancel.addEventListener("click", () => {
      picker.style.display = "none";
    });
  }

  // ============================================================
  // Switch to year form view
  // ============================================================

  function switchToYear(ay) {
    currentAy = ay;
    const wb = window.taxDataModel.loadWorkbook(ay) || window.taxDataModel.emptyWorkbook(ay);
    window.taxDataModel.saveWorkbook(wb);    // ensure it's saved
    showView("year");
    renderYearForm(wb);
    recompute();
    // Default to first tab (Salary)
    activateTab("salary");
  }

  function renderYearForm(wb) {
    const ayInfo = window.taxDataModel.findAy(currentAy) || { ay: currentAy, fy: "?" };
    document.getElementById("yearTitle").textContent = `AY ${ayInfo.ay}`;
    document.getElementById("yearSubtitle").textContent =
      `${ayInfo.fy} · All data stays in this browser`;
    // Render the per-year data fields
    renderEmployers(wb);
    renderProperties(wb);
    renderOtherSources(wb);
    renderCapitalGains(wb);
    renderDeductions(wb);
    renderTaxesPaid(wb);
    // Imports panel uses the form fields below; no per-year data to render
  }

  // ============================================================
  // Profile page
  // ============================================================

  function loadProfileFromStorage() {
    profile = window.taxDataModel.loadProfile() || window.taxDataModel.emptyProfile();
    return profile;
  }

  function renderProfile() {
    profile = window.taxDataModel.loadProfile() || window.taxDataModel.emptyProfile();
    setVal("profile_name", profile.name);
    setVal("profile_pan", profile.pan);
    setVal("profile_dob", profile.dob);
    setVal("profile_mobile", profile.mobile);
    setVal("profile_email", profile.email);
    setVal("profile_aadhaar_last4", profile.aadhaar_last4);
    setVal("profile_filing_status", profile.filing_status);
    setVal("profile_new_regime", profile.new_regime);
    setVal("profile_address_line1", profile.address.line1);
    setVal("profile_address_line2", profile.address.line2);
    setVal("profile_address_city", profile.address.city);
    setVal("profile_address_state", profile.address.state);
    setVal("profile_address_pincode", profile.address.pincode);
    setVal("profile_address_country", profile.address.country || "India");
    setVal("profile_bank_account_number", profile.bank_for_refund.account_number);
    setVal("profile_bank_ifsc", profile.bank_for_refund.ifsc);
    setVal("profile_bank_bank_name", profile.bank_for_refund.bank_name);
    setVal("profile_bank_account_type", profile.bank_for_refund.account_type);
  }

  function collectProfile() {
    const p = window.taxDataModel.emptyProfile();
    p.name = val("profile_name") || "";
    p.pan = (val("profile_pan") || "").toUpperCase();
    p.dob = val("profile_dob") || "";
    p.mobile = val("profile_mobile") || "";
    p.email = val("profile_email") || "";
    p.aadhaar_last4 = val("profile_aadhaar_last4") || "";
    p.filing_status = val("profile_filing_status") || "resident";
    p.new_regime = !!val("profile_new_regime");
    p.address.line1 = val("profile_address_line1") || "";
    p.address.line2 = val("profile_address_line2") || "";
    p.address.city = val("profile_address_city") || "";
    p.address.state = val("profile_address_state") || "";
    p.address.pincode = val("profile_address_pincode") || "";
    p.address.country = val("profile_address_country") || "India";
    p.bank_for_refund.account_number = val("profile_bank_account_number") || "";
    p.bank_for_refund.ifsc = (val("profile_bank_ifsc") || "").toUpperCase();
    p.bank_for_refund.bank_name = val("profile_bank_bank_name") || "";
    p.bank_for_refund.account_type = val("profile_bank_account_type") || "savings";
    return p;
  }

  function bindProfile() {
    const ids = [
      "profile_name", "profile_pan", "profile_dob", "profile_mobile",
      "profile_email", "profile_aadhaar_last4", "profile_filing_status",
      "profile_new_regime",
      "profile_address_line1", "profile_address_line2", "profile_address_city",
      "profile_address_state", "profile_address_pincode", "profile_address_country",
      "profile_bank_account_number", "profile_bank_ifsc", "profile_bank_bank_name",
      "profile_bank_account_type",
    ];
    const saveDebounced = debounce(() => {
      const p = collectProfile();
      try {
        window.taxDataModel.saveProfile(p);
        profile = p;
        showSaveStatus("Profile saved", "saved");
        setTimeout(() => showSaveStatus(""), SAVE_STATUS_DISPLAY_MS);
        // Re-render the year picker (it uses profile for summaries)
        if (currentView === "years") renderYearCards();
      } catch (e) {
        showSaveStatus("Save error", "error");
      }
    }, SAVE_DEBOUNCE_MS);
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", saveDebounced);
    });
  }

  // ============================================================
  // Compare view
  // ============================================================

  function initCompareButton() {
    const btn = document.getElementById("compareYearsBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      showView("compare");
      renderCompare();
    });
  }

  function renderCompare() {
    const container = document.getElementById("compareTable");
    if (!container) return;
    const ays = window.taxDataModel.listSavedAys();
    if (ays.length === 0) {
      container.innerHTML = "<p class='hint'>No saved years yet. Add a workbook from the Years view to compare.</p>";
      return;
    }
    const p = window.taxDataModel.loadProfile() || window.taxDataModel.emptyProfile();
    let html = '<table class="compare-table"><thead><tr>';
    html += '<th>AY</th><th>FY</th><th>Gross income</th><th>Old regime tax</th><th>New regime tax</th><th>Recommended</th><th>Result</th>';
    html += '</tr></thead><tbody>';
    for (const ay of ays) {
      const ayInfo = window.taxDataModel.findAy(ay) || { ay, fy: "?" };
      const wb = window.taxDataModel.loadWorkbook(ay);
      const tr = window.taxEngine.computeBothRegimes(wb, p);
      const rec = tr.recommendation;
      const chosen = rec === "old" ? tr.old : (rec === "new" ? tr.new :
                    (p.new_regime ? tr.new : tr.old));
      const resultClass = chosen.net_payable > 0 ? "payable" : "refund";
      const resultText = chosen.net_payable > 0
        ? `Pay ${fmtRs(chosen.tax_payable_rounded)}`
        : `Refund ${fmtRs(chosen.refund_due_rounded)}`;
      const recLabel = rec === "tie" ? "tie" : (rec === "old" ? "OLD" : "NEW");
      html += '<tr>';
      html += `<td class="ay-cell">${escapeHtml(ay)}</td>`;
      html += `<td>${escapeHtml(ayInfo.fy)}</td>`;
      html += `<td>${fmtRs(chosen.gti)}</td>`;
      html += `<td>${fmtRs(tr.old.total_tax_rounded)}</td>`;
      html += `<td>${fmtRs(tr.new.total_tax_rounded)}</td>`;
      html += `<td>${recLabel}${rec !== "tie" ? ` (saves ${fmtRs(tr.savings)})` : ""}</td>`;
      html += `<td class="${resultClass}">${resultText}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ============================================================
  // Tab handling (inside year form view)
  // ============================================================

  function initTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        activateTab(tab.dataset.tab);
      });
    });
  }

  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) =>
      p.classList.toggle("active", p.id === "panel-" + name)
    );
  }

  // ============================================================
  // Per-year form rendering
  // ============================================================

  function val(id) {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return el.value === "" ? 0 : +el.value;
    return el.value;
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!v;
    else if (v === null || v === undefined) el.value = "";
    else el.value = v;
  }

  function renderEmployers(wb) {
    const container = document.getElementById("employers");
    if (!container) return;
    container.innerHTML = "";
    if (!wb.salary.employers || wb.salary.employers.length === 0) {
      wb.salary.employers = [makeEmptyEmployer()];
    }
    wb.salary.employers.forEach((e, i) => {
      container.appendChild(buildEmployerCard(e, i));
    });
    addTdsTotalField(container, wb);
  }

  function makeEmptyEmployer() {
    return {
      employer_name: "", tan: "", gross_salary: 0,
      allowances_exempt_10: 0, professional_tax: 0,
    };
  }

  function buildEmployerCard(emp, index) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">Employer ${index + 1}</span>
        <button class="remove-btn" data-action="remove-employer">Remove</button>
      </div>
      <div class="grid grid-2">
        <label>Employer name<input type="text" data-emp-field="employer_name" value="${escapeHtml(emp.employer_name || "")}"></label>
        <label>TAN<input type="text" data-emp-field="tan" value="${escapeHtml(emp.tan || "")}" maxlength="10"></label>
        <label>Gross salary (annual)<input type="number" data-emp-field="gross_salary" value="${emp.gross_salary || 0}" min="0" step="any"></label>
        <label>Allowances exempt u/s 10<input type="number" data-emp-field="allowances_exempt_10" value="${emp.allowances_exempt_10 || 0}" min="0" step="any"></label>
        <label>Professional tax<input type="number" data-emp-field="professional_tax" value="${emp.professional_tax || 0}" min="0" step="any"></label>
      </div>
    `;
    card.querySelector('[data-action="remove-employer"]').addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.salary.employers.splice(index, 1);
      window.taxDataModel.saveWorkbook(wb);
      renderEmployers(wb);
      recompute();
    });
    card.querySelectorAll("[data-emp-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const wb = collectWorkbook();
        wb.salary.employers[index][input.dataset.empField] =
          input.type === "number" ? (+input.value || 0) : input.value;
        saveWorkbookDebounced();
        recompute();
      });
    });
    return card;
  }

  function addTdsTotalField(container, wb) {
    const wrap = document.createElement("div");
    wrap.className = "card";
    wrap.innerHTML = `
      <div class="card-header">
        <span class="card-title">TDS on salary (total across employers)</span>
      </div>
      <div class="grid grid-2">
        <label>TDS total<input type="number" id="salary_tds_total" value="${wb.salary.tds_total || 0}" min="0" step="any"></label>
        <span class="hint" style="align-self: end; padding-bottom: 8px;">Sum of all Form 16 Part A TDS lines.</span>
      </div>
    `;
    container.appendChild(wrap);
    document.getElementById("salary_tds_total").addEventListener("input", (e) => {
      const wb = collectWorkbook();
      wb.salary.tds_total = +e.target.value || 0;
      saveWorkbookDebounced();
      recompute();
    });
  }

  function renderProperties(wb) {
    const container = document.getElementById("properties");
    if (!container) return;
    container.innerHTML = "";
    if (!wb.house_property.properties || wb.house_property.properties.length === 0) {
      wb.house_property.properties = [makeEmptyProperty()];
    }
    wb.house_property.properties.forEach((p, i) => {
      container.appendChild(buildPropertyCard(p, i));
    });
  }

  function makeEmptyProperty() {
    return {
      type: "self-occupied", address: "", rent_received: 0,
      municipal_taxes_paid: 0, home_loan_interest_paid: 0,
      home_loan_principal_paid: 0, co_ownership_share: HP_FULL_OWNERSHIP_PCT, tds_on_rent: 0,
    };
  }

  function buildPropertyCard(prop, index) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">Property ${index + 1}</span>
        <button class="remove-btn" data-action="remove-property">Remove</button>
      </div>
      <div class="grid grid-2">
        <label>Type
          <select data-prop-field="type">
            <option value="self-occupied" ${prop.type === "self-occupied" ? "selected" : ""}>Self-occupied</option>
            <option value="let-out" ${prop.type === "let-out" ? "selected" : ""}>Let-out</option>
            <option value="deemed-let-out" ${prop.type === "deemed-let-out" ? "selected" : ""}>Deemed let-out</option>
          </select>
        </label>
        <label>Address<input type="text" data-prop-field="address" value="${escapeHtml(prop.address || "")}"></label>
        <label>Annual rent received (gross of TDS)<input type="number" data-prop-field="rent_received" value="${prop.rent_received || 0}" min="0" step="any"></label>
        <label>Municipal taxes paid<input type="number" data-prop-field="municipal_taxes_paid" value="${prop.municipal_taxes_paid || 0}" min="0" step="any"></label>
        <label>Home loan interest paid (Sec 24(b))<input type="number" data-prop-field="home_loan_interest_paid" value="${prop.home_loan_interest_paid || 0}" min="0" step="any"></label>
        <label>Co-ownership share %<input type="number" data-prop-field="co_ownership_share" value="${prop.co_ownership_share == null ? HP_FULL_OWNERSHIP_PCT : prop.co_ownership_share}" min="0" max="${HP_FULL_OWNERSHIP_PCT}" step="any"></label>
      </div>
    `;
    card.querySelector('[data-action="remove-property"]').addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.house_property.properties.splice(index, 1);
      window.taxDataModel.saveWorkbook(wb);
      renderProperties(wb);
      recompute();
    });
    card.querySelectorAll("[data-prop-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const wb = collectWorkbook();
        const field = input.dataset.propField;
        wb.house_property.properties[index][field] =
          input.type === "number" ? (+input.value || 0) : input.value;
        saveWorkbookDebounced();
        recompute();
      });
    });
    return card;
  }

  function renderOtherSources(wb) {
    setVal("os_savings", wb.other_sources.savings_account_interest);
    setVal("os_fd", wb.other_sources.fd_interest);
    setVal("os_rd", wb.other_sources.rd_interest);
    setVal("os_dividend", wb.other_sources.dividend_gross);
    setVal("os_family_pension", wb.other_sources.family_pension);
    setVal("os_lottery", wb.other_sources.lottery_winnings);
  }

  function renderCapitalGains(wb) {
    const cg = wb.capital_gains;
    setVal("cg_stcg_111a", cg.stcg_111a);
    setVal("cg_ltcg_112a", cg.ltcg_112a);
    setVal("cg_stcg_other", cg.stcg_other);
    setVal("cg_ltcg_other", cg.ltcg_other);
    setVal("cg_stcl_brought_forward", cg.stcl_brought_forward);
    setVal("cg_ltcl_brought_forward", cg.ltcl_brought_forward);
    renderBuckets("stclBuckets", cg.stcl_buckets, "stcl");
    renderBuckets("ltclBuckets", cg.ltcl_buckets, "ltcl");
  }

  function renderBuckets(containerId, buckets, kind) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";
    (buckets || []).forEach((b, i) => {
      container.appendChild(buildBucketRow(b, i, kind, containerId, buckets));
    });
  }

  function buildBucketRow(bucket, index, kind, containerId, bucketsArr) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.innerHTML = `
      <label>FY (e.g. 2020-21)<input type="text" data-bkt-field="fy" value="${escapeHtml(bucket.fy || "")}" maxlength="7"></label>
      <label>Amount (₹)<input type="number" data-bkt-field="amount" value="${bucket.amount || 0}" min="0" step="any"></label>
      <span class="hint" style="align-self: end; padding-bottom: 8px;">${kind === "stcl" ? "STCL" : "LTCL"} bucket ${index + 1}</span>
      <button class="remove-btn" data-action="remove-bucket" style="align-self: end;">×</button>
    `;
    row.querySelector('[data-action="remove-bucket"]').addEventListener("click", () => {
      bucketsArr.splice(index, 1);
      renderBuckets(containerId, bucketsArr, kind);
      saveWorkbookDebounced();
      recompute();
    });
    row.querySelectorAll("[data-bkt-field]").forEach((input) => {
      input.addEventListener("input", () => {
        bucketsArr[index][input.dataset.bktField] =
          input.type === "number" ? (+input.value || 0) : input.value;
        saveWorkbookDebounced();
        recompute();
      });
    });
    return row;
  }

  function renderDeductions(wb) {
    const d = wb.deductions;
    setVal("ded_80c", d["80c_total"]);
    setVal("ded_80ccd_1b", d["80ccd_1b"]);
    setVal("ded_80ccd_2", d["80ccd_2"]);
    setVal("ded_80d_self", d["80d_self_family"]);
    setVal("ded_80d_parents", d["80d_parents"]);
    setVal("ded_80e", d["80e"]);
    setVal("ded_80g_50pct", d["80g_50pct"]);
    setVal("ded_80g_100pct", d["80g_100pct"]);
    setVal("ded_80tta", d["80tta"]);
    setVal("ded_80ttb", d["80ttb"]);
  }

  function renderTaxesPaid(wb) {
    const tp = wb.taxes_paid;
    setVal("taxes_tds_other", tp.tds_other_than_salary);
    setVal("taxes_advance", tp.advance_tax);
    setVal("taxes_self_assessment", tp.self_assessment_tax);
    setVal("taxes_tcs", tp.tcs);
  }

  // ============================================================
  // Collect current form into a workbook
  // ============================================================

  function collectWorkbook() {
    const wb = window.taxDataModel.loadWorkbook(currentAy)
            || window.taxDataModel.emptyWorkbook(currentAy);
    wb.salary.tds_total = val("salary_tds_total") || 0;
    wb.other_sources.savings_account_interest = val("os_savings") || 0;
    wb.other_sources.fd_interest = val("os_fd") || 0;
    wb.other_sources.rd_interest = val("os_rd") || 0;
    wb.other_sources.dividend_gross = val("os_dividend") || 0;
    wb.other_sources.family_pension = val("os_family_pension") || 0;
    wb.other_sources.lottery_winnings = val("os_lottery") || 0;
    wb.capital_gains.stcg_111a = val("cg_stcg_111a") || 0;
    wb.capital_gains.ltcg_112a = val("cg_ltcg_112a") || 0;
    wb.capital_gains.stcg_other = val("cg_stcg_other") || 0;
    wb.capital_gains.ltcg_other = val("cg_ltcg_other") || 0;
    wb.capital_gains.stcl_brought_forward = val("cg_stcl_brought_forward") || 0;
    wb.capital_gains.ltcl_brought_forward = val("cg_ltcl_brought_forward") || 0;
    wb.deductions["80c_total"] = val("ded_80c") || 0;
    wb.deductions["80ccd_1b"] = val("ded_80ccd_1b") || 0;
    wb.deductions["80ccd_2"] = val("ded_80ccd_2") || 0;
    wb.deductions["80d_self_family"] = val("ded_80d_self") || 0;
    wb.deductions["80d_parents"] = val("ded_80d_parents") || 0;
    wb.deductions["80e"] = val("ded_80e") || 0;
    wb.deductions["80g_50pct"] = val("ded_80g_50pct") || 0;
    wb.deductions["80g_100pct"] = val("ded_80g_100pct") || 0;
    wb.deductions["80tta"] = val("ded_80tta") || 0;
    wb.deductions["80ttb"] = val("ded_80ttb") || 0;
    wb.taxes_paid.tds_other_than_salary = val("taxes_tds_other") || 0;
    wb.taxes_paid.advance_tax = val("taxes_advance") || 0;
    wb.taxes_paid.self_assessment_tax = val("taxes_self_assessment") || 0;
    wb.taxes_paid.tcs = val("taxes_tcs") || 0;
    return wb;
  }

  // ============================================================
  // Save (debounced)
  // ============================================================

  const saveWorkbookDebounced = debounce(() => {
    const wb = collectWorkbook();
    try {
      window.taxDataModel.saveWorkbook(wb);
      showSaveStatus("Saved", "saved");
      setTimeout(() => showSaveStatus(""), SAVE_STATUS_DISPLAY_MS);
    } catch (e) {
      showSaveStatus("Save error", "error");
    }
  }, SAVE_DEBOUNCE_MS);

  // ============================================================
  // Recompute & render the compute panel
  // ============================================================

  function recompute() {
    if (!currentAy) return;
    const wb = collectWorkbook();
    const taxResult = window.taxEngine.computeBothRegimes(wb, profile);

    document.getElementById("oldTax").textContent = fmtRs(taxResult.old.total_tax_rounded);
    document.getElementById("oldSub").textContent =
      taxResult.old.result === "refund"
        ? "Refund " + fmtRs(taxResult.old.refund_due_rounded)
        : "Pay " + fmtRs(taxResult.old.tax_payable_rounded);

    document.getElementById("newTax").textContent = fmtRs(taxResult.new.total_tax_rounded);
    document.getElementById("newSub").textContent =
      taxResult.new.result === "refund"
        ? "Refund " + fmtRs(taxResult.new.refund_due_rounded)
        : "Pay " + fmtRs(taxResult.new.tax_payable_rounded);

    const rec = taxResult.recommendation;
    const recLabelEl = document.getElementById("recLabel");
    recLabelEl.className = "rec" + (rec === "tie" ? " tie" : "");
    if (rec === "old") {
      recLabelEl.textContent = "Pick OLD";
      document.getElementById("recTax").textContent = fmtRs(taxResult.old.total_tax_rounded);
      document.getElementById("recSub").textContent = "Save " + fmtRs(taxResult.savings) + " vs new";
    } else if (rec === "new") {
      recLabelEl.textContent = "Pick NEW";
      document.getElementById("recTax").textContent = fmtRs(taxResult.new.total_tax_rounded);
      document.getElementById("recSub").textContent = "Save " + fmtRs(taxResult.savings) + " vs old";
    } else {
      recLabelEl.textContent = "TIE";
      document.getElementById("recTax").textContent = fmtRs(taxResult.old.total_tax_rounded);
      document.getElementById("recSub").textContent = "Both regimes equal";
    }

    const chosen = rec === "new" ? taxResult.new
                : rec === "old" ? taxResult.old
                : (profile && profile.new_regime ? taxResult.new : taxResult.old);
    const cg = chosen.schedule_cg;
    const details = document.getElementById("computeDetails");
    details.innerHTML = `<pre>${escapeHtml(JSON.stringify({
      gti: chosen.gti,
      gti_ordinary: chosen.gti_ordinary,
      total_deductions: chosen.deductions.total_deductions,
      taxable_income: chosen.taxable_income,
      pre_rebate_tax: chosen.pre_rebate_tax,
      rebate_87a: chosen.rebate_87a,
      tax_after_rebate: chosen.tax_after_rebate,
      schedule_cg: {
        stcg_111a_tax: cg.stcg_111a_tax,
        ltcg_112a_tax: cg.ltcg_112a_tax,
        ltcg_other_tax: cg.ltcg_other_tax,
        total: cg.total_schedule_cg_tax,
      },
      surcharge: chosen.surcharge,
      surcharge_rate: chosen.surcharge_rate,
      cess: chosen.cess,
      lottery_tax: chosen.lottery_tax,
      total_tax_liability: chosen.total_tax_liability,
      tds_total: chosen.tds_total,
      interest_234: chosen.interest_234,
      net_payable: chosen.net_payable,
    }, null, 2))}</pre>`;
  }

  // ============================================================
  // Field listeners for non-card fields
  // ============================================================

  function bindYearFormFields() {
    const ids = [
      "os_savings", "os_fd", "os_rd", "os_dividend", "os_family_pension", "os_lottery",
      "cg_stcg_111a", "cg_ltcg_112a", "cg_stcg_other", "cg_ltcg_other",
      "cg_stcl_brought_forward", "cg_ltcl_brought_forward",
      "ded_80c", "ded_80ccd_1b", "ded_80ccd_2",
      "ded_80d_self", "ded_80d_parents",
      "ded_80e", "ded_80g_50pct", "ded_80g_100pct",
      "ded_80tta", "ded_80ttb",
      "taxes_tds_other", "taxes_advance", "taxes_self_assessment", "taxes_tcs",
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", () => { saveWorkbookDebounced(); recompute(); });
    });
  }

  function bindAddButtons() {
    const addEmp = document.getElementById("addEmployer");
    if (addEmp) addEmp.addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.salary.employers.push(makeEmptyEmployer());
      window.taxDataModel.saveWorkbook(wb);
      renderEmployers(wb);
      recompute();
    });
    const addProp = document.getElementById("addProperty");
    if (addProp) addProp.addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.house_property.properties.push(makeEmptyProperty());
      window.taxDataModel.saveWorkbook(wb);
      renderProperties(wb);
      recompute();
    });
    const addStcl = document.getElementById("addStclBucket");
    if (addStcl) addStcl.addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.capital_gains.stcl_buckets.push({ fy: "", amount: 0 });
      window.taxDataModel.saveWorkbook(wb);
      renderBuckets("stclBuckets", wb.capital_gains.stcl_buckets, "stcl");
    });
    const addLtcl = document.getElementById("addLtclBucket");
    if (addLtcl) addLtcl.addEventListener("click", () => {
      const wb = collectWorkbook();
      wb.capital_gains.ltcl_buckets.push({ fy: "", amount: 0 });
      window.taxDataModel.saveWorkbook(wb);
      renderBuckets("ltclBuckets", wb.capital_gains.ltcl_buckets, "ltcl");
    });
  }

  // ============================================================
  // Form 16 / 26AS / broker imports (with AY auto-routing)
  // ============================================================

  function bindImports() {
    document.getElementById("form16File").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const out = document.getElementById("form16Output");
      out.textContent = "Reading…";
      try {
        const text = await window.PDFJS_STUB.getDocumentText(file);
        const result = window.taxIntegrations.parseForm16Text(text);
        if (!result.ok) {
          out.innerHTML = `<span class="err">${escapeHtml(result.errors.join(" / "))}</span>`;
          return;
        }
        // Use the AY detected from the file, not the currently-viewed AY
        const targetAy = result.ay || currentAy;
        const offerToSwitch = targetAy && targetAy !== currentAy;
        let html = renderForm16Summary(result);
        if (offerToSwitch) {
          html += `<br><br><span class="warn">This Form 16 is for AY ${result.ay} (FY ${result.fy}), but you're currently viewing AY ${currentAy}.</span>`;
          html += ` <button id="switchToForm16Ay" class="btn-tiny">Switch to AY ${result.ay} and apply</button>`;
          html += ` <button id="applyForm16Here" class="btn-tiny">Apply to current AY anyway</button>`;
        }
        out.innerHTML = html;
        // Apply to the detected AY (so the data is saved immediately)
        applyForm16ToAy(targetAy, result.fields);
        // Wire up the buttons
        if (offerToSwitch) {
          document.getElementById("switchToForm16Ay").addEventListener("click", () => {
            switchToYear(targetAy);
            out.innerHTML = renderForm16Summary(result) + "<br><span class='warn'>Switched to AY " + targetAy + "</span>";
          });
          document.getElementById("applyForm16Here").addEventListener("click", () => {
            applyForm16ToAy(currentAy, result.fields);
            out.innerHTML = renderForm16Summary(result) + "<br><span class='warn'>Applied to current AY " + currentAy + " (note: this overwrites your current AY's data)</span>";
          });
        }
        // If we applied to a different AY and we're on the year form, refresh
        if (targetAy === currentAy) {
          const wb = window.taxDataModel.loadWorkbook(currentAy);
          renderYearForm(wb);
          recompute();
        } else {
          // Re-render year cards so the summary updates
          renderYearCards();
        }
      } catch (err) {
        out.innerHTML = `<span class="err">Error: ${escapeHtml(err.message)}</span>`;
      }
    });

    document.getElementById("form26asFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const out = document.getElementById("form26asOutput");
      out.textContent = "Reading…";
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const result = window.taxIntegrations.parseForm26ASJson(parsed);
        if (!result.ok) {
          out.innerHTML = `<span class="err">${escapeHtml(result.errors.join(" / "))}</span>`;
          return;
        }
        const targetAy = result.ay || currentAy;
        const offerToSwitch = targetAy && targetAy !== currentAy;
        let html = renderForm26ASSummary(result);
        if (offerToSwitch) {
          html += `<br><br><span class="warn">This 26AS is for AY ${result.ay} (FY ${result.fy}), but you're currently viewing AY ${currentAy}.</span>`;
          html += ` <button id="switchTo26asAy" class="btn-tiny">Switch to AY ${result.ay}</button>`;
        }
        out.innerHTML = html;
        applyForm26ASToAy(targetAy, result);
        if (offerToSwitch) {
          document.getElementById("switchTo26asAy").addEventListener("click", () => {
            switchToYear(targetAy);
          });
        }
        if (targetAy === currentAy) {
          const wb = window.taxDataModel.loadWorkbook(currentAy);
          renderYearForm(wb);
          recompute();
        } else {
          renderYearCards();
        }
      } catch (err) {
        out.innerHTML = `<span class="err">Error: ${escapeHtml(err.message)}</span>`;
      }
    });

    document.getElementById("brokerPnlFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const out = document.getElementById("brokerPnlOutput");
      out.textContent = "Reading…";
      try {
        const fileName = file.name || "";
        const lower = fileName.toLowerCase();
        let result;
        if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
          const workbook = await window.SheetJSLoader.readWorkbook(file);
          result = window.taxBrokers.parseBrokerFile(workbook, fileName);
        } else if (lower.endsWith(".csv")) {
          const text = await file.text();
          result = window.taxBrokers.parseBrokerFile(text, fileName);
        } else {
          out.innerHTML = `<span class="err">Unsupported file type. Use .xlsx (Angel One) or .csv (Zerodha).</span>`;
          return;
        }
        const targetAy = result.fy ? (window.taxDataModel.findFy(result.fy) || {}).ay : currentAy;
        const offerToSwitch = targetAy && targetAy !== currentAy;
        applyBrokerDeltasToAy(targetAy, result);
        let html = renderBrokerSummary(result);
        if (offerToSwitch) {
          html += `<br><br><span class="warn">This P&L is for FY ${result.fy} → AY ${targetAy}, but you're currently viewing AY ${currentAy}.</span>`;
          html += ` <button id="switchToBrokerAy" class="btn-tiny">Switch to AY ${targetAy}</button>`;
        }
        out.innerHTML = html;
        if (offerToSwitch) {
          document.getElementById("switchToBrokerAy").addEventListener("click", () => {
            switchToYear(targetAy);
          });
        }
        if (targetAy === currentAy) {
          const wb = window.taxDataModel.loadWorkbook(currentAy);
          renderYearForm(wb);
          recompute();
        } else {
          renderYearCards();
        }
      } catch (err) {
        out.innerHTML = `<span class="err">Error: ${escapeHtml(err.message)}</span>`;
      }
    });
  }

  function applyForm16ToAy(ay, fields) {
    if (!ay) return;
    const wb = window.taxDataModel.loadWorkbook(ay) || window.taxDataModel.emptyWorkbook(ay);
    window.taxIntegrations.applyForm16ToWorkbook(wb, fields);
    window.taxDataModel.saveWorkbook(wb);
  }

  function applyForm26ASToAy(ay, result) {
    if (!ay) return;
    const wb = window.taxDataModel.loadWorkbook(ay) || window.taxDataModel.emptyWorkbook(ay);
    window.taxIntegrations.applyForm26ASToWorkbook(wb, result);
    window.taxDataModel.saveWorkbook(wb);
  }

  function applyBrokerDeltasToAy(ay, result) {
    if (!ay) return;
    const wb = window.taxDataModel.loadWorkbook(ay) || window.taxDataModel.emptyWorkbook(ay);
    const d = result.workbookDeltas || {};
    if (d.stcg_111a) wb.capital_gains.stcg_111a = d.stcg_111a;
    if (d.ltcg_112a) wb.capital_gains.ltcg_112a = d.ltcg_112a;
    if (d.stcg_other) wb.capital_gains.stcg_other = d.stcg_other;
    if (d.ltcg_other) wb.capital_gains.ltcg_other = d.ltcg_other;
    if (d.dividend_gross) {
      wb.other_sources.dividend_gross = (wb.other_sources.dividend_gross || 0) + d.dividend_gross;
    }
    wb.capital_gains.source = result.broker;
    wb.capital_gains.imported_at = new Date().toISOString();
    wb.capital_gains.imported_from = result.broker;
    window.taxDataModel.saveWorkbook(wb);
  }

  function renderForm16Summary(result) {
    const f = result.fields;
    return `<strong>Form 16 fields extracted:</strong><br>
      <pre style="font-size: 11px; max-height: 200px; overflow-y: auto;">${escapeHtml(JSON.stringify(f, null, 2))}</pre>
      ${result.warnings.length > 0 ? `<span class="warn">${result.warnings.map(escapeHtml).join("<br>")}</span>` : ""}`;
  }

  function renderForm26ASSummary(result) {
    return `<strong>Form 26AS TDS by section:</strong><br>
      <pre style="font-size: 11px;">${escapeHtml(JSON.stringify(result.by_section, null, 2))}</pre>
      <br>Total: ₹${result.total.toLocaleString("en-IN")}`;
  }

  function renderBrokerSummary(result) {
    const fy = result.fy || "current";
    const trades = result.trades || [];
    const byKind = { stcg_111a: 0, ltcg_112a: 0, intraday: 0 };
    for (const t of trades) {
      if (t.kind in byKind) byKind[t.kind]++;
    }
    let html = `<strong>${escapeHtml(result.broker)}</strong> — FY ${escapeHtml(fy)}`;
    html += `<br>Detected ${trades.length} closed trade(s).`;
    if (Object.values(byKind).some((v) => v > 0)) {
      html += " Breakdown:";
      if (byKind.stcg_111a) html += ` ${byKind.stcg_111a} STCG 111A`;
      if (byKind.ltcg_112a) html += `, ${byKind.ltcg_112a} LTCG 112A`;
      if (byKind.intraday) html += `, ${byKind.intraday} intraday`;
    }
    if (trades.length > 0) {
      html += "<br><br><strong>Trades:</strong><ul style=\"margin: 4px 0; padding-left: 20px; font-size: 12px; max-height: 200px; overflow-y: auto;\">";
      for (const t of trades) {
        const sign = t.pnl >= 0 ? "+" : "";
        const dates = t.buy_date && t.sell_date ? `${t.buy_date} → ${t.sell_date}` : (t.buy_date || "n/a");
        html += `<li>${escapeHtml(t.scrip)}: qty ${t.quantity}, ${dates}, P&L ${sign}₹${Math.round(t.pnl).toLocaleString("en-IN")} <em>(${escapeHtml(t.kind)})</em></li>`;
      }
      html += "</ul>";
    }
    return html;
  }

  // ============================================================
  // Export buttons
  // ============================================================

  function bindExports() {
    const downloadJson = document.getElementById("downloadJson");
    if (downloadJson) downloadJson.addEventListener("click", () => {
      const wb = collectWorkbook();
      const tr = window.taxEngine.computeBothRegimes(wb, profile);
      const ok = window.taxAdapters.downloadItrJson(wb, tr, profile);
      if (ok) showSaveStatus("Downloaded", "saved");
    });
    const copyJson = document.getElementById("copyJson");
    if (copyJson) copyJson.addEventListener("click", async () => {
      const wb = collectWorkbook();
      const tr = window.taxEngine.computeBothRegimes(wb, profile);
      const obj = window.taxAdapters.toItrJson(wb, tr, profile);
      const ok = await window.taxAdapters.toClipboard(JSON.stringify(obj, null, 2));
      showSaveStatus(ok ? "Copied" : "Copy failed", ok ? "saved" : "error");
    });
    const downloadReport = document.getElementById("downloadReport");
    if (downloadReport) downloadReport.addEventListener("click", () => {
      const wb = collectWorkbook();
      const tr = window.taxEngine.computeBothRegimes(wb, profile);
      const text = window.taxReports.buildReport(wb, tr);
      const filename = `itr-report-${wb.ay}.txt`;
      window.taxAdapters.toFile(text, filename, "text/plain");
      showSaveStatus("Downloaded", "saved");
    });
  }

  // ============================================================
  // Top bar buttons
  // ============================================================

  function bindTopBar() {
    const homeBtn = document.getElementById("homeBtn");
    if (homeBtn) homeBtn.addEventListener("click", () => {
      showView("years");
      renderYearCards();
    });
    const profileBtn = document.getElementById("profileBtn");
    if (profileBtn) profileBtn.addEventListener("click", () => {
      renderProfile();
      showView("profile");
    });
  }

  // ============================================================
  // Init
  // ============================================================

  function init() {
    initTabs();
    bindTopBar();
    initAddYear();
    initCompareButton();
    bindYearFormFields();
    bindAddButtons();
    bindImports();
    bindExports();
    bindProfile();
    loadProfileFromStorage();
    showView("years");
    renderYearCards();
    // Pre-load PDF.js + xlsx in the background
    preloadLibraries();
  }

  async function preloadLibraries() {
    if (window.PDFJS_STUB) {
      const ok = await window.PDFJS_STUB.preload();
      const pdfStatus = document.getElementById("form16PdfStatus");
      if (pdfStatus) {
        pdfStatus.innerHTML = ok
          ? '<span style="color: var(--color-success);">✓ PDF.js loaded — you can upload .pdf files directly.</span>'
          : '<span style="color: var(--color-warning);">⚠ PDF.js not loaded. Save your Form 16 as .txt (or try again with internet) before uploading.</span>';
      }
    }
    if (window.SheetJSLoader) {
      const xlsxOk = await window.SheetJSLoader.preload();
      const xlsxStatus = document.getElementById("brokerPnlStatus");
      if (xlsxStatus) {
        xlsxStatus.innerHTML = xlsxOk
          ? '<span style="color: var(--color-success);">✓ SheetJS loaded — you can upload broker P&L xlsx files.</span>'
          : '<span style="color: var(--color-warning);">⚠ SheetJS not loaded. Broker P&L upload disabled.</span>';
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
