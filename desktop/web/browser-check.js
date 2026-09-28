/* Browser capability check, loaded before app.js.
 *
 * Why this exists
 * ---------------
 * On Windows 7 the default browser is Internet Explorer 11, which cannot run
 * this page: `fetch` does not exist, and app.js uses optional chaining (`?.`)
 * and nullish coalescing (`??`). Chrome 109, Firefox 115 ESR and Edge 109 are
 * the last versions that run on Windows 7, and they all work -- but if someone
 * has only IE, the honest outcome is a page that says so, not a blank window
 * with a broken layout and a console full of errors.
 *
 * So this checks for the three things app.js genuinely depends on, and if any
 * are missing it replaces the page with an explanation. Not a warning banner,
 * not a console message: the app is unusable, so the page says so.
 *
 * The checks are feature-detection by parsing, not a version string. User-agent
 * sniffing is wrong the moment it is written -- it breaks when a browser lies,
 * and when a new browser ships the feature, both cases point the same way. Each
 * test compiles a tiny snippet with `new Function`, which throws a SyntaxError
 * on a parser that does not understand the syntax. That is the only reliable
 * way to ask "can this browser run this code" from inside a browser.
 *
 * This file must stay ES5. It runs on exactly the browsers that cannot run
 * anything else, so arrow functions or `const` here would defeat the purpose.
 */
(function () {
  "use strict";

  function canParse(source) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(source);
      return true;
    } catch (e) {
      return false;
    }
  }

  var missing = [];

  if (typeof window.fetch !== "function") {
    missing.push("the fetch API (network requests)");
  }
  if (typeof window.Promise !== "function") {
    missing.push("Promises");
  }
  // Async functions and template literals: ES2017 and ES2015.
  if (!canParse("return (async function () { return 1; });")) {
    missing.push("async functions");
  }
  if (!canParse("return `t`;")) {
    missing.push("template literals");
  }
  // Optional chaining and nullish coalescing: ES2020. Both are used in app.js,
  // and both are the reason IE11 cannot load it.
  if (!canParse("var o = null; return o?.x;")) {
    missing.push("optional chaining");
  }
  if (!canParse("var v = null; return v ?? 1;")) {
    missing.push("nullish coalescing");
  }
  if (typeof window.Map !== "function" || typeof window.Array.from !== "function") {
    missing.push("Map / Array.from");
  }

  if (!missing.length) {
    // Capable. app.js may run.
    window.__CAPABLE__ = true;
    return;
  }

  window.__CAPABLE__ = false;

  /* Rendered with DOM calls rather than a template string, because this file
   * may be running in a browser that cannot parse one. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.appendChild(document.createTextNode(text));
    return node;
  }

  function render() {
    var box = el("div");
    box.setAttribute("style",
      "max-width:640px;margin:12vh auto;padding:28px 32px;" +
      "font:16px/1.55 'Segoe UI',Tahoma,Verdana,sans-serif;color:#0f172a;");

    box.appendChild(el("h1", null, "This browser is too old for this calculator"));
    box.appendChild(el("p", null,
      "The page is written in modern JavaScript, and this browser does not " +
      "support the parts it needs. Nothing is wrong with your computer or " +
      "your data -- there is simply no way to run the lookup here."));

    var what = el("p");
    what.appendChild(document.createTextNode("Missing: " + missing.join(", ") + "."));
    box.appendChild(what);

    box.appendChild(el("p", null, "What to do: install one of these, which are the " +
      "last versions to run on Windows 7, and then reopen the calculator."));

    var ul = document.createElement("ul");
    var browsers = [
      "Google Chrome 109 or later",
      "Mozilla Firefox 115 ESR or later",
      "Microsoft Edge 109 or later (the Chromium-based Edge, not Internet Explorer)",
    ];
    for (var i = 0; i < browsers.length; i++) {
      var li = document.createElement("li");
      li.appendChild(document.createTextNode(browsers[i]));
      ul.appendChild(li);
    }
    box.appendChild(ul);

    box.appendChild(el("p", null,
      "If you are online, google.com/chrome and mozilla.org/firefox both offer " +
      "these downloads. Internet Explorer cannot be made to work here."));

    document.body.innerHTML = "";
    document.body.appendChild(box);
  }

  if (document.readyState === "loading") {
    // The <head> script runs before <body> exists, so wait for it. addEventListener
    // rather than attachEvent, because attachEvent is IE-only and this file must
    // never be the reason a modern browser fails.
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
