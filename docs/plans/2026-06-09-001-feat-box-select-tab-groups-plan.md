---
title: "feat: Box-Select → Tab Group browser extension"
type: feat
status: completed
date: 2026-06-09
origin: docs/brainstorms/2026-06-09-box-select-tab-groups-requirements.md
---

# feat: Box-Select → Tab Group browser extension

## Overview

A Plasmo (MV3, Chromium) extension that lets the user arm a "box-select" mode
from the toolbar, drag a rectangle over any region of a page, and open every
link inside that box as one named Chrome tab group. The canonical use case is a
GitHub issue listing a stack of PR links; the mechanism is generic and GitHub
context only enriches the group name.

The work splits cleanly across two extension surfaces Plasmo supports
first-class: a **content script (CSUI)** that owns the on-page interaction
(overlay, live highlight, confirm popup), and a **background service worker**
that owns activation (`chrome.action.onClicked`) and the privileged tab work
(`chrome.tabs` / `chrome.tabGroups`). They communicate over Chrome's native
runtime messaging — `chrome.tabs.sendMessage` for background→content arm/disarm,
`chrome.runtime.sendMessage` for the single content→background create request
(with one message type the raw API is simpler than `@plasmohq/messaging`).

## Problem Frame

Opening and grouping a cluster of related links by hand is tedious — most
acutely when reviewing a stack of PRs linked from a GitHub issue (e.g.
`acme/api#409` → PRs #410–#417). A box-select gesture turns "open
these 8 links and group them" into one drag. (see origin:
`docs/brainstorms/2026-06-09-box-select-tab-groups-requirements.md`)

## Requirements Trace

Carried from the origin requirements doc:

- R0. Add `tabs` + `tabGroups` to the manifest permission override.
- R1. Single toolbar button arms box-select mode (crosshair); armed-state visual on the icon.
- R2. Drag a rectangle over any region (mousedown → move → up).
- R3 / R3a. Cancelable (Esc / re-click) with synchronous UI cleanup; armed mode scoped to the arming tab.
- R4 / R4a. Capture `<a>` intersecting the box; viewport-bound; pre-filter non-content anchors.
- R5. Live blue-ring highlight on captured links.
- R6. Only http/https; ignore `javascript:`/`mailto:`/`#`/empty; dedupe within selection.
- R7 / R7a. Contextual confirm popup beside the box with edge collision-resolution; zero-link → suppress, no empty group.
- R8. Popup checklist with count header, internal scroll, high-count warning.
- R9. Open each link as a fresh background tab; await all creates → collect IDs → group.
- R10. Wrap into a single group with a deterministic color.
- R11. Name via fallback chain: GitHub issue/PR source → `repo #issue`; else title → host → "Tab Group".
- R12. Tabs keep native titles (no per-tab renaming in v1).

## Scope Boundaries

- Not GitHub-only — GitHub context only enriches naming.
- No per-tab renaming, no reuse/dedupe against already-open tabs, no saving/restoring groups.
- Single window; Chromium only.
- Top document only — links inside iframes / shadow DOM are out of scope (v1).
- No autoscroll / multi-screen selection — capture is viewport-bound (v1).

### Deferred to Separate Tasks

- Per-tab renaming to `[repo #N] title` (origin §Scope Boundaries) — future iteration; requires injecting `document.title` and fighting GitHub's SPA title updates.

## Context & Research

### Relevant Code and Patterns

- `package.json` — current scaffold: `plasmo@0.90.5`, `react@18`; manifest override has only `host_permissions: ["https://*/*"]`; no content script or background yet.
- `popup.tsx` — the default scaffold popup. Its presence makes Plasmo emit `default_popup`, which suppresses `chrome.action.onClicked`. **Removed in Unit 1.**
- No `docs/solutions`, `AGENTS.md`, or prior plans — greenfield.

### External References

