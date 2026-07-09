import { match } from "ts-pattern"

import { isArmableUrl } from "~lib/activation"
import { fetchOpenPrs, fetchPrStatus } from "~lib/github-api"
import { isPrCommitUrl, parsePrUrl, type PrRef } from "~lib/github-pr"
import type {
  AddWatchedRepoResponse,
  ContentRequest,
  CreateTabGroupRequest,
  CreateTabGroupResponse,
  FaviconCommand,
  FaviconRequest,
  OrganizePinsResponse,
  PopupRequest,
  ReconcileTabsResponse,
  RegisterPrResponse
} from "~lib/messages"
import {
  planPinOrganization,
  selectDuplicateTabs,
  selectMergedTabs,
  TAB_GROUP_ID_NONE,
  type OrganizeTab
} from "~lib/organize-pins"
import { hasPollable, isPollDue, pollTier } from "~lib/poll-policy"
import { signalRefreshDue } from "~lib/refresh-gate"
import { REGISTRY_KEY, type RegistryEntry } from "~lib/registry"
import { openAndGroup, type TabGroupApi } from "~lib/tab-group"
import { onPoll, onRegister, onVisibilityChange } from "~lib/unread"
import {
  highestNumber,
  LAST_FETCHED_KEY,
  parseOwnerRepo,
  repoKey,
  selectPrsToOpen,
  WATCHED_KEY,
  type RepoKey,
  type WatchedRepo,
  type WatchedSnapshot
} from "~lib/watched"

// Single-window scope: at most one armed tab at a time. In-memory state is fine
// to lose on SW idle — re-arming is one click, and createTabGroup is self-contained.
let armedTabId: number | null = null

// PR tabs are auto-pinned on open unless the user turns it off (AUTO_PIN_KEY).
// Two in-memory sets gate that:
//  • groupOpenedTabs — tabs opened (or led) into a tab group; never auto-pinned.
//  • autoPinAttempted — tabs already evaluated once, so a manual unpin sticks.
const groupOpenedTabs = new Set<number>()
const autoPinAttempted = new Set<number>()

const BADGE_COLOR = "#1a73e8"
const COLOR_COUNTER_KEY = "groupColorCounter"

async function setBadge(tabId: number, on: boolean): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" })
  if (on) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR })
  }
}

/** Clear armed state + per-tab badge; optionally tell the content script to tear down. */
async function disarm(
  tabId: number | null,
  notifyContent: boolean
): Promise<void> {
  if (tabId == null) return
  if (armedTabId === tabId) armedTabId = null
  await setBadge(tabId, false)
  if (notifyContent) {
    chrome.tabs.sendMessage(tabId, { type: "disarm" }).catch(() => {
      // content script may be gone; badge is already cleared
    })
  }
}

/**
 * Arm box-select on a specific tab — the popup's target. The toolbar icon now
 * opens a popup (so `chrome.action.onClicked` no longer fires); the popup calls
 * this via `armBoxSelect`. Only arms where the content script can run, disarms
 * any previously armed tab, sets the per-tab badge, and tells the content script
 * to arm. Returns false (rolling back) if the tab is gone, isn't armable, or has
 * no content-script receiver yet, so the popup can surface a retry hint.
 */
async function armTab(tabId: number): Promise<boolean> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return false // tab gone
  }
  if (!isArmableUrl(tab.url)) return false

  // Re-arming the already-armed tab is a no-op success (the content script's
  // arm() self-guards); a *different* tab first tears down the old one.
  if (armedTabId != null && armedTabId !== tabId) await disarm(armedTabId, true)

  armedTabId = tabId
  await setBadge(tabId, true)

  try {
    await chrome.tabs.sendMessage(tabId, { type: "arm" })
    return true
  } catch {
    // No content-script receiver (tab opened before install/update, or still
    // loading). Roll back so the icon never shows a stuck "ON".
    await disarm(tabId, false)
    return false
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (armedTabId != null && armedTabId !== tabId) {
    void disarm(armedTabId, true)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (armedTabId === tabId) armedTabId = null
  groupOpenedTabs.delete(tabId)
  autoPinAttempted.delete(tabId)
})

async function readColorCounter(): Promise<number> {
  const stored = await chrome.storage.session.get(COLOR_COUNTER_KEY)
  const value = stored[COLOR_COUNTER_KEY]
  return typeof value === "number" ? value : 0
}

