# PI Planner — collaboration server

Turns the single-file PI Planner into a **multi-user, real-time tool for one office network**. Zero npm dependencies — just Node 18+.

## Run it

```bash
cd "PI Planner/server"
node pi-server.js          # or: npm start
```

You'll see:

```
PI Planner collab server running.
  Local:   http://localhost:4040
  Network: http://<this-machine-ip>:4040   (share this with your team)
```

Find this machine's LAN IP (e.g. `192.168.1.20`) and give teammates `http://192.168.1.20:4040`. Everyone opens that URL — the server serves the app itself, so there's nothing to install on their side.

Change the port with `PORT=8080 node pi-server.js`.

## How collaboration works

- **The server holds the one canonical plan** (`plan.json`, written on every change). It replaces per-browser localStorage as the source of truth.
- **Feature breakdown is parallel.** Opening a feature in *Features & PBIs* acquires a lock on *that feature only*. Two people editing different features never conflict; PBI edits sync live.
- **Program Board and Setup are single-writer.** One person "drives"; everyone else sees a live read-only view with a **Take over** button.
- **Edits sync field-by-field**, so the board driver moving a PBI and a feature editor renaming the same PBI don't clobber each other.
- **Locks self-heal.** Each browser sends a heartbeat every 3s; if it stops (closed tab, crash, lost wifi) the server releases that person's locks within ~10s.
- **Presence**: avatars in the header show who's connected and what each person is editing.

Open the same URL in two browser tabs to try it — each tab is treated as a separate user.

## Standalone still works

Opening `pi-planner.html` directly (double-click, `file://`) runs the original single-user, localStorage app unchanged. The collaboration layer only activates when the page is served over http(s) by this server.

## Backup

`plan.json` in this folder is the live plan. Copy it to back up; the in-app **Export JSON** also still works.

## Endpoints (for reference)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | serves `pi-planner.html` |
| GET | `/events` | SSE stream (state, patch, locks, presence) |
| GET | `/state` | one-shot snapshot |
| POST | `/patch` | apply a field-level change |
| POST | `/lock` | acquire / release / force-take a lock |
| POST | `/heartbeat` | keep-alive + presence |

## Tests

```bash
cd "PI Planner/server"
node --test        # diff/merge logic, incl. the concurrent-edit merge case
```