- Plasmo CSUI (`content.tsx` + `PlasmoCSConfig`) mounts React into a style-isolated **Shadow DOM**; `getStyle` injects CSS into the shadow root. _(Context7 /plasmohq/docs)_
- Plasmo background: a single `background/index.ts` is the service-worker entry. IPC uses Chrome's native messaging — note **`@plasmohq/messaging`'s `sendToBackground` is content→background only**, so background→content arming must use `chrome.tabs.sendMessage(tabId, …)`. _(Context7 /plasmohq/docs)_
- Chrome APIs: `chrome.tabs.create({url, active:false})`, `chrome.tabs.group({tabIds})`, `chrome.tabGroups.update(groupId, {title, color})`. `color` ∈ a fixed enum (grey, blue, red, yellow, green, pink, purple, cyan, orange). `tabGroups` requires MV3 + Chromium.

## Key Technical Decisions

- **Remove `popup.tsx`; arm via `chrome.action.onClicked`** — one click = armed (R1). _(see origin: Key Decisions → Activation)_ `onClicked` fires on **every** tab, so the handler must **guard `tab.url`** — skip restricted schemes (`chrome://`, `chrome-extension://`, the web store, `view-source:`, `file:`, non-`https`) — and **roll back the armed flag + badge if the arm message can't be delivered** (tabs opened before the extension installed/updated have no content script yet and need a reload).
- **Native messaging, per direction:** background→content `arm`/`disarm` via `chrome.tabs.sendMessage(tabId, …)` (the `tabId` comes from the `onClicked` tab arg); content→background `createTabGroup` via `chrome.runtime.sendMessage` answered by a `chrome.runtime.onMessage` handler in `background/index.ts`. No `@plasmohq/messaging`.
- **CSUI Shadow DOM for the overlay/box/popup** — style-isolated, high `z-index`, captures pointer events only during a drag. **Caveat:** the highlight is set on the host page's own `<a>` elements (outside the shadow root) — the one thing that _cannot_ be isolated. Use `outline` + `outline-offset` (ignores ancestor `overflow:hidden` clipping) or record-and-restore each anchor's prior inline style in teardown.
- **Background owns armed-state + badge + tab orchestration; content owns interaction + naming.** The content script computes the group name (`window.location` + `document.title`) and passes it in the create message. Armed-state is a single `armed: tabId | null` (single-window scope), not a `Record`. The badge is **per-tab**: `setBadgeText({ text, tabId })` on both set and clear.
- **Async tab grouping**: `Promise.allSettled(create…)` → collect _fulfilled_ tab IDs → `chrome.tabs.group` only if ≥1 (R9). This matches the accepted partial-open behavior; `Promise.all` would reject the whole batch on the first failed `create` and group nothing.
- **Deterministic group color**: `nextGroupColor` stays **pure** (index in → color out); the counter is persisted in `chrome.storage.session` so cycling survives SW idle/restart instead of resetting to the first color mid-session.
- **Pure logic extracted to `lib/` and unit-tested with Vitest**; interactive overlay/drag and background orchestration verified by load-unpacked manual runs (and optionally Playwright). Vitest + jsdom added in Unit 1.

### Resolved planning defaults (origin "Deferred to Planning")

- Cancel gesture: **both** `Esc` and toolbar re-click.
- Group name template: **`{repo} #{issueNumber}`** (e.g. `api #409`).
- No-text link rendering in popup: show **truncated href** (`host + pathname`, …-elided).
- High-count warning threshold: **> 15** captured links.
- Dedupe href normalization: strip trailing slash and `#fragment`; **keep** query string.
- Partial-open failures (popup-blocked / 404 / no-access): **accepted** — those tabs still join the group; no special handling in v1.

## Open Questions

### Deferred to Implementation

