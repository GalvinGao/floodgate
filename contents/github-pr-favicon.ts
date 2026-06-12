import type { PlasmoCSConfig } from "plasmo"

import { drawFavicon } from "~lib/favicon"
import { parsePrUrl, type PrRef } from "~lib/github-pr"
import type { FaviconCommand, RegisterPrResponse } from "~lib/messages"
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

async function register(ref: PrRef): Promise<void> {
  currentRef = ref
  captureOriginal()
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
  document.removeEventListener("visibilitychange", reportVisibility)
  chrome.runtime.sendMessage({ type: "unregisterPr" }).catch(() => {})
  restoreOriginal()
  restoreTitle()
}

// Background → content pushes (poll updates, errors, token-clear restore).
chrome.runtime.onMessage.addListener((message: FaviconCommand) => {
  if (message?.type === "prStatus") drawStatus(message.status, !!message.unread)
  else if (message?.type === "prError") {
    if (!lastDataUri) drawStatus("fetching")
  } else if (message?.type === "restoreFavicon") {
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
  teardownToOriginal()
})

const initial = parsePrUrl(location.href)
if (initial) void register(initial)
