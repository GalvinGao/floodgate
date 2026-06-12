---
title: "feat: GitHub PR status in the favicon"
type: feat
status: completed
date: 2026-06-09
origin: docs/brainstorms/2026-06-09-pr-status-favicon-requirements.md
---

# feat: GitHub PR status in the favicon

## Overview

Encode a GitHub PR's **review** status and **check** status into the favicon of
its tab, so you can scan a strip of PR tabs (e.g. a stack opened by box-select)
and see which are approved/passing without clicking in. A background worker
fetches status from the GitHub GraphQL API with a user-provided token and
pushes it to a GitHub-PR content script that draws the favicon. Configuration
(the token) lives on a new Options page.

## Problem Frame

GitHub shows neither review nor check status in the favicon. When many PR tabs
are open, telling their state apart means clicking each one. This surfaces both
states in the tab icon. (see origin:
`docs/brainstorms/2026-06-09-pr-status-favicon-requirements.md`)

## Requirements Trace

- R0. Add the `alarms` permission to the manifest.
- R1. Act only on `github.com/{owner}/{repo}/pull/{number}` (incl. `/files`,`/commits`,`/checks` subtabs); not `github.dev`/gist; re-evaluate on SPA nav.
- R2. One GraphQL query per fetch (`reviewDecision`, head-commit `statusCheckRollup.state`, `state`, `isDraft`); fetch in the background; only **derived status** (never the token) crosses to the content script.
- R3 / R3a. Options page stores/validates/clears the PAT in `chrome.storage.local`; token stays in the background; endpoint hard-coded to `api.github.com`.
- R4. No token → silent no-op.
- R5 / R5a. Fail silent on the page, but surface auth/token errors discoverably (action badge + Options page).
- R6. Capture + replace the favicon with a canvas data-URI encoding A+B; show a "fetching" state first.
- R7 / R7a. Re-assert via a self-guarded, debounced `<head>` MutationObserver; restore the original favicon on SPA nav-away / token-clear / teardown.
- R8 / R8a. Draw on load (not focus-gated); `chrome.alarms` poll (~60s floor + jitter) while not settled; stop when settled (check terminal AND review terminal, or PR closed/merged); pending-set persisted in `chrome.storage.session`.
- R9. Normalize the response so null fields never throw; handle closed/merged/draft.
- R10. Centralize fetching in the background for cross-tab rate-limit safety.
- Encoding: color-blind-safe (shape, not hue alone), validated at 16/32px; distinct "no checks" and "fetching" states.

## Scope Boundaries

- Favicon only; github.com only; single token; no custom colors/glyphs; per-loaded-document only. (see origin §Scope Boundaries)

### Deferred to Separate Tasks