- Exact pre-filter predicate for "non-content" anchors (zero-size rect vs. also no-text) — tune against real GitHub pages during implementation.
- Whether a small drag-threshold (e.g. ignore <5px drags) is needed to avoid accidental click-arms — decide when testing the drag handler.
- Final shadow-root `z-index` value that survives the messiest real pages — empirical.
- Whether to add a `chrome.scripting.executeScript` fallback so already-open tabs can be armed without a manual reload — deferred; v1 documents the reload and rolls back the badge on delivery failure.

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```mermaid
sequenceDiagram
    participant U as User
    participant BG as Background SW
    participant CS as Content script (CSUI)
    participant Chrome as chrome.tabs/tabGroups

    U->>BG: click toolbar icon (action.onClicked)
    BG->>BG: guard tab.url; armed = tabId; setBadgeText("ON", {tabId})
    BG->>CS: chrome.tabs.sendMessage "arm" (rollback armed+badge if no receiver)
    CS->>CS: crosshair + overlay; mousedown→move→up (rAF-throttled capture)
    CS->>CS: live capture (intersect + filter) + outline highlight
    U->>CS: mouse up
    CS->>CS: snapshot hrefs; render confirm popup beside box (edge-aware)
    alt zero links
        CS->>CS: flash box, exit (no message)
        CS->>BG: chrome.runtime "disarm"
    else >=1 link
        U->>CS: confirm (checklist) — button disables, shows "Opening N…"
        CS->>BG: chrome.runtime.sendMessage "createTabGroup" {links, groupName}
        BG->>Chrome: allSettled creates → fulfilled IDs → group(≥1) → title+color
        BG->>CS: result (ok / partial / fail)
        CS->>BG: "disarm"
    end
    BG->>BG: clear per-tab badge
```

## Output Structure

    .
    ├── background/
    │   └── index.ts                 # onClicked (guarded), armed-state, per-tab badge,
    │                                # tab-switch reset, onMessage createTabGroup handler
    ├── contents/
    │   └── box-select.tsx           # CSUI: arm listener, overlay, drag, capture, highlight, popup
    ├── lib/
    │   ├── capture.ts               # rect intersect, link filtering, dedupe
    │   ├── capture.test.ts
    │   ├── naming.ts                # GitHub detection + group-name fallback chain
    │   ├── naming.test.ts
    │   ├── color.ts                 # pure group-color cycling (counter in chrome.storage.session)
    │   └── color.test.ts
    ├── popup.tsx                     # REMOVED
    └── package.json                 # +perms (tabs, tabGroups), +vitest/jsdom (no messaging dep)

## Implementation Units

- [x] **Unit 1: Project setup — manifest, deps, remove popup, test harness**

**Goal:** Prepare the scaffold so the rest of the work can build: correct permissions, test dependencies, no `default_popup`.

**Requirements:** R0, activation decision, R12 (no per-tab rename — no extra deps).

**Dependencies:** None.

**Files:**

- Modify: `package.json` (manifest `permissions: ["tabs", "tabGroups"]` added to the existing override; add `vitest` + `jsdom` dev deps + a `test` script — no runtime messaging dependency)
- Delete: `popup.tsx`
- Create: `vitest.config.ts` (or config block) with jsdom environment

**Approach:**

- Keep `host_permissions: ["https://*/*"]`; add `tabs` + `tabGroups` permissions.
- Deleting `popup.tsx` removes `default_popup` from the generated manifest so `chrome.action.onClicked` fires.

**Test scenarios:** Test expectation: none — configuration/scaffolding only. Verification is structural.

**Verification:**

- `pnpm build` (or `plasmo build`) succeeds; generated manifest contains `tabs`, `tabGroups`, no `default_popup`, no `action.default_popup`.
- `pnpm test` runs Vitest (zero tests is fine at this point).

---

- [x] **Unit 2: Pure logic library — capture geometry, filtering, naming, color**

**Goal:** Implement and unit-test the deterministic core in isolation from the DOM/Chrome APIs.

**Requirements:** R4, R4a, R6, R10, R11.

**Dependencies:** Unit 1.

**Files:**

