/* ==========================================================================
   Chakwal DC Rate Calculator -- DESKTOP build
   --------------------------------------------------------------------------
   The form, the unit conversion and the DC value arithmetic are all here and
   all exact, and the reference lists come from the data/ files beside this one.

   This file is the offline build's app.js with one addition: desktop.js can ask
   the local server for a rate and fill the rate field in. That is the only
   difference, and it is why the rate field stays an editable input rather than
   becoming a read-only output -- a rate you were given on paper is still a
   legitimate thing to type in, and the arithmetic downstream cannot tell the
   difference between that and one read from the portal.

   Why a rate cannot simply be fetched from this page: the portal replies with
   no `access-control-*` headers at all, so a browser throws the response away
   before any script here can see it. That is a browser rule, not something
   this file can work around -- which is exactly why the desktop build runs a
   small local server (main.py) and asks that instead. Both paths are the same
   maths, so a figure computed here matches one from the server given the same
   rate.

   The conversion constants below are copied from govapi.py rather than
   retyped, so the two cannot drift apart.
   ========================================================================== */

"use strict";

/* browser-check.js has already decided whether this browser can run the page at
 * all. On Internet Explorer 11 -- which is the default browser on Windows 7 --
 * it cannot, and this file's own `?.` and `??` would throw while parsing, before
 * a single line of the app ran. Stopping here means the checker's explanation
 * is what the user sees, instead of a SyntaxError and an empty page. */
if (window.__CAPABLE__ === false) {
  throw new Error("browser-check.js reported this browser as unsupported");
}

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
  // The rate is a readout, not an input. There is no rate field and no rate-unit
  // select anywhere in this build: a typed rate cannot be traced back to a
  // published DC Valuation row, and a figure that looks authoritative but was
  // keyed in by hand is exactly the failure this project exists to prevent.
  rateOut: $("rate-readout"),
  rateFigure: $("rate-readout-value"),
  rateUnit: $("rate-readout-unit"),
  rateNote: $("rate-readout-note"),
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
  // The live rate for the parcel currently described by the form.
  //
  //   key      identity of the chain this rate belongs to, so a rate can never
  //            be shown against a parcel it was not fetched for
  //   status   "idle" | "loading" | "ready" | "none" | "error"
  //   rate     the portal's own figure, or null
  //   unit     the unit the portal quoted it per -- Marla and Acre differ by a
  //            factor of 160, so this is part of the answer, not a detail
  //   message  why there is no rate, in the portal's terms
  rate: { key: null, status: "idle", rate: null, unit: null, message: null },
  // Bumped on every chain change so a rate still in flight when the user moves
  // on is discarded rather than landing on the wrong parcel.
  rateEpoch: 0,
  // Timer for the debounce between typing a Khasra and asking the portal.
  rateTimer: null,
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

/**
 * The numeric id behind a <select>, or null when nothing usable is chosen.
 *
 * The portal wants ids, not labels, so every chain level has to be unwrapped
 * before it is sent. A NaN here would be worse than a null: it would reach the
 * portal as "not a number" and come back as a confusing 422 rather than as the
 * plain "choose one first" the user needs to see.
 */