const chromeTabGroupApi: TabGroupApi = {
  async create(url) {
    const tab = await chrome.tabs.create({ url, active: false })
    if (tab.id != null) groupOpenedTabs.add(tab.id) // → excluded from auto-pin
    return tab.id
  },
  async group(tabIds) {
    return chrome.tabs.group({ tabIds })
  },
  async update(groupId, info) {
    await chrome.tabGroups.update(groupId, info)
  }
}

async function handleCreateTabGroup(
  message: CreateTabGroupRequest,
  leadTabId: number | undefined,
  sendResponse: (response: CreateTabGroupResponse) => void
): Promise<void> {
  // The lead (current) tab joins the group, so it must be unpinned first
  // (pinned tabs can't be grouped) and is excluded from auto-pin thereafter.
  if (leadTabId != null) {
    groupOpenedTabs.add(leadTabId)
    await chrome.tabs.update(leadTabId, { pinned: false }).catch(() => {})
  }

  const counter = await readColorCounter()
  const result = await openAndGroup(
    message.links,
    message.groupName,
    counter,
    chromeTabGroupApi,
    leadTabId
  )
  // Advance the persisted counter only when a group actually formed, so cycling
  // survives SW restarts instead of resetting to the first color.
  if (result.groupId != null) {
    await chrome.storage.session.set({ [COLOR_COUNTER_KEY]: counter + 1 })
  }
  sendResponse({
    ok: result.groupId != null,
    opened: result.opened,
    failed: result.failed
  })
}

/**
 * Cluster a window's PR tabs by repo. Runs the pure planner over every tab in
 * the window, then applies its moves in order (each is a left-move onto the
 * already-finalized prefix, so intermediate index shifts stay consistent).
 * Resolves the number of tabs relocated.
 */
/** Snapshot a window's tabs as OrganizeTab[], tagging merged PRs from the registry. */
async function snapshotWindow(windowId: number): Promise<OrganizeTab[]> {
  const tabs = await chrome.tabs.query({ windowId })
  return tabs
    .filter((t): t is chrome.tabs.Tab & { id: number } => t.id != null)
    .map((t) => {
      const entry = prRegistry.get(t.id)
      return {
        id: t.id,
        index: t.index,
        pinned: t.pinned ?? false,
        groupId: t.groupId ?? TAB_GROUP_ID_NONE,
        url: t.url || t.pendingUrl || "",
        // Carry the ref only when the last-known status is merged, so the pure
        // selector can confirm the tab still shows that PR before closing it.
        mergedRef: entry?.status?.state === "merged" ? entry.ref : undefined
      }
    })
}

async function closeTabs(tabIds: number[], label: string): Promise<number> {
  let closed = 0
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId)
      closed++
    } catch (err) {
      console.warn(`[organize] close ${label} tab ${tabId} failed:`, err)
    }
  }
  return closed
}

async function handleOrganizePins(
  windowId: number
): Promise<{ closed: number; deduped: number; moved: number; failed: number }> {
  // Each close phase re-queries the window afterward so the next step runs on the
  // real post-close strip (robust to a close Chrome rejects).

  // 1. Close merged-PR tabs.
  const closed = await closeTabs(
    selectMergedTabs(await snapshotWindow(windowId)),
    "merged"
  )

  // 2. Close duplicate PR tabs — the same PR page open more than once, keeping one
  //    copy. Runs on the post-merge strip so a survivor always exists (a group
  //    whose copies are all merged was already fully closed in step 1).
  const deduped = await closeTabs(
    selectDuplicateTabs(await snapshotWindow(windowId)),
    "duplicate"
  )

  // 3. Reorganize whatever remains.
  const after = await snapshotWindow(windowId)
  const moves = planPinOrganization(after)
  let failed = 0
  for (const move of moves) {
    try {
      await chrome.tabs.move(move.tabId, { index: move.index })
    } catch (err) {
      failed++
      console.warn(
        `[organize] tab ${move.tabId} → index ${move.index} failed:`,
        err
      )
    }
  }
  console.log(
    `[organize] window ${windowId}: ${after.length} tabs, ${closed} merged closed, ${deduped} duplicates closed, ${moves.length} moves, ${failed} failed`
  )
  return { closed, deduped, moved: moves.length, failed }
}

