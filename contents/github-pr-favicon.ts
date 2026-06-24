import type { PlasmoCSConfig } from "plasmo"

import { drawFavicon } from "~lib/favicon"
import { parsePrUrl, type PrRef } from "~lib/github-pr"
import {
  detectTerminalState,
  findMergeboxRegion,
  mergeboxSignature,
  type TerminalState
} from "~lib/mergebox"
import type { FaviconCommand, RegisterPrResponse } from "~lib/messages"
import {
  IDLE,
  reconcile,
  type Baseline,
  type ReconcileCommand,
  type ReconcileEvent,
  type ReconcileState
} from "~lib/paint-reconcile"
import { toFaviconSpec, type PrStatus } from "~lib/pr-status"

export const config: PlasmoCSConfig = {
  matches: ["https://github.com/*/*/pull/*"]
}

let currentRef: PrRef | null = null
let ourLink: HTMLLinkElement | null = null
let originalIcons: HTMLLinkElement[] = []
let lastDataUri: string | null = null
let observer: MutationObserver | null = null
let reassertTimer = 0
// Last drawn favicon state — lets a become-visible event optimistically clear
// the dot without waiting for the background's authoritative push.
let lastStatus: PrStatus | "fetching" | null = null
let lastUnread = false

const refKey = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`

const iconLinks = () =>
  Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
  )

function captureOriginal(): void {
  if (originalIcons.length) return
  originalIcons = iconLinks()
    .filter((l) => !l.hasAttribute("data-prfav"))
    .map((l) => l.cloneNode(true) as HTMLLinkElement)
}

function startObserver(): void {
  if (observer) return
  observer = new MutationObserver(() => {
    if (!lastDataUri) return
    const links = iconLinks()
    const hasOurs = links.some((l) => l === ourLink)
    const hasForeign = links.some((l) => !l.hasAttribute("data-prfav"))
    if (!hasOurs || hasForeign) {
      // GitHub overwrote our icon → re-assert (debounced). The state check (not
      // a flag) means our own mutations don't trigger a re-assert loop.
      window.clearTimeout(reassertTimer)
      reassertTimer = window.setTimeout(() => {
        if (lastDataUri) applyFavicon(lastDataUri)
      }, 200)
    }
  })
  observer.observe(document.head, { childList: true })
}

function applyFavicon(dataUri: string): void {
  lastDataUri = dataUri
  for (const l of iconLinks()) if (!l.hasAttribute("data-prfav")) l.remove()
  if (!ourLink) {
    ourLink = document.createElement("link")
    ourLink.rel = "icon"
    ourLink.setAttribute("data-prfav", "1")
  }
  ourLink.href = dataUri
  if (!ourLink.isConnected) document.head.appendChild(ourLink)
  startObserver()
}

function drawStatus(status: PrStatus | "fetching", unread = false): void {
  lastStatus = status
  lastUnread = unread
  applyFavicon(drawFavicon(toFaviconSpec(status), 32, { unread }))
}

/** Report this tab's visibility to the background; optimistically clear the dot on focus. */
function reportVisibility(): void {
  const visible = document.visibilityState === "visible"
  chrome.runtime.sendMessage({ type: "visibility", visible }).catch(() => {})
  // Drop the dot instantly on focus; the background's push (U5) is authoritative.
  if (visible && lastStatus !== null && lastUnread)
    drawStatus(lastStatus, false)
}

function restoreOriginal(): void {
  observer?.disconnect()
  observer = null
  window.clearTimeout(reassertTimer)
  ourLink?.remove()
  ourLink = null
  lastDataUri = null
  lastStatus = null
  lastUnread = false
  for (const l of iconLinks()) if (l.hasAttribute("data-prfav")) l.remove()
  for (const orig of originalIcons)
    document.head.appendChild(orig.cloneNode(true))
}

// --- Title prefix --------------------------------------------------------
// GitHub puts the PR number at the END of the title ("… · Pull Request #N ·
// …"), where a narrow tab truncates it away. We prepend "#N " so the number
// is always visible, and re-assert against Turbo's title rewrites. Derived
// purely from the URL — applies regardless of token/favicon state.
let titleObserver: MutationObserver | null = null

const stripOurPrefix = (t: string) => t.replace(/^#\d+\s+/, "")

function applyTitle(number: number): void {
  const desired = `#${number} ${stripOurPrefix(document.title)}`
  // Guard against the no-op set that would otherwise re-trigger the observer.
  if (document.title !== desired) document.title = desired
}

