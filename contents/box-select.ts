import type { PlasmoCSConfig } from "plasmo"

import { dedupe, isEligibleHref, rectsIntersect, type Box } from "~lib/capture"
import type { BackgroundCommand, CreateTabGroupResponse } from "~lib/messages"
import { deriveGroupName } from "~lib/naming"

export const config: PlasmoCSConfig = {
  matches: ["https://github.com/*"]
}

const ACCENT = "#1a73e8"
const HIGH_COUNT = 15
const CLICK_THRESHOLD = 4 // px — a box smaller than this is treated as a click
const EDGE_ZONE = 60 // px from a viewport edge where auto-scroll engages
const MAX_SCROLL = 22 // px/frame at the very edge (eased toward the boundary)

interface Candidate {
  el: HTMLAnchorElement
  rect: Box
  href: string
}

// --- module state (single armed tab; this script instance owns its own page) ---
let active = false
let dragging = false
let host: HTMLElement | null = null
let overlay: HTMLDivElement | null = null
let boxEl: HTMLDivElement | null = null
let popupEl: HTMLDivElement | null = null
let start = { x: 0, y: 0 } // selection anchor, in PAGE coords (survives scroll)
let lastClient = { x: 0, y: 0 } // last pointer position, in VIEWPORT coords
let candidates: Candidate[] = []
let rafPending = false
let scrollRaf = 0 // rAF handle for the edge auto-scroll loop
const highlighted = new Map<HTMLElement, { outline: string; offset: string }>()

// ---------------------------------------------------------------------------
// Arm / teardown
// ---------------------------------------------------------------------------

function arm(): void {
  if (active) return
  active = true
  document.documentElement.style.cursor = "crosshair"
  buildOverlay()
  window.addEventListener("keydown", onKeyDown, true)
  // Bubble phase: only fire on the window itself losing focus, not on
  // descendant element blurs (which a capture-phase listener would catch).
  window.addEventListener("blur", onWindowBlur)
}

/** Single exit point for every cancel/confirm/disarm path (R3). */
function teardown(notifyBackground: boolean): void {
  if (!active) return
  for (const el of [...highlighted.keys()]) restoreHighlight(el)
  highlighted.clear()
  detachDragListeners()
  window.removeEventListener("keydown", onKeyDown, true)
  window.removeEventListener("blur", onWindowBlur)
  host?.remove()
  host = overlay = boxEl = popupEl = null
  document.documentElement.style.cursor = ""
  candidates = []
  dragging = false
  active = false
  if (notifyBackground) {
    chrome.runtime.sendMessage({ type: "contentDisarmed" }).catch(() => {})
  }
}

function buildOverlay(): void {
  host = document.createElement("div")
  host.style.cssText = "position:fixed;z-index:2147483647"
  const root = host.attachShadow({ mode: "open" })

  const style = document.createElement("style")
  style.textContent = STYLE
  root.appendChild(style)

  overlay = document.createElement("div")
  overlay.className = "overlay"

  boxEl = document.createElement("div")
  boxEl.className = "box box--hidden"
  overlay.appendChild(boxEl)

  root.appendChild(overlay)
  document.documentElement.appendChild(host)

  overlay.addEventListener("mousedown", onMouseDown, true)
}

// ---------------------------------------------------------------------------
// Drag lifecycle
// ---------------------------------------------------------------------------

function onMouseDown(event: MouseEvent): void {
  if (!active || event.button !== 0 || popupEl) return
  event.preventDefault()
  dragging = true
  start = {
    x: event.clientX + window.scrollX,
    y: event.clientY + window.scrollY
  }
  lastClient = { x: event.clientX, y: event.clientY }
  snapshotCandidates()
  updateBox()
  window.addEventListener("mousemove", onMouseMove, true)
  window.addEventListener("mouseup", onMouseUp, true)
  window.addEventListener("pointerup", onMouseUp, true)
  window.addEventListener("pointercancel", onPointerCancel, true)
  // Passive: we never block the scroll, we just re-anchor the box to it.
  window.addEventListener("scroll", onScroll, { passive: true })
}