function num(sel) {
  const v = sel ? sel.value : "";
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

/* --------------------------------------------------------- the live rate */

/**
 * Describe the parcel the form currently points at, or say what is missing.
 *
 * Returns { body, key, label, names, parcel } on success, or { error, field }
 * when the chain is incomplete. `key` identifies the chain for rate-lookup
 * purposes and deliberately excludes the area: the rate does not depend on it.
 */
function currentChain({ needParcel = true } = {}) {
  const base = {
    district_id: 21, district_name: "Chakwal",
    tehsil_id: 75, tehsil_name: "Chakwal",
  };

  if (state.landType === "urban") {
    if (!el.town.value) return { error: "Choose a Town / City first.", field: el.town };
    if (!el.revenueCircle.value) return { error: "Choose a Revenue Circle.", field: el.revenueCircle };
    if (!el.propertyArea.value) return { error: "Choose a Property Area.", field: el.propertyArea };
    const body = Object.assign({}, base, {
      land_type: "urban", path: "area",
      town: text(el.town),
      revenue_circle_id: num(el.revenueCircle),
      property_area_id: num(el.propertyArea),
      property_area_name: text(el.propertyArea),
      floor_id: num(el.floor) || null,
      land_classification_id: num(el.landClassification) || null,
      land_classification_name: text(el.landClassification),
      location: text(el.location),
    });
    // An urban property area is rated as a whole; the portal publishes no
    // narrower parcel for it, so nothing to put in khasra_no.
    body.khasra_no = "";
    return {
      body,
      key: ["urban", body.town, body.revenue_circle_id, body.property_area_id].join("|"),
      label: [text(el.town), state.selectedCircle?.name, text(el.propertyArea)]
        .filter(Boolean).join(" › "),
      names: [text(el.town), state.selectedCircle?.name, state.selectedFloor?.name,
              text(el.propertyArea)].filter(Boolean),
      parcel: null,
    };
  }

  if (!el.mouza.value) return { error: "Choose a Mouza first.", field: el.mouza };
  if (!el.landClassification.value) {
    return { error: "Choose a land classification.", field: el.landClassification };
  }
  if (!text(el.location)) return { error: "Choose a location.", field: el.location };
  const khasra = el.khasra.value.trim();
  // A bulk run prices a list rather than the one parcel in the box, so it asks
  // for the same chain with the parcel left out.
  if (!khasra && needParcel) {
    return { error: "Enter the Khasra number.", field: el.khasra };
  }

  const body = Object.assign({}, base, {
    land_type: "rural", path: "khasra",
    mouza_id: num(el.mouza),
    qanoongo_id: state.selectedMouza ? state.selectedMouza.qanoongoId : null,
    mouza_name: text(el.mouza),
    land_classification_id: num(el.landClassification),
    land_classification_name: text(el.landClassification),
    location: text(el.location),
    khasra_no: khasra,
  });
  return {
    body,
    // With no parcel to name, the key stops at the location: every Khasra in
    // this location shares that scope, which is exactly what a bulk run is.
    key: ["rural", body.mouza_id, body.land_classification_id, body.location,
          needParcel ? khasra : "*"].join("|"),
    label: [text(el.mouza), text(el.landClassification), text(el.location), khasra]
      .filter(Boolean).join(" › "),
    names: [text(el.qanoongo), text(el.mouza),
            text(el.landClassification), text(el.location)].filter(Boolean),
    parcel: needParcel ? khasra : null,
  };
}

/**
 * Is this Khasra one the portal actually publishes for this location?
 *
 * The bundled reference data lists every Khasra per mouza, classification and
 * location, so this can be answered without asking the portal. It matters: the
 * Khasra box is a free-text field, and without this check every typo and every
 * half-typed number would be a live request against a government server to be
 * told the number does not exist.
 */
function isPublishedKhasra(khasra) {
  const list = currentKhasraList();
  return !!khasra && list.includes(khasra);
}

/**
 * Paint the readout in one of its five states.
 *
 * The parameter is named `status`, not `state`: the module-level `state` object
 * is the thing being written to here, and a parameter of the same name would
 * shadow it and turn every line below into a string.
 */
function showRate(status, figure, unit, note) {
  state.rate = {
    key: state.rate.key, status, rate: figure, unit, message: note,
  };
  el.rateOut.dataset.state = status;
  el.rateFigure.innerHTML =
    status === "ready" ? esc(nf.format(figure)) :
    status === "none" ? "No published rate" :
    status === "loading" ? "Reading…" : "&mdash;";
  el.rateUnit.textContent = status === "ready" ? `per ${AREA_LABELS[unit] || unit}` : "";
  el.rateNote.textContent = note || "";
}

/**
 * Fetch the rate for whatever the form points at, and show it.
 *
 * Called on every chain change, debounced, so a user picking their way down the
 * dropdowns triggers one request for the finished chain rather than one per
 * click. A response is discarded unless the chain is still the same one it was
 * asked for -- otherwise a slow lookup for a Khasra the user has already
 * navigated away from would overwrite the correct rate for the new one.
 */
async function refreshRate() {
  const chain = currentChain();
  if (chain.error) {
    showRate("idle", null, null, chain.error);
    return;
  }

  // A Khasra the portal does not publish for this location cannot have a rate.
  // Saying so locally is both faster and kinder than asking.
  if (chain.body.land_type === "rural" && !isPublishedKhasra(chain.body.khasra_no)) {
    const known = currentKhasraList();
    showRate(
      "none", null, null,
      known.length
        ? `Khasra ${chain.body.khasra_no} is not one of the ${known.length.toLocaleString()} ` +
          `the portal publishes for ${text(el.mouza)} / ${text(el.landClassification)} / ` +
          `${text(el.location)}. Pick one from the list.`
        : "No Khasras are published for this classification and location."
    );
    return;
  }

  if (state.rate.key === chain.key && state.rate.status === "ready") return;

  const epoch = ++state.rateEpoch;
  state.rate.key = chain.key;
  showRate("loading", null, null, `Asking the Punjab e-Stamp portal about ${chain.label}…`);

  try {
    const r = await window.LiveRates.single(
      Object.assign({ area: num(el.areaValue) || 0, area_unit: el.areaUnit.value }, chain.body)
    );
    if (epoch !== state.rateEpoch) return; // the form moved on; this is stale
    if (r.found) {
      showRate("ready", r.rate, r.unit,
        `Rs. ${nf.format(r.rate)} per ${AREA_LABELS[r.unit] || r.unit}, read live from the ` +
        `Punjab e-Stamp portal. Not saved — it is read again next time.`);
    } else {
      // The readout stands alone, so it names the parcel. `state.rate.message`
      // deliberately does not: the result card already prints the whole chain
      // above the notice, and saying it twice reads as a stutter.
      state.rate.message = r.message || "The portal publishes no DC rate for it.";
      showRate("none", null, null,
        `The portal publishes no DC rate for ${chain.label}. ${state.rate.message}`);
    }
  } catch (e) {
    if (epoch !== state.rateEpoch) return;
    showRate("error", null, null,
      `Could not read the portal: ${e && e.message ? e.message : e}. ` +
      `Check your internet connection.`);
  }
}

/** Re-run the rate lookup, but not until the user stops changing things. */
function scheduleRate() {
  clearTimeout(state.rateTimer);
  state.rateTimer = setTimeout(refreshRate, 400);
}

function renderResult() {
  const areaUnit = el.areaUnit.value;
  const opts = conversionOpts();

  // One description of the parcel, shared by the guards, the request and the
  // trail, so the three cannot quietly disagree about which Khasra is meant.
  const chain = currentChain();
  if (chain.error) { fail(chain.error, chain.field); return; }

  const areaRes = readPositive(el.areaValue, "a land area", false);
  if (areaRes.state === "bad") return;
  const area = areaRes.value;

  // The rate is not something the user supplies any more, so the old "is it
  // filled in and is it usable" guard has nothing left to check. It has either
  // arrived from the portal or it has not, and the second case is a fact about
  // the published data rather than something the reader can fix by typing.
  //
  // Two different failures, and they must not be reported the same way. A rate
  // that has not been asked for yet is work in progress and deserves "one
  // moment". A rate the portal has already declined to publish is a settled
  // answer, and pressing the button again should report that answer rather than
  // claim to still be waiting for it.
  if (state.rate.key !== chain.key || state.rate.status === "loading") {
    fail("Reading this parcel's rate from the portal — one moment.", chain.field);
    refreshRate();
    return;
  }
  if (state.rate.status !== "ready") {
    renderNoRate(chain, area, areaUnit, opts);
    return;
  }
  const rate = state.rate.rate;
  const rateUnit = state.rate.unit;

  // Past every guard, so nothing stays ringed in red next to a value that is
  // now fine.
  clearBadFields();

  const parts = ["District Chakwal", "Tehsil Chakwal", ...chain.names]
    .filter(Boolean).map((b) => `<b>${esc(b)}</b>`);
  if (chain.parcel) parts.push(`<b>${esc(chain.parcel)}</b>`);
  const trail = parts.join(" › ");

  // Wording follows the chain: an urban property area is rated as a whole and
  // the portal publishes no parcel inside it, so calling it a Khasra would name
  // something that does not exist in the official data.
  const what = chain.parcel ? `Khasra ${chain.parcel}` : "this property area";

  const actions = `
    <div class="actions">
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  const v = landValue({ area, areaUnit, rate, rateUnit, opts });
  const unitNote = rateUnit === "SqFt" ? " <small>(sq ft)</small>" : "";

  el.resultBody.innerHTML = `
    <p class="path-summary">${trail}</p>

    <div class="rate-hero-wrap">
      <div class="rate-hero">
        <span class="rate-num">${money(v.total)}</span>
        <span class="rate-unit">value of ${esc(what)}</span>
      </div>
    </div>

    <dl class="metrics">
      <div class="metric"><dt>Land area</dt>
        <dd>${nf.format(area)} <small>${esc(AREA_LABELS[areaUnit] || areaUnit)}</small></dd></div>
      <div class="metric"><dt>Area in rate units</dt>
        <dd>${nf.format(v.areaInRateUnit)} <small>${esc(AREA_LABELS[rateUnit] || rateUnit)}</small></dd></div>
      <div class="metric"><dt>That area in sq ft</dt>
        <dd>${nf.format(v.totalSqft)}</dd></div>
      <div class="metric"><dt>DC rate applied</dt>
        <dd>${money(rate)} <small>per ${esc(AREA_LABELS[rateUnit] || rateUnit)}${unitNote}</small></dd></div>
      <div class="metric"><dt>Value of ${esc(what)}</dt><dd>${money(v.total)}</dd></div>
      <div class="metric"><dt>Per sq ft (implied)</dt>
        <dd>${money(v.impliedPerSqft)}</dd></div>
    </dl>

    <div class="notice"><span class="notice-ico">i</span><div>
      <strong>The value above is the Khasra's own.</strong> It is the
      ${nf.format(area)} ${esc(AREA_LABELS[areaUnit] || areaUnit)} valued at the
      ${money(rate)} per ${esc(AREA_LABELS[rateUnit] || rateUnit)} that the Punjab
      e-Stamp portal publishes for this exact chain. Both figures were read live
      just now and neither was typed in or saved. The rate is the basis the value
      is worked out from, not the value itself — and the unit matters: rural
      agricultural Khasras are commonly quoted per Acre rather than per Marla,
      and the two differ by a factor of 160.
    </div></div>

    ${actions}`;

  el.resultCard.hidden = false;
  $("result-handoff").href = handoffUrl();
  $("print-btn").onclick = () => window.print();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus("", false);
}

/**
 * The result card for a parcel the portal declines to rate.
 *
 * This is a real answer, not an error, and it is answered in full rather than as
 * a refusal: the area is still worth converting, and a reader checking a land
 * record usually wants to know how big the parcel is even when the rate is
 * missing. What is NOT offered is a value -- there is no rate to value it at,
 * and inventing one is the single worst thing this app could do.
 */
function renderNoRate(chain, area, areaUnit, opts) {
  clearBadFields();

  const parts = ["District Chakwal", "Tehsil Chakwal", ...chain.names]
    .filter(Boolean).map((b) => `<b>${esc(b)}</b>`);
  if (chain.parcel) parts.push(`<b>${esc(chain.parcel)}</b>`);
  const trail = parts.join(" › ");
  const what = chain.parcel ? `Khasra ${chain.parcel}` : "this property area";

  const failed = state.rate.status === "error";
  const conversions = AREA_UNITS.filter((u) => u !== areaUnit).map((to) => `
    <div class="metric"><dt>In ${esc((AREA_LABELS[to] || to).toLowerCase())}</dt>
      <dd>${nf.format(convert(area, areaUnit, to, opts))}</dd></div>`).join("");

  el.resultBody.innerHTML = `
    <p class="path-summary">${trail}</p>

    <div class="rate-hero-wrap">
      <div class="rate-hero">
        <span class="rate-num rate-num-none">${failed ? "Not read" : "No rate"}</span>
        <span class="rate-unit">so ${esc(what)} cannot be valued &mdash; area only</span>
      </div>
    </div>

    <dl class="metrics">
      <div class="metric"><dt>Land area</dt>
        <dd>${nf.format(area)} <small>${esc(AREA_LABELS[areaUnit] || areaUnit)}</small></dd></div>
      ${conversions}
    </dl>

    <div class="notice ${failed ? "notice-bad" : "notice-warn"}">
      <span class="notice-ico">${failed ? "!" : "i"}</span><div>
        ${failed ? `
        <strong>The portal could not be read.</strong>
        ${esc(state.rate.message || "")} Nothing has been valued here, and no
        figure below is a rate. Check the internet connection and try again.
        ` : `
        <strong>The portal publishes no DC rate for ${esc(what)}.</strong>
        ${esc(state.rate.message || "")} This is a fact about the published data,
        not something that can be typed around — and it is the honest answer, so
        no value is shown for this parcel. The area conversions above are exact.
        If you hold a record that gives a rate for this parcel, it is worth
        opening the official DC Valuation page below and checking whether the
        chain you selected matches the one on the record.
        `}
      </div>
    </div>

    <div class="actions">
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  el.resultCard.hidden = false;
  $("result-handoff").href = handoffUrl();
  $("print-btn").onclick = () => window.print();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus(failed
    ? "Could not read the portal. Nothing was valued."
    : "The portal publishes no rate for this parcel. No value was calculated.", true);
}

/* --------------------------------------------------------- bulk result */

/**
 * Price every selected Khasra at its OWN rate, and show what each one is worth.
 *
 * The earlier version of this page applied a single typed rate to the whole
 * selection. That had a consequence worth naming: it could never tell you that
 * Khasra 947 and Khasra 948 in one location carry different figures, because it
 * had decided in advance that they did not. This looks each Khasra up
 * separately, so the table below is a schedule of what the portal publishes per
 * parcel, and any disagreement between them is visible rather than smoothed away.
 *
 * The price of that honesty is one portal request per Khasra -- the portal has
 * no bulk rate endpoint, so a batch is N calls however it is arranged. Hence the
 * cap, and hence the reported skip count. Rows arrive in chunks and the table
 * fills as they land, because a few hundred lookups is not instant and a frozen
 * page reads as a broken one.
 */
async function runBatch() {
  const numbers = sortKhasras([...state.multi.selected]);
  if (!numbers.length) return;

  const areaUnit = el.areaUnit.value;
  const opts = conversionOpts();

  // The chain with the parcel left out: a bulk run covers the whole location,
  // not the one Khasra sitting in the single-Khasra box.
  const chain = currentChain({ needParcel: false });
  if (chain.error) { fail(chain.error, chain.field); return; }

  const n = numbers.length;
  const plural = n === 1 ? "Khasra" : "Khasras";
  const nLabel = n.toLocaleString();

  const areaRes = readPositive(el.areaValue, `the land area of each of the ${nLabel} ${plural}`, false);
  if (areaRes.state === "bad") return;
  const area = areaRes.value;
  clearBadFields();

  const cap = window.LiveRates.MAX_BATCH;
  const use = numbers.slice(0, cap);
  const skipped = n - use.length;

  state.multi.batch = {
    district: "Chakwal",
    tehsil: "Chakwal",
    qanoongo: text(el.qanoongo),
    mouza: text(el.mouza),
    classification: text(el.landClassification),
    location: text(el.location),
    area, areaUnit, opts,
    rows: [],          // one per Khasra, each with its own rate or found:false
    requested: n,
    skipped,
    done: 0,           // lookups completed so far
    pending: use.length,
    running: true,
    error: null,
    source: null,
  };
  state.multi.sort = { key: null, dir: 1 };

  const trailHtml = ["District Chakwal", "Tehsil Chakwal", ...chain.names]
    .filter(Boolean).map((b) => `<b>${esc(b)}</b>`).join(" › ");

  el.resultBody.innerHTML = `
    <p class="path-summary">${trailHtml} › <b>${nLabel} ${plural}</b></p>

    <div id="batch-summary"></div>

    <details class="conv" open>
      <summary>Show all ${nLabel} ${plural}</summary>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr>
            <th class="num">#</th>
            <th class="sortable" data-sort="khasra" tabindex="0" role="columnheader"
                aria-sort="none">Khasra</th>
            <th class="num">Area</th>
            <th class="num sortable" data-sort="rate" tabindex="0" role="columnheader"
                aria-sort="none">DC rate</th>
            <th class="num sortable" data-sort="value" tabindex="0" role="columnheader"
                aria-sort="none">Value of Khasra</th>
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

  paintBatch();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  let result;
  try {
    result = await window.LiveRates.batch(
      Object.assign({ area, area_unit: areaUnit }, chain.body, { khasra_no: "" }),
      use,
      (p) => {
        const b = state.multi.batch;
        if (!b) return; // the user moved on and cleared the run
        b.done = p.done;
        b.rows = p.rows;
        paintBatch();
        setStatus(`Reading rates from the portal — ${p.done.toLocaleString()} of ` +
                  `${p.total.toLocaleString()} ${plural}…`, false);
      }
    );
  } catch (e) {
    const b = state.multi.batch;
    if (!b) return;
    b.running = false;
    b.error = (e && e.message) || String(e);
    paintBatch();
    setStatus("Could not read the portal. " + b.error, true);
    return;
  }

  const b = state.multi.batch;
  if (!b) return;
  b.running = false;
  b.rows = result.rows;
  b.source = result.source;
  b.skipped = result.skipped || 0;

  paintBatch();
  const priced = b.rows.filter((r) => r.found).length;
  setStatus(
    `Priced ${priced.toLocaleString()} of ${nLabel} ${plural} from the Punjab ` +
    `e-Stamp portal.${b.rows.length - priced ? ` ${(b.rows.length - priced).toLocaleString()} had no published rate.` : ""}`,
    false
  );
}

/**
 * Value one Khasra from its own rate.
 *
 * Each row carries its own unit, because Khasras in one location are not
 * obliged to share one -- a residential Khasra and an agricultural Khasra in the
 * same mouza are commonly quoted per Marla and per Acre respectively. Running
 * each through landValue is what makes a mixed-unit table arithmetically
 * correct instead of 160x out somewhere in the middle.
 */
function batchValue(b, row) {
  if (!row.found || !(row.rate > 0) || !row.unit) return null;
  return landValue({
    area: b.area, areaUnit: b.areaUnit, rate: row.rate, rateUnit: row.unit, opts: b.opts,
  });
}

/** Rebuild each row's derived figures from its own rate. */
function decorateBatch(b) {
  for (const r of b.rows) {
    const v = batchValue(b, r);
    r.value = v ? v.total : null;
    r.inRate = v ? v.areaInRateUnit : null;
    r.totalSqft = v ? v.totalSqft : null;
    r.impliedPerSqft = v ? v.impliedPerSqft : null;
  }
  return b;
}

/** Draw the headline numbers and the notices above the table. */
function paintBatch() {
  const b = state.multi.batch;
  const host = $("batch-summary");
  if (!b || !host) return;

  decorateBatch(b);

  const rated = b.rows.filter((r) => r.found && r.value !== null);
  const unrated = b.rows.filter((r) => !r.found);
  const totalValue = rated.reduce((s, r) => s + r.value, 0);
  const units = new Set(rated.map((r) => r.unit));
  const distinct = new Set(rated.map((r) => Math.round(r.rate * 1e6) / 1e6));

  const nLabel = b.requested.toLocaleString();
  const nRated = rated.length.toLocaleString();
  const nUnrated = unrated.length.toLocaleString();

  // Mid-run, say so plainly rather than showing a confident zero.
  const running = b.running;

  const hero = running
    ? `<div class="rate-hero-wrap">
        <div class="rate-hero">
          <span class="rate-num">Reading…</span>
          <span class="rate-unit">${b.done.toLocaleString()} of ${b.pending.toLocaleString()} looked up</span>
        </div>
      </div>`
    : b.error
      ? `<div class="rate-hero-wrap">
          <div class="rate-hero">
            <span class="rate-num rate-num-none">No rates</span>
            <span class="rate-unit">the portal could not be read</span>
          </div>
        </div>`
      : rated.length
        ? `<div class="rate-hero-wrap">
            <div class="rate-hero">
              <span class="rate-num">${money(totalValue)}</span>
              <span class="rate-unit">total value of the ${nRated} Khasra${rated.length === 1 ? "" : "s"} priced</span>
            </div>
          </div>`
        : `<div class="rate-hero-wrap">
            <div class="rate-hero">
              <span class="rate-num rate-num-none">No rates</span>
              <span class="rate-unit">the portal publishes none for these Khasras</span>
            </div>
          </div>`;

  const metrics = `
    <dl class="metrics">
      <div class="metric"><dt>Khasras selected</dt><dd>${nLabel}</dd></div>
      <div class="metric"><dt>Area each</dt>
        <dd>${nf.format(b.area)} <small>${esc(AREA_LABELS[b.areaUnit] || b.areaUnit)}</small></dd></div>
      <div class="metric"><dt>Priced by the portal</dt>
        <dd>${running ? "&mdash;" : nRated}</dd></div>
      <div class="metric"><dt>No published rate</dt>
        <dd>${running ? "&mdash;" : nUnrated}</dd></div>
      <div class="metric"><dt>Distinct DC rates</dt>
        <dd>${running ? "&mdash;" : distinct.size.toLocaleString()}</dd></div>
      <div class="metric"><dt>Total value</dt>
        <dd>${running || !rated.length ? "&mdash;" : money(totalValue)}</dd></div>
    </dl>`;

  const notices = [];

  if (b.error) {
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>Could not read the portal.</strong> ${esc(b.error)} Nothing below
      is priced, and the area figures are the only thing that could be shown.
      Check the internet connection and run it again.
    </div></div>`);
  }

  if (b.skipped > 0) {
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>${b.skipped.toLocaleString()} of your ${nLabel} Khasras were not looked up.</strong>
      A run prices at most ${cap()} Khasras, because the portal answers one
      Khasra per request and a larger run would be a larger pile of requests to
      somebody else's server. Those ${b.skipped.toLocaleString()} are not in the
      table and not in the CSV. Narrow the selection to the parcels you actually
      need and run it again.
    </div></div>`);
  }

  if (!b.running && !b.error && rated.length && distinct.size > 1) {
    notices.push(`<div class="notice"><span class="notice-ico">i</span><div>
      <strong>These ${nRated} Khasras do not share one rate.</strong>
      The portal publishes ${distinct.size.toLocaleString()} different DC
      figures across them${units.size > 1
        ? `, in ${units.size} different units (${Array.from(units).sort()
             .map((u) => AREA_LABELS[u] || u).join(" and ")})`
        : ""}. Each row below is priced at its own rate, which is the whole
      point of looking them up one by one — an earlier version of this page
      applied a single rate to the whole selection and would have valued some of
      these Khasras wrongly. The total is the sum of the individual values, each
      already worked out in rupees.
    </div></div>`);
  }

  if (!b.running && !b.error && unrated.length) {
    // Counted against the Khasras actually looked up, not the Khasras selected.
    // "1 of 377 have no rate" would blame the data for 177 parcels nobody asked
    // about, which is a different and much less alarming claim.
    const looked = rated.length + unrated.length;
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>${nUnrated} of the ${looked.toLocaleString()} Khasras looked up
      ${unrated.length === 1 ? "has" : "have"} no published rate.</strong>
      The portal returned no DC figure for ${unrated.length === 1 ? "it" : "them"}.
      That is a fact about the published data, not a failure here — the
      ${unrated.length === 1 ? "area is" : "areas are"} shown, the
      ${unrated.length === 1 ? "value is" : "values are"} left blank rather than
      guessed, and the total covers only the ${nRated} that could be priced.
    </div></div>`);
  }

  if (!b.running && !b.error && !rated.length && !unrated.length) {
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>No Khasras were priced.</strong> Nothing came back for this
      selection.
    </div></div>`);
  }

  host.innerHTML = hero + metrics + notices.join("\n");
  renderBatchRows();
}

function cap() {
  return (window.LiveRates && window.LiveRates.MAX_BATCH) || 0;
}

/**
 * Draw the batch table body in the current sort order.
 *
 * Khasra sorts by the same numeric rule as the picker, so "1807/1" lands next
 * to "1807" rather than at the end. Everything else sorts on its number, not on
 * its formatted string -- sorting "9,000" against "10,000" as text would put
 * the smaller value last. Rows with no rate keep their place at the end rather
 * than being treated as zero, because zero is a rate and they have none.
 */
function renderBatchRows() {
  const b = state.multi.batch;
  const body = $("batch-rows");
  if (!b || !body) return;

  const s = state.multi.sort || { key: null, dir: 1 };
  let rows = b.rows.slice();

  if (b.running && !rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="cell-note">${
      esc(`Asking the Punjab e-Stamp portal about ${b.requested.toLocaleString()} Khasras…`)}</td></tr>`;
    return;
  }

  if (s.key) {
    const dir = s.dir;
    const nullsLast = s.key !== "khasra";
    rows.sort((x, y) => {
      let d;
      if (s.key === "khasra") {
        const kx = khasraSortKey(x.khasra), ky = khasraSortKey(y.khasra);
        d = kx[0] - ky[0] || kx[1] - ky[1] ||
            (x.khasra < y.khasra ? -1 : x.khasra > y.khasra ? 1 : 0);
      } else {
        const key = s.key === "value" ? "value" : "rate";
        const xv = x[key], yv = y[key];
        if (nullsLast && (xv === null || xv === undefined)) return 1;
        if (nullsLast && (yv === null || yv === undefined)) return -1;
        d = (xv ?? 0) - (yv ?? 0);
      }
      return d * dir;
    });
  }

  const cell = (r) => {
    if (!r.found) {
      return `<td class="num cell-none">No published rate</td>
              <td class="num cell-none">&mdash;</td>`;
    }
    return `<td class="num">${money(r.rate)} <small>per ${esc(AREA_LABELS[r.unit] || r.unit)}</small></td>
            <td class="num">${money(r.value)}</td>`;
  };

  body.innerHTML = rows.map((r, i) => `<tr>
    <td class="num">${(i + 1).toLocaleString()}</td>
    <td class="mono">${esc(r.khasra)}</td>
    <td class="num">${nf.format(b.area)} <small>${esc(AREA_LABELS[b.areaUnit] || b.areaUnit)}</small></td>
    ${cell(r)}
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
  // Every Khasra carries its own rate, so the rate and value columns are always
  // present. A Khasra with no published rate gets an empty rate and value, which
  // is visibly missing data rather than a zero that would read as "worthless".
  const tailCols = ["area_in_rate_unit", "rate", "rate_unit", "khasra_value",
                    "total_sqft", "implied_per_sqft"];
  const lines = [lead.concat(tailCols).join(",")];
  for (const r of b.rows) {
    lines.push([
      r.khasra, b.district, b.tehsil, b.qanoongo, b.mouza, b.classification,
      b.location, b.area, b.areaUnit,
      r.found ? r.inRate : "", r.found ? r.rate : "", r.found ? r.unit : "",
      r.found ? r.value : "", r.found ? r.totalSqft : "", r.found ? r.impliedPerSqft : "",
    ].map(q).join(","));
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
  a.download = "chakwal-khasra-values.csv";
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
  el.areaValue.value = "1";
  el.areaUnit.value = "Marla";
  resetRural();
  resetUrban();
  updateConversionPreview();
  showRate("idle", null, null, "");
  setStatus("", false);
}

function init() {
  // Unit dropdowns, from the same list the server uses. Only the area has a
  // unit now -- the rate's unit comes from the portal, which is the whole
  // reason it cannot be a dropdown.
  fill(el.areaUnit, AREA_UNITS.map((u) => ({ id: u, name: AREA_LABELS[u] || u })), { placeholder: "" });
  el.areaUnit.value = "Marla";

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
  for (const s of [el.areaUnit, el.acreToKanal, el.marlaToSqft]) {
    s.addEventListener("change", updateConversionPreview);
  }

  // A rejected field stops looking rejected as soon as it is edited, rather
  // than staying ringed in red next to a value that is now fine.
  for (const f of [el.areaValue, el.khasra, el.mouza,
                   el.landClassification, el.location, el.town,
                   el.revenueCircle, el.propertyArea]) {
    f.addEventListener("input", clearBadFields);
    f.addEventListener("change", clearBadFields);
  }
  el.resetBtn.addEventListener("click", resetAll);
  el.form.addEventListener("submit", (e) => { e.preventDefault(); renderResult(); });

  // --- the rate is looked up, not typed. Every control that can change which
  // --- parcel the form points at re-asks for it. scheduleRate() is debounced,
  // --- so working down the dropdowns costs one request for the finished chain
  // --- rather than one per click, and one per keystroke in the Khasra box.
  for (const f of [el.qanoongo, el.mouza, el.landClassification, el.location,
                   el.khasra, el.town, el.revenueCircle, el.floor,
                   el.propertyArea]) {
    f.addEventListener("change", scheduleRate);
    f.addEventListener("input", scheduleRate);
  }

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
  // The two builds differ in exactly one respect here: the offline copy cannot
  // reach the portal at all, while the desktop copy can. Saying "cannot reach
  // it" in a build that just fetched a rate from it would be plainly wrong, so
  // the last sentence follows the build rather than being hardcoded.
  const reach = window.__DESKTOP__
    ? `No rate is stored anywhere — the portal is the only source, and this app ` +
      `reads from it live each time you ask.`
    : `No rate is stored anywhere — the portal is the only source, and this build ` +
      `cannot reach it.`;
  el.refreshNote.textContent =
    `Reference lists bundled: ${REFERENCE.districts.length} districts, ` +
    `${REFERENCE.mouzas.length} mouzas, ${combos} classification/location lists ` +
    `(read from the official portal on ${REFERENCE.generated.replace("T", " ")}). ` +
    reach;
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