chrome.runtime.onMessage.addListener(
  (message: ContentRequest | PopupRequest, sender, sendResponse) =>
    match(message)
      .with({ type: "createTabGroup" }, (m) => {
        // sender.tab is the page the selection was made on → group it first.
        void handleCreateTabGroup(m, sender.tab?.id, sendResponse)
        return true // keep the channel open for the async response
      })
      .with({ type: "contentDisarmed" }, () => {
        void disarm(sender.tab?.id ?? null, false)
        return false
      })
      // --- Popup → background (sender.tab is undefined; the popup passes tabId) ---
      .with({ type: "armBoxSelect" }, (m) => {
        armTab(m.tabId)
          .then((ok) => sendResponse({ ok }))
          .catch(() => sendResponse({ ok: false }))
        return true // keep the channel open for the async response
      })
      .with({ type: "disarmBoxSelect" }, (m) => {
        void disarm(m.tabId, true)
        return false
      })
      .with({ type: "getArmState" }, () => {
        sendResponse({ armedTabId })
        return false
      })
      .with({ type: "organizePins" }, (m) => {
        handleOrganizePins(m.windowId)
          .then(({ closed, deduped, moved, failed }) =>
            sendResponse({ ok: true, closed, deduped, moved, failed })
          )
          .catch((err) => {
            console.error("[organize] failed:", err)
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          })
        return true // keep the channel open for the async response
      })
      .with({ type: "reconcileTabs" }, () => {
        handleReconcileTabs()
          .then((result) => sendResponse(result))
          .catch((err) => {
            console.error("[reconcile] failed:", err)
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          })
        return true // keep the channel open for the async response
      })
      // Messages are broadcast to every onMessage listener; ignore the ones this
      // listener doesn't own (the favicon listener below handles them) instead of
      // throwing NonExhaustiveError and spamming the service-worker console.
      .otherwise(() => false)
)

// ============================================================================
// PR status favicon — token-gated fetch + central chrome.alarms poll
// ============================================================================

const TOKEN_KEY = "prFavicon.token"
// Auto-pin toggle. Absent (the default) means ON — PR tabs are auto-pinned
// unless the user disables it in Options. Only `=== false` turns it off.
const AUTO_PIN_KEY = "prFavicon.autoPin"
const POLL_ALARM = "pr-poll"

// tabId -> entry. Mirrored to chrome.storage.session so it survives SW eviction.
const prRegistry = new Map<number, RegistryEntry>()

void chrome.storage.session.get(REGISTRY_KEY).then((stored) => {
  const saved = stored[REGISTRY_KEY] as
    | Record<string, RegistryEntry>
    | undefined
  if (!saved) return
  for (const [tabId, entry] of Object.entries(saved)) {
    prRegistry.set(Number(tabId), entry)
  }
  void reconcilePollAlarm()
})

function persistRegistry(): void {
  const obj: Record<number, RegistryEntry> = {}
  for (const [tabId, entry] of prRegistry) obj[tabId] = entry
  void chrome.storage.session.set({ [REGISTRY_KEY]: obj })
}

async function getToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(TOKEN_KEY)
  const token = stored[TOKEN_KEY]
  return typeof token === "string" && token.trim() ? token.trim() : null
}

async function getAutoPin(): Promise<boolean> {
  const stored = await chrome.storage.local.get(AUTO_PIN_KEY)
  return stored[AUTO_PIN_KEY] !== false
}

function refKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

function pushToTab(tabId: number, message: FaviconCommand): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // A failed push just means "couldn't redraw right now" (tab backgrounded,
    // discarded, or mid-reload). Do NOT prune here — that would drop the unread
    // latch + Options row. chrome.tabs.onRemoved (and unregisterPr on SPA-nav)
    // are the authoritative prune signals (U10).
  })
}

async function setErrorBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "!" : "" })
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#cf222e" })
      await chrome.action.setTitle({
        tabId,
        title: "PR Status: token error — open the extension's Options to fix"
      })
    } else {
      await chrome.action.setTitle({ tabId, title: "" })
    }
  } catch {
    // tab gone
  }
}

