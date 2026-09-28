/* Live DC rate client for the Windows desktop build.
 *
 * This file does one job: ask the local server for official DC rates and hand
 * back what came back. It draws nothing, reads no form fields, and has no
 * opinion about which Khasra is selected. The page decides what to ask for;
 * this decides how to ask.
 *
 * Why there is a server at all: the Punjab e-Stamp portal replies with no
 * `access-control-*` headers, so a browser throws the response away before any
 * script on the page can see it. main.py runs the same FastAPI app the hosted
 * build uses, bound to 127.0.0.1, and this calls it over loopback. Same portal
 * call, same arithmetic, no hosting account and nothing left running.
 *
 * Two rules this file exists to enforce:
 *
 *   1. Nothing is written to disk. A rate fetched now is held in memory for
 *      this session and dropped when the window closes. A rate that survives
 *      somewhere would go stale without saying so, and a stale rate is worse
 *      than no answer.
 *
 *   2. The portal is not touched until it is asked. Launching the app makes no
 *      requests at all, and the caller decides what to look up. Rate lookups
 *      are one portal request each, so they are chunked and reported as they
 *      complete rather than fired in a single burst.
 */

(function () {
  "use strict";

  if (!window.__DESKTOP__) return; // opened in a plain browser: no live lookup
  // Same guard as app.js, and for the same reason: on a browser that cannot
  // parse this file, desktop-check has already put an explanation on screen.
  if (window.__CAPABLE__ === false) return;

  const SINGLE_URL = "/api/rate";
  const BATCH_URL = "/api/rates/batch";

  /**
   * How many Khasras to price per request.
   *
   * The portal has no "many Khasras" endpoint -- its own bulk screen issues one
   * request per Khasra too -- so a bulk run is N requests either way. The batch
   * is split so the page can show progress and so no single request runs long
   * enough to look hung. The server keeps at most 4 portal calls in flight, so
   * a chunk of 8 is two waves of work.
   */
  const CHUNK = 8;

  /**
   * The most Khasras one run will price.
   *
   * A cap, and an honest one rather than a silent one: the caller is told how
   * many were skipped. The largest mouza in Chakwal publishes 8,768 Khasras,
   * and pricing all of them is 8,768 requests against a government portal that
   * does not bulk-look-up. That is not a useful thing to do to somebody else's
   * server, so the run stops and says so. Raising this is a one-line change for
   * a server you own.
   */
  const MAX_BATCH = 200;

  /**
   * Rates already fetched this session, keyed by the chain that produced them.
   *
   * In memory only, and only for the life of the window -- see rule 1 above.
   * Its whole purpose is to stop the same parcel being re-fetched while the user
   * flicks between classification and location and back. The key deliberately
   * excludes the area: the rate does not depend on it, so changing the area must
   * not throw the rate away.
   */
  const cache = new Map();

  /** Rate-only identity of a request, for use as a cache key. */
  function rateKey(body, khasra) {
    if (body.land_type === "urban") {
      return ["urban", body.town, body.revenue_circle_id, body.property_area_id,
              body.land_classification_id, body.location].join("|");
    }
    return ["rural", body.mouza_id, body.land_classification_id, body.location,
            khasra].join("|");
  }

  async function postJSON(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const detail = (data && (data.detail || data.message)) || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return data;
  }

  /** True when the server is reachable, so the page can say so rather than guess. */
  async function ping() {
    try {
      const r = await fetch("/api/units", { cache: "no-store" });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * One Khasra's official rate.
   *
   * Resolves with { found, rate, unit, message, cached }. `found: false` is the
   * portal's honest answer that it publishes no rate for this parcel -- not an
   * error, and not something to paper over with a guess.
   */
  async function single(body) {
    const key = rateKey(body, body.khasra_no);
    if (cache.has(key)) {
      return Object.assign({ cached: true }, cache.get(key));
    }

    const data = await postJSON(SINGLE_URL, body);
    const out = data && data.found && data.rate
      ? { found: true, rate: data.rate.rate, unit: data.rate.unit, message: null }
      : {
          found: false,
          rate: null,
          unit: null,
          message: (data && (data.message || data.reason)) ||
            "the portal publishes no DC rate for this parcel",
        };
    cache.set(key, out);
    return Object.assign({ cached: false }, out);
  }

  /**
   * Every Khasra's own rate, priced separately.
   *
   * onProgress({ done, total, rows }) is called after each chunk so the table
   * can fill in as answers arrive rather than sitting blank for half a minute.
   * Resolves with { rows, skipped, total, source }; `rows` is one entry per
   * Khasra, each with its own rate, unit and found flag.
   */
  async function batch(body, khasras, onProgress) {
    const numbers = Array.from(khasras);
    const use = numbers.slice(0, MAX_BATCH);
    const skipped = numbers.length - use.length;
    const rows = [];
    const report = onProgress || function () {};
    // The last response, kept so the envelope (source, and the server's own
    // distinct-rate summary) survives past the loop it was received in.
    let last = null;

    for (let i = 0; i < use.length; i += CHUNK) {
      const slice = use.slice(i, i + CHUNK);

      // Only the rates are needed here. The area sent is the real one so the
      // server's own figures agree with this page's, but the caller recomputes
      // the value from the rate -- that keeps a cached rate valid when the area
      // changes, which is the point of the cache.
      const payload = Object.assign({}, body, { khasras: slice });
      const data = await postJSON(BATCH_URL, payload);
      last = data;

      for (const r of (data && data.results) || []) {
        rows.push({
          khasra: r.khasra,
          found: !!r.found,
          rate: r.rate,
          unit: r.rate_unit,
          error: r.error || null,
        });
      }
      report({ done: Math.min(i + CHUNK, use.length), total: use.length, rows });
    }

    return {
      rows,
      skipped,
      total: use.length,
      source: (last && last.source) || null,
      summary: (last && last.summary) || null,
    };
  }

  window.LiveRates = { ready: ping(), single, batch, MAX_BATCH, CHUNK };
})();
