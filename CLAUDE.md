# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A SAFe Program Increment (PI) planning tool. The core app is a single self-contained HTML file (`pi-planner.html`) with no build step — open it directly in a browser. An optional Node.js server (`server/pi-server.js`) adds LAN collaboration via SSE and field-level patches.

## Commands

```bash
# Run the full test suite (from the "PI Planner" folder)
node --test

# Start the collaboration server (default port 4040)
node server/pi-server.js
PORT=4041 node server/pi-server.js

# Run a single test by name
node --test --test-name-pattern="memberAvail"
```

Node ≥ 18 required. No `npm install` needed — zero dependencies.

## Architecture

### Single-file app (`pi-planner.html`)

All UI, state, and planning logic lives in one HTML file. The planning math is isolated in a clearly-marked block:

```
/* ==PURE_LOGIC_START== */
...
/* ==PURE_LOGIC_END== */
```

This block is pure JavaScript with no DOM access. It exports functions via a `module.exports`-style pattern so `tests/pi-logic.test.js` can extract and run the real code (not a copy). If you change the capacity, auto-fit, dependency, or sprint-date logic (`_sprintDates`), keep it inside this block.

The state document holds `piName`, an optional `piStartDate` (YYYY-MM-DD; sprint start/end dates are derived from it via `_sprintDates`, working week Sun–Thu), and the `sprints`/`teams`/`features`/`pbis` arrays. Data is persisted to `localStorage`; Export/Import JSON is the portable format. Multiple boards ("projects") are supported, each under its own `localStorage` key (standalone) or JSON file (server).

### Collaboration server (`server/`)

- **`pi-server.js`** — plain `http` server, no framework. Manages multiple projects (one JSON file each in `server/projects/`). Uses SSE (`/events`) for real-time push. Clients send patches to `/patch`, which applies and broadcasts them.
- **`patch.js`** — shared diff/merge logic (UMD module — runs identically on server via `require` and in the browser via an inline copy in `pi-planner.html`). Sprints/teams/features use whole-object replace-by-id; PBIs use field-level merge so two users can edit the same PBI simultaneously without clobbering each other.
- **`names.js`** — shared unique-board-name logic (`makeUniqueName`), used by the server when creating/duplicating projects and inlined in the browser (`_makeUniqueName`) for the picker and rename.
- **Locking model** — `board`, `setup`, and per-feature locks prevent conflicting edits to section-locked data. Locks are scoped per-project. Stale clients (missed heartbeat > 10 s) are reaped and their locks released.

**Critical invariant:** `patch.js` and `names.js` each have a copy on the server and an inline copy in `pi-planner.html` that must stay in sync — change one, change both. `server/sync.test.js` guards this by extracting the inline copies and asserting behavioral equivalence against the server modules.

### Tests (`tests/pi-logic.test.js`)

Uses Node's built-in `node:test`. Extracts the `PURE_LOGIC` block from `pi-planner.html` at runtime, writes it to a temp file, and `require()`s it — so tests always run the shipped code. Covers: working-day defaults, capacity math (capacity %, PTO, Dev/QA pools), dependency violation detection, the auto-fit invariant (no team/sprint is over-allocated after auto-fit), and sprint date calculation (`_sprintDates`).

The `server/` folder has its own tests (run `node --test` from `server/`): `patch.test.js` (diff/merge incl. `piStartDate`), `names.test.js` (unique naming), and `sync.test.js` (the inline-copy sync guard described above).