async function reconcilePollAlarm(): Promise<void> {
  const statuses = [...prRegistry.values()].map((e) => e.status)
  // Keep the alarm alive while there's anything to poll: PR-status tabs OR
  // watched repos (W4a — watched polling must run even with zero PR tabs open).
  const pollable = hasPollable(statuses) || watchedRepos.size > 0
  if (pollable && (await getToken())) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 })
  } else {
    await chrome.alarms.clear(POLL_ALARM)
  }
  persistRegistry()
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Fetch one ref once and fan the result out to every tab showing it. */
async function fetchAndPushRef(
  ref: PrRef,
  tabIds: number[],
  token: string
): Promise<void> {
  const result = await fetchPrStatus(fetch, token, ref)
  const now = Date.now()
  if (result.ok && result.status) {
    const status = result.status
    for (const tabId of tabIds) {
      const entry = prRegistry.get(tabId)
      // Ref-match guard: the tab may have re-registered to another PR during the
      // fetch (SPA nav). Skip a stale result so it never paints A onto B (U6).
      if (!entry || refKey(entry.ref) !== refKey(ref)) continue
      entry.lastPolledAt = now
      entry.status = status
      entry.error = false
      // Compute the latch against the entry's *current* visibility (read here,
      // post-await) and the seenStatus baseline; onPoll never latches a visible
      // tab and only latches a hidden tab on a visible favicon change.
      Object.assign(entry, onPoll(entry, status))
      await setErrorBadge(tabId, false)
      pushToTab(tabId, { type: "prStatus", status, unread: !!entry.unread })
    }
    persistRegistry()
    return
  }
  const isAuth = result.error === "auth"
  for (const tabId of tabIds) {
    const entry = prRegistry.get(tabId)
    if (!entry || refKey(entry.ref) !== refKey(ref)) continue
    // Errors do not latch: leave seenStatus/unread untouched (the error badge +
    // Options "couldn't fetch" surface it). Still stamp the poll attempt.
    entry.lastPolledAt = now
    entry.error = true
    if (isAuth) await setErrorBadge(tabId, true)
    pushToTab(tabId, { type: "prError" })
  }
  persistRegistry()
}

/** One poll tick: coalesce registered tabs by PR, fetch each once, fan out. */
async function pollAll(force = false): Promise<void> {
  const token = await getToken()
  if (!token) return
  const now = Date.now()
  const byRef = new Map<string, { ref: PrRef; tabIds: number[] }>()
  for (const [tabId, entry] of prRegistry) {
    // Tiered cadence (U9): fast every tick, slow (approved+passing) every ~5min,
    // merged/closed never. `force` (token just set) refreshes everything pollable.
    const tier = pollTier(entry.status)
    const due = force
      ? tier !== "stop"
      : isPollDue(tier, entry.lastPolledAt, now)
    if (!due) continue
    const key = refKey(entry.ref)
    const group = byRef.get(key) ?? { ref: entry.ref, tabIds: [] }
    group.tabIds.push(tabId)
    byRef.set(key, group)
  }
  let first = true
  for (const { ref, tabIds } of byRef.values()) {
    if (!first) await delay(150) // flat in-tick stagger (jitter), not cumulative
    first = false
    await fetchAndPushRef(ref, tabIds, token)
  }
  await pollWatchedRepos(token)
  await reconcilePollAlarm()
}

// ============================================================================
// Signal-driven refresh — single entry point for DOM/visibility signals
// ============================================================================

// Refs with a signal-triggered fetch currently in flight (this SW lifetime).
// Added before the await, removed in finally → a second signal for the same ref
// while its fetch is running is dropped (in-flight dedup), complementing the
// per-ref min-interval (which bounds rate over time).
const inFlightSignalRefs = new Set<string>()

/**
 * Refresh a PR from a fast signal (DOM poke or visibility re-poll). Resolves the
 * ref (explicit `ref` wins; else the tab's registered ref), gates on the
 * persisted per-ref min-interval + tier (signals bypass the fast/slow throttle
 * but not the floor, and never fetch stop-tier refs), dedups in-flight, then
 * reuses fetchAndPushRef to fetch once and fan out to every tab showing the ref.
 * No-ops without a token, mirroring pollAll — the alarm path is untouched.
 */
async function requestRefresh({
  ref,
  tabId
}: {
  ref?: PrRef
  tabId?: number
}): Promise<void> {
  const target = ref ?? (tabId != null ? prRegistry.get(tabId)?.ref : undefined)
  if (!target) return // no explicit ref and the tab isn't registered → nothing to do
  const token = await getToken()
  if (!token) return

  // Once getToken() resolves, everything below runs with no further await until
  // fetchAndPushRef. The JS event loop runs each resumed continuation to its next
  // await before another can run, so this has/gate/stamp/add sequence is atomic
  // relative to other requestRefresh calls — two near-simultaneous signals for the
  // same ref can't both pass: the first adds to inFlightSignalRefs before the
  // second's continuation runs. (Keep this block await-free to preserve that.)
  const key = refKey(target)
  if (inFlightSignalRefs.has(key)) return
  const tabIds: number[] = []
  const entries: RegistryEntry[] = []
  for (const [id, entry] of prRegistry) {
    if (refKey(entry.ref) !== key) continue
    tabIds.push(id)
    entries.push(entry)
  }
  if (tabIds.length === 0) return // tab unregistered mid-flight
  const now = Date.now()
  if (!signalRefreshDue(entries, now)) return
  for (const entry of entries) entry.lastSignalFetchedAt = now
  persistRegistry() // mirror the stamp to storage.session so SW eviction can't reset it
  inFlightSignalRefs.add(key)

  try {
    await fetchAndPushRef(target, tabIds, token)
  } finally {
    inFlightSignalRefs.delete(key)
  }
}

