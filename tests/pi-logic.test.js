/*
 * Unit tests for the PI Planner planning math.
 *
 * These tests do NOT keep their own copy of the logic. They extract the
 * `==PURE_LOGIC_START== ... ==PURE_LOGIC_END==` block straight out of
 * pi-planner.html and run it, so the tests always cover the real shipped code.
 * If someone changes the capacity or auto-fit math and breaks an invariant,
 * `node --test` fails.
 *
 * Run from the "PI Planner" folder:   node --test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadLogic(){
  const htmlPath = path.join(__dirname, '..', 'pi-planner.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/==PURE_LOGIC_START==[\s\S]*?\*\/([\s\S]*?)\/\*\s*==PURE_LOGIC_END==/);
  if (!m) throw new Error('PURE_LOGIC block not found in pi-planner.html — did the markers move?');
  const tmp = path.join(os.tmpdir(), `pi-logic-${process.pid}.js`);
  fs.writeFileSync(tmp, m[1]);
  try { return require(tmp); } finally { fs.unlinkSync(tmp); }
}
const L = loadLogic();

/* ---------------- workingDays / defaultDays ---------------- */
test('workingDays defaults to 5 × weeks', () => {
  assert.equal(L._workingDays({weeks:3}), 15);
  assert.equal(L._workingDays({weeks:2}), 10);
  assert.equal(L._workingDays({weeks:1}), 5);
});
test('workingDays honors an explicit days override (e.g. holidays)', () => {
  assert.equal(L._workingDays({weeks:2, days:8}), 8);
  assert.equal(L._workingDays({weeks:3, days:0}), 0);
});
test('defaultDays ignores the override and reports 5 × weeks', () => {
  assert.equal(L._defaultDays({weeks:2, days:8}), 10);
});

/* ---------------- memberAvail ---------------- */
const SP = {id:'s', weeks:3}; // 15 working days
test('memberAvail = workingDays × capacity% − PTO', () => {
  assert.equal(L._memberAvail({cap:100, pto:{}}, SP), 15);
  assert.equal(L._memberAvail({cap:80,  pto:{}}, SP), 12);
  assert.equal(L._memberAvail({cap:80,  pto:{s:2}}, SP), 10);
  assert.equal(L._memberAvail({cap:50,  pto:{}}, {id:'x', weeks:2}), 5);
});
test('memberAvail never goes negative', () => {
  assert.equal(L._memberAvail({cap:100, pto:{s:99}}, SP), 0);
});

/* ---------------- teamPool (separate Dev / QA) ---------------- */
test('teamPool sums only the requested role', () => {
  const t = {members:[
    {role:'Dev', cap:100, pto:{}}, // 15
    {role:'Dev', cap:80,  pto:{}}, // 12
    {role:'QA',  cap:90,  pto:{}}, // 13.5
  ]};
  assert.equal(L._teamPool(t, SP, 'Dev'), 27);
  assert.equal(L._teamPool(t, SP, 'QA'), 13.5);
});

/* ---------------- teamDemand ---------------- */
test('teamDemand sums effort only for the matching team + sprint + role', () => {
  const pbis = [
    {teamId:'t', sprintId:'s', eeDev:3, eeQA:1},
    {teamId:'t', sprintId:'s', eeDev:2, eeQA:2},
    {teamId:'t', sprintId:'other', eeDev:5, eeQA:5}, // wrong sprint
    {teamId:'x', sprintId:'s', eeDev:9, eeQA:9},      // wrong team
  ];
  assert.equal(L._teamDemand(pbis, 't', 's', 'Dev'), 5);
  assert.equal(L._teamDemand(pbis, 't', 's', 'QA'), 3);
});

/* ---------------- violations ---------------- */
test('dependency violations flag wrong ordering only', () => {
  const sprints = [{id:'A'},{id:'B'},{id:'C'}];
  const pbis = [
    {id:'p1', sprintId:'A', deps:[]},
    {id:'p2', sprintId:'B', deps:['p1']},  // dep earlier -> ok
    {id:'p3', sprintId:'A', deps:['p2']},  // dep later   -> violation
    {id:'p4', sprintId:'A', deps:['p1']},  // dep same sprint -> violation
    {id:'p5', sprintId:'B', deps:['zz']},  // dep unplaced/missing -> violation (missing returns false actually)
    {id:'p6', sprintId:null, deps:['p1']}, // self unplaced -> no violation
  ];
  const v = p => L._violations(p, pbis, sprints);
  assert.deepEqual(v(pbis[0]), []);
  assert.deepEqual(v(pbis[1]), []);                 // p2 ok
  assert.deepEqual(v(pbis[2]), ['p2']);             // p3 dep in later sprint
  assert.deepEqual(v(pbis[3]), ['p1']);             // p4 dep in same sprint
  assert.deepEqual(v(pbis[5]), []);                 // p6 not placed
});
test('a dependency that has no sprint counts as a violation', () => {
  const sprints = [{id:'A'},{id:'B'}];
  const pbis = [
    {id:'d', sprintId:null, deps:[]},
    {id:'p', sprintId:'A', deps:['d']},
  ];
  assert.deepEqual(L._violations(pbis[1], pbis, sprints), ['d']);
});