- Create: `lib/capture.ts`, `lib/capture.test.ts`
- Create: `lib/naming.ts`, `lib/naming.test.ts`
- Create: `lib/color.ts`, `lib/color.test.ts`

**Approach:**

- `capture.ts`: `rectsIntersect(a, b)`; `isEligibleHref(href)` (http/https only; reject `javascript:`/`mailto:`/`#`-only/empty); `normalizeHref(href)` (strip trailing slash + fragment, keep query); `dedupe(hrefs)`. Operates on plain rect/string inputs — no DOM dependency, so it's directly testable.
- `naming.ts`: `deriveGroupName({url, title})` → GitHub issue/PR URL ⇒ `{repo} #{issue}`; else `title` (non-empty) ; else `hostname` ; else `"Tab Group"`. GitHub regex matches `github.com/{org}/{repo}/(issues|pull)/{n}`.
- `color.ts`: `nextGroupColor(counter)` cycling the Chrome group-color enum.

**Patterns to follow:** None local (greenfield) — keep functions pure and side-effect free for testability.

**Test scenarios:**

- Happy path (`capture`): two overlapping rects → intersect true; disjoint rects → false; edge-touching rects → true (intersect semantics).
- Edge case (`capture`): `isEligibleHref` rejects `"javascript:void(0)"`, `"mailto:a@b.com"`, `"#"`, `""`, `"#section"`; accepts `"https://x"`, `"http://x"`.
- Edge case (`capture`): `normalizeHref("https://x/p/")` === `normalizeHref("https://x/p")`; fragment stripped; `?q=1` preserved; dedupe collapses normalized duplicates, preserves order.
- Happy path (`naming`): `https://github.com/acme/api/issues/409` → `"api #409"`; `.../pull/410` → `"api #410"`.
- Edge case (`naming`): non-GitHub URL with title → title; empty title → hostname; `about:blank`/no host → `"Tab Group"`.
- Edge case (`naming`): GitHub URL that is NOT an issue/PR (e.g. `/search?q=`) → falls through to title/host, not step 1.
- Happy path (`color`): `nextGroupColor` cycles through the full enum and wraps to the start.

**Verification:** `pnpm test` green; all branches of the fallback chain and filter covered.

---

- [x] **Unit 3: Background — activation, armed-state, badge, tab-group creation**

**Goal:** Wire the toolbar click to arm/disarm with a badge, scope armed-state per tab, and implement the privileged tab-group creation handler.

**Requirements:** R1 (badge), R3a (tab-scoped), R9, R10, R11 (consumes precomputed name), tab-open→group sequencing.

**Dependencies:** Unit 1, Unit 2 (`lib/color`).

**Files:**

- Create: `background/index.ts` — all background logic:
  - `chrome.action.onClicked(tab => …)`: guard `tab.url` (skip restricted schemes / non-`https`); set `armed = tab.id` + `setBadgeText({ text: "ON", tabId })`; `chrome.tabs.sendMessage(tab.id, { type: "arm" })` with `.catch` → roll back `armed` + badge (no content script in that tab). A second click on the armed tab disarms.
  - `chrome.tabs.onActivated` / `onRemoved`: clear `armed` + the per-tab badge.
  - `chrome.runtime.onMessage`: handle `createTabGroup` (`{ links, groupName }`) and the content script's `disarm` notification.

**Approach:**

- `createTabGroup`: `const results = await Promise.allSettled(links.map(url => chrome.tabs.create({ url, active: false })))` → collect `id`s from fulfilled results → if ≥1, `chrome.tabs.group({ tabIds })` → `chrome.tabGroups.update(groupId, { title: groupName, color })`. The color index is read from `chrome.storage.session`, passed to the pure `nextGroupColor`, and the incremented value written back, so cycling survives SW restarts. Empty / all-failed → no-op (no empty-group error). Return a result `{ ok, opened, failed }` to the caller.
- Armed-state is a single in-memory `armed: tabId | null`; losing it on SW idle is benign because `createTabGroup` is self-contained (it carries its own links + name and reads no armed-state). Badge is per-tab via `setBadgeText({ tabId })`.