/**
 * Auto-pin a freshly-opened PR tab. Acts once per tab (so a manual unpin is
 * never undone), and skips tabs opened into a tab group (box-select) or already
 * in any group — those are the explicit exclusion.
 *
 * Dedup: if the same PR (owner/repo/number) is already pinned in this window,
 * close the new tab and focus the existing pinned one instead of pinning a second.
 *
 * A specific-commit view (…/pull/N/commits/<sha>) is exempt from both pinning and
 * dedup: it's a different thing from the PR, so it opens as its own normal tab
 * rather than merging into the PR's pinned tab.
 */
async function maybeAutoPin(tabId: number): Promise<void> {
  if (autoPinAttempted.has(tabId) || groupOpenedTabs.has(tabId)) return
  // On by default. Checked before marking attempted so toggling it on later
  // still pins PR tabs opened thereafter (the disabled pass leaves no mark).
  if (!(await getAutoPin())) return
  autoPinAttempted.add(tabId) // mark before await: no re-entrant double-pin
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return // tab gone
  }
  // A single-commit diff view is not the PR — leave it as a standalone tab.
  if (tab.url && isPrCommitUrl(tab.url)) return
  // groupId === -1 is TAB_GROUP_ID_NONE (ungrouped). Pinned or grouped → leave it.
  if (tab.pinned || tab.groupId !== -1) return

  // Dedup: same PR already pinned in this window → focus it, close the new tab.
  const ref = tab.url ? parsePrUrl(tab.url) : null
  if (ref && tab.windowId != null) {
    const key = refKey(ref)
    const pinned = await chrome.tabs.query({
      pinned: true,
      windowId: tab.windowId
    })
    const existing = pinned.find((t) => {
      if (t.id == null || t.id === tabId || !t.url) return false
      const r = parsePrUrl(t.url)
      return r != null && refKey(r) === key
    })
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { active: true }).catch(() => {})
      await chrome.tabs.remove(tabId).catch(() => {})
      return // deduped: existing pinned tab focused, new tab closed
    }
  }

  await chrome.tabs.update(tabId, { pinned: true }).catch(() => {})
}

async function handleRegisterPr(
  ref: PrRef,
  tabId: number,
  visible: boolean
): Promise<RegisterPrResponse> {
  void maybeAutoPin(tabId) // pin PR tabs on open if opted in (independent of token)
  // Always register (so a later tokenChanged can reach this tab) with the
  // reported visibility; the unread baseline is seeded on the first fetch.
  prRegistry.set(tabId, { ref, visible, unread: false })
  persistRegistry()

  const token = await getToken()
  if (!token) return { hasToken: false }

  const result = await fetchPrStatus(fetch, token, ref)
  const entry = prRegistry.get(tabId)
  // Ref-match guard: the tab may have re-registered to another PR mid-fetch.
  if (!entry || refKey(entry.ref) !== refKey(ref)) return { hasToken: true }
  if (result.ok && result.status) {
    const status = result.status
    entry.status = status
    entry.error = false
    entry.lastPolledAt = Date.now()
    // Seed the baseline (seenStatus = first status, unread = false).
    Object.assign(entry, onRegister(status, entry.visible ?? visible))
    await setErrorBadge(tabId, false)
    await reconcilePollAlarm()
    return { hasToken: true, status }
  }
  entry.error = true
  if (result.error === "auth") await setErrorBadge(tabId, true)
  // Start/keep the poll alarm so a transient first-fetch failure (rate limit,
  // network blip) is retried on the next tick — the entry's tier is non-stop.
  // Mirrors the success path; reconcilePollAlarm persists the registry too.
  await reconcilePollAlarm()
  return { hasToken: true, error: true }
}

