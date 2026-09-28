/*
 * app.js - DC Rate Finder front end.
 *
 * Unofficial, read-only helper. Talks only to this app's own local backend,
 * which reads public lookups from the official Punjab e-Stamping portal.
 *
 * Chain shapes differ by land type, because the portal rates them differently:
 *
 *   rural  District > Tehsil > Qanoongoee > Mouza > Classification > Location
 *           > [ Khasra | Square+Qila ]
 *   urban  District > Tehsil > Town > Revenue Circle > Floor > Property Area
 *           > [ Khasra | Square+Qila | none ] > Classification > Location
 *
 * Which bracket applies is reported by the portal per parcel, not guessed.
 */
"use strict";

/* ------------------------------------------------------------------ state */

const state = {
  landType: "rural",
  parcelPath: null,        // "khasra" | "qila" | "area" | null
  pathIsChoice: false,     // parcel can be rated either way; user picks
  mouzaMeta: new Map(),    // mouzaId -> { hasKhasra, hasSquare }
  allMouzas: [],           // every mouza in the tehsil, with its qanoongoee
  qgAuto: false,           // true when the Qanoongoee was set by the Mouza pick
  squareMeta: new Map(),   // "name" -> { id }  (urban qila lookup needs the id)
  district: { id: null, name: "" },   // fixed by the backend, not chosen here
  tehsil: { id: null, name: "" },     // ditto -- one tehsil, both chains kept
  units: { area_units: ["Acre", "Kanal", "Marla", "SqFt"] },
  templates: {},
  // anchor = the Khasra a shift-click range extends from, stored by value so
  // that changing the filter cannot make it point at the wrong chip.
  multi: { list: [], selected: new Set(), anchor: null, filter: "", open: false,
           chips: new Map() },
  batch: null,                        // last bulk result, kept for export/sort
  // True when the backend runs somewhere without a persistent process (EdgeOne
  // Cloud Functions, Lambda). Queued bulk runs and the nightly list refresh are
  // both unavailable there, so the page must not offer them.
  serverless: false,
};

const $ = (id) => document.getElementById(id);

const el = {
  town: $("town"), revenueCircle: $("revenue-circle"),
  floor: $("floor"), propertyArea: $("property-area"),
  qanoongo: $("qanoongo"), mouza: $("mouza"),
  qanoongoNote: $("qanoongo-note"),
  mouzaSearch: $("mouza-search"), mouzaSearchNote: $("mouza-search-note"),
  landClassification: $("land-classification"), location: $("location"),
  khasra: $("khasra"), squareNo: $("square-no"), qilaNo: $("qila-no"),
  areaValue: $("area-value"), areaUnit: $("area-unit"),
  acreToKanal: $("acre-to-kanal"), marlaToSqft: $("marla-to-sqft"),
  convOut: $("conv-out"),
  refreshNote: $("refresh-note"), refreshNow: $("refresh-now"),
  status: $("status"), findBtn: $("find-btn"),
  resultCard: $("result-card"), resultBody: $("result-body"),
  flow: $("flow"),
  blockScope: $("block-scope"),
  blockClassification: $("block-classification"),
  blockParcel: $("block-parcel"),
  urbanScope: $("urban-scope"), ruralScope: $("rural-scope"),
  parcelHint: $("parcel-hint"), parcelChoice: $("parcel-choice"),
  parcelKhasra: $("parcel-khasra"), parcelQila: $("parcel-qila"),
  parcelNone: $("parcel-none"),
  districtBadge: $("district-badge"),
  urbanCoverageNote: $("urban-coverage-note"),
  // Multi-Khasra picker
  multi: $("khasra-multi"), multiToggle: $("multi-toggle"),
  multiPanel: $("multi-panel"), multiFilter: $("multi-filter"),
  multiAll: $("multi-all"), multiNone: $("multi-none"),
  multiGrid: $("multi-grid"), multiCount: $("multi-count"),
  multiTrunc: $("multi-trunc"), multiRun: $("multi-run"),
  multiClose: $("multi-close"), multiSummary: $("multi-summary"),
};

const isUrban = () => state.landType === "urban";

// Display labels for the canonical unit keys the backend speaks.
const AREA_LABELS = {
  Acre: "Acre",
  Kanal: "Kanal",
  Marla: "Marla",
  SqFt: "sq ft",
};

/* ------------------------------------------------------------- formatting */

const nf = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 4 });
const money = (n) => (n === null || n === undefined ? "—" : "Rs. " + nf.format(n));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const val = (sel) => (sel.value ? sel.value : "");
const text = (sel) => (sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "");

/* ------------------------------------------------------------------- http */

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = (data && (data.detail || data.Message)) || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

/**
 * Spinner/disabled state only. Deliberately does not touch the message, so
 * an error set by fail() survives the end of a request.
 */
function setBusy(on) {
  el.findBtn.disabled = on;
  el.status.className = on ? "status busy" : (el.status.classList.contains("err") ? "status err" : "status");
  if (on) el.status.textContent = "Working…";
}

function setStatus(message, isError) {
  el.status.className = isError ? "status err" : "status";
  el.status.textContent = message || "";
}

/** Busy state for a cascade step: clears the message when it finishes. */
function busy(on, message) {
  if (on) {
    setBusy(true);
    if (message) el.status.textContent = message;
  } else {
    setBusy(false);
    setStatus("", false);
  }
}

function fail(err) {
  setStatus(err && err.message ? err.message : String(err), true);
}

/** Empty select values must reach the API as null, not "" (422 otherwise). */
const num = (sel) => (sel.value === "" ? null : sel.value);

const qs = (obj) => new URLSearchParams(
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v !== null && v !== undefined))
).toString();

/* ------------------------------------------------------------ select fill */

/**
 * Populate a <select> from an API list.
 *
 * `valueKey` is "id" for lists the API is queried by id, and "name" for the
 * two the API is queried by name (rural Location, Town).
 *
 * This is not a theoretical concern: the portal returns Id 0 for every rural
 * Location row in Chakwal (176/176), and 403 of 528 Location lists hold two
 * or more such rows. Keyed on the id alone, "Link Road" and "Off Road" become
 * the same option value and the select silently reports whichever came
 * first -- so asking for a rate in Off Road returns the Link Road rate, with
 * no error anywhere. Name-keying fixes that; for the id-keyed lists, which
 * were checked and do have distinct ids, an unusable id means the list is
 * refused outright rather than rendered wrong.
 */
function fill(sel, items, { placeholder = "Select…", valueKey = "id" } = {}) {
  const list = items || [];
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  sel.appendChild(ph);

  const used = new Set();
  const built = [];
  let unusable = 0;

  for (const item of list) {
    const name = String(item.name);
    const id = item.id === null || item.id === undefined ? "" : String(item.id);
    const value = valueKey === "name" ? name : (id && id !== "0" ? id : "");
    if (!value || used.has(value)) { unusable++; continue; }
    used.add(value);
    built.push({ value, name });
  }

  for (const { value, name } of built) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = name;
    sel.appendChild(opt);
  }

  sel.value = "";
  sel.disabled = built.length === 0;
  // Stashed on the element because callers routinely follow fill() with their
  // own noteEmpty(sel, ""), which would otherwise wipe the reason.
  delete sel.dataset.unusableNote;

  if (unusable) {
    // Two rows sharing an option value is a <select> that cannot tell them
    // apart, and picking the second silently means the first. Say so rather
    // than hand back a plausible wrong answer.
    sel.disabled = true;
    sel.dataset.unusableNote =
      `The official portal gave no usable identifier for ${unusable} of these ` +
      `${list.length} options, so they cannot be listed without risking the ` +
      "wrong one being sent. Choose a different step above, or confirm the " +
      "selection on the official portal.";
    noteEmpty(sel, sel.dataset.unusableNote);
  } else {
    // A list that came back usable again must not inherit the last one's
    // warning. The dataset is already cleared above, so this really clears.
    noteEmpty(sel, "");
  }
  return sel;
}

