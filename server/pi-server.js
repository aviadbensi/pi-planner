/*
 * PI Planner collaboration server — zero external dependencies.
 *
 * Runs on one machine on the office LAN. Everyone points their browser at it:
 *     http://<this-machine>:4040
 * It serves pi-planner.html itself (so same origin, no CORS hassles), holds the
 * one canonical plan, broadcasts changes over Server-Sent Events, and arbitrates
 * locks. Locks are tied to client heartbeats, so a crashed browser tab can never
 * freeze a feature forever — its locks are released when its heartbeats stop.
 *
 * Endpoints:
 *   GET  /                serves pi-planner.html (and other static files)
 *   GET  /events         SSE stream: state, patch, locks, presence events
 *   GET  /state          one-shot snapshot {version, doc, locks, presence}
 *   POST /patch          {clientId, patch}      apply + broadcast a field-level patch
 *   POST /lock           {clientId, scope, action, force}   acquire/release a lock
 *   POST /heartbeat      {clientId, name, editing}          keep-alive + presence
 *
 * Start:  node server/pi-server.js     (PORT env var optional, default 4040)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { diffDoc, applyPatch, isEmpty } = require('./patch');

const PORT = process.env.PORT || 4040;
const ROOT = path.join(__dirname, '..');        // the "PI Planner" folder
const DATA = path.join(__dirname, 'plan.json'); // canonical persisted plan
const HEARTBEAT_TTL = 10000;                    // drop client + its locks after 10s silent

/* ---------- seed (mirrors the app's defaultState) ---------- */
function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 9); }
function seed() {
  const s = [1, 2, 3, 4, 5].map(n => ({ id: uid('sp'), name: 'Sprint ' + n, weeks: 3, days: 15 }));
  const t1 = uid('tm'), t2 = uid('tm');
  const f = [
    { id: uid('ft'), title: 'Customer onboarding revamp', desc: 'New signup + KYC flow', rank: 1 },
    { id: uid('ft'), title: 'Reporting dashboard', desc: 'Self-serve analytics', rank: 2 },
    { id: uid('ft'), title: 'Mobile push notifications', desc: 'Cross-platform delivery', rank: 3 },
  ];
  return {
    piName: '2026 Q3',
    sprints: s,
    teams: [
      { id: t1, name: 'Team Falcon', members: [
        { id: uid('mb'), name: 'Alice', role: 'Dev', cap: 80, pto: {} },
        { id: uid('mb'), name: 'Bob', role: 'Dev', cap: 100, pto: {} },
        { id: uid('mb'), name: 'Carol', role: 'QA', cap: 90, pto: {} },
      ] },
      { id: t2, name: 'Team Phoenix', members: [
        { id: uid('mb'), name: 'Dan', role: 'Dev', cap: 100, pto: {} },
        { id: uid('mb'), name: 'Erin', role: 'QA', cap: 80, pto: {} },
      ] },
    ],
    features: f,
    pbis: [
      { id: uid('pb'), title: 'Signup form UI', desc: '', featureId: f[0].id, teamId: t1, eeDev: 6, eeQA: 2, sprintId: null, deps: [] },
      { id: uid('pb'), title: 'KYC integration', desc: '', featureId: f[0].id, teamId: t1, eeDev: 8, eeQA: 3, sprintId: null, deps: [] },
      { id: uid('pb'), title: 'Dashboard API', desc: '', featureId: f[1].id, teamId: t2, eeDev: 7, eeQA: 2, sprintId: null, deps: [] },
      { id: uid('pb'), title: 'Charts frontend', desc: '', featureId: f[1].id, teamId: t1, eeDev: 5, eeQA: 2, sprintId: null, deps: [] },
      { id: uid('pb'), title: 'Push gateway', desc: '', featureId: f[2].id, teamId: t2, eeDev: 6, eeQA: 3, sprintId: null, deps: [] },
    ],
  };
}

/* ---------- canonical state ---------- */
function loadDoc() {
  try {
    if (fs.existsSync(DATA)) {
      const raw = fs.readFileSync(DATA, 'utf8').trim();
      if (raw) return JSON.parse(raw);   // empty file → fall through to seed
    }
  } catch (e) { console.error('Could not read plan.json, starting from seed:', e.message); }
  return seed();
}
let doc = loadDoc();
let version = 0;
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA, JSON.stringify(doc, null, 2)); }
    catch (e) { console.error('persist failed:', e.message); }
  }, 300);
}

/* ---------- clients, presence, locks ---------- */
const clients = new Map();   // id -> {name, lastSeen, res|null, editing}
const locks = { board: null, setup: null, features: {} }; // value = clientId

function nameOf(id) { const c = clients.get(id); return c ? c.name : null; }
function locksView() {
  const feats = {};
  for (const k in locks.features) if (locks.features[k]) feats[k] = { by: locks.features[k], name: nameOf(locks.features[k]) };
  return {
    board: locks.board ? { by: locks.board, name: nameOf(locks.board) } : null,
    setup: locks.setup ? { by: locks.setup, name: nameOf(locks.setup) } : null,
    features: feats,
  };
}
function presenceView() {
  const out = [];
  clients.forEach((c, id) => out.push({ id, name: c.name, editing: c.editing || '' }));
  return out;
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => { if (c.res) { try { c.res.write(payload); } catch (e) {} } });
}