/** A content script reported its tab's Page-Visibility transition. */
function handleVisibility(tabId: number, visible: boolean): void {
  const entry = prRegistry.get(tabId)
  if (!entry) return
  Object.assign(entry, onVisibilityChange(entry.status, visible))
  if (visible) {
    // Clear the latch on the PR's OTHER tabs too: the Options row ORs unread
    // across a PR's tabs, so a single-tab clear would leave the row stuck lit.
    // Siblings stay hidden but advance their baseline to the status already seen
    // here, so they don't immediately re-latch on the next poll.
    const key = refKey(entry.ref)
    for (const [id, sib] of prRegistry) {
      if (id === tabId || !sib.unread || refKey(sib.ref) !== key) continue
      sib.unread = false
      if (sib.status) {
        sib.seenStatus = sib.status
        pushToTab(id, { type: "prStatus", status: sib.status, unread: false })
      }
    }
  }
  persistRegistry()
  // Became visible with a known status → push a redraw clearing the dot (the
  // content script also clears optimistically; this is the authoritative push).
  if (visible && entry.status) {
    pushToTab(tabId, { type: "prStatus", status: entry.status, unread: false })
  }
  // Now-visible tab: re-poll so it reflects current status instead of waiting
  // for the next alarm tick. Gated by the per-ref signal min-interval and
  // token inside requestRefresh; cross-PR bursts are naturally user-paced.
  if (visible) void requestRefresh({ tabId })
}

function unregister(tabId: number | null | undefined): void {
  if (tabId == null) return
  if (prRegistry.delete(tabId)) {
    persistRegistry()
    void setErrorBadge(tabId, false)
    void reconcilePollAlarm()
  }
}

chrome.tabs.onRemoved.addListener((tabId) => unregister(tabId))

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void pollAll()
})

chrome.runtime.onMessage.addListener(
  (message: FaviconRequest, sender, sendResponse) => {
    const tabId = sender.tab?.id
    return (
      match(message)
        .with({ type: "registerPr" }, (m) => {
          if (tabId == null) return false
          handleRegisterPr(m.ref, tabId, m.visible)
            .then(sendResponse)
            .catch(() => sendResponse({ hasToken: false }))
          return true // async response
        })
        .with({ type: "addWatchedRepo" }, (m) => {
          handleAddWatchedRepo(m.owner, m.repo)
            .then(sendResponse)
            .catch(() => sendResponse({ ok: false, error: "network" }))
          return true // async response
        })
        .with({ type: "visibility" }, (m) => {
          if (tabId != null) handleVisibility(tabId, m.visible)
          return false
        })
        .with({ type: "prDomSignal" }, (m) => {
          void requestRefresh({ ref: m.ref })
          return false
        })
        .with({ type: "unregisterPr" }, () => {
          unregister(tabId)
          return false
        })
        .with({ type: "tokenChanged" }, () => {
          void pollAll(true) // token now present → refresh everything
          return false
        })
        .with({ type: "tokenCleared" }, () => {
          for (const id of prRegistry.keys()) {
            void setErrorBadge(id, false)
            pushToTab(id, { type: "restoreFavicon" })
          }
          prRegistry.clear()
          persistRegistry()
          void chrome.alarms.clear(POLL_ALARM)
          return false
        })
        .with({ type: "removeWatchedRepo" }, (m) => {
          handleRemoveWatchedRepo(m.owner, m.repo)
          return false
        })
        // Popup/content messages are broadcast here too; ignore them (the listener
        // above owns them) rather than throwing NonExhaustiveError on normal traffic.
        .otherwise(() => false)
    )
  }
)

// ============================================================================
// Watched repositories — auto-open new PRs
// ============================================================================

const WATCHED_TICK_CAP = 5 // max PRs auto-opened per poll tick, across all repos

const watchedRepos = new Map<RepoKey, WatchedRepo>()

/**
 * Resolves once the watch list (storage.local) has loaded. The watched poll branch
 * awaits this so the first post-restart tick can't re-open the backlog before the
 * watermarks/handled sets are in memory (W11).
 */
const watchedReady: Promise<void> = (async () => {
  const local = await chrome.storage.local.get(WATCHED_KEY)
  const saved = local[WATCHED_KEY] as WatchedSnapshot | undefined
  if (saved) {
    for (const [key, entry] of Object.entries(saved))
      watchedRepos.set(key, entry)
  }
  // Re-arm the alarm now that watched repos are loaded — the module-top reconcile
  // ran before this resolved, so without this a restart with watched repos but no
  // PR tabs would leave the alarm cleared and the feature would never poll (W4a/W11).
  await reconcilePollAlarm()
})()

function persistWatched(): void {
  const obj: WatchedSnapshot = {}
  for (const [key, entry] of watchedRepos) obj[key] = entry
  void chrome.storage.local.set({ [WATCHED_KEY]: obj })
}

