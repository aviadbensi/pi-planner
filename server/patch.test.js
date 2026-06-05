/*
 * Tests for the field-level diff/merge used by collaboration.
 * Run from the server folder:  node --test
 *
 * The critical case is "concurrent edit of the same PBI": the board-lock holder
 * moves a PBI to a sprint while a feature-lock holder edits its title. Both
 * changes must survive.
 */
const test = require('node:test');
const assert = require('node:assert');
const { diffDoc, applyPatch, isEmpty } = require('./patch');

const clone = x => JSON.parse(JSON.stringify(x));
function base() {
  return {
    piName: 'PI-1',
    sprints: [{ id: 'sp1', name: 'S1', weeks: 3, days: 15 }],
    teams: [{ id: 't1', name: 'Falcon', members: [] }],
    features: [{ id: 'f1', title: 'Feat A', desc: '', rank: 1 }],
    pbis: [{ id: 'p1', title: 'Old title', desc: '', featureId: 'f1', teamId: 't1', eeDev: 3, eeQA: 1, sprintId: null, deps: [] }],
  };
}

test('empty diff when nothing changes', () => {
  const b = base();
  assert.ok(isEmpty(diffDoc(b, clone(b))));
});

test('piName change produces a patch', () => {
  const b = base(), c = clone(b); c.piName = 'PI-2';
  const p = diffDoc(b, c);
  assert.strictEqual(p.piName, 'PI-2');
  const applied = applyPatch(clone(b), p);
  assert.strictEqual(applied.piName, 'PI-2');
});

test('piStartDate change is diffed and applied', () => {
  const b = base(), c = clone(b); c.piStartDate = '2026-09-06';
  const p = diffDoc(b, c);
  assert.strictEqual(p.piStartDate, '2026-09-06');
  const applied = applyPatch(clone(b), p);
  assert.strictEqual(applied.piStartDate, '2026-09-06');
});

test('piStartDate merges alongside other field changes without clobbering', () => {
  const b = base(), c = clone(b);
  c.piStartDate = '2026-09-06';
  c.piName = 'PI-2';
  c.pbis[0].title = 'New title';
  const p = diffDoc(b, c);
  const applied = applyPatch(clone(b), p);
  assert.strictEqual(applied.piStartDate, '2026-09-06');
  assert.strictEqual(applied.piName, 'PI-2');
  assert.strictEqual(applied.pbis[0].title, 'New title');
});

test('PBI title edit only sends the changed field', () => {
  const b = base(), c = clone(b); c.pbis[0].title = 'New title';
  const p = diffDoc(b, c);
  assert.deepStrictEqual(p.pbis.upsert, [{ title: 'New title', id: 'p1' }]);
});

test('concurrent title + sprint edits both survive (field-level merge)', () => {
  const b = base();

  // User A (feature lock) renames the PBI
  const ca = clone(b); ca.pbis[0].title = 'Renamed by A';
  const patchA = diffDoc(b, ca);

  // User B (board lock) moves the same PBI to a sprint
  const cb = clone(b); cb.pbis[0].sprintId = 'sp1';
  const patchB = diffDoc(b, cb);

  // Server applies A then B onto the canonical doc
  const server = clone(b);
  applyPatch(server, patchA);
  applyPatch(server, patchB);

  assert.strictEqual(server.pbis[0].title, 'Renamed by A', 'title from A kept');
  assert.strictEqual(server.pbis[0].sprintId, 'sp1', 'placement from B kept');
});

test('adding and removing PBIs', () => {
  const b = base(), c = clone(b);
  c.pbis.push({ id: 'p2', title: 'Added', desc: '', featureId: 'f1', teamId: 't1', eeDev: 2, eeQA: 1, sprintId: null, deps: [] });
  c.pbis = c.pbis.filter(p => p.id !== 'p1'); // remove p1
  const p = diffDoc(b, c);
  const applied = applyPatch(clone(b), p);
  assert.deepStrictEqual(applied.pbis.map(x => x.id), ['p2']);
});

test('feature reorder (whole-object replace) applies', () => {
  const b = base(), c = clone(b);
  c.features.push({ id: 'f2', title: 'Feat B', desc: '', rank: 2 });
  c.features[0].rank = 2; c.features[1].rank = 1; // swap ranks
  const applied = applyPatch(clone(b), diffDoc(b, c));
  const ranks = {}; applied.features.forEach(f => ranks[f.id] = f.rank);
  assert.strictEqual(ranks.f1, 2);
  assert.strictEqual(ranks.f2, 1);
});

test('sprint days edit merges without dropping other sprints', () => {
  const b = base(), c = clone(b);
  c.sprints.push({ id: 'sp2', name: 'S2', weeks: 2, days: 10 });
  const server = clone(b);
  applyPatch(server, diffDoc(b, c));
  c.sprints[0].days = 12;
  applyPatch(server, diffDoc(applyPatch(clone(b), diffDoc(b, c)), c)); // idempotent-ish sanity
  assert.strictEqual(server.sprints.length, 2);
});
