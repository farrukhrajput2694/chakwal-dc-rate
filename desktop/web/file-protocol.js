/* What to do when this page is opened by double-clicking index.html.
 *
 * The short version: if you got here by double-clicking a file, live DC rates
 * will not work, and no amount of waiting will make them work. This file exists
 * to say that clearly and immediately, instead of letting you pick a Khasra and
 * wonder why nothing comes back.
 *
 * Why it cannot work, precisely. Reading a DC rate means asking the Punjab
 * e-Stamp portal. A browser will only hand a page the response to a request if
 * that page's origin is allowed by the portal's CORS headers. The portal sends
 * no `access-control-*` headers at all -- verified against it directly, not
 * assumed -- so the browser discards every response before any script here can
 * see it. That is the browser refusing to let one web page read another web
 * page's data, and no change to this file, this page, or the markup below can
 * override it.
 *
 * A local server is not a workaround dressed up as a convenience. It is what
 * puts the request somewhere the browser's rule does not apply, which is why
 * run-server.bat has to be used.
 *
 * Loaded before anything else in <head>, and deliberately a no-op over http --
 * every shipped build (desktop window, Windows 7, hosted) serves this page over
 * http and must be completely unaffected by this file.
 */
(function () {
  "use strict";

  // Served normally. Nothing to do, and nothing must be drawn over the app.
  if (window.location.protocol !== "file:") return;
  if (window.__CAPTURED_FILE__) return; // re-entry guard, belt and braces
  window.__CAPTURED_FILE__ = true;

  document.addEventListener("DOMContentLoaded", function () {
    var body = document.body;
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.className = "";
    body.setAttribute("style",
      "margin:0;padding:40px 24px;background:#f6f7f9;color:#1c2024;" +
      "font:16px/1.6 'Segoe UI',Tahoma,Arial,sans-serif");

    function box(title, tone) {
      var d = document.createElement("div");
      d.setAttribute("style",
        "max-width:760px;margin:0 auto 18px;padding:20px 24px;background:#fff;" +
        "border-radius:10px;border:1px solid #dfe3e8;border-left:5px solid " + tone);
      var h = document.createElement("h1");
      h.setAttribute("style", "margin:0 0 10px;font-size:20px;font-weight:600");
      h.textContent = title;
      d.appendChild(h);
      body.appendChild(d);
      return d;
    }

    function para(host, text, mono) {
      var p = document.createElement("p");
      p.setAttribute("style", "margin:0 0 12px");
      if (mono) {
        p.setAttribute("style", "margin:0 0 12px;font-family:Consolas,'Courier New',monospace;font-size:14px");
      }
      p.textContent = text;
      host.appendChild(p);
      return p;
    }

    var d = box("Live DC rates need the local server — they cannot work from a file", "#c0392b");
    para(d,
      "This page was opened straight off the disk, so your browser is giving it " +
      "the address file:///... . That is the only reason the rate lookup is " +
      "unavailable. Nothing is wrong with the page, and no rate can be made to " +
      "appear by reloading it.");
    para(d,
      "Reading a DC rate means asking the Punjab e-Stamp portal. Your browser " +
      "will only hand a page the answer if the portal permits it, and the " +
      "portal sends no permission headers at all — so every response is thrown " +
      "away before this page could see it. That rule belongs to the browser and " +
      "cannot be switched off from here.");

    var d2 = box("How to get it working", "#2c7fb8");
    para(d2, "In this same folder, double-click:");
    para(d2, "    run-server.bat", true);
    para(d2,
      "That starts a small server on this computer only — it listens on " +
      "127.0.0.1, which no other machine on your network can reach. It then " +
      "opens this same page automatically, and from there every rate works, " +
      "read live from the portal exactly as the desktop app does.");
    para(d2,
      "The rates are never stored. Each one is fetched when you ask for it and " +
      "held only in memory until the window closes.");

    var d3 = box("If you only wanted to look at it", "#7f8c8d");
    para(d3,
      "That is all right — this page is the real interface, and everything " +
      "except the live rate lookup works from the disk. The district, tehsil, " +
      "mouza, qanoongo, classification and Khasra lists are all bundled in this " +
      "folder, so you can navigate the whole form and see the layout.");
  });
})();