**Patterns to follow:** Plasmo single-file `background/index.ts` service-worker entry (Context7).

**Test scenarios:**

- Happy path: handler receives 3 links → 3 `chrome.tabs.create` → `chrome.tabs.group` once with all 3 IDs → `tabGroups.update` sets title + a color. _(chrome APIs mocked)_
- Edge case: empty `links` (and: all creates reject) → no `tabs.group`/`update` call (no empty-group error).
- Error path: one `tabs.create` rejects → `Promise.allSettled` keeps the successful IDs; the group still forms from those (accepted partial-open behavior).
- Integration: `onClicked` on an `https` tab sets the per-tab badge + sends `arm`; a second click disarms + clears the badge; `tabs.onActivated` to another tab clears the previous tab's badge.
- Error path: `arm` send rejects (no content-script receiver) → `armed` + badge roll back, so the icon never shows a stuck "ON".
- Edge case: `onClicked` on a `chrome://` / web-store / non-`https` tab → no arm, no badge (URL guard).
- Edge case: color counter persisted across a simulated SW restart → the next group gets the next color, not a reset to the first.

**Verification:** With chrome mocks, the create→group→update ordering holds and never groups an empty set; manual load-unpacked shows the badge toggling and a group forming.

**Execution note:** Implement the `createTabGroup` ordering test-first — the create→collect→group sequence is the highest-risk correctness path.

---

- [x] **Unit 4: Content script — armed mode, overlay, box drawing, capture + highlight**

**Goal:** The on-page interaction up to (not including) the confirm popup: enter armed mode, draw the selection box, live-capture and highlight intersecting links, and cancel cleanly.

**Requirements:** R1 (crosshair), R2, R3, R3a, R4, R4a, R5, R6.

**Dependencies:** Unit 2 (`lib/capture`), Unit 3 (arm/disarm messages exist).

**Files:**

- Create: `contents/box-select.tsx` (`PlasmoCSConfig` `matches: ["https://*/*"]`; `getStyle` for shadow-root CSS)

**Approach:**