function startTitleObserver(number: number): void {
  titleObserver?.disconnect()
  const titleEl = document.querySelector("title")
  if (!titleEl) return
  titleObserver = new MutationObserver(() => applyTitle(number))
  titleObserver.observe(titleEl, {
    childList: true,
    characterData: true,
    subtree: true
  })
}

function restoreTitle(): void {
  titleObserver?.disconnect()
  titleObserver = null
  document.title = stripOurPrefix(document.title)
}

// --- Mergebox signal + optimistic terminal paint -------------------------
// A long-lived observer on a STABLE ancestor (document.body), deliberately NOT
// tied to the per-ref register/teardown lifecycle: that only re-runs on a URL/ref
// change, but the mergebox lives in the Turbo-swapped content region and must
// keep working across same-PR sub-tab swaps (Conversation/Files/Checks). On a
// debounced mutation we re-resolve the mergebox and poke the background only when
// a stable-hook signature actually changes, so streaming CI logs/comments don't
// poke. When the DOM unambiguously shows a terminal state we optimistically paint
// it, reconciled by the confirming fetch via a pure state machine.
const SIGNAL_DEBOUNCE_MS = 300
const SELF_CHECK_DELAY_MS = 4000
const REVERT_WAIT_MS = 6000

let mergeboxObserver: MutationObserver | null = null
let mergeboxDebounce = 0
let selfCheckTimer = 0
let lastSignature: string | null = null
let selfCheckLogged = false

let reconcileState: ReconcileState = IDLE
let revertTimer = 0

const terminalStatus = (t: TerminalState): PrStatus => ({
  review: "none",
  check: "none",
  state: t,
  isDraft: false
})

/** The favicon shown before an optimistic paint — what a revert restores to. */
function currentBaseline(): Baseline {
  if (lastStatus && lastStatus !== "fetching")
    return { kind: "status", status: lastStatus, unread: lastUnread }
  return { kind: "original" }
}

function runReconcile(command: ReconcileCommand): void {
  if (command.timer === "clear") {
    window.clearTimeout(revertTimer)
    revertTimer = 0
  }
  if (command.paint === "terminal") {
    drawStatus(terminalStatus(command.terminal), false)
  } else if (command.paint === "revert") {
    if (command.baseline.kind === "status")
      drawStatus(command.baseline.status, command.baseline.unread)
    else restoreOriginal() // no prior authoritative favicon → restore GitHub's
  }
  if (command.timer === "start") {
    window.clearTimeout(revertTimer)
    revertTimer = window.setTimeout(() => {
      revertTimer = 0
      dispatchReconcile({ type: "timeout" })
    }, REVERT_WAIT_MS)
  }
}

function dispatchReconcile(event: ReconcileEvent): void {
  const result = reconcile(reconcileState, event)
  reconcileState = result.state
  runReconcile(result.command)
}

function handleMergeboxChange(): void {
  if (!currentRef) return
  const region = findMergeboxRegion(document)
  if (!region) return // absent (e.g. a sub-tab without it) → no-op; self-check covers breakage
  selfCheckLogged = false // region present → clear any prior self-check latch
  const sig = mergeboxSignature(document)
  if (sig === lastSignature) return // nothing meaningful changed → no poke
  lastSignature = sig
  // Optimistic terminal fast-path: paint merged/closed now; the confirming fetch
  // reconciles. Baseline is snapshotted BEFORE the paint (drawStatus overwrites
  // lastStatus), so an error/timeout revert restores the real prior favicon.
  const terminal = detectTerminalState(document)
  if (terminal)
    dispatchReconcile({
      type: "optimisticTerminal",
      terminal,
      baseline: currentBaseline()
    })
  chrome.runtime
    .sendMessage({ type: "prDomSignal", ref: currentRef })
    .catch(() => {})
}

function startMergeboxObserver(): void {
  if (mergeboxObserver) return
  const target = document.body ?? document.documentElement
  if (!target) return
  mergeboxObserver = new MutationObserver(() => {
    window.clearTimeout(mergeboxDebounce)
    mergeboxDebounce = window.setTimeout(
      handleMergeboxChange,
      SIGNAL_DEBOUNCE_MS
    )
  })
  mergeboxObserver.observe(target, { childList: true, subtree: true })
}