/* ----------------------------------------------- "nothing here" explanations */

/**
 * Attach a short note under a select explaining why it is empty, or clear it.
 * An empty dropdown is ambiguous on its own -- it reads the same whether the
 * request is still in flight, failed, or the portal genuinely has no rows.
 */
function noteEmpty(sel, message) {
  const field = sel.closest(".field") || sel.parentElement;
  if (!field) return;
  const existing = field.querySelector(".empty-note");
  // A list held back for unusable identifiers is not an empty list, and the
  // reason for it must survive the noteEmpty(sel, "") that callers use to
  // clear their own notes.
  if (!message && sel.dataset && sel.dataset.unusableNote) {
    message = sel.dataset.unusableNote;
  }
  if (!message) { if (existing) existing.remove(); return; }
  const note = existing || document.createElement("p");
  note.className = "empty-note";
  note.textContent = message;
  if (!existing) field.appendChild(note);
}

const EMPTY_LOCATION = {
  urban:
    "No locations are recorded on the official portal for this property area " +
    "and land classification. This is a gap in the portal's own data, not a " +
    "tool error - most Chakwal urban property areas are in this state. Try a " +
    "different land classification, or confirm on the official DC Valuation page.",
  rural:
    "No locations are recorded on the official portal for this land " +
    "classification in this mouza. Try a different land classification.",
};

function fillDatalist(id, values) {
  const dl = $(id);
  dl.innerHTML = "";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    dl.appendChild(opt);
  }
}

/* -------------------------------------------------------- flow management */

/** Rural rates by parcel after classification; urban rates by parcel before. */
function reorderFlow() {
  const { blockScope, blockClassification, blockParcel, flow } = el;
  if (isUrban()) flow.append(blockScope, blockParcel, blockClassification);
  else flow.append(blockScope, blockClassification, blockParcel);
}

function hideParcelBlock() {
  state.parcelPath = null;
  state.pathIsChoice = false;
  el.blockParcel.classList.add("hidden");
  el.parcelChoice.classList.add("hidden");
  el.parcelHint.classList.add("hidden");
  el.parcelKhasra.classList.add("hidden");
  el.parcelQila.classList.add("hidden");
  el.parcelNone.classList.add("hidden");
  el.khasra.disabled = true;
  el.squareNo.disabled = true;
  el.qilaNo.disabled = true;
  fillDatalist("khasra-options", []);
  fillDatalist("square-options", []);
  fillDatalist("qila-options", []);
  state.squareMeta.clear();
  resetMulti();
}

function clearParcelInputs() {
  el.khasra.value = "";
  el.squareNo.value = "";
  el.qilaNo.value = "";
}

/**
 * Show the right parcel inputs and enable them only once we can offer
 * suggestions (rural needs a Location; urban needs a Property Area).
 */
async function renderParcelBlock() {
  if (!state.parcelPath) { hideParcelBlock(); return; }

  el.blockParcel.classList.remove("hidden");

  const showChoice = state.pathIsChoice;
  el.parcelChoice.classList.toggle("hidden", !showChoice);
  el.parcelHint.classList.toggle("hidden", !showChoice);

  if (state.parcelPath === "area") {
    el.parcelKhasra.classList.add("hidden");
    el.parcelQila.classList.add("hidden");
    el.parcelNone.classList.remove("hidden");
    el.khasra.disabled = true;
    el.squareNo.disabled = true;
    el.qilaNo.disabled = true;
    return;
  }

  el.parcelNone.classList.add("hidden");
  el.parcelKhasra.classList.toggle("hidden", state.parcelPath !== "khasra");
  el.parcelQila.classList.toggle("hidden", state.parcelPath !== "qila");

  // Rural parcel numbers depend on the chosen Location.
  const ready = isUrban() ? !!el.propertyArea.value : !!el.location.value;
  el.khasra.disabled = !ready || state.parcelPath !== "khasra";
  el.squareNo.disabled = !ready || state.parcelPath !== "qila";
  el.qilaNo.disabled = !ready || state.parcelPath !== "qila";

  if (ready) await loadParcelSuggestions();
  else {
    fillDatalist("khasra-options", []);
    fillDatalist("square-options", []);
    fillDatalist("qila-options", []);
  }
}

function setPathChoiceButtons(active) {
  for (const btn of el.parcelChoice.querySelectorAll(".seg-btn")) {
    const on = btn.dataset.path === active;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-checked", String(on));
  }
}

/* ------------------------------------------------------ suggestion loading */

async function loadParcelSuggestions() {
  busy(true, "Loading parcel numbers…");
  try {
    if (state.parcelPath === "khasra") {
      const khasras = await fetchKhasras();
      fillDatalist("khasra-options", khasras.map((i) => i.name));
      resetMulti(khasras.map((i) => i.name));
    } else if (state.parcelPath === "qila") {
      const squares = await fetchSquareNos();
      state.squareMeta.clear();
      for (const s of squares) state.squareMeta.set(s.name, s);
      fillDatalist("square-options", squares.map((i) => i.name));
      fillDatalist("qila-options", []);
    }
  } catch (e) {
    fail(e);
  } finally {
    busy(false);
  }
}

function fetchKhasras() {
  if (isUrban()) {
    return api(`/api/urban/khasras?${qs({
      tehsilId: state.tehsil.id, town: text(el.town),
      revenueCircleId: el.revenueCircle.value, propertyAreaId: el.propertyArea.value,
    })}`);
  }
  return api(`/api/rural/khasras?${qs({
    mouzaId: el.mouza.value, qanoongoId: el.qanoongo.value, mouzaName: text(el.mouza),
    landClassificationId: val(el.landClassification), location: text(el.location),
  })}`);
}

function fetchSquareNos() {
  if (isUrban()) {
    return api(`/api/urban/square-nos?${qs({
      tehsilId: state.tehsil.id, town: text(el.town),
      revenueCircleId: el.revenueCircle.value, propertyAreaId: el.propertyArea.value,
    })}`);
  }
  return api(`/api/rural/square-nos?${qs({
    mouzaId: el.mouza.value, qanoongoId: el.qanoongo.value, mouzaName: text(el.mouza),
    landClassificationId: val(el.landClassification), location: text(el.location),
  })}`);
}

async function loadQilaSuggestions() {
  const square = el.squareNo.value.trim();
  fillDatalist("qila-options", []);
  if (!square) return;

  busy(true, "Loading qila numbers…");
  try {
    let qilas;
    if (isUrban()) {
      const match = state.squareMeta.get(square);
      if (!match) return;
      qilas = await api(`/api/urban/qila-nos?${qs({
        tehsilId: state.tehsil.id, town: text(el.town),
        revenueCircleId: el.revenueCircle.value,
        propertyAreaId: el.propertyArea.value, squareNoId: match.id,
      })}`);
    } else {
      qilas = await api(`/api/rural/qila-nos?${qs({
        mouzaId: el.mouza.value, qanoongoId: el.qanoongo.value, mouzaName: text(el.mouza),
        landClassificationId: val(el.landClassification), location: text(el.location),
        squareNo: square,
      })}`);
    }
    fillDatalist("qila-options", qilas.map((i) => i.name));
  } catch (e) {
    fail(e);
  } finally {
    busy(false);
  }
}

