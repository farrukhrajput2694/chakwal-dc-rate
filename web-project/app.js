/* ==========================================================================
   Chakwal DC Rate Calculator -- offline build
   --------------------------------------------------------------------------
   The form, the unit conversion and the DC value arithmetic are all here and
   all exact. The one thing this build cannot do is READ a rate from the
   Punjab e-Stamp portal, so the rate is typed in by the user.

   Why a rate has to be typed rather than fetched: the portal replies with no
   `access-control-*` headers at all, so a browser on any domain throws the
   response away before any script here can see it. That is a browser rule, not
   something this file can work around. The FastAPI project in the parent
   folder does the same arithmetic after fetching the rate server-side, and
   both paths are the same maths, so a figure computed here matches one from
   the live server given the same rate.

   The conversion constants below are copied from govapi.py rather than
   retyped, so the two cannot drift apart.
   ========================================================================== */

"use strict";

const REFERENCE = window.REFERENCE;

const AREA_UNITS = ["Acre", "Kanal", "Marla", "SqFt"];

const AREA_LABELS = {
  Acre: "Acre",
  Kanal: "Kanal",
  Marla: "Marla",
  SqFt: "sq ft",
};

/* --- conversion constants, verbatim from govapi.py ---------------------- */
const ACRE_TO_KANAL = { "8": 8, "9.65": 9.65, "9.8": 9.8 };
const KANAL_TO_MARLA = 20;
const MARLA_TO_SQFT = { "272": 272, "225": 225 };

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 4 });
const money = (n) => (n === null || n === undefined ? "-" : "Rs. " + nf.format(n));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------ the calculations */

/**
 * Convert an area between Acre / Kanal / Marla / SqFt, via Marla.
 *
 * Marla is the pivot because it is the one unit every other one has a fixed
 * ratio to in Punjab land records: 1 Kanal = 20 Marla, and a Marla is either
 * 272 sq ft (revenue/Pucca, the default the portal uses) or 225 sq ft
 * (modern). Acre is not fixed at 8 Kanal in every record, which is why the
 * Acre-to-Kanal figure is a setting rather than a constant.
 */
function convert(value, from, to, opts) {
  const a2k = ACRE_TO_KANAL[opts.acre_to_kanal];
  const m2s = MARLA_TO_SQFT[opts.marla_to_sqft];

  let marla;
  if (from === "Acre") marla = value * a2k * KANAL_TO_MARLA;
  else if (from === "Kanal") marla = value * KANAL_TO_MARLA;
  else if (from === "Marla") marla = value;
  else marla = value / m2s;

  if (to === "Acre") return marla / (a2k * KANAL_TO_MARLA);
  if (to === "Kanal") return marla / KANAL_TO_MARLA;
  if (to === "Marla") return marla;
  if (to === "SqFt") return marla * m2s;
  throw new Error("Unknown area unit: " + to);
}

/**
 * Value the land at the DC rate.
 *
 * The critical detail, and the one that is easy to get wrong: the rate is
 * quoted per `rateUnit`, which is NOT always Marla. Rural agricultural Khasras
 * commonly come back per Acre. So the entered area is converted into the RATE's
 * own unit before multiplying -- 1 Acre at Rs. 100,000/Acre is Rs. 100,000, not
 * Rs. 8,000,000.
 *
 * The per-sq-ft figure divides the whole area's value by the whole area in
 * sq ft. Dividing by one unit of area instead would inflate it by the area
 * figure, which is the classic way to get this wrong by a factor of 8.
 */
function landValue({ area, areaUnit, rate, rateUnit, opts }) {
  const areaInRateUnit = convert(area, areaUnit, rateUnit, opts);
  const total = areaInRateUnit * rate;
  const totalSqft = convert(area, areaUnit, "SqFt", opts);
  return {
    total: total,
    areaInRateUnit: areaInRateUnit,
    totalSqft: totalSqft,
    impliedPerSqft: totalSqft ? total / totalSqft : null,
  };
}

/* ------------------------------------------------------------- dom refs */

const el = {
  form: $("lookup-form"),
  landTypeBtns: [...document.querySelectorAll("[data-land-type]")],
  urbanCoverageNote: $("urban-coverage-note"),
  urbanScope: $("urban-scope"),
  ruralScope: $("rural-scope"),
  town: $("town"),
  revenueCircle: $("revenue-circle"),
  floor: $("floor"),
  propertyArea: $("property-area"),
  propertyAreaNote: $("property-area-note"),
  blockClassification: $("block-classification"),
  parcelKhasra: $("parcel-khasra"),
  parcelNone: $("parcel-none"),
  qanoongo: $("qanoongo"),
  mouzaSearch: $("mouza-search"),
  mouza: $("mouza"),
  mouzaSearchNote: $("mouza-search-note"),
  landClassification: $("land-classification"),
  location: $("location"),
  khasra: $("khasra"),
  khasraNote: $("khasra-note"),
  khasraOptions: $("khasra-options"),
  multi: $("khasra-multi"),
  multiToggle: $("multi-toggle"),
  multiSummary: $("multi-summary"),
  multiPanel: $("multi-panel"),
  multiFilter: $("multi-filter"),
  multiAll: $("multi-all"),
  multiNone: $("multi-none"),
  multiCount: $("multi-count"),
  multiGrid: $("multi-grid"),
  multiTrunc: $("multi-trunc"),
  multiRun: $("multi-run"),
  multiClose: $("multi-close"),
  multiNote: $("multi-note"),
  rateValue: $("rate-value"),
  rateUnit: $("rate-unit"),
  areaValue: $("area-value"),
  areaUnit: $("area-unit"),
  acreToKanal: $("acre-to-kanal"),
  marlaToSqft: $("marla-to-sqft"),
  convOut: $("conv-out"),
  findBtn: $("find-btn"),
  resetBtn: $("reset-btn"),
  status: $("status"),
  resultCard: $("result-card"),
  resultBody: $("result-body"),
  refreshNote: $("refresh-note"),
  sourceNote: $("source-note"),
};

const state = {
  landType: "rural",
  selectedMouza: null,
  selectedClassification: null,
  // Urban side of the chain. URBAN itself is the bundled data; these are the
  // picks made inside it.
  selectedTown: null,
  selectedCircle: null,
  selectedFloor: null,
  selectedPropertyArea: null,
  // Khasra numbers for the chosen mouza, keyed by classification id then by
  // location. Loaded on demand, one file per mouza.
  khasraData: {},
  // anchor = the Khasra a shift-click range extends from, stored by value so
  // that changing the filter cannot make it point at the wrong chip.
  multi: { list: [], selected: new Set(), anchor: null, filter: "", open: false,
           chips: new Map(), batch: null, sort: null },
};

/* ------------------------------------------------------------- utilities */

