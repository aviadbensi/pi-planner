/*
 * patch.js — shared diff/merge logic for PI Planner collaboration.
 *
 * The same logic runs on the server (require) and in the browser (an
 * identical inline copy lives in pi-planner.html). Keep them in sync.
 *
 * Why field-level patches: two people can legitimately touch the same PBI at
 * once — the board-lock holder moves it to another sprint while a feature-lock
 * holder edits its title. Whole-object "last write wins" would clobber one of
 * those. Diffing per field and merging per field keeps both changes.
 *
 * sprints / teams / features are section-locked (only one writer at a time),
 * so they use simpler whole-object replace-by-id.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PIPatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function byId(arr) { const m = {}; (arr || []).forEach(o => { m[o.id] = o; }); return m; }

  // Whole-object upsert + remove (sprints / teams / features)
  function diffList(base, cur) {
    const b = byId(base), c = byId(cur);
    const upsert = [], remove = [];
    for (const id in c) { if (!b[id] || !eq(b[id], c[id])) upsert.push(clone(c[id])); }
    for (const id in b) { if (!c[id]) remove.push(id); }
    return (upsert.length || remove.length) ? { upsert, remove } : null;
  }

  // Field-level upsert + remove (pbis)
  function diffPbis(base, cur) {
    const b = byId(base), c = byId(cur);
    const upsert = [], remove = [];
    for (const id in c) {
      const cv = c[id], bv = b[id];
      if (!bv) { upsert.push(clone(cv)); continue; }   // brand-new PBI → full object
      const changed = {}; let any = false;
      for (const k in cv) { if (!eq(cv[k], bv[k])) { changed[k] = clone(cv[k]); any = true; } }
      if (any) { changed.id = id; upsert.push(changed); }   // only changed fields
    }
    for (const id in b) { if (!c[id]) remove.push(id); }
    return (upsert.length || remove.length) ? { upsert, remove } : null;
  }

  function diffDoc(base, cur) {
    const p = {};
    if ((base.piName || '') !== (cur.piName || '')) p.piName = cur.piName || '';
    if ((base.piStartDate || '') !== (cur.piStartDate || '')) p.piStartDate = cur.piStartDate || '';
    const s = diffList(base.sprints, cur.sprints); if (s) p.sprints = s;
    const t = diffList(base.teams, cur.teams); if (t) p.teams = t;
    const f = diffList(base.features, cur.features); if (f) p.features = f;
    const pb = diffPbis(base.pbis, cur.pbis); if (pb) p.pbis = pb;
    return p;
  }

  function isEmpty(p) { return !p || Object.keys(p).length === 0; }

  // Replace-by-id, preserving original order then appending new entries.
  function applyList(arr, sub) {
    const m = byId(arr);
    (sub.upsert || []).forEach(o => { m[o.id] = o; });
    (sub.remove || []).forEach(id => { delete m[id]; });
    const out = [];
    arr.forEach(o => { if (m[o.id]) { out.push(m[o.id]); delete m[o.id]; } });
    (sub.upsert || []).forEach(o => { if (m[o.id]) { out.push(m[o.id]); delete m[o.id]; } });
    return out;
  }

  // Field-level merge for pbis (Object.assign onto existing).
  function applyPbis(arr, sub) {
    const m = byId(arr);
    (sub.upsert || []).forEach(o => {
      if (m[o.id]) Object.assign(m[o.id], o);
      else m[o.id] = clone(o);
    });
    (sub.remove || []).forEach(id => { delete m[id]; });
    const out = []; const seen = {};
    arr.forEach(o => { if (m[o.id]) { out.push(m[o.id]); seen[o.id] = 1; } });
    (sub.upsert || []).forEach(o => { if (m[o.id] && !seen[o.id]) { out.push(m[o.id]); seen[o.id] = 1; } });
    return out;
  }

  function applyPatch(doc, patch) {
    if (!patch) return doc;
    if ('piName' in patch) doc.piName = patch.piName;
    if ('piStartDate' in patch) doc.piStartDate = patch.piStartDate;
    if (patch.sprints) doc.sprints = applyList(doc.sprints || [], patch.sprints);
    if (patch.teams) doc.teams = applyList(doc.teams || [], patch.teams);
    if (patch.features) doc.features = applyList(doc.features || [], patch.features);
    if (patch.pbis) doc.pbis = applyPbis(doc.pbis || [], patch.pbis);
    return doc;
  }

  return { diffDoc, applyPatch, isEmpty, clone };
});