/** R11: if a PR page never shows a detectable mergebox, log once so the silent
 * fallback to poll-only is observable rather than looking like a slow favicon. */
function scheduleSelfCheck(): void {
  window.clearTimeout(selfCheckTimer)
  selfCheckTimer = window.setTimeout(() => {
    if (currentRef && !findMergeboxRegion(document) && !selfCheckLogged) {
      selfCheckLogged = true
      console.debug(
        "[prfav] mergebox region not found on a PR page — DOM signal idle, poll still active"
      )
    }
  }, SELF_CHECK_DELAY_MS)
}

/** Reset per-PR signal state on nav away / token-clear (the observer itself is
 * long-lived and only disconnected on pagehide). */
function resetMergeboxSignal(): void {
  window.clearTimeout(mergeboxDebounce)
  window.clearTimeout(selfCheckTimer)
  window.clearTimeout(revertTimer)
  revertTimer = 0
  reconcileState = IDLE
  lastSignature = null
  selfCheckLogged = false
}

async function register(ref: PrRef): Promise<void> {
  currentRef = ref
  captureOriginal()
  // Fresh PR (or sub-tab nav): reset the signal signature so the new page can
  // re-poke, (re)start the long-lived mergebox observer, and arm the self-check.
  lastSignature = null
  selfCheckLogged = false
  startMergeboxObserver()
  scheduleSelfCheck()
  // Title prefix is independent of the token — apply it up front.
  applyTitle(ref.number)
  startTitleObserver(ref.number)
  document.addEventListener("visibilitychange", reportVisibility)
  let res: RegisterPrResponse | undefined
  try {
    res = (await chrome.runtime.sendMessage({
      type: "registerPr",
      ref,
      visible: document.visibilityState === "visible"
    })) as RegisterPrResponse
  } catch {
    return
  }
  // Ref-match guard: a newer soft-nav may have re-registered during the await.
  if (!currentRef || refKey(currentRef) !== refKey(ref)) return
  // R4: no token → leave the favicon untouched (we never drew anything).
  if (!res?.hasToken) return
  drawStatus(res.status ?? "fetching")
}

function teardownToOriginal(): void {
  currentRef = null
  resetMergeboxSignal()
  document.removeEventListener("visibilitychange", reportVisibility)
  chrome.runtime.sendMessage({ type: "unregisterPr" }).catch(() => {})
  restoreOriginal()
  restoreTitle()
}

// Background → content pushes (poll updates, errors, token-clear restore).
chrome.runtime.onMessage.addListener((message: FaviconCommand) => {
  if (message?.type === "prStatus") {
    drawStatus(message.status, !!message.unread)
    // The authoritative status landed (agree ⇒ same pixels, disagree ⇒ corrected
    // above); cancel any pending optimistic-paint revert timer so it can't fire.
    if (reconcileState.pending) dispatchReconcile({ type: "authoritativePush" })
  } else if (message?.type === "prError") {
    // If an optimistic paint is pending, reconcile reverts it — the bare
    // `!lastDataUri` guard alone would leave a wrong favicon stranded (it's a
    // no-op once any favicon is drawn).
    if (reconcileState.pending) dispatchReconcile({ type: "error" })
    else if (!lastDataUri) drawStatus("fetching")
  } else if (message?.type === "restoreFavicon") {
    resetMergeboxSignal()
    restoreOriginal()
  }
  // Box-select's messages (arm/disarm/…) have no branch here → ignored.
})

// GitHub is a Turbo SPA — watch for soft navigation between/away from PRs.
let lastUrl = location.href
function onNav(): void {
  if (location.href === lastUrl) return
  lastUrl = location.href
  const ref = parsePrUrl(location.href)
  if (!ref) {
    if (currentRef) teardownToOriginal()
    return
  }
  if (currentRef && refKey(ref) === refKey(currentRef)) return
  void register(ref)
}
const navTimer = window.setInterval(onNav, 1000)
window.addEventListener("pagehide", () => {
  window.clearInterval(navTimer)
  mergeboxObserver?.disconnect()
  mergeboxObserver = null
  teardownToOriginal()
})

const initial = parsePrUrl(location.href)
if (initial) void register(initial)
