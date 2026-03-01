/**
 * Lightweight input validation & sanitization.
 * No external dependencies.
 */

function str(val, maxLen = 500) {
  if (val === undefined || val === null) return "";
  const s = String(val);
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function strRequired(val, maxLen = 500) {
  const s = str(val, maxLen);
  if (!s.trim()) return null;
  return s;
}

function id(val) {
  const s = str(val, 100);
  if (!/^[a-zA-Z0-9_\-]+$/.test(s)) return null;
  return s;
}

function int(val, min = 0, max = 1000000) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function bool(val) {
  return Boolean(val);
}

function stripHtml(val) {
  if (typeof val !== "string") return "";
  return val.replace(/<[^>]*>/g, "").trim();
}

function safeObj(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return {};
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    const key = str(k, 50);
    if (!key) continue;
    if (typeof v === "string") out[key] = str(v, 500);
    else if (typeof v === "number") out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

module.exports = { str, strRequired, id, int, bool, stripHtml, safeObj };