/** Urban narrows the classification list once a parcel identifier is known. */
async function reloadUrbanClassifications() {
  if (!isUrban() || !el.propertyArea.value) return;

  const match = state.squareMeta.get(el.squareNo.value.trim());
  busy(true, "Loading land classifications…");
  try {
    const list = await api(`/api/urban/land-classifications?${qs({
      tehsilId: state.tehsil.id, town: text(el.town),
      revenueCircleId: el.revenueCircle.value, propertyAreaId: el.propertyArea.value,
      propertyAreaName: text(el.propertyArea),
      khasraNo: state.parcelPath === "khasra" ? el.khasra.value.trim() : "",
      squareNoId: state.parcelPath === "qila" ? (match ? match.id : "") : "",
      qilaNo: state.parcelPath === "qila" ? el.qilaNo.value.trim() : "",
    })}`);
    fill(el.landClassification, list);
    fill(el.location, []);
    noteEmpty(el.location, "");
  } catch (e) {
    fail(e);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------- multi-Khasra picker */

// No limit on how many Khasras may be picked. The server issues the lookups a
// few at a time, and caches each rate for five minutes, so a big selection is
// slow rather than abusive. BATCH_CEILING in app.py is only a guard against a
// malformed request; it sits above the largest list in the tehsil (8,768) so
// that "select everything" works on the biggest mouza.
const BATCH_CEILING = 12000;

// A run this size takes about a minute of sustained requests to a government
// server, so say so before starting rather than after.
const BIG_RUN_WARN = 500;

// Above this many Khasras the run is queued on the server and polled rather
// than held open in one request. Set at the same size as BIG_RUN_WARN so that
// any run worth confirming about is also a run that survives a hosting proxy's
// request timeout.
const ASYNC_ABOVE = 500;

// Every Khasra list in the tehsil is shown in full: the largest measured is
// 8,768 (Padshahan / Residential / Link Road), and rendering that many buttons
// costs well under a frame budget's worth of attention, so a cap would only
// hide data the user is entitled to see. This is a runaway guard, not a
// display limit -- the real bound is BATCH_CEILING.
const CHIP_RENDER_CAP = 10000;

/**
 * Sort Khasra numbers the way a person reads them.
 *
 * The portal hands them back in no useful order (3785, 4071, 4073, 3120, 855, 20,
 * ...), which makes a list of a thousand impossible to scan. Almost all are plain
 * integers -- 37,797 of a 37,806 sample -- but a handful carry a subdivision
 * ("1807/1", "2047/55"), and those belong next to their parent number rather
 * than at the very end. Comparing as text would put "20" after "1998", so this
 * splits on the slash and compares the two halves numerically.
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

function resetMulti(list) {
  state.multi.list = sortKhasras(list || []);
  state.multi.selected = new Set();
  state.multi.anchor = null;
  state.multi.filter = "";
  state.multi.open = false;
  state.batch = null;
  el.multiFilter.value = "";
  el.multiPanel.hidden = true;
  // Only worth offering when there is a choice to make. Chakwal's urban PAs
  // report a single Khasra at most, so this stays hidden there.
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
    ? `${n} Khasra${n === 1 ? "" : "s"} selected.`
    : `${state.multi.list.length} Khasras available here.`;
}

function updateMultiCount(matching) {
  const n = state.multi.selected.size;
  el.multiCount.innerHTML = `<strong>${n}</strong> selected of ${matching}`;
  el.multiRun.disabled = n === 0;
  el.multiRun.textContent = n
    ? `Find rates for ${n} Khasra${n === 1 ? "" : "s"}`
    : "Find rates for selected";
  updateMultiSummary();
}

function renderKhasraGrid() {
  const matching = filteredKhasras();
  const shown = matching.slice(0, CHIP_RENDER_CAP);

  el.multiGrid.innerHTML = shown.map((k) => {
    const on = state.multi.selected.has(k);
    return `<button type="button" class="chip${on ? " is-on" : ""}` +
      `${k === state.multi.anchor ? " is-anchor" : ""}"` +
      ` data-khasra="${esc(k)}" aria-pressed="${on}">${esc(k)}</button>`;
  }).join("");

  // Index the rendered chips so a click repaints only what changed. With
  // thousands of chips on screen, rewriting every one of them per click is the
  // difference between instant and visibly laggy.
  state.multi.chips = new Map();
  for (const chip of el.multiGrid.querySelectorAll(".chip")) {
    state.multi.chips.set(chip.dataset.khasra, chip);
  }

  el.multiTrunc.hidden = matching.length <= shown.length;
  if (!el.multiTrunc.hidden) {
    // Only reachable past CHIP_RENDER_CAP, which is above the largest list in
    // the tehsil, so in practice this never shows.
    el.multiTrunc.textContent =
      `Showing the first ${shown.length} of ${matching.length} matches. ` +
      "Type in the filter box to narrow the list.";
  }

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
      setStatus("", false);
    } else {
      const add = span.filter((k) => !chosen.has(k));
      const room = BATCH_CEILING - chosen.size;
      if (room <= 0) {
        setStatus(
          `${chosen.size} Khasras is more than any mouza here holds. Clear the ` +
          "selection and start again.", true);
        return;
      }
      for (const k of add.slice(0, room)) chosen.add(k);
      setStatus("", false);
    }
  } else {
    touched = [number];
    if (chosen.has(number)) {
      chosen.delete(number);
    } else {
      if (chosen.size >= BATCH_CEILING) {
        setStatus(
          `${chosen.size} Khasras is more than any mouza here holds. Clear the ` +
          "selection and start again.", true);
        return;
      }
      chosen.add(number);
    }
    // A plain click re-aims the sweep. The old anchor's ring has to come off,
    // so it is repainted even though its selection did not change.
    if (state.multi.anchor && state.multi.anchor !== number) {
      touched.push(state.multi.anchor);
    }
    // Stored by value, and dropped if the filter has since hidden it, so a
    // later shift-click can't sweep nothing.
    state.multi.anchor = visible.includes(number) ? number : null;
    setStatus("", false);
  }

  for (const k of touched) paintChip(k);
  updateMultiCount(visible.length);
}

/** Repaint one chip from state, or every rendered chip when given nothing. */
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
  if (already) {
    setStatus(`${already} of those were already selected.`, false);
  }
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

async function runBatch() {
  const numbers = sortKhasras([...state.multi.selected]);
  if (!numbers.length) return;

  // Same context requirements as a single lookup, minus the single-Khasra
  // field, which a bulk run deliberately does not use.
  const problem = validate(true);
  if (problem) { fail(new Error(problem)); return; }

  // The portal has no bulk endpoint, so this is one request per Khasra. At the
  // measured rate that is ~134/second, so a big selection is a real, visible
  // load on a government server. Say what it costs before committing to it.
  if (numbers.length > BIG_RUN_WARN) {
    const secs = Math.round(numbers.length / 134);
    const mins = Math.floor(secs / 60);
    const wait = mins
      ? `about ${mins} minute${mins === 1 ? "" : "s"}`
      : `about ${secs} second${secs === 1 ? "" : "s"}`;
    // On a normal host an oversized run is handed to the queue and polled, so
    // it can outlive any proxy. Where there is no queue the whole run has to
    // finish inside one request, and the platform kills it at 120s -- with no
    // partial result. That is worth saying before the user commits to a wait.
    const limit = state.serverless
      ? "\n\nNote: this deployment has no background queue, so the whole run " +
        "must finish inside a single 120-second request. If the platform cuts " +
        "it off you get no rows back at all, so a smaller selection is safer."
      : "";
    if (!confirm(
      `This sends ${numbers.length} separate lookups to the official portal — ` +
      `${wait}, four at a time.${limit}\n\nRun it anyway?`
    )) return;
  }

  setBusy(true);

  // A long run is slow by nature: the portal has no bulk endpoint, so this is
  // one request per Khasra no matter how it is arranged. Measured: 1,376 Khasras
  // in ~10s cold, ~0.1s warm; 8,768 extrapolates to ~65s cold.
  //
  // That last figure is why a big run does not use a single request. Hosting
  // platforms cut connections off well before a minute (nginx 60s, Render 100s),
  // so a synchronous 8,768-Khasra batch dies as a gateway timeout even though
  // the server is doing the work perfectly. Past ASYNC_ABOVE the run is handed
  // to a server-side job and polled, so it survives any proxy timeout and can
  // report real progress instead of a spinner.
  const noun = `Khasra${numbers.length === 1 ? "" : "s"}`;
  const started = Date.now();
  el.status.textContent = `Starting ${numbers.length} ${noun}…`;

  let lastDone = 0;
  const tick = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const progress = lastDone
      ? ` — ${lastDone.toLocaleString()} of ${numbers.length.toLocaleString()} done`
      : "";
    el.status.textContent =
      `Looking up ${numbers.length} ${noun} on the official portal, a few at a ` +
      `time — ${secs}s so far${progress}…`;
  };
  const ticker = setInterval(tick, 1000);

  try {
    const body = JSON.stringify({ ...buildRequest(), save: false, khasras: numbers });
    // Queue only where the server can actually keep a job. A queued run lives in
    // one process's memory; on a serverless deployment the status poll would be
    // answered by a different instance that has never heard of it. The server
    // advertises this via /api/scope, so ask rather than guess.
    const useQueue = numbers.length > ASYNC_ABOVE && !state.serverless;
    const result = useQueue
      ? await pollBatchJob(body, numbers.length, (done) => { lastDone = done; tick(); })
      : await api("/api/rates/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
    renderBatchResult(result);
    setStatus("", false);
  } catch (e) {
    fail(e);
  } finally {
    clearInterval(ticker);
    setBusy(false);
  }
}

/**
 * Hand a bulk run to the server and poll until it finishes.
 *
 * The progress poll asks for no results (`results=false`), because re-sending
 * an 8,768-row payload on every tick would be megabytes of JSON for nothing.
 */
async function pollBatchJob(body, total, onProgress) {
  const { job_id: jobId } = await api("/api/rates/batch/async", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  for (let i = 0; i < 7200; i++) {
    const job = await api(`/api/rates/batch/async/${jobId}?results=false`);
    if (job.status === "done") {
      return api(`/api/rates/batch/async/${jobId}?results=true`);
    }
    if (job.status === "error") throw new Error(job.error || "The bulk run failed.");
    if (job.status === "cancelled") throw new Error("The bulk run was cancelled.");
    onProgress(job.done);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Still running after two hours. The job is ${jobId} and will be kept for ` +
    "30 minutes after it finishes."
  );
}

/* ------------------------------------------------------- batch result view */

const BATCH_COLUMNS = [
  { key: "khasra", label: "Khasra", num: true, get: (r) => r.khasra,
    // Khasra numbers are text, so the default text compare would put "10"
    // straight after "1". Reuse the picker's key so a number reads as a number.
    cmp: (a, b) => {
      const ka = khasraSortKey(a);
      const kb = khasraSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || String(a).localeCompare(String(b));
    } },
  { key: "rate", label: "DC rate", num: true, get: (r) => (r.found ? r.value.rate : null) },
  { key: "unit", label: "Unit", get: (r) => (r.found ? r.value.rate_unit : "") },
  { key: "total", label: "DC value", num: true, get: (r) => (r.found ? r.value.total : null) },
  { key: "sqft", label: "Per sq ft", num: true, get: (r) => (r.found ? r.value.implied_per_sqft : null) },
];

function sortBatchResults() {
  const col = BATCH_COLUMNS.find((c) => c.key === state.batch.sort.key);
  if (!col) return;
  const sign = state.batch.sort.dir === "asc" ? 1 : -1;
  const blank = (v) => v === null || v === undefined || v === "";
  state.batch.results = [...state.batch.results].sort((x, y) => {
    const a = col.get(x), b = col.get(y);
    const ab = blank(a), bb = blank(b);
    // Unrated Khasras have no number to compare, so park them at the bottom
    // whichever way the column is sorted.
    if (ab && bb) return 0;
    if (ab) return 1;
    if (bb) return -1;
    if (col.cmp) return col.cmp(a, b) * sign;
    if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
    return String(a).localeCompare(String(b)) * sign;
  });
}

function batchTableHtml() {
  const head = BATCH_COLUMNS.map((c) => {
    const on = state.batch.sort.key === c.key;
    const cls = ["sortable", on ? state.batch.sort.dir : ""].filter(Boolean).join(" ");
    return `<th class="${cls}" data-sort="${c.key}">${esc(c.label)}</th>`;
  }).join("");

  const body = state.batch.results.map((r) => {
    if (!r.found) {
      const why = r.error === "no_rate"
        ? "No rate published for this Khasra"
        : (r.error || "Lookup failed");
      return `<tr class="is-unrated" title="${esc(why)}">
        <td class="num">${esc(r.khasra)}</td>
        <td class="num">—</td><td>—</td><td class="num">—</td><td class="num">—</td>
      </tr>`;
    }
    const v = r.value;
    return `<tr>
      <td class="num">${esc(r.khasra)}</td>
      <td class="num">${money(v.rate)}</td>
      <td>${esc(v.rate_unit)}</td>
      <td class="num">${money(v.total)}</td>
      <td class="num">${money(v.implied_per_sqft)}</td>
    </tr>`;
  }).join("");

  return `<div class="table-wrap"><table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function wireBatchSorting() {
  for (const th of el.resultBody.querySelectorAll("th[data-sort]")) {
    th.onclick = () => {
      const key = th.dataset.sort;
      const sort = state.batch.sort;
      sort.dir = sort.key === key && sort.dir === "asc" ? "desc" : "asc";
      sort.key = key;
      sortBatchResults();
      $("batch-table-slot").innerHTML = batchTableHtml();
      wireBatchSorting();
    };
  }
}

function batchCsv() {
  const a = state.batch.area;
  const rows = [[
    "khasra", "rated", "rate", "rate_unit", "area", "area_unit",
    "dc_value", "area_in_rate_unit", "total_sqft",
    "implied_per_sqft", "portal_per_sqft", "note",
  ]];
  for (const r of state.batch.results) {
    const v = r.value;
    rows.push([
      r.khasra,
      r.found ? "yes" : "no",
      v ? v.rate : "", v ? v.rate_unit : "",
      a.area, a.area_unit,
      v ? v.total : "", v ? v.area_in_rate_unit : "", v ? v.total_sqft : "",
      v ? v.implied_per_sqft : "", v ? (v.portal_per_sqft ?? "") : "",
      r.error || "",
    ]);
  }
  return rows.map((r) => r.join(",")).join("\r\n");
}

function downloadBatchCsv() {
  // Leading BOM so Excel reads the file as UTF-8 rather than Latin-1.
  const blob = new Blob(["﻿" + batchCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chakwal-dc-rates-${state.batch.results.length}-khasras.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderBatchResult(r) {
  const s = r.summary;
  const a = r.area;
  state.batch = { ...r, sort: { key: "khasra", dir: "asc" } };
  sortBatchResults();

  const trail = [
    state.district.name, state.tehsil.name, text(el.qanoongo), text(el.mouza),
    text(el.landClassification), text(el.location),
  ].filter(Boolean).map((b) => `<b>${esc(b)}</b>`).join(" › ");

  const stats = [
    `<div class="batch-stat"><b>${s.rated}</b><span>of ${s.requested} rated</span></div>`,
    `<div class="batch-stat"><b>${s.distinct_rate_count}</b>` +
      `<span>distinct rate${s.distinct_rate_count === 1 ? "" : "s"}</span></div>`,
    `<div class="batch-stat"><b>${nf.format(a.area)} <small>${esc(a.area_unit)}</small></b>` +
      `<span>area each</span></div>`,
  ];
  if (s.total_value !== null) {
    // The total only means something if every Khasra is the same size, so say
    // what it actually is rather than just "total".
    stats.push(`<div class="batch-stat"><b>${money(s.total_value)}</b>` +
      `<span>total for ${s.rated} &times; ${nf.format(a.area)} ${esc(a.area_unit)}</span></div>`);
  }

  const notices = [];
  if (s.unrated > 0) {
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      <strong>${s.unrated} Khasra${s.unrated === 1 ? "" : "s"} returned no DC rate.</strong>
      The official portal has no rate recorded for those numbers in this
      mouza, classification and location. Either the number is wrong, or the
      parcel is not yet rated here. Nothing has been invented for them.
    </div></div>`);
  }
  if (s.units_differ) {
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      These Khasras are quoted in <strong>different units</strong>, so their DC
      values cannot simply be added. No total is shown.
    </div></div>`);
  } else if (s.all_same_rate) {
    notices.push(`<div class="notice notice-info"><span class="notice-ico">i</span><div>
      All ${s.rated} rated Khasras came back at the same
      <strong>${money(s.min_rate)} per ${esc(s.rate_unit)}</strong>. That is
      normal within one mouza, classification and location — the portal still
      stores and checks the rate per Khasra, so each one was looked up
      individually rather than assumed from its neighbours.
    </div></div>`);
  }
  if (s.distinct_rate_count > 1) {
    // A min/max across mixed units is not a real range, so do not dress it up
    // as one -- just point at the column that is comparable.
    const range = s.units_differ
      ? `Rates differ across the Khasras you picked, and they are quoted in more
         than one unit, so there is no single range. Sort the table by DC rate
         and read the Unit column.`
      : `Rates range from <strong>${money(s.min_rate)}</strong> to
         <strong>${money(s.max_rate)}</strong> per ${esc(s.rate_unit)} across the
         Khasras you picked. Sort the table by DC rate to see the spread.`;
    notices.push(`<div class="notice notice-info"><span class="notice-ico">i</span><div>
      ${range}
    </div></div>`);
  }

  // Same discrepancy the single-parcel view flags: the portal publishes a
  // per-sq-ft rate that often disagrees with its own per-unit rate.
  const skewed = r.results.filter((row) => row.found
    && row.value.portal_per_sqft && row.value.implied_per_sqft
    && Math.abs(row.value.portal_per_sqft - row.value.implied_per_sqft) > 0.5);
  if (skewed.length) {
    const sample = skewed[0].value;
    notices.push(`<div class="notice notice-warn"><span class="notice-ico">!</span><div>
      For ${skewed.length} of these Khasras the portal's own per-sq-ft rate
      (<strong>${money(sample.portal_per_sqft)}</strong>) does not reconcile with
      the per-sq-ft rate implied by its per-${esc((sample.rate_unit || "unit").toLowerCase())}
      figure (<strong>${money(sample.implied_per_sqft)}</strong>). The portal
      reports these as two separate values and does not always reconcile them.
      The table and CSV carry both. Use the official portal's own DC value for
      anything that matters.
    </div></div>`);
  }

  el.resultBody.innerHTML = `
    <p class="path-summary">${trail} › <b>${s.requested} Khasras</b></p>
    <div class="batch-summary">${stats.join("")}</div>
    <div id="batch-table-slot">${batchTableHtml()}</div>
    ${notices.join("")}
    <div class="notice notice-info"><span class="notice-ico">i</span><div>
      Each Khasra rate is a separate lookup against the official portal, fetched
      live, ${s.requested === 1 ? "one at a time" : "a few at a time"} — which is
      why a long list takes a while. Nothing is stored on this machine, so use
      the CSV download to keep the list. Confirm anything legally binding on the
      official portal itself.
    </div></div>
    <div class="actions">
      <button class="btn" type="button" id="batch-csv">Download CSV</button>
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  el.resultCard.hidden = false;
  $("result-handoff").href = handoffUrl();
  $("batch-csv").onclick = downloadBatchCsv;
  $("print-btn").onclick = () => window.print();
  wireBatchSorting();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ------------------------------------------------------------ rural chain */

/**
 * Build the Mouza select from every mouza in the tehsil, grouped under its
 * Qanoongoee. The groups keep the hierarchy visible while letting someone go
 * straight to a mouza without picking a Qanoongoee first, which is the point:
 * Chakwal has 226 mouzas spread over 8 Qanoongoes, and most people know which
 * mouza they want, not which Qanoongoee it sits in.
 *
 * `qgId` narrows the list to one Qanoongoee when the user has chosen one
 * themselves.
 *
 * This cannot use fill(): the owner Qanoongoee has to ride along on each
 * option, and <optgroup> needs the list re-laid-out per group.
 */
function fillMouzas(qgId, query) {
  const q = (query || "").trim().toLowerCase();
  let rows = qgId
    ? state.allMouzas.filter((m) => String(m.qanoongo_id) === String(qgId))
    : state.allMouzas;
  const pool = rows.length;
  if (q) rows = rows.filter((m) => m.name.toLowerCase().includes(q));

  el.mouza.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Select…";
  el.mouza.appendChild(ph);

  // Group order follows the Qanoongoee list, which the portal returns sorted.
  const groups = new Map();
  for (const m of rows) {
    const key = String(m.qanoongo_id);
    if (!groups.has(key)) groups.set(key, { name: m.qanoongo_name, items: [] });
    groups.get(key).items.push(m);
  }

  for (const { name, items } of groups.values()) {
    const group = document.createElement("optgroup");
    // Always show the count: with a search running it is the most useful
    // thing in the label.
    group.label = `${name} (${items.length})`;
    for (const m of items) {
      const opt = document.createElement("option");
      opt.value = String(m.id);
      opt.textContent = m.name;
      // Carried on the element so a Mouza pick can name its own Qanoongoee.
      opt.dataset.qg = String(m.qanoongo_id);
      group.appendChild(opt);
    }
    el.mouza.appendChild(group);
  }

  el.mouza.value = "";
  el.mouza.disabled = rows.length === 0;

  // Say what the search actually did, including the empty case -- a disabled
  // dropdown with no explanation reads as a broken page.
  const hidden = el.mouzaSearchNote;
  if (!q) {
    hidden.hidden = true;
  } else if (!rows.length) {
    hidden.hidden = false;
    hidden.textContent = `No mouza matches “${query.trim()}”.` +
      (qgId ? " Clear the search, or pick a different Qanoongoee." : " Try a shorter spelling.");
  } else if (rows.length < pool) {
    hidden.hidden = false;
    hidden.textContent = `${rows.length} of ${pool} shown.` +
      (rows.length === 1 ? " Pick it below." : "");
  } else {
    hidden.hidden = true;
  }
  return rows.length;
}

/** Adopt a Qanoongoee the user did not pick, and lock the field to match. */
function autoFillQanoongo(qgId, qgName) {
  state.qgAuto = true;
  el.qanoongo.value = String(qgId);
  el.qanoongo.disabled = true;
  el.qanoongoNote.textContent = `${qgName} — set from the Mouza. Pick a Qanoongoee to change it.`;
}

function releaseQanoongo() {
  state.qgAuto = false;
  el.qanoongo.disabled = false;
  el.qanoongoNote.textContent = "Optional — picking a Mouza fills this in for you.";
}

/**
 * Load the next level for the one tehsil this calculator serves. The tehsil is
 * fixed, so there is no tehsil step to wait on -- this just picks between the
 * town list (urban) and the mouza list (rural).
 */
async function loadScopeLevels() {
  hideParcelBlock();
  resetFrom(el.landClassification, el.location);
  resetFrom(isUrban()
    ? [el.town, el.revenueCircle, el.floor, el.propertyArea]
    : [el.qanoongo, el.mouza]);
  if (!isUrban()) releaseQanoongo();
  clearMouzaSearch();
  el.mouzaSearch.disabled = true;

  if (!state.tehsil.id) return;
  busy(true, isUrban() ? "Loading towns…" : "Loading mouzas…");
  try {
    if (isUrban()) {
      fill(el.town, await api(`/api/towns?tehsilId=${state.tehsil.id}`), { valueKey: "name" });
      return;
    }
    // One request for the whole tehsil: the server walks the Qanoongoes
    // concurrently and tags each mouza with the one that owns it.
    const [qgs, mouzas] = await Promise.all([
      api(`/api/qanoongoes?tehsilId=${state.tehsil.id}`),
      api(`/api/mouzas?tehsilId=${state.tehsil.id}`),
    ]);
    fill(el.qanoongo, qgs);
    state.allMouzas = mouzas;
    state.mouzaMeta.clear();
    for (const m of mouzas) {
      state.mouzaMeta.set(String(m.id), {
        hasKhasra: !!m.IS_KHASRA_HIERARCHY,
        hasSquare: !!m.IS_SQUARE_NO_HIERARCHY,
        qanoongoId: m.qanoongo_id,
        qanoongoName: m.qanoongo_name,
      });
    }
    fillMouzas();
    el.mouzaSearch.disabled = false;
  } catch (e) { fail(e); } finally { busy(false); }
}

async function onQanoongoChange() {
  hideParcelBlock();
  resetFrom(el.mouza, el.landClassification, el.location);
  // Choosing a Qanoongoee by hand overrides anything a Mouza set, so hand the
  // field back rather than leaving it disabled and inconsistent.
  if (state.qgAuto) releaseQanoongo();
  clearMouzaSearch();
  if (!el.qanoongo.value) {
    if (state.allMouzas.length) fillMouzas();
    return;
  }
  // The full list is already in hand -- filtering it locally is instant and
  // costs no further portal traffic.
  fillMouzas(el.qanoongo.value);
}

/** Drop any typed search and put the full list back. */
function clearMouzaSearch() {
  el.mouzaSearch.value = "";
  el.mouzaSearchNote.hidden = true;
}

/**
 * Filter the Mouza list as the user types. Runs entirely against the copy
 * already in memory, so it costs no portal traffic however fast they type.
 *
 * A Qanoongoee the user never chose is a side effect of their last Mouza pick,
 * and it locks the list to that one Qanoongoee. Typing a search means they are
 * after something else, so the search is allowed to see the whole tehsil and
 * the lock is released -- otherwise searching for a mouza they know is
 * elsewhere would silently return nothing. A Qanoongoee they *did* choose is
 * respected, and the search narrows within it.
 */
function onMouzaSearch() {
  if (!state.allMouzas.length) return;
  const query = el.mouzaSearch.value.trim();
  if (query && state.qgAuto) {
    releaseQanoongo();
    el.qanoongo.value = "";
  }
  fillMouzas(el.qanoongo.value || null, query);
}

async function onMouzaChange() {
  hideParcelBlock();
  resetFrom(el.landClassification, el.location);
  if (!el.mouza.value) {
    if (state.allMouzas.length) fillMouzas(el.qanoongo.value || null, el.mouzaSearch.value);
    return;
  }

  // Carry the owning Qanoongoee up, so the two steps can never disagree.
  const meta = state.mouzaMeta.get(el.mouza.value);
  const chosen = el.mouza.value;
  if (meta && meta.qanoongoId && el.qanoongo.value !== String(meta.qanoongoId)) {
    const qg = [...el.qanoongo.options].find((o) => o.value === String(meta.qanoongoId));
    if (qg) autoFillQanoongo(qg.value, qg.textContent);
  }

  // The search has done its job now that something is chosen. Clear it and
  // re-lay the list under the Qanoongoee that now owns the choice, so the
  // dropdown agrees with the lock instead of showing a stale filter.
  if (el.mouzaSearch.value.trim()) {
    clearMouzaSearch();
    fillMouzas(el.qanoongo.value || null);
    el.mouza.value = chosen;   // fillMouzas resets the selection
  }

  busy(true, "Loading land classifications…");
  try {
    fill(el.landClassification, await api(`/api/rural/land-classifications?${qs({
      mouzaId: el.mouza.value, qanoongoId: el.qanoongo.value, mouzaName: text(el.mouza),
    })}`));
  } catch (e) { fail(e); } finally { busy(false); }

  // The Mouza's hierarchy flags tell us which identifier rates it.
  state.pathIsChoice = !!(meta.hasKhasra && meta.hasSquare);
  state.parcelPath = state.pathIsChoice ? "khasra" : (meta.hasSquare ? "qila" : "khasra");
  setPathChoiceButtons(state.parcelPath);
  await renderParcelBlock();
}

async function onLandClassificationChange() {
  clearParcelInputs();
  fill(el.location, []);
  noteEmpty(el.location, "");
  if (!el.landClassification.value) return;

  busy(true, "Loading locations…");
  try {
    const list = isUrban()
      ? await api(`/api/urban/locations?${qs({
          tehsilId: state.tehsil.id, town: text(el.town),
          revenueCircleId: el.revenueCircle.value, propertyAreaId: el.propertyArea.value,
          landClassificationId: el.landClassification.value,
          khasraNo: state.parcelPath === "khasra" ? el.khasra.value.trim() : "",
          squareNo: state.parcelPath === "qila" ? el.squareNo.value.trim() : "",
          qilaNo: state.parcelPath === "qila" ? el.qilaNo.value.trim() : "",
        })}`)
      : await api(`/api/rural/locations?${qs({
          mouzaId: el.mouza.value, qanoongoId: el.qanoongo.value, mouzaName: text(el.mouza),
          landClassificationId: el.landClassification.value,
        })}`);
    // The portal gives every rural Location the id 0, so this list is keyed
    // by name -- which is also how the API is queried.
    fill(el.location, list, { valueKey: "name" });
    noteEmpty(el.location, list.length ? "" : EMPTY_LOCATION[isUrban() ? "urban" : "rural"]);
  } catch (e) { fail(e); } finally { busy(false); }
}

async function onLocationChange() {
  clearParcelInputs();
  if (state.parcelPath && !state.pathIsChoice) await renderParcelBlock();
}

/* ------------------------------------------------------------ urban chain */

async function onTownChange() {
  hideParcelBlock();
  resetFrom(el.revenueCircle, el.floor, el.propertyArea, el.landClassification, el.location);
  if (!el.town.value) return;

  busy(true, "Loading revenue circles…");
  try {
    fill(el.revenueCircle, await api(`/api/revenue-circles?${qs({
      tehsilId: state.tehsil.id, town: text(el.town),
    })}`));
  } catch (e) { fail(e); } finally { busy(false); }
}

async function onRevenueCircleChange() {
  hideParcelBlock();
  resetFrom(el.floor, el.propertyArea, el.landClassification, el.location);
  if (!el.revenueCircle.value) return;

  busy(true, "Loading property areas…");
  try {
    const [floors, areas] = await Promise.all([
      api(`/api/floors?revenueCircleId=${el.revenueCircle.value}`),
      api(`/api/property-areas?${qs({
        tehsilId: state.tehsil.id, town: text(el.town),
        revenueCircleId: el.revenueCircle.value,
      })}`),
    ]);
    fill(el.floor, floors, { placeholder: "Any floor" });
    fill(el.propertyArea, areas);
  } catch (e) { fail(e); } finally { busy(false); }
}

async function onPropertyAreaChange() {
  hideParcelBlock();
  resetFrom(el.landClassification, el.location);
  if (!el.propertyArea.value) return;

  busy(true, "Checking how this parcel is rated…");
  try {
    const availability = await api(`/api/urban/availability?${qs({
      tehsilId: state.tehsil.id, town: text(el.town),
      revenueCircleId: el.revenueCircle.value, propertyAreaId: el.propertyArea.value,
    })}`);

    state.pathIsChoice = !!(availability.khasra && availability.square_no);
    state.parcelPath = state.pathIsChoice ? "khasra"
      : availability.khasra ? "khasra"
      : availability.square_no ? "qila"
      : "area";

    setPathChoiceButtons("khasra");
    await renderParcelBlock();

    // "area" basis still needs the classification list.
    if (state.parcelPath === "area") await reloadUrbanClassifications();
  } catch (e) { fail(e); } finally { busy(false); }
}

/* ------------------------------------------------------------- submitting */

function buildRequest() {
  return {
    land_type: state.landType,
    path: state.parcelPath,
    district_id: state.district.id,
    district_name: state.district.name,
    tehsil_name: state.tehsil.name,
    tehsil_id: state.tehsil.id,
    land_classification_name: text(el.landClassification),
    land_classification_id: num(el.landClassification),
    location: text(el.location),
    town: text(el.town),
    floor_id: num(el.floor),
    revenue_circle_id: num(el.revenueCircle),
    property_area_id: num(el.propertyArea),
    property_area_name: text(el.propertyArea),
    mouza_id: num(el.mouza),
    qanoongo_id: num(el.qanoongo),
    mouza_name: text(el.mouza),
    khasra_no: el.khasra.value.trim(),
    square_no: el.squareNo.value.trim(),
    qila_no: el.qilaNo.value.trim(),
    area: Number(el.areaValue.value) || 0,
    area_unit: el.areaUnit.value,
    acre_to_kanal: el.acreToKanal.value,
    marla_to_sqft: el.marlaToSqft.value,
    // Nothing is stored locally any more -- the Saved lookups card is gone.
    save: false,
  };
}

function validate(skipParcelInput) {
  if (!state.tehsil.id) return "Still loading the tehsil — try again in a moment.";
  if (!state.parcelPath) return "Finish the location steps — the rating basis is still unknown.";

  const area = Number(el.areaValue.value);
  if (!area || area <= 0) return "Enter a land area greater than zero.";

  // A bulk run carries its own list of Khasras, so the single-Khasra field
  // stays empty on purpose.
  if (!skipParcelInput && state.parcelPath === "khasra" && !el.khasra.value.trim())
    return "Enter the Khasra number.";
  if (!skipParcelInput && state.parcelPath === "qila") {
    if (!el.squareNo.value.trim()) return "Enter the Square number.";
    if (!el.qilaNo.value.trim()) return "Enter the Qila number.";
  }
  if (isUrban() && state.parcelPath !== "area" && !el.landClassification.value)
    return "Pick a land classification.";
  if (!isUrban() && !el.location.value) return "Pick a location.";
  return null;
}

async function onSubmit(event) {
  event.preventDefault();
  const problem = validate();
  if (problem) { fail(new Error(problem)); return; }

  setBusy(true);
  el.status.textContent = "Asking the official portal…";
  try {
    const result = await api("/api/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest()),
    });
    renderResult(result);
    setStatus("", false);
  } catch (e) {
    fail(e);
  } finally {
    // setBusy (not busy) so any error message from fail() is preserved.
    setBusy(false);
  }
}

/* --------------------------------------------------------------- rendering */

function renderResult(r) {
  const v = r.value;

  const trail = [
    state.district.name, state.tehsil.name,
    isUrban() ? text(el.town) : text(el.qanoongo),
    isUrban() ? text(el.propertyArea) : text(el.mouza),
    text(el.landClassification), text(el.location),
  ].filter(Boolean).map((b) => `<b>${esc(b)}</b>`).join(" › ");

  let html = `<p class="path-summary">${trail} › <b>${esc(r.parcel)}</b></p>`;

  if (!r.found || !v) {
    html += `<div class="notice notice-bad"><span class="notice-ico">!</span><div>${
      esc(r.message || "No DC rate is recorded for this parcel.")
    }</div></div>`;
  } else {
    const unitNote = (v.rate_unit_raw && v.rate_unit_raw !== v.rate_unit)
      ? ` <small>(${esc(v.rate_unit_raw)})</small>` : "";

    // The portal publishes a per-sqft rate as its own field. It does not
    // always equal (marla rate / sq ft per marla), so show both, labelled.
    const sqftRows = [];
    if (v.portal_per_sqft) {
      sqftRows.push(`<div class="metric"><dt>Per sq ft (portal)</dt>
        <dd>${money(v.portal_per_sqft)}</dd></div>`);
    }
    if (v.implied_per_sqft) {
      sqftRows.push(`<div class="metric"><dt>Per sq ft (implied)</dt>
        <dd>${money(v.implied_per_sqft)}</dd></div>`);
    }
    const mismatch = v.portal_per_sqft && v.implied_per_sqft
      && Math.abs(v.portal_per_sqft - v.implied_per_sqft) > 0.5
      ? `<div class="notice notice-warn"><span class="notice-ico">!</span><div>
           The portal's own per-sq-ft rate (${money(v.portal_per_sqft)}) differs from the
           rate implied by its per-${esc(v.rate_unit.toLowerCase())} figure
           (${money(v.implied_per_sqft)}). The portal reports these as separate values and
           does not always reconcile them. Use the official portal's DC value for anything
           that matters.
         </div></div>`
      : "";

    html += `
      <div class="rate-hero-wrap">
        <div class="rate-hero">
          <span class="rate-num">${money(v.rate)}</span>
          <span class="rate-unit">per ${esc(v.rate_unit)}${unitNote}</span>
        </div>
      </div>
      <dl class="metrics">
        <div class="metric"><dt>Your area</dt>
          <dd>${nf.format(v.area)} <small>${esc(v.area_unit)}</small></dd></div>
        <div class="metric"><dt>Converted to rate units</dt>
          <dd>${nf.format(v.area_in_rate_unit)} <small>${esc(v.rate_unit)}</small></dd></div>
        <div class="metric"><dt>That area in sq ft</dt>
          <dd>${nf.format(v.total_sqft)}</dd></div>
        <div class="metric"><dt>DC value</dt><dd>${money(v.total)}</dd></div>
        ${sqftRows.join("")}
      </dl>
      ${mismatch}
      <div class="notice notice-info"><span class="notice-ico">i</span><div>
        Saved to your local history. The DC value above is this tool multiplying the
        official rate by your area — the portal keeps its signed DC value encrypted for
        challan use, so it cannot be read outside a transaction. Confirm anything
        legally binding on the official portal.
      </div></div>`;
  }

  html += `<div class="actions">
      <a class="btn" id="result-handoff" target="_blank" rel="noopener noreferrer"
         href="#">Open official DC Valuation</a>
      <button class="btn" id="print-btn" type="button">Print</button>
    </div>`;

  el.resultBody.innerHTML = html;
  el.resultCard.hidden = false;

  $("result-handoff").href = handoffUrl();
  $("print-btn").onclick = () => window.print();
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function handoffUrl() {
  const tpl = state.templates.dc_valuation_with_district || "#";
  return tpl.replace("{districtId}", state.district.id ?? "");
}

/* -------------------------------------------------------------- deep links */

/**
 * The link card is gone, but /api/links is still the only place the official
 * DC Valuation URL template lives, and the result card's hand-off button needs
 * it. So this now only fetches the template and points that button at it.
 */
async function loadLinks() {
  try {
    state.templates = await api("/api/links");
  } catch (e) { fail(e); }
}

/* -------------------------------------------------- area conversion preview */

// Mirrors the backend conversion so the preview needs no round trip.
const ACRE_TO_KANAL = { "8": 8, "9.65": 9.65, "9.8": 9.8 };
const KANAL_TO_MARLA = 20;
const MARLA_TO_SQFT = { "272": 272, "225": 225 };

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
  return marla * m2s;
}

function updateConversionPreview() {
  const area = Number(el.areaValue.value);
  if (!area || area <= 0) { el.convOut.textContent = ""; return; }
  const opts = { acre_to_kanal: el.acreToKanal.value, marla_to_sqft: el.marlaToSqft.value };
  const from = el.areaUnit.value;
  el.convOut.textContent = state.units.area_units
    .filter((u) => u !== from)
    .map((to) => {
      const out = nf.format(convert(area, from, to, opts));
      return `${nf.format(area)} ${AREA_LABELS[from] || from} = ${out} ${AREA_LABELS[to] || to}`;
    })
    .join("   ·   ");
}

/* ------------------------------------------------------------------ reset */

function resetFrom(selects) {
  for (const s of [].concat(selects)) {
    fill(s, [], { placeholder: "Select…" });
    noteEmpty(s, "");
  }
}

function onLandTypeChange(next) {
  state.landType = next;
  hideParcelBlock();

  el.urbanScope.classList.toggle("hidden", next !== "urban");
  el.ruralScope.classList.toggle("hidden", next !== "rural");
  el.urbanCoverageNote.classList.toggle("hidden", next !== "urban");

  for (const btn of document.querySelectorAll(".seg-btn[data-land-type]")) {
    const active = btn.dataset.landType === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }

  reorderFlow();
  resetFrom(isUrban()
    ? [el.town, el.revenueCircle, el.floor, el.propertyArea]
    : [el.qanoongo, el.mouza]);
  resetFrom([el.landClassification, el.location]);

  if (state.tehsil.id) loadScopeLevels();
}

function resetAll() {
  el.resultCard.hidden = true;
  el.status.textContent = "";
  el.status.className = "status";
  resetFrom([el.town, el.revenueCircle, el.floor,
             el.propertyArea, el.qanoongo, el.mouza,
             el.landClassification, el.location]);
  hideParcelBlock();
  clearParcelInputs();
  el.areaValue.value = "1";
  updateConversionPreview();
  loadScopeLevels();
}

/* ------------------------------------------------- reference-list freshness */

/**
 * Report how fresh the reference lists (mouzas, classifications, Khasra
 * numbers) are, and offer a manual re-read.
 *
 * Rates are deliberately not mentioned here: they are never stored, so there
 * is no rate freshness to report. The only thing that can go stale is the
 * lists, and a failed pass is surfaced rather than left for the user to
 * discover as a missing Khasra.
 */
function showRefreshStatus(s) {
  if (!s || !el.refreshNote) return;
  const note = el.refreshNote;

  // A serverless deployment has no midnight to aim at: instances are created
  // per request, so there is nothing to survive until and a scheduled pass
  // would be pointless. Say that instead of showing the idle-refresh wording,
  // and hide the button that would 501.
  if (s.schedule && s.schedule.startsWith("disabled")) {
    note.parentElement.classList.remove("is-warn");
    note.textContent =
      "Portal lists (mouzas, classifications, Khasra numbers) are re-read " +
      "from the official portal as you browse. Rates are always fetched live, " +
      "never stored.";
    if (el.refreshNow) el.refreshNow.hidden = true;
    return;
  }

  const warn = !!s.last_error || (s.last_ok === null && !s.running);
  note.parentElement.classList.toggle("is-warn", warn);

  if (s.running) {
    note.textContent =
      `Re-reading the portal lists now — ${s.lists.toLocaleString()} of ` +
      `~1,070 lists, ${s.khasras.toLocaleString()} Khasras so far` +
      (s.failures ? `, ${s.failures} failed.` : ".");
  } else if (s.last_error) {
    note.textContent =
      `Last list refresh failed (${s.last_error}). The lists in use are from ` +
      `${s.last_ok ? s.last_ok.replace("T", " ") : "an earlier run"}. ` +
      "They may be out of date.";
  } else if (s.last_ok) {
    note.textContent =
      `Portal lists (mouzas, classifications, Khasra numbers) refreshed ` +
      `${s.last_ok.replace("T", " ")} — ${s.khasras.toLocaleString()} Khasras ` +
      `across ${s.lists.toLocaleString()} lists in ${s.duration_s}s. ` +
      `Next automatic run ${s.next_run.replace("T", " ")}. Rates are always ` +
      "fetched live, never stored.";
  } else {
    note.textContent = "No list refresh has completed yet.";
  }

  if (el.refreshNow) {
    el.refreshNow.hidden = false;
    el.refreshNow.disabled = !!s.running;
    el.refreshNow.textContent = s.running ? "Refreshing…" : "Refresh lists now";
  }
}

async function onRefreshNow() {
  if (el.refreshNow) el.refreshNow.disabled = true;
  try {
    // Returns as soon as the pass is claimed; the walk itself takes minutes.
    showRefreshStatus(await api("/api/refresh", { method: "POST" }));
  } catch (e) {
    fail(e);
  }
  await pollRefresh();
}

/** Follow a running pass to completion, then show the result. */
async function pollRefresh() {
  for (let i = 0; i < 900; i++) {
    const s = await api("/api/refresh");
    showRefreshStatus(s);
    if (!s.running) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/* ------------------------------------------------------------------- boot */

function init() {
  reorderFlow();
  if (el.refreshNow) el.refreshNow.addEventListener("click", onRefreshNow);

  el.town.addEventListener("change", onTownChange);
  el.revenueCircle.addEventListener("change", onRevenueCircleChange);
  el.propertyArea.addEventListener("change", onPropertyAreaChange);
  el.qanoongo.addEventListener("change", onQanoongoChange);
  el.mouza.addEventListener("change", onMouzaChange);
  el.mouzaSearch.addEventListener("input", onMouzaSearch);
  el.landClassification.addEventListener("change", onLandClassificationChange);
  el.location.addEventListener("change", onLocationChange);
  el.squareNo.addEventListener("change", loadQilaSuggestions);

  // --- Multi-Khasra picker. Delegated, because a mouza can hold thousands
  // --- of Khasras and per-chip listeners would be thousands of closures.
  el.multiToggle.addEventListener("click", () => toggleMultiPanel());
  el.multiClose.addEventListener("click", () => toggleMultiPanel(false));
  el.multiAll.addEventListener("click", selectAllShown);
  el.multiNone.addEventListener("click", clearMultiSelection);
  el.multiRun.addEventListener("click", runBatch);
  el.multiFilter.addEventListener("input", () => {
    state.multi.filter = el.multiFilter.value;
    renderKhasraGrid();
  });
  el.multiGrid.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (chip) toggleKhasra(chip.dataset.khasra, event);
  });

  // Choosing a different rating basis re-renders the parcel inputs.
  el.parcelChoice.addEventListener("click", (event) => {
    const btn = event.target.closest(".seg-btn");
    if (!btn) return;
    state.parcelPath = btn.dataset.path;
    setPathChoiceButtons(state.parcelPath);
    clearParcelInputs();
    renderParcelBlock();
  });

  // Urban: picking a parcel identifier narrows the classification list.
  let debounce;
  const onParcelEdit = () => {
    if (!isUrban() || state.parcelPath === "area") return;
    clearTimeout(debounce);
    debounce = setTimeout(reloadUrbanClassifications, 500);
  };
  el.khasra.addEventListener("change", onParcelEdit);
  el.qilaNo.addEventListener("change", onParcelEdit);

  for (const btn of document.querySelectorAll(".seg-btn[data-land-type]")) {
    btn.addEventListener("click", () => onLandTypeChange(btn.dataset.landType));
  }

  $("lookup-form").addEventListener("submit", onSubmit);
  $("reset-btn").addEventListener("click", resetAll);

  for (const node of [el.areaValue, el.areaUnit, el.acreToKanal, el.marlaToSqft]) {
    node.addEventListener("input", updateConversionPreview);
    node.addEventListener("change", updateConversionPreview);
  }

  (async () => {
    try {
      const [units, scope] = await Promise.all([api("/api/units"), api("/api/scope")]);
      state.units = units;
      state.district = scope.district;
      state.tehsil = scope.tehsil;
      state.serverless = !!scope.serverless;

      // /api/units returns bare unit names; give them display labels.
      fill(el.areaUnit, units.area_units.map((u) => ({ id: u, name: AREA_LABELS[u] || u })),
           { placeholder: "" });
      el.areaUnit.value = "Marla";

      // Both scope fields are fixed, so they render as labels, not dropdowns.
      el.districtBadge.textContent = scope.label;
      document.getElementById("district-locked").textContent = "District " + scope.district.name;
      document.getElementById("tehsil-locked").textContent = "Tehsil " + scope.tehsil.name;
      document.title = scope.tehsil.name + " DC Rate Calculator — " + scope.label +
        " land valuation (unofficial)";

      await loadScopeLevels();
      showRefreshStatus(scope.refresh);
    } catch (e) { fail(e); }
    await loadLinks();
    updateConversionPreview();
  })();
}

document.addEventListener("DOMContentLoaded", init);
