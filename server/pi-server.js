/*
 * PI Planner collaboration server — multi-project support.
 *
 * Runs on one machine on the office LAN. Everyone points their browser at it:
 *     http://<this-machine>:4040
 *
 * Each team's planning lives in a separate project file under server/projects/.
 * Presence and locks are per-project — groups never see each other's cursors.
 *
 * Project endpoints:
 *   GET  /projects              list all projects [{id, name, lastSaved}]
 *   POST /projects              create a new project → {id, doc}
 *   DELETE /projects/:id        delete a project
 *
 * Per-project endpoints (add ?project=<id> to every request; default = "default"):
 *   GET  /                serves pi-planner.html
 *   GET  /events          SSE stream: state, patch, locks, presence
 *   GET  /state           one-shot snapshot
 *   POST /patch           apply + broadcast a field-level patch
 *   POST /lock            acquire/release a lock
 *   POST /heartbeat       keep-alive + presence
 *
 * Start:  node server/pi-server.js     (PORT env var optional, default 4040)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { diffDoc, applyPatch, isEmpty } = require('./patch');
const { makeUniqueName } = require('./names');

const PORT = process.env.PORT || 4040;
const ROOT = path.join(__dirname, '..');
const PROJECTS_DIR = path.join(__dirname, 'projects');
const HEARTBEAT_TTL = 10000;

/* ---------- bootstrap: projects directory + migration ---------- */
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}
// Migrate old single plan.json → projects/default.json
const OLD_DATA = path.join(__dirname, 'plan.json');
if (fs.existsSync(OLD_DATA)) {
  const defaultPath = path.join(PROJECTS_DIR, 'default.json');
  if (!fs.existsSync(defaultPath)) {
    try { fs.copyFileSync(OLD_DATA, defaultPath); console.log('Migrated plan.json → projects/default.json'); }
    catch (e) { console.warn('Migration warning:', e.message); }
  }
}

/* ---------- seed ---------- */
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
    piName: 'New PI Plan',
    piStartDate: '',
    sprintStartNum: '',
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

/* ---------- project ID sanitiser (prevent path traversal) ---------- */
function safeId(id) {
  return String(id || 'default').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
}
function getProjectPath(id) {
  return path.join(PROJECTS_DIR, safeId(id) + '.json');
}

/* ---------- project data: doc + version + save timer ---------- */
const projectData = new Map();   // safeId → {doc, version, saveTimer}

function loadProject(rawId) {
  const id = safeId(rawId);
  if (projectData.has(id)) return projectData.get(id);
  const fp = getProjectPath(id);
  let doc;
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (raw) doc = JSON.parse(raw);
    }
  } catch (e) { console.error(`Could not read project "${id}":`, e.message); }
  if (!doc) doc = seed();
  const proj = { doc, version: 0, saveTimer: null };
  projectData.set(id, proj);
  return proj;
}

function persistProject(rawId) {
  const id = safeId(rawId);
  const proj = projectData.get(id);
  if (!proj) return;
  clearTimeout(proj.saveTimer);
  proj.saveTimer = setTimeout(() => {
    try { fs.writeFileSync(getProjectPath(id), JSON.stringify(proj.doc, null, 2)); }
    catch (e) { console.error(`persist failed for project "${id}":`, e.message); }
  }, 300);
}

function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const id = f.slice(0, -5);
        const fp = path.join(PROJECTS_DIR, f);
        let name = id;
        try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); name = d.piName || id; } catch (e) {}
        const stat = fs.statSync(fp);
        return { id, name, lastSaved: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.lastSaved) - new Date(a.lastSaved));
  } catch (e) { return []; }
}

// Dedupe a project name against every other project — both flushed-to-disk
// and still in memory (created within the last 300 ms save debounce).
function uniqueProjectName(desired) {
  const names = listProjects().map(p => p.name);
  projectData.forEach(proj => { if (proj.doc) names.push(proj.doc.piName); });
  return makeUniqueName(desired, names);
}

/* ---------- per-project runtime: clients + locks + presence ---------- */
const projectRuntime = new Map();   // safeId → {clients: Map, locks: {board, setup, features}}