/* ---------------- computeAutoFit ---------------- */
// helper: one team with given dev/qa day pools per (1-week) sprint
function plan(sprints, devDays, qaDays, pbis, features){
  return {
    sprints,
    features: features || [{id:'f1', rank:1}],
    teams: [{id:'t', members:[
      {role:'Dev', cap:100, pto:{}},   // weeks adjusted via sprint.days below
      {role:'QA',  cap:100, pto:{}},
    ]}],
    pbis,
  };
}
// Use explicit `days` so capacity is exact and independent of weeks.
const A = {id:'A', weeks:1, days:5}, B = {id:'B', weeks:1, days:5};

test('auto-fit splits work across sprints when one sprint cannot hold it all', () => {
  const p = plan([A,B], 5, 5, [
    {id:'p1', teamId:'t', featureId:'f1', eeDev:3, eeQA:1, deps:[]},
    {id:'p2', teamId:'t', featureId:'f1', eeDev:3, eeQA:1, deps:[]}, // 3+3 dev = 6 > 5
  ]);
  const r = L._computeAutoFit(p);
  assert.equal(r.placements.p1, 'A');
  assert.equal(r.placements.p2, 'B');
  assert.deepEqual(r.unplaced, []);
});

test('auto-fit respects dependency order even when capacity would allow same sprint', () => {
  const p = plan([A,B], 5, 5, [
    {id:'p1', teamId:'t', featureId:'f1', eeDev:2, eeQA:1, deps:[]},
    {id:'p2', teamId:'t', featureId:'f1', eeDev:2, eeQA:1, deps:['p1']}, // would fit A, but must follow p1
  ]);
  const r = L._computeAutoFit(p);
  assert.equal(r.placements.p1, 'A');
  assert.equal(r.placements.p2, 'B');
});

test('auto-fit leaves a PBI unplaced when its dependency lands in the last sprint', () => {
  const p = plan([A], 5, 5, [   // only one sprint
    {id:'p1', teamId:'t', featureId:'f1', eeDev:2, eeQA:1, deps:[]},
    {id:'p2', teamId:'t', featureId:'f1', eeDev:2, eeQA:1, deps:['p1']},
  ]);
  const r = L._computeAutoFit(p);
  assert.equal(r.placements.p1, 'A');
  assert.equal(r.placements.p2, null);
  assert.deepEqual(r.unplaced, ['p2']);
});

test('auto-fit honors feature priority when capacity is scarce', () => {
  const features = [{id:'hi', rank:1}, {id:'lo', rank:2}];
  const p = {
    sprints:[A], features,
    teams:[{id:'t', members:[{role:'Dev',cap:100,pto:{}},{role:'QA',cap:100,pto:{}}]}],
    pbis:[
      {id:'low',  teamId:'t', featureId:'lo', eeDev:5, eeQA:0, deps:[]}, // listed first but lower priority
      {id:'high', teamId:'t', featureId:'hi', eeDev:5, eeQA:0, deps:[]},
    ],
  };
  const r = L._computeAutoFit(p);
  assert.equal(r.placements.high, 'A');   // priority wins the single slot
  assert.equal(r.placements.low, null);
  assert.deepEqual(r.unplaced, ['low']);
});

test('auto-fit does not place a PBI that has no team', () => {
  const p = plan([A,B], 5, 5, [
    {id:'x', teamId:null, featureId:'f1', eeDev:1, eeQA:1, deps:[]},
  ]);
  const r = L._computeAutoFit(p);
  assert.equal(r.placements.x, null);
  assert.deepEqual(r.unplaced, []); // teamless PBIs are not reported as "didn't fit"
});

test('auto-fit is pure — it must not mutate the input plan', () => {
  const p = plan([A,B], 5, 5, [
    {id:'p1', teamId:'t', featureId:'f1', eeDev:3, eeQA:1, deps:[]},
  ]);
  const before = JSON.stringify(p);
  L._computeAutoFit(p);
  assert.equal(JSON.stringify(p), before, 'input plan was mutated');
});