async function handleAddWatchedRepo(
  owner: string,
  repo: string
): Promise<AddWatchedRepoResponse> {
  const parsed = parseOwnerRepo(`${owner}/${repo}`)
  if (!parsed) return { ok: false, error: "invalid" }
  const key = repoKey(parsed.owner, parsed.repo)
  if (watchedRepos.has(key)) return { ok: false, error: "duplicate" }
  const token = await getToken()
  if (!token) return { ok: false, error: "no-token" }
  // The add-time list both checks access and sets the watermark (highest open PR
  // number now), so only later PRs auto-open. A no-access/typo error rejects the add.
  const result = await fetchOpenPrs(fetch, token, parsed)
  if (!result.ok || !result.prs) {
    // Transient (network/rate-limit) errors keep their own message so we don't
    // wrongly blame the repo name/token; auth/notfound/unknown → "no-access".
    const e = result.error
    return {
      ok: false,
      error: e === "network" || e === "rate-limit" ? e : "no-access"
    }
  }
  watchedRepos.set(key, {
    owner: parsed.owner,
    repo: parsed.repo,
    watermark: highestNumber(result.prs),
    handled: []
  })
  persistWatched()
  // The add-time list query above IS a fetch — stamp it so Options shows
  // "Last fetched just now" immediately, instead of waiting for the first tick.
  void chrome.storage.session.set({ [LAST_FETCHED_KEY]: Date.now() })
  await reconcilePollAlarm()
  return { ok: true }
}

function handleRemoveWatchedRepo(owner: string, repo: string): void {
  if (watchedRepos.delete(repoKey(owner, repo))) {
    persistWatched()
    void reconcilePollAlarm()
  }
}

/**
 * The window to open auto-opened PR tabs in: the last-focused normal window
 * (excludes Options/devtools/popup). `undefined` lets chrome.tabs.create fall
 * back to the current window.
 */
async function targetWindowId(): Promise<number | undefined> {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] })
    return win?.id
  } catch {
    return undefined
  }
}

/**
 * Open a watched-repo PR as an inactive tab in `windowId` (the content script
 * then pins + dedups it). Logs every open to the service-worker console so new
 * auto-opened PRs are visible while debugging. Returns the tab, or null on failure.
 */
async function openPrTab(
  owner: string,
  repo: string,
  number: number,
  { windowId, title }: { windowId?: number; title?: string }
): Promise<chrome.tabs.Tab | null> {
  const url = `https://github.com/${owner}/${repo}/pull/${number}`
  const created = await chrome.tabs
    .create({ url, windowId, active: false })
    .catch(() => null)
  const ref = `${owner}/${repo}#${number}`
  if (created == null) {
    console.warn(`[watched] failed to open new PR ${ref}`)
  } else {
    console.info(
      `[watched] opened new PR ${ref}${title ? ` — ${title}` : ""} in window ${created.windowId} (inactive)`
    )
  }
  return created
}

/**
 * Cross-window set of PR ref keys currently open in a tab (W7). A single-commit
 * view (…/pull/N/commits/<sha>) is a different thing from the PR, so it doesn't
 * count as the PR being open — the PR can still auto-open alongside it. On a
 * tabs.query failure returns an empty set (worst case: one duplicate tab).
 */
async function openPrRefKeys(): Promise<Set<string>> {
  const openRefs = new Set<string>()
  try {
    const tabs = await chrome.tabs.query({ url: "*://github.com/*/*/pull/*" })
    for (const t of tabs) {
      if (!t.url || isPrCommitUrl(t.url)) continue
      const r = parsePrUrl(t.url)
      if (r) openRefs.add(refKey(r))
    }
  } catch {
    // tabs.query failed → proceed with an empty set.
  }
  return openRefs
}

