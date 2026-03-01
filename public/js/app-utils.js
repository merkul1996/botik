/**
 * Общие утилиты для NeuroSpytnik WebApp
 * Загружается до app.js
 */
(function () {
  "use strict";

  window.Neuro$ = function (id) { return document.getElementById(id); };

  var _escEl = document.createElement("div");
  window.esc = function (s) {
    if (typeof s !== "string") return String(s ?? "");
    _escEl.textContent = s;
    return _escEl.innerHTML;
  };

  window.showToast = function (msg, dur) {
    dur = dur || 3000;
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, dur);
  };

  window.logError = function (context, err) {
    if (err && err.name === "AbortError") return;
    console.error("[" + context + "]", err);
  };

  var _focusStack = [];
  window.trapFocus = function (overlay) {
    _focusStack.push(document.activeElement);
    var focusable = overlay.querySelectorAll('button,input,select,textarea,a,[tabindex]:not([tabindex="-1"])');
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (first) first.focus();
    function handler(e) {
      if (e.key === "Tab" && focusable.length) {
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === "Escape") window.releaseFocus(overlay);
    }
    overlay._focusHandler = handler;
    overlay.addEventListener("keydown", handler);
  };

  window.releaseFocus = function (overlay) {
    if (overlay._focusHandler) {
      overlay.removeEventListener("keydown", overlay._focusHandler);
      delete overlay._focusHandler;
    }
    var prev = _focusStack.pop();
    if (prev && prev.focus) prev.focus();
  };

  window.safeUrl = function (url) {
    if (!url || typeof url !== "string") return "";
    return url.replace(/['"\\()]/g, "");
  };
})();