test('INVARIANT: after auto-fit no team/sprint is over-allocated', () => {
  // a denser scenario across 3 sprints and 2 features
  const sprints = [{id:'S1',weeks:1,days:5},{id:'S2',weeks:1,days:5},{id:'S3',weeks:1,days:5}];
  const features = [{id:'F1',rank:1},{id:'F2',rank:2}];
  const teams = [{id:'T', members:[
    {role:'Dev',cap:100,pto:{}}, {role:'Dev',cap:100,pto:{}}, // 10 dev days/sprint
    {role:'QA', cap:100,pto:{}},                              // 5 qa days/sprint
  ]}];
  const pbis = [
    {id:'a', teamId:'T', featureId:'F1', eeDev:4, eeQA:2, deps:[]},
    {id:'b', teamId:'T', featureId:'F1', eeDev:4, eeQA:2, deps:[]},
    {id:'c', teamId:'T', featureId:'F2', eeDev:6, eeQA:1, deps:[]},
    {id:'d', teamId:'T', featureId:'F2', eeDev:3, eeQA:3, deps:['a']},
  ];
  const p = {sprints, features, teams, pbis};
  const r = L._computeAutoFit(p);
  // apply placements onto a copy and check every pool
  const placed = pbis.map(x => ({...x, sprintId: r.placements[x.id]}));
  for (const t of teams) for (const sp of sprints) {
    const devDem = L._teamDemand(placed, t.id, sp.id, 'Dev');
    const qaDem  = L._teamDemand(placed, t.id, sp.id, 'QA');
    assert.ok(devDem <= L._teamPool(t, sp, 'Dev') + 1e-9, `Dev over in ${sp.id}: ${devDem}`);
    assert.ok(qaDem  <= L._teamPool(t, sp, 'QA')  + 1e-9, `QA over in ${sp.id}: ${qaDem}`);
  }
});

/* ---------------- sprintDates (PI start date → sprint date ranges) ---------------- */
const _dow = d => d.getDay();           // 0=Sun … 4=Thu … 6=Sat
// Format using LOCAL date parts — _sprintDates builds Dates in local time,
// so toISOString() (UTC) would shift the day in non-UTC zones.
const _iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

test('sprintDates returns all-null when no PI start date is set', () => {
  const sprints = [{id:'s1',weeks:2},{id:'s2',weeks:2}];
  const r = L._sprintDates(sprints, '');
  assert.equal(r.length, 2);
  assert.deepEqual(r, [{start:null,end:null},{start:null,end:null}]);
});

test('every sprint starts on a Sunday and ends on a Thursday', () => {
  const sprints = [{id:'s1',weeks:1},{id:'s2',weeks:2},{id:'s3',weeks:3}];
  const r = L._sprintDates(sprints, '2026-09-01'); // a Tuesday
  for (const {start,end} of r) {
    assert.equal(_dow(start), 0, `start ${_iso(start)} should be Sunday`);
    assert.equal(_dow(end),   4, `end ${_iso(end)} should be Thursday`);
  }
});

test('a mid-week start snaps forward to the next Sunday', () => {
  // 2026-09-01 is Tue → next Sunday is 2026-09-06
  const r = L._sprintDates([{id:'s1',weeks:2}], '2026-09-01');
  assert.equal(_iso(r[0].start), '2026-09-06');
});

test('a Sunday start stays put; Fri and Sat snap to the following Sunday', () => {
  // 2026-09-06 is Sun
  assert.equal(_iso(L._sprintDates([{id:'s',weeks:1}], '2026-09-06')[0].start), '2026-09-06');
  // 2026-09-04 Fri and 2026-09-05 Sat both → 2026-09-06
  assert.equal(_iso(L._sprintDates([{id:'s',weeks:1}], '2026-09-04')[0].start), '2026-09-06');
  assert.equal(_iso(L._sprintDates([{id:'s',weeks:1}], '2026-09-05')[0].start), '2026-09-06');
});

test('sprints chain back-to-back: next start is the prev end + 3 days (Thu→Sun)', () => {
  const sprints = [{id:'s1',weeks:1},{id:'s2',weeks:2},{id:'s3',weeks:3}];
  const r = L._sprintDates(sprints, '2026-09-06'); // Sunday
  for (let i = 1; i < r.length; i++) {
    const expected = new Date(r[i-1].end);
    expected.setDate(expected.getDate() + 3);
    assert.equal(_iso(r[i].start), _iso(expected), `sprint ${i} should start 3 days after prev end`);
  }
  // a 1-week sprint: Sun 09-06 → Thu 09-10
  assert.equal(_iso(r[0].start), '2026-09-06');
  assert.equal(_iso(r[0].end),   '2026-09-10');
});