function detachDragListeners(): void {
  window.removeEventListener("mousemove", onMouseMove, true)
  window.removeEventListener("mouseup", onMouseUp, true)
  window.removeEventListener("pointerup", onMouseUp, true)
  window.removeEventListener("pointercancel", onPointerCancel, true)
  window.removeEventListener("scroll", onScroll)
  stopAutoScroll()
}

/** Cache eligible anchors + their PAGE rects once, at drag start. */
function snapshotCandidates(): void {
  candidates = []
  const sx = window.scrollX
  const sy = window.scrollY
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    if (!isEligibleHref(a.getAttribute("href"))) return
    const r = a.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return // hidden / zero-size
    // Store in page coords (viewport + scroll) so cached rects stay valid as
    // the page scrolls under the selection.
    candidates.push({
      el: a,
      rect: {
        left: r.left + sx,
        top: r.top + sy,
        right: r.right + sx,
        bottom: r.bottom + sy
      },
      href: a.href
    })
  })
}

function onMouseMove(event: MouseEvent): void {
  lastClient = { x: event.clientX, y: event.clientY }
  scheduleRender()
  maybeAutoScroll()
}

/** Coalesce box + highlight repaints to one per frame (move or scroll driven). */
function scheduleRender(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    if (!dragging) return
    updateBox()
    recomputeHighlights(currentBox())
  })
}

// --- Edge auto-scroll --------------------------------------------------------
// Like file managers / spreadsheets / canvas editors: holding the drag near a
// viewport edge scrolls the page so the selection can extend past the fold. A
// self-driven rAF loop keeps scrolling while the pointer sits still at the edge
// (a mousemove-only approach would stall the moment the cursor stops).

/** Per-axis scroll speed: 0 outside the edge zone, eased up to MAX_SCROLL at the edge. */
function axisVelocity(pos: number, size: number): number {
  let d = 0
  if (pos < EDGE_ZONE)
    d = (pos - EDGE_ZONE) / EDGE_ZONE // negative → up/left
  else if (pos > size - EDGE_ZONE) d = (pos - (size - EDGE_ZONE)) / EDGE_ZONE
  const c = Math.max(-1, Math.min(1, d))
  return Math.sign(c) * c * c * MAX_SCROLL // ease-in toward the boundary
}

function autoScrollVelocity(): { vx: number; vy: number } {
  return {
    vx: axisVelocity(lastClient.x, window.innerWidth),
    vy: axisVelocity(lastClient.y, window.innerHeight)
  }
}

function maybeAutoScroll(): void {
  if (scrollRaf) return
  const { vx, vy } = autoScrollVelocity()
  if (vx || vy) scrollRaf = requestAnimationFrame(autoScrollTick)
}

function autoScrollTick(): void {
  scrollRaf = 0
  if (!dragging) return
  const { vx, vy } = autoScrollVelocity()
  if (!vx && !vy) return // pointer left the edge zone → loop ends
  window.scrollBy({ left: vx, top: vy, behavior: "instant" })
  scheduleRender()
  scrollRaf = requestAnimationFrame(autoScrollTick)
}

function stopAutoScroll(): void {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }
}

/** Re-anchor the box to the document as the page scrolls (auto or manual wheel). */
function onScroll(): void {
  if (dragging) scheduleRender()
}

function onMouseUp(): void {
  if (!dragging) return
  dragging = false
  detachDragListeners()

  const box = currentBox()
  if (
    box.right - box.left < CLICK_THRESHOLD &&
    box.bottom - box.top < CLICK_THRESHOLD
  ) {
    teardown(true) // a click, not a selection
    return
  }

  const hrefs = dedupe(
    candidates.filter((c) => rectsIntersect(box, c.rect)).map((c) => c.href)
  )

  if (hrefs.length === 0) {
    flashEmptyThenTeardown()
    return
  }

  showPopup(hrefs, toViewport(box))
}

function onPointerCancel(): void {
  if (dragging) teardown(true)
}

/** The selection box in PAGE coords: anchor (start) to pointer (client + scroll). */
function currentBox(): Box {
  const lx = lastClient.x + window.scrollX
  const ly = lastClient.y + window.scrollY
  return {
    left: Math.min(start.x, lx),
    top: Math.min(start.y, ly),
    right: Math.max(start.x, lx),
    bottom: Math.max(start.y, ly)
  }
}