/** One tick of watched-repo detection → auto-open (W4–W9). Token is already verified. */
async function pollWatchedRepos(token: string): Promise<void> {
  await watchedReady
  if (watchedRepos.size === 0) return

  // Cross-window already-open set once per tick (W7), plus an in-tick guard so two
  // candidates / a slow content-script load can't double-open.
  const openRefs = await openPrRefKeys()
  const openingThisTick = new Set<string>()

  let remaining = WATCHED_TICK_CAP // global per-tick cap across all repos (W8b)
  let windowId: number | undefined
  let windowResolved = false
  let first = true
  for (const entry of watchedRepos.values()) {
    if (remaining <= 0) break
    if (!first) await delay(150) // share the favicon poll's in-tick stagger
    first = false

    const result = await fetchOpenPrs(fetch, token, entry)
    if (!result.ok || !result.prs) continue // per-repo error isolation (W4)

    const { toOpen } = selectPrsToOpen({
      prs: result.prs,
      watermark: entry.watermark,
      handled: entry.handled,
      cap: remaining
    })
    for (const pr of toOpen) {
      const key = refKey({
        owner: entry.owner,
        repo: entry.repo,
        number: pr.number
      })
      if (openRefs.has(key) || openingThisTick.has(key)) continue // W7: already open
      openingThisTick.add(key)
      if (!windowResolved) {
        windowId = await targetWindowId()
        windowResolved = true
      }
      const created = await openPrTab(entry.owner, entry.repo, pr.number, {
        windowId,
        title: pr.title
      })
      if (created == null) {
        // create failed (e.g. the target window closed mid-tick) — leave the PR
        // UNHANDLED so it retries next tick, and re-resolve the window next time.
        windowResolved = false
        windowId = undefined
        continue
      }
      entry.handled.push(pr.number) // mark handled only after we actually open it
      remaining--
      if (remaining <= 0) break
    }
  }
  persistWatched()
  // Stamp the completed poll cycle so Options can show "last fetched X ago".
  void chrome.storage.session.set({ [LAST_FETCHED_KEY]: Date.now() })
}

// A single reconcile opens at most this many tabs — a safety valve so a repo with
// a huge backlog of open PRs can't flood the window in one click.
const RECONCILE_TAB_CAP = 50

/**
 * Open every currently-open PR across all watched repos that isn't already open
 * (W7). This is the explicit "catch up on the backlog" counterpart to poll's
 * auto-open: same eligibility (skips drafts + Renovate) but it ignores the
 * watermark and the handled set, so it also reopens PRs you opened then closed —
 * bringing your tabs back in sync with the repos' current open set. Each opened
 * PR is still marked handled so a later poll won't re-open it once you close it.
 * Bounded by RECONCILE_TAB_CAP. Per-repo fetch errors are isolated and counted.
 */
async function handleReconcileTabs(): Promise<ReconcileTabsResponse> {
  await watchedReady
  if (watchedRepos.size === 0) {
    return { ok: true, opened: 0, repos: 0, failed: 0 }
  }
  const token = await getToken()
  if (!token) {
    return {
      ok: false,
      error: "Set a GitHub token in the extension's Options first."
    }
  }

  const openRefs = await openPrRefKeys() // doubles as the in-run double-open guard
  let opened = 0
  let failed = 0
  let remaining = RECONCILE_TAB_CAP
  let windowId: number | undefined
  let windowResolved = false
  let first = true
  for (const entry of watchedRepos.values()) {
    if (remaining <= 0) break
    if (!first) await delay(150) // share the poll's in-tick stagger
    first = false

    const result = await fetchOpenPrs(fetch, token, entry)
    if (!result.ok || !result.prs) {
      failed++ // per-repo error isolation (mirrors the poll path)
      continue
    }
    // watermark 0 + no handled → every non-draft, non-Renovate open PR, regardless
    // of age or whether we opened it before. Consider them all (cap = list size),
    // ascending; the already-open filter and the RECONCILE_TAB_CAP tab budget
    // (`remaining`) are enforced in the loop below, not by slicing candidates here
    // — else already-open low numbers could push not-yet-open ones past the cap.
    const { toOpen } = selectPrsToOpen({
      prs: result.prs,
      watermark: 0,
      handled: [],
      cap: result.prs.length
    })
    const handled = new Set(entry.handled)
    for (const pr of toOpen) {
      const key = refKey({
        owner: entry.owner,
        repo: entry.repo,
        number: pr.number
      })
      if (openRefs.has(key)) continue // already open, or opened earlier this run
      if (!windowResolved) {
        windowId = await targetWindowId()
        windowResolved = true
      }
      const created = await openPrTab(entry.owner, entry.repo, pr.number, {
        windowId,
        title: pr.title
      })
      if (created == null) {
        // create failed (e.g. the target window closed) — re-resolve next time.
        windowResolved = false
        windowId = undefined
        continue
      }
      openRefs.add(key) // don't open this PR twice within one reconcile
      if (!handled.has(pr.number)) {
        entry.handled.push(pr.number) // mark handled only after we actually open it
        handled.add(pr.number)
      }
      opened++
      remaining--
      if (remaining <= 0) break
    }
  }
  persistWatched()
  void chrome.storage.session.set({ [LAST_FETCHED_KEY]: Date.now() })
  console.log(
    `[reconcile] ${watchedRepos.size} repos scanned, ${opened} opened, ${failed} failed`
  )
  return { ok: true, opened, repos: watchedRepos.size, failed }
}

export {}