function conversionOpts() {
  return {
    acre_to_kanal: el.acreToKanal.value,
    marla_to_sqft: el.marlaToSqft.value,
  };
}

function text(sel) {
  return sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "";
}

function setStatus(message, isError) {
  el.status.className = isError ? "status err" : "status";
  el.status.textContent = message || "";
}

/**
 * Report a problem and put the cursor on the field that caused it.
 *
 * A message at the bottom of a long form that names a field the user has to
 * go and find is barely better than no message: they read "Enter the DC
 * rate", carry on looking for something called a rate, and often never notice
 * the input sitting above the button they just pressed. So every guard routes
 * through here, and this takes the field itself, marks it, focuses it and
 * scrolls it into view.
 */
function fail(message, field) {
  clearBadFields();
  setStatus(message, true);
  if (!field) return;
  const wrap = field.closest(".field") || field.parentElement;
  if (wrap) wrap.classList.add("is-bad");
  field.focus({ preventScroll: true });
  field.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearBadFields() {
  for (const w of document.querySelectorAll(".field.is-bad")) w.classList.remove("is-bad");
}

/**
 * Read a numeric field that has to be a positive number.
 *
 * The result has three possible states, and the caller has to keep them apart:
 *
 *   { state: "ok",  value }  a usable number
 *   { state: "off" }         left blank, and blank was allowed -- carry on
 *                            without a value rather than stopping
 *   { state: "bad" }         something was typed but it cannot be used. The
 *                            message is already on screen and the offending
 *                            field is focused, so the caller must stop.
 *
 * "off" and "bad" are deliberately not the same. A blank rate means the user
 * has not got a figure yet and still wants the area arithmetic, which is worth
 * showing. A rate of -5 is a mistake that would produce a wrong valuation, so
 * it is stopped. Collapsing both into one null is what made a bad rate look
 * like an absent one.
 *
 * Blank and unusable are also told apart in the wording, because they are
 * different mistakes: telling someone who typed -5 that they failed to
 * "enter" the rate sends them hunting for a field they already filled in.
 *
 * `label` is a noun phrase, e.g. "the DC rate for this Khasra", so the
 * messages read as sentences: "Enter the DC rate for this Khasra." and
 * "The DC rate for this Khasra must be greater than zero."
 */
function readPositive(field, label, optional) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const raw = field.value.trim();
  if (raw === "") {
    if (optional) return { state: "off" };
    fail(`Enter ${label}.`, field);
    return { state: "bad" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) { fail(`${cap(label)} must be a number.`, field); return { state: "bad" }; }
  if (n <= 0) { fail(`${cap(label)} must be greater than zero.`, field); return { state: "bad" }; }
  return { state: "ok", value: n };
}

/**
 * The same area figures `updateConversionPreview` puts under the form, in the
 * result card, so that a run with no rate still answers a real question: how
 * big is this parcel, in every unit a land record might use?
 *
 * Without a rate there is no valuation, so this is the entire result. It is
 * better than an error message, and better than refusing to run, because the
 * area conversions are useful on their own when you are checking a record.
 */
function areaMetricRows(area, areaUnit, opts) {
  return `<div class="metric"><dt>Your area</dt>
      <dd>${nf.format(area)} <small>${esc(AREA_LABELS[areaUnit] || areaUnit)}</small></dd></div>
    ${AREA_UNITS.filter((u) => u !== areaUnit).map((to) => `
      <div class="metric"><dt>In ${esc((AREA_LABELS[to] || to).toLowerCase())}</dt>
        <dd>${nf.format(convert(area, areaUnit, to, opts))}</dd></div>`).join("")}`;
}

/**
 * Fill a <select> with a placeholder plus options.
 *
 * `disabled` on an item makes the browser grey it out and refuse to select it,
 * which is how the Qanoongoee list marks the ones the current search excludes:
 * visible but not pickable, so the user can see that the Qanoongoee exists
 * rather than wondering where it went.
 */
function fill(sel, items, { placeholder = "Select…", valueKey = "id" } = {}) {
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  sel.appendChild(ph);
  for (const item of items) {
    const o = document.createElement("option");
    o.value = item[valueKey];
    o.textContent = item.name;
    if (item.disabled) o.disabled = true;
    sel.appendChild(o);
  }
  sel.disabled = false;
}

/* ------------------------------------------------------ reference loading */

/**
 * The Qanoongoee list, filtered by whatever the user has typed into the Mouza
 * search box.
 *
 * Kept in step with the visible Mouza list on purpose. The two describe the
 * same set of places, and if the Qanoongoee list stayed unfiltered while the
 * Mouza list narrowed, the user could pick a Qanoongoee that no longer appears
 * below it and be left wondering why their selection vanished.
 */
function visibleMouzas() {
  const q = el.mouzaSearch.value.trim().toLowerCase();
  const all = REFERENCE.mouzas;
  if (!q) return all;
  const hits = all.filter((m) => m.name.toLowerCase().includes(q));
  if (hits.length) return hits;
  // Fall back to matching the owning Qanoongoee, so searching "balkassar"
  // still finds its mouzas rather than an empty list.
  return all.filter((m) => (m.qanoongoName || "").toLowerCase().includes(q));
}

function renderQanoongoes() {
  const seen = new Map();
  for (const m of visibleMouzas()) {
    if (m.qanoongoId && !seen.has(m.qanoongoId)) {
      seen.set(m.qanoongoId, { id: m.qanoongoId, name: m.qanoongoName });
    }
  }
  // Any Qanoongoee with no mouza under the current filter would otherwise be
  // unselectable, so keep them all and only mark which ones match.
  const all = REFERENCE.qanoongoes.map((q) => {
    const inFilter = seen.has(q.id);
    return { id: q.id, name: inFilter ? q.name : q.name + " (no match)", disabled: !inFilter };
  });
  fill(el.qanoongo, all);
}

function renderMouzas() {
  const list = visibleMouzas();
  fill(el.mouza, list.map((m) => ({ id: String(m.mouzaId), name: m.name })));

  const q = el.mouzaSearch.value.trim();
  el.mouzaSearchNote.hidden = !q;
  if (q) {
    el.mouzaSearchNote.textContent =
      list.length + (list.length === 1 ? " mouza matches" : " mouzas match") +
      " “" + q + "”. Greyed-out Qanoongoees have none.";
  }
  renderQanoongoes();
}

/* ------------------------------------------------------- the cascade */

function onQanoongoChange() {
  const id = el.qanoongo.value;
  if (!id) {
    state.selectedMouza = null;
    resetClassifications();
    return;
  }

  // Choosing a Qanoongoee first narrows the Mouza list to its mouzas. This is
  // the reverse of picking a Mouza, which fills the Qanoongoee in.
  //
  // Deliberately NOT filtered by the search box. The Qanoongoee list already
  // shows non-matching entries greyed out, so picking one is a clear request
  // for that Qanoongoee's mouzas. Intersecting with the search here would drop
  // Dhudial's 19 mouzas down to the 1 that happened to match "padshahan", and
  // the user would see an almost-empty list with nothing explaining why. The
  // search text is cleared instead, so the two never disagree about what the
  // Mouza list contains.
  el.mouzaSearch.value = "";
  el.mouzaSearchNote.hidden = true;
  renderQanoongoes();

  const list = REFERENCE.mouzas.filter((m) => String(m.qanoongoId) === id);
  fill(el.mouza, list.map((m) => ({ id: String(m.mouzaId), name: m.name })));
  resetClassifications();
}

function onMouzaChange() {
  const id = el.mouza.value;
  state.selectedMouza = REFERENCE.mouzas.find((m) => String(m.mouzaId) === id) || null;

  if (state.selectedMouza) {
    // The two must never disagree. Picking a Mouza sets its Qanoongoee, and
    // this is the one place that happens.
    el.qanoongo.value = String(state.selectedMouza.qanoongoId);
  }
  renderClassifications();
}

function resetClassifications() {
  state.selectedMouza = null;
  state.selectedClassification = null;
  state.khasraData = {};
  resetMulti([]);
  fill(el.landClassification, [], { placeholder: "Select a Mouza first" });
  fill(el.location, [], { placeholder: "Select a classification first" });
}

function renderClassifications() {
  state.selectedClassification = null;
  state.khasraData = {};
  resetMulti([]);
  fill(el.location, [], { placeholder: "Select a classification first" });

  if (!state.selectedMouza) {
    fill(el.landClassification, [], { placeholder: "Select a Mouza first" });
    return;
  }
  const cls = state.selectedMouza.classifications;
  if (!cls.length) {
    fill(el.landClassification, [], { placeholder: "None published for this Mouza" });
    return;
  }
  fill(el.landClassification, cls.map((c) => ({ id: String(c.id), name: c.name })));
}

function onClassificationChange() {
  state.selectedClassification = null;
  state.khasraData = {};
  resetMulti([]);
  if (!state.selectedMouza) {
    fill(el.location, [], { placeholder: "Select a classification first" });
    return;
  }
  const id = el.landClassification.value;
  const cls = state.selectedMouza.classifications.find((c) => String(c.id) === id);
  state.selectedClassification = cls || null;
  if (!cls || !cls.locations.length) {
    fill(el.location, [], { placeholder: "None published here" });
    return;
  }
  fill(el.location, cls.locations.map((name) => ({ id: name, name })));
}

/**
 * Load this mouza's Khasra numbers and populate the picker for the chosen
 * location.
 *
 * The list is a plain list of numbers, not of rates, so bundling it costs
 * nothing in staleness: a Khasra that exists today exists tomorrow. If a
 * Khasra is missing from the list, the single-number box above is still typed
 * and still works.
 */
async function onLocationChange() {
  resetMulti([]);
  if (!state.selectedMouza) return;

  el.khasraNote.textContent = "Loading Khasra numbers…";
  state.khasraData = await loadKhasras(state.selectedMouza.mouzaId);

  const list = currentKhasraList();
  if (!list.length) {
    el.khasraNote.textContent =
      "The portal publishes no Khasra list for this location. Type the number above.";
    return;
  }
  const n = list.length;
  el.khasraNote.textContent =
    `${n.toLocaleString()} Khasra${n === 1 ? "" : "s"} published here. ` +
    "Pick one, or open the list below to value many at once.";
  resetMulti(list);

  // Offer the numbers as browser suggestions on the single-Khasra box. All of
  // them, not a sample: the field is a datalist, so a 8,768-entry list costs
  // nothing until someone actually starts typing.
  el.khasraOptions.innerHTML = list
    .map((k) => `<option value="${esc(k)}"></option>`)
    .join("");
}

/* ------------------------------------------------- conversion preview */

function updateConversionPreview() {
  const area = Number(el.areaValue.value);
  if (!area || area <= 0) { el.convOut.textContent = ""; return; }
  const opts = conversionOpts();
  const from = el.areaUnit.value;
  el.convOut.textContent = AREA_UNITS
    .filter((u) => u !== from)
    .map((to) => {
      const out = nf.format(convert(area, from, to, opts));
      return `${nf.format(area)} ${AREA_LABELS[from] || from} = ${out} ${AREA_LABELS[to] || to}`;
    })
    .join("   ·   ");
}

/* ------------------------------------------------- Khasra number loading */

const KHASRA_DIR = "data/khasras/";
const _khCache = new Map();

/**
 * Load the Khasra list for one mouza, on demand.
 *
 * Injected as a <script> rather than fetched, and that is not a stylistic
 * choice: `fetch()` of a local file is blocked under `file://`, which is
 * exactly how this project is meant to be opened. A script tag works from a
 * hard drive and from a web server alike, so the same files serve both.
 *
 * Each file sets window.KH_<mouzaId>, so the payload lands somewhere namespaced
 * instead of loose on window.
 */
function loadKhasras(mouzaId) {
  const id = String(mouzaId);
  if (_khCache.has(id)) return Promise.resolve(_khCache.get(id));

  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = KHASRA_DIR + id + ".js";
    s.onload = () => {
      const data = window["KH_" + id] || {};
      _khCache.set(id, data);
      resolve(data);
    };
    s.onerror = () => {
      // A missing file means this mouza published no Khasra list. Report an
      // empty list rather than leaving the picker stuck saying "loading".
      _khCache.set(id, {});
      resolve({});
    };
    document.head.appendChild(s);
  });
}