- The `A | B | original-title` **PR title-prefix** idea (the user's original framing) — separate future feature; this plan is favicon-only.

## Context & Research

### Relevant Code and Patterns

- `background/index.ts` — existing SW: `chrome.runtime.onMessage` request/response, `chrome.storage.session`, `chrome.tabs` usage, per-tab `chrome.action` badge. Mirror its messaging + storage patterns; **extend** this file (it already owns the action and message routing).
- `contents/box-select.ts` — existing `https://*/*` content script. It **already runs on PR pages**, so the new favicon content script coexists on the same document and shares the `chrome.runtime` channel. Box-select's current listener returns `undefined` (not `false`) — fine for fire-and-forget. Each listener must **type-discriminate on `message.type`** and ignore unowned types without throwing; background→content pushes use `chrome.tabs.sendMessage(tabId, …)` expecting no response, so box-select simply ignores `prStatus`.
- `lib/*` + Vitest — established pure-logic + unit-test pattern (`lib/capture.ts`, `lib/tab-group.ts` with injected APIs). New pure logic (URL parse, status normalize, settled predicate, render-spec) follows this.
- `lib/messages.ts` — shared message-type shapes; add the new favicon message types here.

### External References (verified during brainstorm)

- GitHub GraphQL: `repository.pullRequest` exposes `reviewDecision`, `state`, `isDraft`, and `commits(last:1){nodes{commit{statusCheckRollup{state}}}}`. _(GitHub GraphQL docs)_
- `chrome.alarms` is the eviction-surviving MV3 timer; **minimum period ~60s** (sub-60s is clamped). _(Chrome extensions docs / feasibility review)_
- Plasmo: `options.tsx` registers `options_ui` (open-in-tab) and does **not** add `default_popup` or alter `chrome.action.onClicked` (box-select activation is unaffected). _(Context7 /plasmohq/docs / feasibility review)_

## Key Technical Decisions

- **Background owns the token, the API, and the poll loop.** The content script never sees the token; it sends "I'm PR X" and receives a normalized status. Endpoint hard-coded to `https://api.github.com/graphql`. _(R2, R3a, R10)_
- **Token in `chrome.storage.local`** (persists; not `sync` = cross-device leak, not `session` = wiped on restart). _(R3)_
- **`chrome.alarms`-driven central poll**, one alarm tick re-fetches all not-yet-settled registered PR tabs; jitter per-PR; pending registry persisted in `chrome.storage.session` so it survives SW eviction; back off on rate-limit. _(R8a, R10)_
- **Pure render-spec, imperative draw.** `lib` maps status → a `FaviconSpec` (pure, unit-tested); a `drawFavicon(spec)` canvas function turns it into a data URI (verified visually). _(R6, encoding)_
- **Color-blind-safe encoding:** check state = base fill color **and** a distinct center glyph/shape (✓ / hollow ring / ✕ / dash); review = corner badge differing by shape (filled dot / ring / absent). _(encoding)_
- **Self-guarded MutationObserver:** tag the injected `<link>`, ignore self-mutations, debounce re-assert; capture the original `<link rel=icon>` to restore on leave. _(R7, R7a)_
- **v1 takes `reviewDecision` at face value** (required-review verdict); does not query `latestReviews`. The badge means "required-review decision," documented. _(origin caveat)_
- **Auth-error surface is per-tab, not a global badge.** Chrome renders a per-tab `setBadgeText({tabId})` _over_ the global one, so box-select's per-tab "ON" would mask a global error badge on the exact PR tabs that matter. Set the error indicator (`!`) **per registered PR tab** (error wins over "ON" when both apply) plus a `chrome.action.setTitle` tooltip. The toolbar **click stays box-select's** (arming), so recovery is via right-click → Options, not the click. _(badge contention)_
- **Validate the token against a capability the feature uses**, not `viewer{login}` — a least-privilege fine-grained PAT (the documented recipe) may lack account scope and would false-reject. Probe `repository.pullRequest` on a known repo (or accept any 200 with non-null data). _(token validation)_
- **Read checks from the PR head commit, not blindly `commits(last:1)`** — assert the rollup's commit `oid` equals `pullRequest.headRefOid` (or use `headRef.target`); a null rollup maps to "no checks" and is **not** conflated with "pending." _(check correctness)_
- **One named alarm + in-tick stagger, coalesced by `prRef`.** `chrome.alarms` are extension-global and clamped to a 60s floor in production; a single `pr-poll` alarm's tick re-fetches all unsettled PRs, fetching each distinct `owner/repo/number` **once** and fanning the result to every tab showing it; jitter is in-tick stagger. _(alarms topology, rate limit)_
- **Token in `storage.local` is readable by any content script** (shared namespace) — background confinement is convention, not an enforced control. For this first-party personal tool we **accept** that: (a) the token is never put in a message, (b) the key is clearly named, (c) the gap is documented; an SW-memory-only hardening is noted as future. _(token exposure — see Risks)_

## Open Questions

### Resolved During Planning

- Favicon visual: filled rounded-rect, fill by check color + center glyph; review corner badge = dot/triangle/absent (not hollow-ring); shape-distinct, validated at 16/32px (Unit 3).
- GraphQL shape: single `repository.pullRequest` query (`reviewDecision`, `state`, `isDraft`, head-commit rollup with `headRefOid` assertion); no `latestReviews` in v1.
- Token validation: probe `repository.pullRequest` (not `viewer{login}`, which false-rejects fine-grained PATs); distinct auth/network/scope messages.
- Cross-tab strategy: registry keyed by tabId, **coalesced by `prRef`**; one `pr-poll` alarm re-fetches all unsettled; 403 backoff; registry rehydrated from session on SW restart.
- Auth-error surface: per-tab `!` badge (error > box-select "ON") + `setTitle` tooltip; recovery via right-click → Options (toolbar click stays box-select's).
- Favicon draw coverage: add the `canvas` dev dep for a distinct-output smoke test (Unit 3).
- Token exposure: accepted that content scripts can read `storage.local`; mitigated by never messaging the token + documentation (first-party personal tool).

### Deferred to Implementation

- [Needs research] Exact frequency/trigger of GitHub's own favicon re-sets on a PR page — observe during dev to tune the debounce window.
- Exact canvas glyph geometry at 16/32px — iterate visually.

## Output Structure

    ├── options.tsx                       # NEW: token settings page
    ├── background/
    │   └── index.ts                      # MODIFY: add GitHub fetch, registry, alarms poll, badge, messaging
    ├── contents/
    │   ├── box-select.ts                 # MODIFY: type-discriminate so it ignores favicon messages
    │   └── github-pr-favicon.ts          # NEW: PR detect, register, favicon lifecycle
    ├── lib/
    │   ├── github-pr.ts (+ .test.ts)     # NEW: URL parse / is-PR
    │   ├── pr-status.ts (+ .test.ts)     # NEW: normalize, isSettled, status→FaviconSpec
    │   ├── github-api.ts (+ .test.ts)    # NEW: GraphQL client (injected fetch) + token validate
    │   ├── favicon.ts                    # NEW: drawFavicon(spec)→dataURI (canvas)
    │   └── messages.ts                   # MODIFY: add favicon message types
    └── package.json                      # MODIFY: add "alarms" permission

## High-Level Technical Design

> _Directional guidance for review, not implementation specification._

```mermaid
sequenceDiagram
    participant CS as PR content script
    participant BG as Background SW
    participant GH as api.github.com
    participant ALARM as chrome.alarms

    CS->>CS: detect /pull/{n}; capture original favicon; draw "fetching"
    CS->>BG: register {tabId, owner/repo/number}
    BG->>BG: read token (storage.local); if none → reply no-op
    BG->>GH: GraphQL (reviewDecision, rollup.state, state, isDraft)
    GH-->>BG: data | 401 | 403 rate-limit
    BG->>BG: normalize (null-safe); store in registry; if 401 → action badge
    BG-->>CS: status (derived only)
    CS->>CS: drawFavicon(spec) → replace <link>; observe+re-assert (self-guarded)
    BG->>ALARM: ensure ~60s alarm while any tab unsettled
    ALARM-->>BG: tick → re-fetch all unsettled (coalesced, backoff) → push updates
    CS->>BG: on SPA nav-away / unload → unregister
    CS->>CS: restore original favicon
```

## Implementation Units

- [x] **Unit 1: Manifest `alarms` perm + Options page (token)**

**Goal:** Add the polling permission and a settings surface to store/validate/clear the PAT.

**Requirements:** R0, R3, R5a (Options-page error surface).

**Dependencies:** Unit 3 of the box-select work is unrelated; this depends only on the current repo state.

**Files:**

- Modify: `package.json` (add `"alarms"` to `manifest.permissions`)
- Create: `options.tsx` (token field, Save / Clear, inline validation result + last-error)
- Create: `lib/github-api.ts` partial — `validateToken(fetchFn, token)` (used here and Unit 4), `lib/github-api.test.ts`

**Approach:**

- `options.tsx` reads/writes the token in `chrome.storage.local` under a clearly-named key (e.g. `prFavicon.token`). It shows the **required PAT scopes** inline (fine-grained: Pull requests: Read + Commit statuses: Read) with a link to the README, plus distinct messages per validation outcome and a persistent "last auth error" line (R5a). Clear removes the key **and** notifies the background to restore favicons.
- `validateToken(fetchFn, token)` probes a capability the feature actually uses — a tiny `repository.pullRequest` query, **not** `viewer{login}` (a fine-grained PAT may lack account scope and would false-reject). Returns `{ ok, error? }` distinguishing **auth** (401/invalid), **network**, and best-effort **insufficient-scope**; on classic tokens it inspects `X-OAuth-Scopes` and warns if write scopes are present.
- Register `chrome.runtime.setUninstallURL` → GitHub's token-revocation guide; the page + README remind the user to revoke the PAT on uninstall (storage.local may persist after removal).

**Patterns to follow:** `lib/*` injected-dependency pattern (like `lib/tab-group.ts`'s `TabGroupApi`).

**Test scenarios:**

- Happy path: `validateToken` with a fetch stub returning a non-null `repository.pullRequest` → `{ok:true}`.
- Error path: 401 → `{ok:false, error:"auth"}`; network throw → `{ok:false, error:"network"}`; empty token → `{ok:false}` without calling fetch.
- Edge: classic token whose `X-OAuth-Scopes` includes a write scope → `{ok:true, warn:"broad-scope"}`.

**Verification:** `pnpm build` registers `options_ui` (open-in-tab) and no `default_popup`; loading the options page, saving a good/bad token shows the right inline state; `pnpm test` green.

---

- [x] **Unit 2: Pure status logic — URL parse, normalize, settled, render-spec**

**Goal:** The deterministic core, isolated from chrome/DOM/network.

**Requirements:** R1 (parse), R8 (settled), R9 (normalize), R6/encoding (spec).

**Dependencies:** None.

**Files:**

- Create: `lib/github-pr.ts` (+ `lib/github-pr.test.ts`) — `parsePrUrl(url)` → `{owner,repo,number}|null` (matches `/pull/{digits}` + subtabs; rejects `/pulls`, `github.dev`, gist).
- Create: `lib/pr-status.ts` (+ `lib/pr-status.test.ts`) — `normalize(graphqlData)` → `{ review: "approved"|"changes"|"none", check: "success"|"pending"|"failure"|"none", state: "open"|"closed"|"merged", isDraft }`; `isSettled(status)`; `toFaviconSpec(status | "fetching")` → `FaviconSpec { fill, glyph, badge }`.

**Approach:**

- `normalize` is fully null-safe: missing `pullRequest`, null `reviewDecision`, null/empty `statusCheckRollup`, empty `commits` all map to defined enum values (never throw).
- Check status reads the **head commit**: prefer asserting the rollup commit `oid` equals `headRefOid`; a null rollup → `"none"` (no checks), documented as possibly differing from GitHub's merge-ref checks and **distinct** from `"pending"`.
- `isSettled` = `check ∈ {success,failure} && review ∈ {approved,changes}` OR `state ∈ {closed,merged}`.

**Test scenarios:**

- Happy path (`parsePrUrl`): `https://github.com/o/r/pull/409` and `.../pull/409/files` → `{o,r,409}`.
- Edge (`parsePrUrl`): `/pulls`, `/issues/409`, `github.dev/...`, `gist.github.com/...`, non-github → null.
- Happy path (`normalize`): APPROVED+SUCCESS+OPEN → `{review:"approved",check:"success",state:"open"}`.
- Edge (`normalize`): null reviewDecision → `"none"`; null rollup / empty commits → check `"none"`; MERGED → state `"merged"`; never throws on `{}`.
- Edge (`isSettled`): success+approved → true; success+none(review) → false; pending+approved → false; merged (any) → true.
- Happy path (`toFaviconSpec`): each check state → distinct `fill`+`glyph`; each review → distinct `badge`; `"fetching"` → neutral spec with no badge; all 12 combos produce distinct (fill,glyph,badge) triples.

**Verification:** `pnpm test` green; the spec mapping is exhaustive over the enum product.

---

- [x] **Unit 3: Favicon drawing — `drawFavicon(spec)`**

**Goal:** Turn a `FaviconSpec` into a favicon data-URI, color-blind-safe at 16/32px.

**Requirements:** R6, encoding constraints.

**Dependencies:** Unit 2 (`FaviconSpec` type).

**Files:**

- Create: `lib/favicon.ts` — `drawFavicon(spec): string` (data URI). Renders at 32px (downscales to 16), `devicePixelRatio`-aware.

**Approach:**

- Base: filled rounded-rect in `spec.fill` (success `#2da44e` / pending `#bf8700` / failure `#cf222e` / none `#8c959f`) with a center glyph (`✓` / hollow ring / `✕` / dash) so states differ by **shape** not just hue.
- Corner badge (top-right) by review: filled dot (approved) / small **triangle** (changes-requested) / absent (none). Deliberately **not** a hollow ring — that would collide with the "pending" center glyph and is illegible at ~4px. Min stroke ~1.5px @32 + a contrasting halo so the badge survives downscale to 16px.
- "fetching": grey base, hollow center, no badge — visually distinct from "no checks" and from the unmodified GitHub icon.
- Render the PNG at a fixed high resolution (32 or 64px) and let the browser downscale into the favicon slot — the page's `devicePixelRatio` is **not** the right multiplier for a `<link rel=icon>` data URI.

**Technical design:** _(directional)_ draw on a `<canvas>` 2D context (the content script has a `document`), `toDataURL("image/png")`. Exact geometry tuned visually.

**Test scenarios:**

- Add the `canvas` dev dependency so a Vitest smoke test asserts the 13 specs (12 check×review combos + "fetching") each yield a **distinct, non-empty** data URI. _(Pure spec coverage lives in Unit 2; exact pixel geometry is still verified visually at 16/32px incl. grayscale.)_

**Verification:** Manual: render all 12 combos + fetching at 16px and 32px; each is visually distinguishable, including in a grayscale check.

---

- [x] **Unit 4: Background — GitHub client, tab registry, alarms poll, error badge**

**Goal:** Fetch + normalize status, drive central polling, surface auth errors, message content scripts. The token never leaves here.

**Requirements:** R2, R3a, R5, R5a, R8a, R9, R10.

**Dependencies:** Unit 1 (`validateToken`/storage key), Unit 2 (parse/normalize/isSettled).

**Files:**

- Modify: `background/index.ts` (add: `fetchPrStatus` call, tab registry + session rehydrate, single `pr-poll` alarm, per-tab error badge + title, message handlers, token-clear restore broadcast)
- Modify: `lib/github-api.ts` (+ tests) — `fetchPrStatus(fetchFn, token, prRef)` → normalized status or `{error:"auth"|"rate-limit"|"network"}`
- Modify: `lib/messages.ts` — add `registerPr`, `unregisterPr`, `prStatus` (push), `restoreFavicon` (token-clear) types

**Approach:**

- Registry keyed by `tabId → {prRef, lastStatus, settled}`, mirrored to `chrome.storage.session` under a **distinct** key (e.g. `prFavicon.registry` — not box-select's `groupColorCounter`; targeted `.remove`, never `.clear`); the in-memory registry is **rehydrated from session on SW startup**. `registerPr({tabId, prRef})` **replaces** any prior entry for that tabId (resetting lastStatus/settled).
- On `registerPr`: read token from `chrome.storage.local`; none → reply `{noToken:true}` (R4). Else `fetchPrStatus` → reply status; on `auth` error set the **per-tab** error badge (`!`) + `setTitle` tooltip (R5a) and reply `{error}`.
- A single `pr-poll` `chrome.alarms` (60s floor) runs while any registered tab is unsettled; each tick **coalesces by `prRef`** (one fetch per distinct PR, fanned to every tab showing it), staggers in-tick for jitter, backs off on 403, pushes `prStatus` via `chrome.tabs.sendMessage(tabId, …).catch(prune)`, and clears the alarm when all settled or no tabs remain. A fetch error _after_ a prior successful draw pushes an error/stale status so the tab reverts rather than freezing a stale icon.
- `chrome.tabs.onRemoved` / `unregisterPr` prune the registry. On token-clear (from Options), broadcast `restoreFavicon` to registered tabs.
- Endpoint constant `https://api.github.com/graphql`; token read **only** here, never messaged out.

**Execution note:** Implement `fetchPrStatus` + `isSettled`-driven poll-continuation test-first — the fetch→normalize→settle loop is the correctness core.

**Test scenarios:**

- Happy path: `fetchPrStatus` stubbed → normalized status (uses Unit 2 `normalize`).
- Error path: 401 → `{error:"auth"}`; 403 + rate-limit headers → `{error:"rate-limit"}`; network throw → `{error:"network"}`; none throw.
- Edge: `registerPr` with no token → `{noToken:true}`, no fetch.
- Integration: two tabs on the **same** PR → one fetch per tick, two `prStatus` pushes (coalesce by `prRef`).
- Integration: register tab T on PR#1 then re-register T on PR#2 → next tick fetches #2 only, never #1.
- Integration: 2 unsettled PRs schedule one `pr-poll` alarm; when all settle, the alarm clears.
- Integration: a push to a closed/navigated tab rejects → that tabId is pruned.
- Integration: registry rehydrates from `chrome.storage.session` after a simulated SW restart (the tick still has the tabs).
- Integration: an `auth` error sets the **per-tab** badge; a valid token clears it; token-clear broadcasts `restoreFavicon`.
- Edge: 403 rate-limit → next tick backs off (longer delay).

**Verification:** Mocked chrome+fetch tests green; manual load-unpacked: a real PR tab gets its status; a pending check flips on the next poll tick (typically 60–90s); bad token shows the per-tab error badge.

---

- [x] **Unit 5: GitHub PR content script — favicon lifecycle**

**Goal:** On a PR page, register with the background, draw the favicon from pushed status, keep it asserted, and restore on leave.

**Requirements:** R1, R6, R7, R7a, R8 (draw-on-load), coexistence.

**Dependencies:** Unit 2 (`parsePrUrl`/spec), Unit 3 (`drawFavicon`), Unit 4 (background messaging).

**Files:**

- Create: `contents/github-pr-favicon.ts` (`PlasmoCSConfig` match `https://github.com/*/*/pull/*` + runtime `parsePrUrl` gate)
- Modify: `contents/box-select.ts` (add an explicit `message.type` guard so it ignores favicon messages — its listener currently returns `undefined`, fine for fire-and-forget; this is a clarity guard, not a functional fix)

**Approach:**

- On load: `parsePrUrl(location.href)`; if a PR → capture the current `<link rel="icon">` (href), draw the **fetching** favicon immediately, and `registerPr` with the background. Receives `prStatus` pushes → `drawFavicon(toFaviconSpec(status))` → replace the icon link.
- `<head>` MutationObserver re-asserts the injected link if GitHub overwrites it; the injected link carries a data-attribute tag so the observer ignores its own writes; re-assertion is debounced.
- SPA nav (Turbo): on URL change, if still a PR (different number) re-register; if no longer a PR, **restore** the captured original favicon, disconnect the observer, and `unregisterPr`. Same restore on `pagehide`/unload.
- Draw happens on load regardless of tab focus, so background-opened (box-selected) tabs paint once loaded.
- A pushed **error/stale** status redraws the fetching/error state (never keep a stale green icon); a `restoreFavicon` message (token cleared) restores the captured original. Ignore `arm`/`disarm`/`createTabGroup` by type-discriminating (box-select likewise ignores `prStatus`).

**Patterns to follow:** `contents/box-select.ts` CSUI/shadow conventions are not needed here (no overlay); reuse its single-teardown discipline for observer + restore.

**Test scenarios:**

- Happy path (jsdom): PR URL → original `<link>` captured, fetching favicon injected, `registerPr` sent; a pushed `prStatus` swaps the link's href to a new data URI.
- Edge: non-PR URL → no registration, no favicon change.
- Integration: GitHub replaces the `<link>` → observer re-injects ours; the observer does **not** loop on its own write (tagged-node guard).
- Integration: SPA nav from a PR to a non-PR URL → original favicon restored, observer disconnected, `unregisterPr` sent.
- Integration: SPA nav PR#1→PR#2 → re-register with the new `prRef`; a subsequent `prStatus` for #2 redraws (no stale #1 icon).
- Integration: a `restoreFavicon` message (token cleared) restores the captured original favicon.
- Edge: an error/stale `prStatus` after a successful draw reverts the icon to fetching/error (not a frozen green).
- Edge: box-select messages (`arm`/`createTabGroup`) at this script's listener are ignored, and vice-versa — no cross-talk.

**Verification:** Manual load-unpacked on PR #410: favicon shows fetching → status; checks completing flips it within ~a minute; navigating to the repo home restores GitHub's favicon; box-select still works on the same pages.

## System-Wide Impact

- **Interaction graph:** New `registerPr`/`unregisterPr`/`prStatus` messages share `background/index.ts`'s `onMessage` with box-select's `createTabGroup`/`contentDisarmed`; both content scripts share the channel and must ignore foreign types. `chrome.alarms` + `chrome.tabs.onRemoved` drive/prune polling. Action badge now reflects token errors (distinct from box-select's "ON" — coordinate badge usage).
- **Badge contention:** Chrome renders a per-tab badge _over_ the global default, so a global error badge would be **masked** on box-selected (armed) PR tabs. Resolve: set the auth-error badge (`!`) **per-tab** via `setBadgeText({tabId})` on each registered PR tab, with error taking precedence over box-select's `"ON"` when a tab is both; plus a `setTitle` tooltip. The toolbar **click stays box-select's** (arming) — error recovery is via right-click → Options, not the click.
- **Error propagation:** all network/API failures normalize to a typed result; the page favicon never breaks (R5); auth errors surface via badge + Options page (R5a).
- **State lifecycle:** registry mirrored to `chrome.storage.session` (survives SW eviction; lost on restart — benign, re-registered on next load). Token in `chrome.storage.local` (persists).
- **Unchanged invariants:** box-select behavior, manifest host permissions (`https://*/*`), and the `chrome.action.onClicked` activation are unchanged; only `alarms` permission and an options page are added.

## Risks & Dependencies

| Risk                                                          | Mitigation                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| MV3 SW eviction kills a plain poll timer                      | `chrome.alarms` (≥60s) + registry in `chrome.storage.session` (Unit 4).                                                          |
| GitHub re-sets its favicon → flicker/observer loop            | Tagged-node self-mutation guard + debounce (Unit 5); tune window after observing real frequency (deferred).                      |
| Token leak surface                                            | Token confined to background + `storage.local`; never messaged to content scripts; endpoint hard-coded (Units 1,4).              |
| Rate limit with a large box-selected stack                    | Centralized, coalesced fetching + 403 backoff (Unit 4).                                                                          |
| Action badge clobbered between box-select and token-error     | Per-tab vs global badge separation; verify in Unit 4/5.                                                                          |
| 16px two-channel illegibility / color-blindness               | Shape-distinct encoding validated at 16/32px + grayscale (Units 2,3).                                                            |
| Stale icons on token expiry read as authoritative             | Discoverable error surface (per-tab badge + Options page), R5a (Units 1,4).                                                      |
| Content scripts can read the token from `storage.local`       | Accepted for a first-party personal tool: token never messaged, key named, gap documented; SW-memory-only is a future hardening. |
| Global error badge masked on armed PR tabs (per-tab wins)     | Error badge set **per-tab** on registered PR tabs, error > "ON" precedence (Unit 4).                                             |
| `commits(last:1)` ≠ PR head (force-push/merge) → wrong check  | Assert rollup commit `oid` == `headRefOid`; null → "no checks" (Unit 2).                                                         |
| `viewer{login}` validation false-rejects least-privilege PATs | Validate via a `repository.pullRequest` probe (Unit 1).                                                                          |
| Same PR in two tabs → duplicate API spend                     | Coalesce the poll by `prRef`, fan out to all tabs (Unit 4).                                                                      |
| `chrome.alarms` floor is a minimum, not a deadline            | Success criterion states "typically 60–90s," not a guarantee.                                                                    |

## Documentation / Operational Notes

- Update `README.md`: the favicon feature, how to create a least-privilege fine-grained PAT (Pull requests: Read + Commit statuses: Read), and that it's GitHub.com + Chromium only.
- No server/deploy impact; the only stored secret is the user's own PAT in `chrome.storage.local`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-09-pr-status-favicon-requirements.md](docs/brainstorms/2026-06-09-pr-status-favicon-requirements.md)
- Existing patterns: `background/index.ts`, `contents/box-select.ts`, `lib/tab-group.ts`, `lib/messages.ts`
- GitHub GraphQL API (`pullRequest.reviewDecision` / `statusCheckRollup` / `state` / `isDraft`); `chrome.alarms`, `chrome.storage`, `chrome.action` (MV3)
- Plasmo docs (options page, content scripts) via Context7 `/plasmohq/docs`