/* ---------- reaper: release locks of clients that stopped sending heartbeats ---------- */
setInterval(() => {
  const now = Date.now(); let lk = false, pr = false;
  for (const [id, c] of clients) {
    if (now - c.lastSeen > HEARTBEAT_TTL) {
      if (c.res) { try { c.res.end(); } catch (e) {} }
      clients.delete(id); pr = true;
      if (locks.board === id) { locks.board = null; lk = true; }
      if (locks.setup === id) { locks.setup = null; lk = true; }
      for (const k in locks.features) if (locks.features[k] === id) { delete locks.features[k]; lk = true; }
    }
  }
  if (lk) broadcast('locks', locksView());
  if (pr) broadcast('presence', presenceView());
}, 3000);

/* ---------- helpers ---------- */
function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // SSE stream
  if (u.pathname === '/events') {
    const id = u.searchParams.get('clientId') || ('c_' + Math.random().toString(36).slice(2, 9));
    const name = u.searchParams.get('name') || 'Anon';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    const existing = clients.get(id);
    clients.set(id, { name: existing ? existing.name : name, lastSeen: Date.now(), res, editing: existing ? existing.editing : '' });
    res.write(`event: state\ndata: ${JSON.stringify({ version, doc, locks: locksView(), presence: presenceView() })}\n\n`);
    broadcast('presence', presenceView());
    req.on('close', () => { const c = clients.get(id); if (c && c.res === res) c.res = null; });
    return;
  }

  if (u.pathname === '/state') {
    return sendJSON(res, { version, doc, locks: locksView(), presence: presenceView() });
  }

  if (u.pathname === '/patch' && req.method === 'POST') {
    const { clientId, patch } = await readBody(req);
    if (patch && !isEmpty(patch)) {
      applyPatch(doc, patch); version++; persist();
      broadcast('patch', { version, patch, by: clientId });
    }
    const c = clients.get(clientId); if (c) c.lastSeen = Date.now();
    return sendJSON(res, { version });
  }

  if (u.pathname === '/lock' && req.method === 'POST') {
    const { clientId, scope, action, force } = await readBody(req);
    const isFeat = scope && scope.startsWith('feature:');
    const featId = isFeat ? scope.slice('feature:'.length) : null;
    const get = () => scope === 'board' ? locks.board : scope === 'setup' ? locks.setup : (isFeat ? locks.features[featId] : undefined);
    const set = v => {
      if (scope === 'board') locks.board = v;
      else if (scope === 'setup') locks.setup = v;
      else if (isFeat) { if (v) locks.features[featId] = v; else delete locks.features[featId]; }
    };
    const cur = get();
    let ok = true, holder = null;
    if (action === 'acquire') {
      if (!cur || cur === clientId || force) set(clientId);
      else { ok = false; holder = cur; }
    } else if (action === 'release') {
      if (cur === clientId) set(null);
    }
    const c = clients.get(clientId); if (c) c.lastSeen = Date.now();
    broadcast('locks', locksView());
    return sendJSON(res, { ok, holder, holderName: holder ? nameOf(holder) : null, locks: locksView() });
  }

  if (u.pathname === '/heartbeat' && req.method === 'POST') {
    const { clientId, name, editing } = await readBody(req);
    let c = clients.get(clientId);
    if (!c) { c = { name: name || 'Anon', res: null }; clients.set(clientId, c); }
    c.lastSeen = Date.now();
    if (name) c.name = name;
    c.editing = editing || '';
    return sendJSON(res, { ok: true });
  }

  // static files (pi-planner.html at "/", plus patch.js etc.)
  let rel = u.pathname === '/' ? 'pi-planner.html' : decodeURIComponent(u.pathname.slice(1));
  const fp = path.normalize(path.join(ROOT, rel));
  if (fp.startsWith(ROOT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Graceful shutdown: flush the latest plan, close SSE streams, then exit.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n${sig} received — saving plan and shutting down…`);
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DATA, JSON.stringify(doc, null, 2)); } catch (e) { console.error('final save failed:', e.message); }
  clients.forEach(c => { if (c.res) { try { c.res.end(); } catch (e) {} } });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();   // don't hang if a socket lingers
}
process.on('SIGINT', () => shutdown('SIGINT'));    // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM'));  // kill <PID>

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — a PI Planner server is probably already running.`);
    console.error(`  • Just open it:           http://localhost:${PORT}`);
    console.error(`  • Or free the port:       lsof -ti:${PORT} | xargs kill`);
    console.error(`  • Or use another port:    PORT=${(+PORT) + 1} node pi-server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`PI Planner collab server running.`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<this-machine-ip>:${PORT}   (share this with your team)`);
  console.log(`  Plan saved to: ${DATA}`);
});
