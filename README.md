# PI Planner

A lightweight, single-file tool for **SAFe Program Increment (PI) planning** — quarterly planning across multiple SCRUM teams. Break prioritized features into stories (PBIs), estimate Dev and QA effort, and place them into sprints against each team's real capacity.

No install, no server, no build step. It's one HTML file you open in a browser.

---

## Quick start

1. Open `pi-planner.html` in any modern browser (double-click it).
2. The app loads with sample data so you can explore immediately.
3. Edit the data, plan your PI, and it auto-saves in the browser as you go.
4. Use **Export JSON** to keep a copy of the plan as a file; **Import JSON** to load one back.

To start clean, use **Reset** (header) for sample data, or the clear actions in the *Features & PBIs* tab.

---

## What it does

### Setup
- **Sprints** — 3 to 5 per PI. Each sprint is 1, 2, or 3 weeks (default 3).
- **First sprint #** *(optional)* — the number the PI's first sprint starts at; sprint names follow it (e.g. `60` → *Sprint 60, Sprint 61, …*). Leave it blank to start at 1.
- **Working days** — default to `5 × weeks`, but editable per sprint so you can subtract holidays or other non-working time. A *reset* button restores the default.
- **PI start date** *(optional)* — set it and each sprint's start/end dates are calculated automatically (working week is **Sun–Thu**; sprints run back-to-back). The dates show in the sprint table and on the board.
- **Teams & members** — add any number of teams. Each member has a role (**Dev** or **QA**), a **capacity %** (focus factor), and **PTO days per sprint**.

### Features & PBIs
- **Features** — a prioritized, program-level backlog. Drag to reorder; rank 1 is highest priority. A feature is "fully planned" when all its PBIs are placed in a sprint.
- **Plan by feature** — pick a feature on the right, edit its PBIs on the left. Each PBI has a title, a free-text **description**, a **team**, **Dev** and **QA** effort in person-days, an optional **sprint**, and **dependencies**.
- **Dependencies** — a PBI can depend only on other PBIs **within the same feature**.

### Program Board
- Standard SAFe layout: **team swimlanes (rows) × sprint columns**.
- Drag PBIs between cells to plan (dropping into another team's lane reassigns the team).
- Live **Dev** and **QA capacity bars** per team per sprint — they turn **red when demand exceeds the pool**.
- **Auto-fit** greedily packs PBIs by feature priority into the earliest sprint that has room in both pools and respects dependency order. Anything that can't fit is left in the backlog.
- Dependency-order conflicts are flagged in red.

### Other
- **Multiple boards** — keep several PI plans side by side. The **Projects** picker lets you create a board from scratch, **duplicate** an existing one to tweak, filter by name, and delete. Board names are kept unique automatically.
- **Light / dark theme** toggle (header), remembered across sessions.
- **Clear actions** (Features & PBIs tab): *Clear plan* (unassign all sprint placements), *Clear all PBIs*, *Clear all features*.

---

## How capacity is calculated

For each member, in each sprint:

```
available days = sprint working days × (capacity% / 100) − PTO days   (never below 0)
```

Dev and QA are tracked as **separate pools**:

- **Team Dev pool** (per sprint) = sum of available days of the team's Dev members.
- **Team QA pool** (per sprint) = sum of available days of the team's QA members.
- **Dev demand** = sum of `EE-Dev` of PBIs placed in that team/sprint; **QA demand** likewise.

A sprint is over-allocated when demand exceeds the pool for either role.

---

## Data & persistence

- **Auto-save** — the whole plan is saved to the browser (localStorage) on every change. It survives refresh and reopening.
- **Export / Import JSON** — portable backup and sharing. The exported `.json` is the full plan; keep it in this folder for versioning.
- **Theme** is stored separately and is *not* part of an exported plan.

> Note: auto-save is tied to the browser you use. Moving the HTML file to another machine won't carry the in-browser copy — export the JSON to move a plan.

---

## Testing

The planning math (capacity, demand, dependency violations, auto-fit) lives in one self-contained block inside `pi-planner.html`, marked by `==PURE_LOGIC_START==` / `==PURE_LOGIC_END==`. The rest of the app calls it through thin wrappers.

The test suite extracts that exact block and runs it, so tests cover the real shipped code rather than a copy.

```bash
# from the PI Planner folder
node --test
```

`tests/pi-logic.test.js` covers working-day defaults and overrides, capacity math (capacity %, PTO, the non-negative floor, separate Dev/QA pools), dependency-violation detection, and auto-fit behavior — including the invariant that **no team/sprint is ever over-allocated after auto-fit**.

Run it after any change to the logic; a named test will fail if a behavior regresses.

---

## Files

```
PI Planner/
├── pi-planner.html          # the entire app (open this)
├── README.md                # this file
└── tests/
    └── pi-logic.test.js      # unit tests for the planning math (node --test)
```

---

## Scope

Built for capacity-based PI planning with cross-team (within-feature) dependencies. The single HTML file runs standalone (no server). For real-time multi-user planning on a LAN, an **optional** zero-dependency collaboration server is included — see [`server/README.md`](server/README.md). Authentication is out of scope (the server is intended for a trusted network).