/** Page coords → viewport coords for the position:fixed overlay/popup. */
function toViewport(b: Box): Box {
  return {
    left: b.left - window.scrollX,
    top: b.top - window.scrollY,
    right: b.right - window.scrollX,
    bottom: b.bottom - window.scrollY
  }
}

function updateBox(): void {
  if (!boxEl) return
  const b = toViewport(currentBox())
  boxEl.style.left = `${b.left}px`
  boxEl.style.top = `${b.top}px`
  boxEl.style.width = `${b.right - b.left}px`
  boxEl.style.height = `${b.bottom - b.top}px`
  boxEl.classList.remove("box--hidden")
}

function flashEmptyThenTeardown(): void {
  boxEl?.classList.add("box--empty")
  window.setTimeout(() => teardown(true), 400)
}

// ---------------------------------------------------------------------------
// Highlighting (on host-page anchors — outline ignores overflow:hidden clipping)
// ---------------------------------------------------------------------------

function recomputeHighlights(box: Box): void {
  const inSet = new Set<HTMLElement>()
  for (const c of candidates) {
    if (rectsIntersect(box, c.rect)) {
      inSet.add(c.el)
      if (!highlighted.has(c.el)) applyHighlight(c.el)
    }
  }
  for (const el of [...highlighted.keys()]) {
    if (!inSet.has(el)) restoreHighlight(el)
  }
}

function applyHighlight(el: HTMLElement): void {
  highlighted.set(el, {
    outline: el.style.outline,
    offset: el.style.outlineOffset
  })
  el.style.outline = `3px solid ${ACCENT}`
  el.style.outlineOffset = "1px"
}

function restoreHighlight(el: HTMLElement): void {
  const prev = highlighted.get(el)
  if (!prev) return
  el.style.outline = prev.outline
  el.style.outlineOffset = prev.offset
  highlighted.delete(el)
}

// ---------------------------------------------------------------------------
// Confirm popup
// ---------------------------------------------------------------------------

function showPopup(hrefs: string[], box: Box): void {
  if (!overlay) return
  const selected = new Set(hrefs)

  popupEl = document.createElement("div")
  popupEl.className = "popup"

  const header = document.createElement("div")
  header.className = "popup__header"
  popupEl.appendChild(header)

  const caution = document.createElement("div")
  caution.className = "popup__caution"
  caution.textContent = "Opening many tabs may briefly slow your browser."
  popupEl.appendChild(caution)

  const list = document.createElement("div")
  list.className = "popup__list"
  for (const href of hrefs) {
    const row = document.createElement("label")
    row.className = "popup__row"
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.checked = true
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(href)
      else selected.delete(href)
      syncState()
    })
    const label = document.createElement("span")
    label.className = "popup__label"
    label.textContent = linkLabel(href)
    label.title = href
    row.append(cb, label)
    list.appendChild(row)
  }
  popupEl.appendChild(list)

  const footer = document.createElement("div")
  footer.className = "popup__footer"
  const cancelBtn = document.createElement("button")
  cancelBtn.className = "popup__btn"
  cancelBtn.textContent = "Cancel"
  cancelBtn.addEventListener("click", () => teardown(true))
  const confirmBtn = document.createElement("button")
  confirmBtn.className = "popup__btn popup__btn--primary"
  const error = document.createElement("div")
  error.className = "popup__error"

  confirmBtn.addEventListener("click", () =>
    submit([...selected], confirmBtn, cancelBtn, error)
  )
  footer.append(error, cancelBtn, confirmBtn)
  popupEl.appendChild(footer)

  overlay.appendChild(popupEl)
  positionPopup(popupEl, box)

  function syncState(): void {
    const n = selected.size
    header.textContent = `${n} ${n === 1 ? "link" : "links"}`
    caution.classList.toggle("popup__caution--show", n > HIGH_COUNT)
    confirmBtn.textContent = n === 0 ? "Create group" : `Create group (${n})`
    confirmBtn.disabled = n === 0
  }
  syncState()
}