/** The Khasras published for the chosen classification + location. */
function currentKhasraList() {
  const m = state.selectedMouza;
  const cls = state.selectedClassification;
  const loc = el.location.value;
  if (!m || !cls || !loc) return [];
  const byClass = state.khasraData[String(cls.id)] || [];
  const entry = byClass.find((e) => e.location === loc);
  return entry ? entry.khasras : [];
}

/* ------------------------------------------------------------- sorting */

/**
 * Sort Khasra numbers the way a person reads them.
 *
 * The portal hands them back in no useful order, which makes a list of a
 * thousand impossible to scan. Almost all are plain integers, but a handful
 * carry a subdivision ("1807/1", "2047/55"), and those belong next to their
 * parent number rather than at the very end. Comparing as text would put "20"
 * after "1998", so this splits on the slash and compares each half numerically.
 */
function khasraSortKey(value) {
  const [head, tail] = String(value).split("/");
  const main = parseInt(head, 10);
  // A bare "1807" gets -1 so it sorts just before its "1807/1".
  const sub = tail === undefined ? -1 : (parseInt(tail, 10) || 0);
  return [Number.isNaN(main) ? Number.MAX_SAFE_INTEGER : main, sub];
}

function sortKhasras(list) {
  return [...list].sort((a, b) => {
    const ka = khasraSortKey(a);
    const kb = khasraSortKey(b);
    // String compare last, purely so equal keys ("037" vs "37") stay stable
    // across renders instead of shuffling.
    return ka[0] - kb[0] || ka[1] - kb[1] || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/* ------------------------------------------------ multi-Khasra picker */

function resetMulti(list) {
  state.multi.list = sortKhasras(list || []);
  state.multi.selected = new Set();
  state.multi.anchor = null;
  state.multi.filter = "";
  state.multi.open = false;
  state.multi.batch = null;
  el.multiFilter.value = "";
  el.multiPanel.hidden = true;
  // Only worth offering when there is a choice to make.
  el.multi.hidden = state.multi.list.length < 2;
  if (el.multi.hidden) { el.multiSummary.hidden = true; return; }
  renderKhasraGrid();
}

function filteredKhasras() {
  const q = state.multi.filter.trim().toLowerCase();
  if (!q) return state.multi.list;
  return state.multi.list.filter((k) => k.toLowerCase().includes(q));
}

function updateMultiSummary() {
  if (el.multi.hidden) return;
  const n = state.multi.selected.size;
  el.multiSummary.hidden = false;
  el.multiSummary.textContent = n
    ? `${n.toLocaleString()} Khasra${n === 1 ? "" : "s"} selected.`
    : `${state.multi.list.length.toLocaleString()} Khasras available here.`;
}

function updateMultiCount(matching) {
  const n = state.multi.selected.size;
  el.multiCount.innerHTML =
    `<strong>${n.toLocaleString()}</strong> selected of ${matching.toLocaleString()}`;
  el.multiRun.disabled = n === 0;
  el.multiRun.textContent = n
    ? `Value ${n.toLocaleString()} Khasra${n === 1 ? "" : "s"}`
    : "Value selected";
  updateMultiSummary();
}

function renderKhasraGrid() {
  const matching = filteredKhasras();

  // Every Khasra is rendered. The largest list in the tehsil is 8,768 and it
  // draws in well under a frame budget, so a cap would only hide data the
  // user is entitled to see.
  el.multiGrid.innerHTML = matching.map((k) => {
    const on = state.multi.selected.has(k);
    return `<button type="button" class="chip${on ? " is-on" : ""}` +
      `${k === state.multi.anchor ? " is-anchor" : ""}"` +
      ` data-khasra="${esc(k)}" aria-pressed="${on}">${esc(k)}</button>`;
  }).join("");

  // Index the rendered chips so a click repaints only what changed. With
  // thousands of chips on screen, rewriting every one per click is the
  // difference between instant and visibly laggy.
  state.multi.chips = new Map();
  for (const chip of el.multiGrid.querySelectorAll(".chip")) {
    state.multi.chips.set(chip.dataset.khasra, chip);
  }

  el.multiTrunc.hidden = true;
  updateMultiCount(matching.length);
}

/**
 * Click a chip to toggle it; shift-click to sweep every Khasra between it and
 * the last plain-clicked one. The anchor stays put across repeated shift-clicks
 * so a sweep can be widened and narrowed from a fixed origin, which is how a
 * file list behaves.
 */
function toggleKhasra(number, event) {
  const chosen = state.multi.selected;
  const visible = filteredKhasras();
  const index = visible.indexOf(number);
  let touched;

  const anchor = state.multi.anchor;
  const sweeping = !!event && event.shiftKey && anchor !== null &&
    anchor !== number && visible.includes(anchor);

  if (sweeping) {
    const from = visible.indexOf(anchor);
    const span = visible.slice(Math.min(from, index), Math.max(from, index) + 1);
    touched = span;

    if (span.every((k) => chosen.has(k))) {
      // Already a full block -- shift-click again to take it all back off.
      for (const k of span) chosen.delete(k);
    } else {
      for (const k of span) chosen.add(k);
    }
    setStatus("", false);
  } else {
    touched = [number];
    if (chosen.has(number)) chosen.delete(number);
    else chosen.add(number);
    // A plain click re-aims the sweep. The old anchor's ring has to come off,
    // so it is repainted even though its selection did not change.
    if (state.multi.anchor && state.multi.anchor !== number) {
      touched.push(state.multi.anchor);
    }
    // Stored by value, and dropped if the filter has since hidden it, so a
    // later shift-click cannot sweep nothing.
    state.multi.anchor = visible.includes(number) ? number : null;
    setStatus("", false);
  }

  for (const k of touched) paintChip(k);
  updateMultiCount(visible.length);
}

/** Repaint one chip from state. */
function paintChip(number) {
  const chip = state.multi.chips.get(number);
  if (!chip) return;
  const on = state.multi.selected.has(number);
  chip.classList.toggle("is-on", on);
  chip.classList.toggle("is-anchor", number === state.multi.anchor);
  chip.setAttribute("aria-pressed", String(on));
}

/**
 * Select every Khasra the filter matches. The grid already renders the whole
 * list, so this is simply "take them all" -- useful on the big mouzas, where
 * clicking or shift-clicking eight thousand chips is not.
 */
function selectAllShown() {
  const matching = filteredKhasras();
  const already = matching.filter((k) => state.multi.selected.has(k)).length;
  for (const k of matching) state.multi.selected.add(k);
  setStatus("", false);
  renderKhasraGrid();
  if (already) setStatus(`${already.toLocaleString()} of those were already selected.`, false);
}

function clearMultiSelection() {
  state.multi.selected.clear();
  state.multi.anchor = null;
  setStatus("", false);
  renderKhasraGrid();
}

function toggleMultiPanel(force) {
  state.multi.open = force !== undefined ? force : !state.multi.open;
  el.multiPanel.hidden = !state.multi.open;
  if (state.multi.open) {
    renderKhasraGrid();
    el.multiFilter.focus();
  }
}

/* --------------------------------------------------- rural / urban switch */

/**
 * Switch between the rural and urban chains.
 *
 * Both halves are bundled, so nothing is fetched. The two chains share no
 * fields beyond District and Tehsil, and each one resets the other: leaving a
 * half-built Mouza selection on screen while the Urban tab is active would let
 * someone value an urban parcel against a rural classification.
 */
function setLandType(next) {
  if (next !== "rural" && next !== "urban") return;
  state.landType = next;

  for (const b of el.landTypeBtns) {
    const on = b.dataset.landType === next;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", String(on));
  }

  el.ruralScope.classList.toggle("hidden", next !== "rural");
  el.urbanScope.classList.toggle("hidden", next !== "urban");
  el.blockClassification.classList.toggle("hidden", next !== "rural");
  el.urbanCoverageNote.classList.toggle("hidden", next !== "urban");
  el.resultCard.hidden = true;
  setStatus("", false);

  if (next === "urban") {
    resetRural();
    renderUrbanTowns();
  } else {
    resetUrban();
    renderMouzas();
  }

  // Re-establish the parcel block for the chain just selected. Without this the
  // Khasra box keeps whatever visibility the *other* chain left it with.
  renderParcelBlock();
}

/* --------------------------------------------------------- urban chain */

function currentTown() {
  return (window.URBAN?.towns || []).find((t) => String(t.id) === el.town.value) || null;
}

function renderUrbanTowns() {
  const towns = window.URBAN?.towns || [];
  fill(el.town, towns.map((t) => ({ id: String(t.id), name: t.name })),
       { placeholder: "Select a Town / City" });
  onTownChange();
}

function onTownChange() {
  state.selectedTown = currentTown();
  state.selectedCircle = null;
  state.selectedFloor = null;
  state.selectedPropertyArea = null;

  const town = state.selectedTown;
  const circles = town ? town.circles : [];
  fill(el.revenueCircle, circles.map((c) => ({ id: String(c.id), name: c.name })),
       { placeholder: town ? "Select a Revenue Circle" : "Select a Town first" });
  onRevenueCircleChange();
}

function onRevenueCircleChange() {
  const id = el.revenueCircle.value;
  state.selectedCircle = id ? { id, name: el.revenueCircle.selectedOptions[0]?.textContent } : null;
  state.selectedPropertyArea = null;

  const floors = (window.URBAN?.floors || {})[id] || [];
  fill(el.floor, floors.map((f) => ({ id: String(f.id), name: f.name })),
       { placeholder: state.selectedCircle ? "Select a Floor" : "Select a circle first" });
  onFloorChange();
}

function onFloorChange() {
  const id = el.floor.value;
  state.selectedFloor = id ? { id, name: el.floor.selectedOptions[0]?.textContent } : null;
  state.selectedPropertyArea = null;

  const town = state.selectedTown;
  const circleId = el.revenueCircle.value;
  const pas = town ? (town.propertyAreas || {})[circleId] || [] : [];
  fill(el.propertyArea, pas.map((p) => ({ id: String(p.id), name: p.name })),
       { placeholder: state.selectedFloor ? "Select a Property Area" : "Select a floor first" });
  onPropertyAreaChange();
}

function onPropertyAreaChange() {
  const id = el.propertyArea.value;
  state.selectedPropertyArea = id
    ? { id, name: el.propertyArea.selectedOptions[0]?.textContent }
    : null;
  renderParcelBlock();
}

/**
 * Decide which parcel block the current state calls for.
 *
 * This is the only place that shows or hides the Khasra box, and it has to be
 * called from the chain switch as well as from the property-area pick. When it
 * lived only in the property-area handler, visiting the Urban tab hid the
 * Khasra box and coming back to Rural left it hidden -- the field simply never
 * reappeared, with nothing on screen to explain why.
 *
 * The portal publishes an availability flag per property area saying whether a
 * Khasra or a Square number exists. Measured across all 118 property areas in
 * this tehsil, every one reports neither -- so the Property Area level message
 * is what actually appears there. The Khasra branch is kept because it is what
 * a property area that does publish one would take, and because guessing
 * rather than asking the data is how a tool starts showing fields that cannot
 * work.
 */
function renderParcelBlock() {
  const detail = (window.URBAN?.propertyAreaDetail || {})[el.propertyArea.value];
  const hasKhasra = !!(detail && detail.hasKhasra);
  const hasSquare = !!(detail && detail.hasSquare);
  const urban = state.landType === "urban";
  const pa = state.selectedPropertyArea;

  el.parcelKhasra.classList.toggle("hidden", urban && !hasKhasra);
  el.parcelNone.classList.toggle("hidden", !(urban && pa && !hasKhasra && !hasSquare));

  el.propertyAreaNote.textContent = pa
    ? (hasKhasra || hasSquare
        ? "This property area publishes parcel numbers."
        : "Rated at Property Area level — no parcel number.")
    : "";
}

function resetUrban() {
  state.selectedTown = null;
  state.selectedCircle = null;
  state.selectedFloor = null;
  state.selectedPropertyArea = null;
  el.propertyAreaNote.textContent = "";
  fill(el.town, [], { placeholder: "Select a Town / City" });
  fill(el.revenueCircle, [], { placeholder: "Select a Town first" });
  fill(el.floor, [], { placeholder: "Select a Revenue Circle first" });
  fill(el.propertyArea, [], { placeholder: "Select a Floor first" });
  renderParcelBlock();
}

function resetRural() {
  state.selectedMouza = null;
  state.selectedClassification = null;
  state.khasraData = {};
  resetMulti([]);
  el.khasraOptions.innerHTML = "";
  el.khasraNote.textContent = "Pick one, or open the list below to value many at once.";
  fill(el.qanoongo, [], { placeholder: "Select a Qanoongoee" });
  renderMouzas();
  resetClassifications();
}

/* ------------------------------------------------------------- result */

function handoffUrl() {
  const tpl = (REFERENCE.links && REFERENCE.links.dc_valuation_with_district) || "#";
  return tpl.replace(/\{districtid\}/gi, REFERENCE.districtId);
}

function renderResult() {
  const areaUnit = el.areaUnit.value;
  const rateUnit = el.rateUnit.value;
  const opts = conversionOpts();

  // The two chains need different context, so they are checked separately
  // rather than sharing one list of dropdowns that only applies to one of them.
  let scopeNames;
  let parcelId;
  if (state.landType === "urban") {
    if (!el.town.value) { fail("Choose a Town / City first.", el.town); return; }
    if (!el.revenueCircle.value) { fail("Choose a Revenue Circle.", el.revenueCircle); return; }
    if (!el.propertyArea.value) { fail("Choose a Property Area.", el.propertyArea); return; }
    scopeNames = [text(el.town), state.selectedCircle?.name, state.selectedFloor?.name,
                  text(el.propertyArea)];
    // No parcel number exists for these property areas, so nothing to require.
    parcelId = null;
  } else {
    if (!el.mouza.value) { fail("Choose a Mouza first.", el.mouza); return; }
    if (!el.landClassification.value) { fail("Choose a land classification.", el.landClassification); return; }
    if (!text(el.location)) { fail("Choose a location.", el.location); return; }
    if (!el.khasra.value.trim()) { fail("Enter the Khasra number.", el.khasra); return; }
    scopeNames = [text(el.qanoongo), text(el.mouza),
                  text(el.landClassification), text(el.location)];
    parcelId = el.khasra.value.trim();
  }

  // The rate is optional. Without one there is no valuation, but there is still
  // a real answer to give -- how big the parcel is in every unit -- so the run
  // continues and the result card carries conversions instead of a total. A
  // rate that is present but unusable is a different matter and still stops.
  //
  // Wording follows the chain: an urban property area has no parcel at all, so
  // calling it one would name something the portal does not publish.
  const rateWhat = state.landType === "urban"
    ? "the DC rate for this property area"
    : "the DC rate for this Khasra";
  const areaRes = readPositive(el.areaValue, "a land area", false);
  if (areaRes.state === "bad") return;
  const rateRes = readPositive(el.rateValue, rateWhat, true);
  if (rateRes.state === "bad") return;
  const area = areaRes.value;
  const rate = rateRes.state === "ok" ? rateRes.value : null;

  // Past every guard, so nothing stays ringed in red next to a value that is
  // now fine -- including a mark left by a value pasted in without an input
  // event, which would otherwise never have been cleared.
  clearBadFields();

  const parts = ["District Chakwal", "Tehsil Chakwal", ...scopeNames]
    .filter(Boolean).map((b) => `<b>${esc(b)}</b>`);
  if (parcelId) parts.push(`<b>${esc(parcelId)}</b>`);
  const trail = parts.join(" › ");

  const actions = `
    <div class="actions">
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  if (rate === null) {
    el.resultBody.innerHTML = `
      <p class="path-summary">${trail}</p>

      <div class="rate-hero-wrap">
        <div class="rate-hero">
          <span class="rate-num rate-num-none">No rate</span>
          <span class="rate-unit">so no value below &mdash; area only</span>
        </div>
      </div>

      <dl class="metrics">
        ${areaMetricRows(area, areaUnit, opts)}
      </dl>

      <div class="notice notice-warn"><span class="notice-ico">!</span><div>
        <strong>No DC rate entered, so nothing is valued.</strong>
        These are the area conversions only. Enter the rate in the
        <em>DC rate</em> box and the value appears here &mdash; and check the
        <em>Rate is per</em> unit, because rural agricultural Khasras are often
        quoted per Acre rather than per Marla, and the two differ by a factor
        of 160. The official page is one click away on the button below.
      </div></div>

      ${actions}`;

    el.resultCard.hidden = false;
    $("result-handoff").href = handoffUrl();
    $("print-btn").onclick = () => window.print();
    el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setStatus("", false);
    return;
  }

  const v = landValue({ area, areaUnit, rate, rateUnit, opts });

  const unitNote = rateUnit === "SqFt" ? " <small>(sq ft)</small>" : "";

  el.resultBody.innerHTML = `
    <p class="path-summary">${trail}</p>

    <div class="rate-hero-wrap">
      <div class="rate-hero">
        <span class="rate-num">${money(rate)}</span>
        <span class="rate-unit">per ${esc(AREA_LABELS[rateUnit] || rateUnit)}${unitNote}</span>
      </div>
    </div>

    <dl class="metrics">
      <div class="metric"><dt>Your area</dt>
        <dd>${nf.format(area)} <small>${esc(AREA_LABELS[areaUnit] || areaUnit)}</small></dd></div>
      <div class="metric"><dt>Converted to rate units</dt>
        <dd>${nf.format(v.areaInRateUnit)} <small>${esc(AREA_LABELS[rateUnit] || rateUnit)}</small></dd></div>
      <div class="metric"><dt>That area in sq ft</dt>
        <dd>${nf.format(v.totalSqft)}</dd></div>
      <div class="metric"><dt>DC value</dt><dd>${money(v.total)}</dd></div>
      <div class="metric"><dt>Per sq ft (implied)</dt>
        <dd>${money(v.impliedPerSqft)}</dd></div>
    </dl>

    <div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>Check the rate you entered.</strong> This page did not read the
      rate from the official portal — you typed it. The arithmetic below it is
      exact, but the whole answer rests on that number being right, including
      the unit it is quoted per. Rural agricultural Khasras are often priced
      per Acre rather than per Marla, and the two differ by a factor of 160.
      Open the official DC Valuation page and confirm before relying on this.
    </div></div>

    ${actions}`;

  el.resultCard.hidden = false;
  $("result-handoff").href = handoffUrl();
  $("print-btn").onclick = () => window.print();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus("", false);
}

/* --------------------------------------------------------- bulk result */

/**
 * Value every selected Khasra at the rate entered above.
 *
 * The portal has no "many Khasras" rate endpoint, so the server build spends
 * one request per Khasra. This build cannot spend any -- it has no connection
 * at all -- so it applies the one rate the user typed to all of them. That is
 * a real and useful thing to do: it values a whole holding, or lets you check
 * what a single parcel would be worth at a rate you read elsewhere.
 *
 * What it cannot do is discover that some of those Khasras are rated
 * differently from each other. Agricultural and residential Khasras in the
 * same mouza routinely carry different rates, and this table will not show
 * that. The warning under the table says so.
 */
function runBatch() {
  const numbers = sortKhasras([...state.multi.selected]);
  if (!numbers.length) return;

  const areaUnit = el.areaUnit.value;
  const rateUnit = el.rateUnit.value;
  const opts = conversionOpts();

  // A bulk run values every selected Khasra at one rate, so the message says
  // so and says how many -- otherwise "this parcel" is both wrong and vague
  // when the selection is eight thousand strong.
  //
  // The rate is optional here for the same reason it is on the single form: a
  // selection with no rate still has a total area, and a schedule of eight
  // thousand Khasras with their areas is worth having. A rate that is present
  // but unusable is still stopped.
  const n = numbers.length;
  const plural = n === 1 ? "Khasra" : "Khasras";
  const nLabel = n.toLocaleString();
  const areaRes = readPositive(el.areaValue, `the land area of each of the ${nLabel} ${plural}`, false);
  if (areaRes.state === "bad") return;
  const rateRes = readPositive(el.rateValue, `the DC rate to apply to all ${nLabel} ${plural}`, true);
  if (rateRes.state === "bad") return;
  const area = areaRes.value;
  const rate = rateRes.state === "ok" ? rateRes.value : null;

  const v = rate === null ? null : landValue({ area, areaUnit, rate, rateUnit, opts });
  // Always available, so the no-rate table can still show a real sq-ft figure
  // rather than an empty column.
  const totalSqft = convert(area, areaUnit, "SqFt", opts);
  clearBadFields();
  const names = [
    "District Chakwal", "Tehsil Chakwal",
    text(el.qanoongo), text(el.mouza),
    text(el.landClassification), text(el.location),
  ].filter(Boolean);
  const trailHtml = names.map((b) => `<b>${esc(b)}</b>`).join(" › ");

  const rows = numbers.map((k) => ({
    khasra: k,
    area,
    areaUnit,
    areaInRateUnit: v ? v.areaInRateUnit : null,
    rate,
    rateUnit,
    total: v ? v.total : null,
  }));

  state.multi.batch = {
    district: "Chakwal",
    tehsil: "Chakwal",
    qanoongo: text(el.qanoongo),
    mouza: text(el.mouza),
    classification: text(el.landClassification),
    location: text(el.location),
    rate, rateUnit, area, areaUnit, opts,
    totalSqft,
    impliedPerSqft: v ? v.impliedPerSqft : null,
    rows,
  };

  // Total area of the whole holding, which is the one figure a no-rate run can
  // still give that is worth more than the per-Khasra sum of identical rows.
  const holdingSqft = totalSqft * n;
  const holdingLabel = (from, to) =>
    `${nf.format(convert(area * n, from, to, opts))} ${AREA_LABELS[to] || to}`;

  const hero = v
    ? `<div class="rate-hero-wrap">
        <div class="rate-hero">
          <span class="rate-num">${money(v.total)}</span>
          <span class="rate-unit">each, at ${money(rate)} per ${esc(AREA_LABELS[rateUnit] || rateUnit)}</span>
        </div>
      </div>`
    : `<div class="rate-hero-wrap">
        <div class="rate-hero">
          <span class="rate-num rate-num-none">No rate</span>
          <span class="rate-unit">so no values below &mdash; areas only</span>
        </div>
      </div>`;

  const valueMetrics = v
    ? `<div class="metric"><dt>Converted to rate units</dt>
        <dd>${nf.format(v.areaInRateUnit)} <small>${esc(AREA_LABELS[rateUnit] || rateUnit)}</small></dd></div>
      <div class="metric"><dt>That area in sq ft</dt>
        <dd>${nf.format(totalSqft)}</dd></div>
      <div class="metric"><dt>DC value each</dt><dd>${money(v.total)}</dd></div>
      <div class="metric"><dt>DC value all ${nLabel}</dt>
        <dd>${money(v.total * n)}</dd></div>`
    : `<div class="metric"><dt>Each in sq ft</dt>
        <dd>${nf.format(totalSqft)}</dd></div>
      <div class="metric"><dt>Whole holding in sq ft</dt>
        <dd>${nf.format(holdingSqft)}</dd></div>
      ${AREA_UNITS.filter((u) => u !== "SqFt").map((to) => `
        <div class="metric"><dt>Whole holding in ${esc((AREA_LABELS[to] || to).toLowerCase())}</dt>
          <dd>${holdingLabel(areaUnit, to)}</dd></div>`).join("")}`;

  const warn = v
    ? `<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>One rate applied to all ${nLabel}.</strong>
      This build cannot read the portal, so it used the single rate you typed
      for every Khasra listed. Khasras in one mouza are frequently rated
      differently from each other — agricultural, residential and commercial
      land in the same location rarely share a figure. Treat this table as
      "what these ${nLabel} would be worth at
      ${money(rate)} per ${esc(AREA_LABELS[rateUnit] || rateUnit)}", not as the
      official rate for each one. The server build looks each Khasra up
      individually and does not have this limitation.
    </div></div>`
    : `<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>No DC rate entered, so nothing here is valued.</strong>
      This is a schedule of the ${nLabel} Khasras you selected and the area
      each one is being treated as, nothing more. Enter the rate above and every
      row gains a DC value. The total area across all of them
      (${holdingLabel(areaUnit, "Marla")}) is the figure this run can give you
      on its own.
    </div></div>`;

  // The rate columns are only in the table when there is a rate to put in them.
  // A column headed "DC value" full of dashes reads as a broken export.
  const rateColumns = v
    ? `<th class="num sortable" data-sort="inRate" tabindex="0" role="columnheader"
                aria-sort="none">In rate units</th>
            <th class="num sortable" data-sort="value" tabindex="0" role="columnheader"
                aria-sort="none">DC value</th>`
    : `<th class="num" role="columnheader">Each in sq ft</th>`;

  el.resultBody.innerHTML = `
    <p class="path-summary">${trailHtml} › <b>${nLabel} ${plural}</b></p>

    ${hero}

    <dl class="metrics">
      <div class="metric"><dt>Khasras selected</dt>
        <dd>${nLabel}</dd></div>
      <div class="metric"><dt>Area each</dt>
        <dd>${nf.format(area)} <small>${esc(AREA_LABELS[areaUnit] || areaUnit)}</small></dd></div>
      ${valueMetrics}
    </dl>

    ${warn}

    <details class="conv" open>
      <summary>Show all ${nLabel} ${plural}</summary>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr>
            <th class="num">#</th>
            <th class="sortable" data-sort="khasra" tabindex="0" role="columnheader"
                aria-sort="none">Khasra</th>
            <th class="num sortable" data-sort="area" tabindex="0" role="columnheader"
                aria-sort="none">Area</th>
            ${rateColumns}
          </tr></thead>
          <tbody id="batch-rows"></tbody>
        </table>
      </div>
    </details>

    <div class="actions">
      <button class="btn" id="batch-csv" type="button">Download CSV</button>
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  el.resultCard.hidden = false;
  $("result-handoff").href = handoffUrl();
  $("print-btn").onclick = () => window.print();
  $("batch-csv").onclick = downloadBatchCsv;

  // Sorting re-renders the tbody only. The <thead> is left alone, so a click
  // never destroys the header that was just pressed.
  state.multi.sort = { key: null, dir: 1 };
  renderBatchRows();
  for (const th of el.resultBody.querySelectorAll("th.sortable")) {
    const go = () => {
      const s = state.multi.sort;
      s.dir = s.key === th.dataset.sort ? -s.dir : 1;
      s.key = th.dataset.sort;
      renderBatchRows();
    };
    th.addEventListener("click", go);
    // A <th> is not a button, so give it the keyboard behaviour it lacks.
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
  }

  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus("", false);
}

/**
 * Draw the batch table body in the current sort order.
 *
 * Khasra sorts by the same numeric rule as the picker, so "1807/1" lands next
 * to "1807" rather than at the end. Everything else sorts on its number, not
 * on its formatted string -- sorting "9,000" against "10,000" as text would
 * put the smaller value last.
 */
function renderBatchRows() {
  const b = state.multi.batch;
  const body = $("batch-rows");
  if (!b || !body) return;

  const s = state.multi.sort || { key: null, dir: 1 };
  let rows = b.rows.slice();
  if (s.key) {
    const dir = s.dir;
    rows.sort((x, y) => {
      let d;
      if (s.key === "khasra") {
        const kx = khasraSortKey(x.khasra), ky = khasraSortKey(y.khasra);
        d = kx[0] - ky[0] || kx[1] - ky[1] ||
            (x.khasra < y.khasra ? -1 : x.khasra > y.khasra ? 1 : 0);
      } else {
        // A no-rate run leaves these null. Every Khasra in the run has the same
        // area, so ordering by them would be arbitrary anyway; treating null as
        // 0 keeps the comparator total instead of returning NaN.
        const key = s.key === "value" ? "total" : s.key;
        d = ((x[key] ?? 0) - (y[key] ?? 0));
      }
      return d * dir;
    });
  }

  // The last two columns are the rate ones, and only exist when there is a
  // rate. Written as a function because the values come from the row.
  const tail = (r) => b.rate === null
    ? `<td class="num">${nf.format(b.totalSqft)}</td>`
    : `<td class="num">${nf.format(r.areaInRateUnit)} <small>${esc(AREA_LABELS[r.rateUnit] || r.rateUnit)}</small></td>
       <td class="num">${money(r.total)}</td>`;

  body.innerHTML = rows.map((r, i) => `<tr>
    <td class="num">${(i + 1).toLocaleString()}</td>
    <td class="mono">${esc(r.khasra)}</td>
    <td class="num">${nf.format(r.area)} <small>${esc(AREA_LABELS[r.areaUnit] || r.areaUnit)}</small></td>
    ${tail(r)}
  </tr>`).join("");

  for (const th of el.resultBody.querySelectorAll("th.sortable")) {
    const on = th.dataset.sort === s.key;
    th.classList.toggle("asc", on && s.dir === 1);
    th.classList.toggle("desc", on && s.dir === -1);
    th.setAttribute("aria-sort", on ? (s.dir === 1 ? "ascending" : "descending") : "none");
  }
}

function batchCsv() {
  const b = state.multi.batch;
  if (!b) return "";
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lead = ["khasra", "district", "tehsil", "qanoongo", "mouza", "classification",
                "location", "area", "area_unit"];
  // The value columns are only exported when there is a rate behind them. A CSV
  // with a dc_value column of empty cells looks like a failed export rather
  // than a deliberate area-only schedule, and gets pasted into a spreadsheet
  // where the empties become zeros.
  const tailCols = b.rate === null
    ? ["area_each_sqft", "whole_holding_area", "whole_holding_unit"]
    : ["area_in_rate_unit", "rate", "rate_unit", "dc_value",
       "total_sqft", "implied_per_sqft"];
  const lines = [lead.concat(tailCols).join(",")];
  for (const r of b.rows) {
    const tail = b.rate === null
      ? [b.totalSqft, b.area * b.rows.length, AREA_LABELS[b.areaUnit] || b.areaUnit]
      : [r.areaInRateUnit, r.rate, r.rateUnit, r.total, b.totalSqft, b.impliedPerSqft];
    lines.push([
      r.khasra, b.district, b.tehsil, b.qanoongo, b.mouza, b.classification,
      b.location, r.area, r.areaUnit,
    ].concat(tail).map(q).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function downloadBatchCsv() {
  const csv = batchCsv();
  if (!csv) return;
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.multi.batch && state.multi.batch.rate === null
    ? "chakwal-khasra-areas.csv"
    : "chakwal-khasra-values.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn rather than immediately: Safari cancels the
  // download if the object URL disappears in the same tick as the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------- wiring */

function resetAll() {
  el.resultCard.hidden = true;
  el.mouzaSearch.value = "";
  el.khasra.value = "";
  el.rateValue.value = "";
  el.areaValue.value = "1";
  el.areaUnit.value = "Marla";
  el.rateUnit.value = "Marla";
  resetRural();
  resetUrban();
  updateConversionPreview();
  setStatus("", false);
}

function init() {
  // Unit dropdowns, from the same list the server uses.
  fill(el.areaUnit, AREA_UNITS.map((u) => ({ id: u, name: AREA_LABELS[u] || u })), { placeholder: "" });
  el.areaUnit.value = "Marla";
  fill(el.rateUnit, AREA_UNITS.map((u) => ({ id: u, name: AREA_LABELS[u] || u })), { placeholder: "" });
  el.rateUnit.value = "Marla";

  // Goes through setLandType so the visible/hidden state of every block is
  // decided in exactly one place rather than being implied by the HTML.
  setLandType("rural");

  el.mouzaSearch.addEventListener("input", renderMouzas);
  el.qanoongo.addEventListener("change", onQanoongoChange);
  el.mouza.addEventListener("change", onMouzaChange);
  el.landClassification.addEventListener("change", onClassificationChange);
  el.location.addEventListener("change", onLocationChange);

  // --- rural / urban
  for (const b of el.landTypeBtns) {
    b.addEventListener("click", () => setLandType(b.dataset.landType));
  }
  el.town.addEventListener("change", onTownChange);
  el.revenueCircle.addEventListener("change", onRevenueCircleChange);
  el.floor.addEventListener("change", onFloorChange);
  el.propertyArea.addEventListener("change", onPropertyAreaChange);
  el.areaValue.addEventListener("input", updateConversionPreview);
  el.rateValue.addEventListener("input", updateConversionPreview);
  for (const s of [el.areaUnit, el.acreToKanal, el.marlaToSqft]) {
    s.addEventListener("change", updateConversionPreview);
  }

  // A rejected field stops looking rejected as soon as it is edited, rather
  // than staying ringed in red next to a value that is now fine.
  for (const f of [el.rateValue, el.areaValue, el.khasra, el.mouza,
                   el.landClassification, el.location, el.town,
                   el.revenueCircle, el.propertyArea]) {
    f.addEventListener("input", clearBadFields);
    f.addEventListener("change", clearBadFields);
  }
  el.resetBtn.addEventListener("click", resetAll);
  el.form.addEventListener("submit", (e) => { e.preventDefault(); renderResult(); });

  // --- multi-Khasra picker. Delegated, because a mouza can hold thousands of
  // --- Khasras and a listener per chip would be thousands of closures.
  el.multiToggle.addEventListener("click", () => toggleMultiPanel());
  el.multiClose.addEventListener("click", () => toggleMultiPanel(false));
  el.multiAll.addEventListener("click", selectAllShown);
  el.multiNone.addEventListener("click", clearMultiSelection);
  el.multiRun.addEventListener("click", runBatch);
  el.multiFilter.addEventListener("input", () => {
    state.multi.filter = el.multiFilter.value;
    renderKhasraGrid();
  });
  el.multiGrid.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (chip) toggleKhasra(chip.dataset.khasra, ev);
  });

  updateConversionPreview();

  const combos = REFERENCE.mouzas.reduce((n, m) => n + m.classifications.length, 0);
  el.refreshNote.textContent =
    `Reference lists bundled: ${REFERENCE.districts.length} districts, ` +
    `${REFERENCE.mouzas.length} mouzas, ${combos} classification/location lists ` +
    `(read from the official portal on ${REFERENCE.generated.replace("T", " ")}). ` +
    `No rate is stored anywhere — the portal is the only source, and this build ` +
    `cannot reach it.`;
}

/* Exported for the test harness, which loads this file under Node to compare
 * the arithmetic against govapi.py and to check the sort order. init() is
 * skipped there: there is no DOM to wire up, and requiring the module should
 * not throw. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    convert, landValue, sortKhasras, khasraSortKey,
    ACRE_TO_KANAL, KANAL_TO_MARLA, MARLA_TO_SQFT,
  };
} else {
  init();
}