- Listen via `chrome.runtime.onMessage` for `arm`/`disarm`. On `arm`: set `cursor: crosshair` on `documentElement`, mount a fixed full-viewport overlay (high z-index) inside the CSUI shadow root.
- **At `mousedown`**, snapshot candidate anchors once: `document.querySelectorAll("a[href]")` → keep those passing `isEligibleHref`, caching each `getBoundingClientRect()` (rects are stable during a viewport-bound, non-scrolling gesture). Avoids re-querying the DOM and forcing layout on every move.
- `mousemove` (**rAF-throttled**) → update the box rect → intersect against the _cached_ rects via `lib/capture`, pre-filter zero-size/no-text anchors, dedupe by normalized href → apply the highlight (`outline` + `outline-offset`, recording each anchor's prior inline value) to the captured set, remove from the rest.
- Capture is viewport-bound; no autoscroll.
- **Gesture-completion robustness:** bind `mouseup`/`pointerup` + `pointercancel` on `window` (capture phase) and a `blur` handler so a release outside the box/window still finalizes rather than freezing the box. Bind the `Esc` keydown on `window` in the **capture** phase so page handlers can't swallow it.
- At `mouseup`, **snapshot the captured hrefs** (strings, not live element refs) so later DOM churn can't change what gets opened.
- Cancel paths (`Esc`, toolbar re-click → `disarm`, window blur): one centralized teardown removes overlay/box, restores every anchor's prior `outline`, restores cursor, and sends `disarm`. Every exit path calls it.
- Mode lives only while this tab is armed (background drives arm/disarm on tab switch).

**Patterns to follow:** Plasmo CSUI with `getStyle` (Context7); single teardown function pattern for cleanup symmetry.

**Test scenarios:**

- Happy path: drag a box over a list of 4 eligible links (jsdom with stubbed `getBoundingClientRect`) → exactly those 4 enter the captured set and receive the ring class.
- Edge case: box also overlaps a `mailto:` link and a duplicate href → filtered out / collapsed; ring not applied.
- Edge case: shrinking the box removes rings from links no longer intersected (live recompute).
- Edge case: zero eligible links under the box → captured set empty (handoff to Unit 5's suppression).
- Integration: `Esc` during a drag → teardown removes overlay + every highlight, cursor restored, `disarm` sent (cleanup symmetry, R3).
- Edge case: `mouseup` outside the box / a `window` `blur` mid-drag → the gesture finalizes (or cancels) deterministically rather than leaving a frozen box.
- Integration: teardown restores each highlighted anchor's _prior_ inline `outline` (no residual styling left on the page).
- Edge case: a captured anchor is removed from the DOM between mousedown and mouseup → the snapshotted hrefs are unaffected; teardown skips the detached node.

**Verification:** Manual load-unpacked on GitHub issue #409: arming shows crosshair; dragging over the PR-stack region highlights exactly the PR links; Esc fully clears the page.

---

- [x] **Unit 5: Confirm popup — checklist, edge placement, zero-link guard, submit**

**Goal:** On mouse-up, present the captured links for confirmation and hand the selected set to the background.

**Requirements:** R7, R7a, R8, R11 (compute name client-side), R9 (trigger).

**Dependencies:** Unit 4 (captured set), Unit 3 (`createTabGroup` handler), Unit 2 (`lib/naming`).

**Files:**

- Modify: `contents/box-select.tsx` (popup component + submit)

**Approach:**

- On mouse-up with ≥1 captured link: render a popup inside the shadow root anchored beside the box; placement collision-resolves (prefer right → flip left → below → clamp to viewport). Checklist of links (checkbox + truncated `host + pathname` label), a count header ("N links"), `max-height` + internal scroll, and a caution line when N > 15.
- **Confirm-button states:** when every checkbox is unchecked, disable Confirm and show "0 links". On Confirm, immediately disable the button and show an in-progress label ("Opening N…") so a second click can't fire a duplicate batch.
- On mouse-up with 0 captured links (R7a): skip the popup, flash the box a distinct color briefly, tear down, send `disarm`. Never message `createTabGroup`.
- Confirm → compute `deriveGroupName({ url: location.href, title: document.title })` (`lib/naming`) → `chrome.runtime.sendMessage({ type: "createTabGroup", links: <checked>, groupName })` and **await the background's result**. On success → tear down + `disarm`. On reported failure → surface an inline error in the popup (don't tear down silently). Dismiss/Esc → tear down + `disarm`, no message.

**Patterns to follow:** Reuse Unit 4's single teardown function for every popup exit.

**Test scenarios:**

- Happy path: 3 captured links, all checked, confirm → `chrome.runtime.sendMessage` called once with those 3 hrefs and the derived group name.
- Edge case: user unchecks 2 of 3 → only the 1 checked link is sent.
- Edge case: all checkboxes unchecked → Confirm disabled, header reads "0 links".
- Edge case: clicking Confirm twice quickly → only one `createTabGroup` message (button disabled + in-progress after the first click).
- Edge case (R7a): 0 captured links → popup never renders, no message, box flashes, mode exits.
- Edge case: N = 20 → count header reads "20 links" and the high-count caution is shown; list scrolls rather than overflowing.
- Edge case: box drawn flush to the right/bottom viewport edge → popup flips/clamps inside the viewport.
- Error path: background reports a failure → popup shows an inline error and does not silently tear down.
- Integration: confirm path tears down all on-page UI and sends `disarm` (no lingering highlight/overlay after submit).

**Verification:** Manual load-unpacked on issue #409: box the PR stack → popup lists the PRs with a count → confirm → a single tab group named `api #409` appears containing the PR tabs; page is clean afterward.

## System-Wide Impact

- **Interaction graph:** `action.onClicked` → (guarded) `chrome.tabs.sendMessage` arm/disarm → content; content → `chrome.runtime.sendMessage` createTabGroup/disarm → background. `tabs.onActivated`/`onRemoved` clear `armed` + per-tab badge.
- **Activation reachability:** `onClicked` fires on every tab, but the content script only exists on `https` tabs loaded _after_ install/update. The URL guard + arm-delivery rollback prevent a stuck "ON" badge on restricted or pre-existing tabs; those need a reload (documented).
- **Error propagation:** `tabs.create` failures are tolerated via `allSettled` (partial group). The content script guarantees a non-empty set before messaging; the handler no-ops on empty/all-failed and returns a result the popup can surface.
- **State lifecycle risks:** `armed` and the color counter would reset on SW idle — `armed` loss is benign (createTabGroup is self-contained), and the color counter is persisted to `chrome.storage.session`. Teardown must be symmetric across every exit path (Esc / dismiss / confirm / tab switch / window blur) or the overlay and host-anchor outlines leak onto the page.
- **API surface parity:** Single activation path (toolbar). No other entry points in v1.
- **Unchanged invariants:** Beyond removing `popup.tsx`, scaffold behavior is unchanged; `host_permissions` stays `https://*/*`, so the content script does not run on `http://` pages.

## Risks & Dependencies

| Risk                                                                                          | Mitigation                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay/highlight fights real pages (z-index, sticky chrome) — the make-or-break product risk | CSUI Shadow DOM isolates the overlay; validate early on a few messy real pages (GitHub, a dashboard) before polishing later units.           |
| Highlight can't be shadow-isolated (it's on host `<a>`s)                                      | Use `outline`/`outline-offset` (ignores ancestor `overflow:hidden` clipping); record + restore each anchor's prior inline value in teardown. |
| Arm on a restricted or pre-existing tab → stuck "ON" badge, no crosshair                      | Guard `tab.url` scheme; roll back `armed` + badge if the arm message has no receiver; document "reload pre-existing tabs after install".     |
| `Promise.all` would reject the whole create batch on one failure                              | Use `Promise.allSettled`, group the fulfilled IDs, no-op on all-failed (Unit 3).                                                             |
| Intersect capture grabs nav/sticky links                                                      | Pre-filter zero-size/no-text anchors; the popup checklist is the final safeguard (R4a/R8).                                                   |
| Per-move `querySelectorAll` + reflow janks large pages                                        | Cache anchors + rects at mousedown; rAF-throttle the intersection recompute (Unit 4).                                                        |
| Mouse released outside the window freezes the box                                             | Bind `pointerup`/`pointercancel`/`blur` on `window` (capture) to finalize the gesture (Unit 4).                                              |
| Color cycling resets when the SW idles                                                        | Persist the counter in `chrome.storage.session`; keep `nextGroupColor` pure.                                                                 |
| Tab title not loaded when naming                                                              | Group name derives from the _source_ page, not the opened tabs — no tab-load dependency.                                                     |
| Teardown asymmetry leaks overlay/outlines onto the page                                       | One centralized teardown invoked by every exit path (Units 4–5).                                                                             |

## Documentation / Operational Notes

- Update `README.md` with load-unpacked dev instructions and the box-select usage once Unit 5 lands.
- Chrome-only; note this if the extension is ever published.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-09-box-select-tab-groups-requirements.md](docs/brainstorms/2026-06-09-box-select-tab-groups-requirements.md)
- Plasmo docs (CSUI, background, native messaging) via Context7 `/plasmohq/docs`
- Chrome Extensions: `chrome.tabs.group`, `chrome.tabGroups` (MV3, Chromium)
- Motivating example: `https://github.com/acme/api/issues/409`