async function submit(
  links: string[],
  confirmBtn: HTMLButtonElement,
  cancelBtn: HTMLButtonElement,
  error: HTMLDivElement
): Promise<void> {
  if (links.length === 0) return
  confirmBtn.disabled = true
  cancelBtn.disabled = true
  confirmBtn.textContent = `Opening ${links.length}…`
  error.classList.remove("popup__error--show")

  const groupName = deriveGroupName({
    url: location.href,
    title: document.title
  })

  try {
    const res = (await chrome.runtime.sendMessage({
      type: "createTabGroup",
      links,
      groupName
    })) as CreateTabGroupResponse | undefined

    if (res?.ok) {
      teardown(true)
      return
    }
    showError(
      error,
      `Couldn't create the group${res?.failed ? ` (${res.failed} failed)` : ""}.`
    )
  } catch {
    showError(error, "Couldn't reach the extension — try reloading the page.")
  }
  confirmBtn.disabled = false
  cancelBtn.disabled = false
  confirmBtn.textContent = `Create group (${links.length})`
}

function showError(error: HTMLDivElement, message: string): void {
  error.textContent = message
  error.classList.add("popup__error--show")
}

/** Place beside the box: prefer right, flip left, then below, clamped to viewport. */
function positionPopup(popup: HTMLDivElement, box: Box): void {
  const margin = 8
  const { width: w, height: h } = popup.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = box.right + margin
  if (left + w > vw) left = box.left - margin - w // flip left
  let top = box.top

  if (left < margin) {
    // no room left or right → place below the box
    left = box.left
    top = box.bottom + margin
  }

  left = Math.min(Math.max(margin, left), vw - w - margin)
  top = Math.min(Math.max(margin, top), vh - h - margin)
  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
}

function linkLabel(href: string): string {
  try {
    const u = new URL(href)
    const text = u.host + u.pathname
    return text.length > 60 ? `${text.slice(0, 57)}…` : text
  } catch {
    return href
  }
}

// ---------------------------------------------------------------------------
// Global key / focus handlers
// ---------------------------------------------------------------------------

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    teardown(true)
  }
}

function onWindowBlur(): void {
  // Only cancel an in-progress drag; leave an open confirm popup alone.
  if (dragging) teardown(true)
}

// ---------------------------------------------------------------------------
// Background commands
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: BackgroundCommand) => {
  if (message?.type === "arm") arm()
  else if (message?.type === "disarm") teardown(false)
})

const STYLE = `
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1;
    cursor: crosshair;
    background: transparent;
  }
  .box {
    position: fixed;
    border: 1px solid ${ACCENT};
    background: rgba(26, 115, 232, 0.1);
    pointer-events: none;
  }
  .box--hidden { display: none; }
  .box--empty {
    border-color: #d93025;
    background: rgba(217, 48, 37, 0.12);
  }
  .popup {
    position: fixed;
    z-index: 2;
    width: 300px;
    max-width: calc(100vw - 16px);
    background: #fff;
    color: #202124;
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
  }
  .popup__header {
    padding: 10px 12px;
    font-weight: 600;
    border-bottom: 1px solid #eceff1;
  }
  .popup__caution {
    display: none;
    padding: 6px 12px;
    background: #fef7e0;
    color: #8a6d00;
    font-size: 12px;
  }
  .popup__caution--show { display: block; }
  .popup__list {
    max-height: 240px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .popup__row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    cursor: pointer;
  }
  .popup__row:hover { background: #f1f3f4; }
  .popup__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .popup__error {
    display: none;
    flex: 1;
    color: #d93025;
    font-size: 12px;
    align-self: center;
  }
  .popup__error--show { display: block; }
  .popup__footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid #eceff1;
  }
  .popup__footer > .popup__error { margin-right: auto; }
  .popup__btn {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid #dadce0;
    background: #fff;
    color: #202124;
    cursor: pointer;
    font: inherit;
  }
  .popup__btn:hover { background: #f1f3f4; }
  .popup__btn--primary {
    background: ${ACCENT};
    border-color: ${ACCENT};
    color: #fff;
    margin-left: auto;
  }
  .popup__btn--primary:hover { background: #1666c9; }
  .popup__btn:disabled { opacity: 0.55; cursor: default; }
`
