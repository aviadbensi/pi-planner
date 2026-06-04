/*
 * names.js — unique project-name logic for PI Planner.
 *
 * Shared like patch.js: the server requires this module, and pi-planner.html
 * keeps an identical inline copy (`_makeUniqueName`). Keep them in sync.
 *
 * makeUniqueName(desired, taken):
 *   Returns `desired` unless it collides (case-insensitive, trimmed) with a
 *   name in `taken`, in which case it appends " (2)", " (3)", … until unique.
 *   If `desired` already ends in " (n)", it counts up from n+1 rather than
 *   nesting a second suffix (e.g. "Alpha (2)" → "Alpha (3)").
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PINames = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function makeUniqueName(desired, taken) {
    desired = String(desired == null ? '' : desired).trim() || 'Untitled';
    const set = new Set((taken || []).map(n => String(n == null ? '' : n).trim().toLowerCase()));
    if (!set.has(desired.toLowerCase())) return desired;
    const m = desired.match(/^(.*?)\s*\((\d+)\)$/);
    const base = (m ? m[1] : desired).trim() || 'Untitled';
    let n = m ? (+m[2] + 1) : 2;
    while (set.has((base + ' (' + n + ')').toLowerCase())) n++;
    return base + ' (' + n + ')';
  }

  return { makeUniqueName };
});