function getRuntime(rawId) {
  const id = safeId(rawId);
  if (!projectRuntime.has(id)) {
    projectRuntime.set(id, {
      clients: new Map(),
      locks: { board: null, setup: null, features: {} },
    });
  }
  return projectRuntime.get(id);
}

function nameOf(rt, clientId) { const c = rt.clients.get(clientId); return c ? c.name : null; }

function locksView(rt) {
  const feats = {};
  for (const k in rt.locks.features) {
    if (rt.locks.features[k]) feats[k] = { by: rt.locks.features[k], name: nameOf(rt, rt.locks.features[k]) };
  }
  return {
    board: rt.locks.board ? { by: rt.locks.board, name: nameOf(rt, rt.locks.board) } : null,
    setup: rt.locks.setup ? { by: rt.locks.setup, name: nameOf(rt, rt.locks.setup) } : null,
    features: feats,
  };
}

function presenceView(rt) {
  const out = [];
  rt.clients.forEach((c, cid) => out.push({ id: cid, name: c.name, editing: c.editing || '' }));
  return out;
}

function broadcastTo(rawId, event, data) {
  const rt = getRuntime(rawId);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  rt.clients.forEach(c => { if (c.res) { try { c.res.write(payload); } catch (e) {} } });
}

/* ---------- reaper: drop stale clients and release their locks ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [projectId, rt] of projectRuntime) {
    let lk = false, pr = false;
    for (const [clientId, c] of rt.clients) {
      if (now - c.lastSeen > HEARTBEAT_TTL) {
        if (c.res) { try { c.res.end(); } catch (e) {} }
        rt.clients.delete(clientId); pr = true;
        if (rt.locks.board === clientId) { rt.locks.board = null; lk = true; }
        if (rt.locks.setup === clientId) { rt.locks.setup = null; lk = true; }
        for (const k in rt.locks.features) {
          if (rt.locks.features[k] === clientId) { delete rt.locks.features[k]; lk = true; }
        }
      }
    }
    if (lk) broadcastTo(projectId, 'locks', locksView(rt));
    if (pr) broadcastTo(projectId, 'presence', presenceView(rt));
    // Evict empty runtimes to free memory
    if (rt.clients.size === 0 && !rt.locks.board && !rt.locks.setup && Object.keys(rt.locks.features).length === 0) {
      projectRuntime.delete(projectId);
    }
  }
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  /* ---- project management ---- */

  if (u.pathname === '/projects' && req.method === 'GET') {
    return sendJSON(res, listProjects());
  }

  if (u.pathname === '/projects' && req.method === 'POST') {
    const body = await readBody(req);
    const rawId = uid('proj');
    let doc;
    if (body.from) {
      // Duplicate an existing project (deep clone its current doc).
      const src = loadProject(body.from);
      doc = JSON.parse(JSON.stringify(src.doc));
      doc.piName = (doc.piName || 'Plan') + ' (copy)';
    } else {
      doc = seed();
      if (body.name) doc.piName = body.name;
    }
    doc.piName = uniqueProjectName(doc.piName);
    projectData.set(safeId(rawId), { doc, version: 0, saveTimer: null });
    persistProject(rawId);
    return sendJSON(res, { id: rawId, doc }, 201);
  }

  const delMatch = u.pathname.match(/^\/projects\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = safeId(delMatch[1]);
    const proj = projectData.get(id);
    if (proj) clearTimeout(proj.saveTimer);
    projectData.delete(id);
    projectRuntime.delete(id);
    const fp = getProjectPath(id);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
    return sendJSON(res, { ok: true });
  }

  /* ---- per-project endpoints ---- */
  const projectId = u.searchParams.get('project') || 'default';

  if (u.pathname === '/events') {
    const clientId = u.searchParams.get('clientId') || ('c_' + Math.random().toString(36).slice(2, 9));
    const name = u.searchParams.get('name') || 'Anon';
    const proj = loadProject(projectId);
    const rt = getRuntime(projectId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    const existing = rt.clients.get(clientId);
    rt.clients.set(clientId, { name: existing ? existing.name : name, lastSeen: Date.now(), res, editing: existing ? existing.editing : '' });
    res.write(`event: state\ndata: ${JSON.stringify({ version: proj.version, doc: proj.doc, locks: locksView(rt), presence: presenceView(rt) })}\n\n`);
    broadcastTo(projectId, 'presence', presenceView(rt));
    req.on('close', () => { const c = rt.clients.get(clientId); if (c && c.res === res) c.res = null; });
    return;
  }

  if (u.pathname === '/state') {
    const proj = loadProject(projectId);
    const rt = getRuntime(projectId);
    return sendJSON(res, { version: proj.version, doc: proj.doc, locks: locksView(rt), presence: presenceView(rt) });
  }

  if (u.pathname === '/patch' && req.method === 'POST') {
    const { clientId, patch } = await readBody(req);
    const proj = loadProject(projectId);
    const rt = getRuntime(projectId);
    if (patch && !isEmpty(patch)) {
      applyPatch(proj.doc, patch); proj.version++; persistProject(projectId);
      broadcastTo(projectId, 'patch', { version: proj.version, patch, by: clientId });
    }
    const c = rt.clients.get(clientId); if (c) c.lastSeen = Date.now();
    return sendJSON(res, { version: proj.version });
  }

  if (u.pathname === '/lock' && req.method === 'POST') {
    const { clientId, scope, action, force } = await readBody(req);
    const rt = getRuntime(projectId);
    const isFeat = scope && scope.startsWith('feature:');
    const featId = isFeat ? scope.slice('feature:'.length) : null;
    const get = () => scope === 'board' ? rt.locks.board : scope === 'setup' ? rt.locks.setup : (isFeat ? rt.locks.features[featId] : undefined);
    const set = v => {
      if (scope === 'board') rt.locks.board = v;
      else if (scope === 'setup') rt.locks.setup = v;
      else if (isFeat) { if (v) rt.locks.features[featId] = v; else delete rt.locks.features[featId]; }
    };
    const cur = get();
    let ok = true, holder = null;
    if (action === 'acquire') {
      if (!cur || cur === clientId || force) set(clientId);
      else { ok = false; holder = cur; }
    } else if (action === 'release') {
      if (cur === clientId) set(null);
    }
    const c = rt.clients.get(clientId); if (c) c.lastSeen = Date.now();
    broadcastTo(projectId, 'locks', locksView(rt));
    return sendJSON(res, { ok, holder, holderName: holder ? nameOf(rt, holder) : null, locks: locksView(rt) });
  }

  if (u.pathname === '/heartbeat' && req.method === 'POST') {
    const { clientId, name, editing } = await readBody(req);
    const rt = getRuntime(projectId);
    let c = rt.clients.get(clientId);
    if (!c) { c = { name: name || 'Anon', res: null }; rt.clients.set(clientId, c); }
    c.lastSeen = Date.now();
    if (name) c.name = name;
    c.editing = editing || '';
    return sendJSON(res, { ok: true });
  }

  // Static files (pi-planner.html at "/", plus patch.js etc.)
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

/* ---------- graceful shutdown: flush all projects ---------- */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n${sig} received — saving all projects and shutting down…`);
  for (const [id, proj] of projectData) {
    clearTimeout(proj.saveTimer);
    try { fs.writeFileSync(getProjectPath(id), JSON.stringify(proj.doc, null, 2)); }
    catch (e) { console.error(`final save failed for project "${id}":`, e.message); }
  }
  projectRuntime.forEach(rt => rt.clients.forEach(c => { if (c.res) { try { c.res.end(); } catch (e) {} } }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — a PI Planner server is probably already running.`);
    console.error(`  • Just open it:     http://localhost:${PORT}`);
    console.error(`  • Or free the port: lsof -ti:${PORT} | xargs kill`);
    console.error(`  • Or another port:  PORT=${(+PORT) + 1} node pi-server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`PI Planner collab server running.`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://<this-machine-ip>:${PORT}   (share with your teams)`);
  console.log(`  Projects: ${PROJECTS_DIR}`);
});
