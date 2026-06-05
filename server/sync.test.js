/*
 * Sync guard: the browser ships INLINE copies of the patch logic (PIPatch) and
 * the unique-name logic (_makeUniqueName) inside pi-planner.html, which must
 * stay behaviorally identical to server/patch.js and server/names.js.
 *
 * Nothing else catches drift between the two copies, so this test extracts the
 * inline versions from the HTML, runs both copies over a battery of inputs, and
 * asserts identical output. It's a BEHAVIORAL compare (not byte-for-byte) — the
 * browser copy is hand-minified, so source would never match character-for-char.
 *
 * If this fails, someone changed one copy and forgot the other (see CLAUDE.md
 * "critical invariant").
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const serverPatch = require('./patch');
const { makeUniqueName: serverMakeUniqueName } = require('./names');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'pi-planner.html'), 'utf8');

/* ---- extract the inline PIPatch IIFE and run it with a fake window ---- */
function loadInlinePatch() {
  const m = HTML.match(/\(function \(root\) \{[\s\S]*?\}\)\(window\);/);
  if (!m) throw new Error('inline PIPatch block not found in pi-planner.html');
  const fakeWin = {};
  // eslint-disable-next-line no-new-func
  new Function('window', m[0])(fakeWin);
  if (!fakeWin.PIPatch) throw new Error('inline PIPatch did not attach to window');
  return fakeWin.PIPatch;
}

/* ---- extract the inline _makeUniqueName function ---- */
function loadInlineMakeUniqueName() {
  const m = HTML.match(/function _makeUniqueName\(desired,taken\)\{[\s\S]*?\n\}/);
  if (!m) throw new Error('inline _makeUniqueName not found in pi-planner.html');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn _makeUniqueName;')();
}

const inlinePatch = loadInlinePatch();
const inlineMakeUniqueName = loadInlineMakeUniqueName();

const clone = x => JSON.parse(JSON.stringify(x));
function baseDoc() {
  return {
    piName: 'PI-1',
    piStartDate: '2026-09-06',
    sprints: [{ id: 'sp1', name: 'S1', weeks: 3, days: 15 }, { id: 'sp2', name: 'S2', weeks: 2, days: 10 }],
    teams: [{ id: 't1', name: 'Falcon', members: [{ id: 'm1', name: 'A', role: 'Dev', cap: 100, pto: {} }] }],
    features: [{ id: 'f1', title: 'Feat A', desc: '', rank: 1 }, { id: 'f2', title: 'Feat B', desc: '', rank: 2 }],
    pbis: [{ id: 'p1', title: 'Old', desc: '', featureId: 'f1', teamId: 't1', eeDev: 3, eeQA: 1, sprintId: null, deps: [] }],
  };
}

// A spread of edits exercising every branch of diffDoc/applyPatch.
function mutations() {
  return [
    cur => { cur.piName = 'PI-2'; },
    cur => { cur.piStartDate = '2026-10-04'; },
    cur => { cur.piStartDate = ''; },
    cur => { cur.sprints[0].days = 12; },
    cur => { cur.sprints.push({ id: 'sp3', name: 'S3', weeks: 1, days: 5 }); },
    cur => { cur.sprints.splice(1, 1); },
    cur => { cur.teams[0].members.push({ id: 'm2', name: 'B', role: 'QA', cap: 80, pto: {} }); },
    cur => { cur.features.reverse(); cur.features.forEach((f, i) => { f.rank = i + 1; }); },
    cur => { cur.pbis[0].title = 'New'; cur.pbis[0].sprintId = 'sp1'; },
    cur => { cur.pbis.push({ id: 'p2', title: 'P2', desc: '', featureId: 'f2', teamId: 't1', eeDev: 2, eeQA: 1, sprintId: null, deps: [] }); },
    cur => { cur.pbis = []; },
    cur => { /* no change */ },
  ];
}

test('inline PIPatch.diffDoc matches server/patch.js diffDoc', () => {
  for (const mutate of mutations()) {
    const base = baseDoc(), cur = clone(base); mutate(cur);
    assert.deepEqual(inlinePatch.diffDoc(base, cur), serverPatch.diffDoc(base, cur));
  }
});

test('inline PIPatch.applyPatch matches server/patch.js applyPatch', () => {
  for (const mutate of mutations()) {
    const base = baseDoc(), cur = clone(base); mutate(cur);
    const patch = serverPatch.diffDoc(base, cur);
    const a = inlinePatch.applyPatch(clone(base), clone(patch));
    const b = serverPatch.applyPatch(clone(base), clone(patch));
    assert.deepEqual(a, b);
  }
});

test('inline PIPatch.isEmpty matches server/patch.js isEmpty', () => {
  assert.equal(inlinePatch.isEmpty({}), serverPatch.isEmpty({}));
  assert.equal(inlinePatch.isEmpty({ piName: 'x' }), serverPatch.isEmpty({ piName: 'x' }));
});

test('inline _makeUniqueName matches server/names.js makeUniqueName', () => {
  const cases = [
    ['Alpha', []],
    ['Alpha', ['Alpha']],
    ['Alpha', ['Alpha', 'Alpha (2)']],
    ['Alpha (2)', ['Alpha (2)']],
    ['alpha', ['ALPHA']],
    ['  Alpha  ', ['Alpha']],
    ['Alpha (copy)', ['Alpha (copy)', 'Alpha (copy) (2)']],
    ['', []],
    ['   ', ['Untitled']],
    [null, ['Alpha']],
  ];
  for (const [desired, taken] of cases) {
    assert.equal(inlineMakeUniqueName(desired, taken), serverMakeUniqueName(desired, taken),
      `mismatch for desired=${JSON.stringify(desired)} taken=${JSON.stringify(taken)}`);
  }
});
