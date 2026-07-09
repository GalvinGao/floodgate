import { useEffect, useState } from "react"
import { match } from "ts-pattern"

import { isArmableUrl } from "~lib/activation"
import type {
  ArmBoxSelectResponse,
  GetArmStateResponse,
  OrganizePinsResponse,
  ReconcileTabsResponse
} from "~lib/messages"

const AUTO_PIN_KEY = "prFavicon.autoPin"

// A "selection marquee" glyph (four corner brackets + a grouped-tab chip) that
// ties the popup to the box-select feature.
function MarqueeGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M2.2 6.4V3.6A1.4 1.4 0 0 1 3.6 2.2H6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M13.6 2.2h2.8A1.4 1.4 0 0 1 17.8 3.6V6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M17.8 13.6v2.8a1.4 1.4 0 0 1-1.4 1.4H13.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M6.4 17.8H3.6a1.4 1.4 0 0 1-1.4-1.4V13.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect x="7" y="7" width="6" height="6" rx="1.4" fill="currentColor" />
    </svg>
  )
}

function StopGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="4" y="4" width="12" height="12" rx="2.4" fill="currentColor" />
    </svg>
  )
}

function Chevron() {
  return (
    <svg
      className="fg__chev"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden>
      <path
        d="M6.5 4l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Auto-pin segmented control — a sliding thumb toggles the storage flag.
function AutoPinSegmented({
  on,
  onChange
}: {
  on: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="seg" data-on={on} role="radiogroup" aria-label="Auto-pin">
      <span className="seg__thumb" aria-hidden />
      <button
        type="button"
        role="radio"
        aria-checked={!on}
        className={`seg__opt${!on ? " seg__opt--active" : ""}`}
        onClick={() => onChange(false)}>
        Off
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        className={`seg__opt seg__opt--on${on ? " seg__opt--active" : ""}`}
        onClick={() => onChange(true)}>
        On
      </button>
    </div>
  )
}

function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null)
  const [armedTabId, setArmedTabId] = useState<number | null>(null)
  const [autoPin, setAutoPin] = useState(true)
  const [arming, setArming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [organizeMsg, setOrganizeMsg] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (alive) setTab(tabs[0] ?? null)
    })
    chrome.runtime
      .sendMessage({ type: "getArmState" })
      .then((r?: GetArmStateResponse) => {
        if (alive && r) setArmedTabId(r.armedTabId)
      })
      .catch(() => {})
    chrome.storage.local.get(AUTO_PIN_KEY).then((s) => {
      if (alive) setAutoPin(s[AUTO_PIN_KEY] !== false)
    })

    // Keep the toggle in sync if Options flips it while the popup is open.
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes[AUTO_PIN_KEY]) {
        setAutoPin(changes[AUTO_PIN_KEY].newValue !== false)
      }
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [])

  const armable = isArmableUrl(tab?.url)
  const isArmed = tab?.id != null && armedTabId === tab.id
  const disabled = arming || (!armable && !isArmed)

  const setPin = (next: boolean) => {
    setAutoPin(next) // optimistic; storage.onChanged (and Options) reconcile
    void chrome.storage.local.set({ [AUTO_PIN_KEY]: next })
  }

  const onOrganize = async () => {
    const windowId = tab?.windowId
    if (windowId == null || organizing) return
    setOrganizing(true)
    setOrganizeMsg(null)
    const res = (await chrome.runtime
      .sendMessage({ type: "organizePins", windowId })
      .catch((err) => {
        console.error("[organize] sendMessage failed:", err)
        return { ok: false, error: String(err?.message ?? err) } as const
      })) as OrganizePinsResponse | undefined
    setOrganizing(false)
    if (!res) {
      setOrganizeMsg(
        "No response from the extension — reload it at chrome://extensions and retry."
      )
      return
    }
    if (res.ok === false) {
      setOrganizeMsg(`Couldn’t organize tabs: ${res.error}`)
      return
    }
    // "closed 2 merged and 1 duplicate" — merge the two close reasons into one clause.
    const closedBits: string[] = []
    if (res.closed > 0) closedBits.push(`${res.closed} merged`)
    if (res.deduped > 0) {
      closedBits.push(`${res.deduped} duplicate${res.deduped === 1 ? "" : "s"}`)
    }
    const parts: string[] = []
    if (closedBits.length > 0) parts.push(`closed ${closedBits.join(" and ")}`)
    if (res.moved > 0) {
      parts.push(`moved ${res.moved} tab${res.moved === 1 ? "" : "s"}`)
    }
    if (parts.length === 0) {
      setOrganizeMsg("Already organized — nothing to change.")
      return
    }
    const suffix = res.failed > 0 ? ` (${res.failed} couldn’t move)` : ""
    const msg = parts.join(", ") // sentence-case the first clause
    setOrganizeMsg(`${msg.charAt(0).toUpperCase()}${msg.slice(1)}${suffix}.`)
  }

  const onReconcile = async () => {
    if (reconciling) return
    setReconciling(true)
    setReconcileMsg(null)
    const res = (await chrome.runtime
      .sendMessage({ type: "reconcileTabs" })
      .catch((err) => {
        console.error("[reconcile] sendMessage failed:", err)
        return { ok: false, error: String(err?.message ?? err) } as const
      })) as ReconcileTabsResponse | undefined
    setReconciling(false)
    if (!res) {
      setReconcileMsg(
        "No response from the extension — reload it at chrome://extensions and retry."
      )
      return
    }
    if (res.ok === false) {
      setReconcileMsg(res.error)
      return
    }
    if (res.repos === 0) {
      setReconcileMsg("No watched repos yet — add some in settings.")
      return
    }
    const suffix =
      res.failed > 0 ? ` (${res.failed} repo couldn’t be read)` : ""
    if (res.opened === 0) {
      setReconcileMsg(`All open PRs are already open${suffix}.`)
      return
    }
    setReconcileMsg(
      `Opened ${res.opened} PR${res.opened === 1 ? "" : "s"}${suffix}.`
    )
  }

  const onTrigger = async () => {
    if (tab?.id == null) return

    // Armed already → the button cancels the selection instead.
    if (isArmed) {
      await chrome.runtime
        .sendMessage({ type: "disarmBoxSelect", tabId: tab.id })
        .catch(() => {})
      window.close()
      return
    }
    if (!armable) return

    setArming(true)
    setError(null)
    const res = (await chrome.runtime
      .sendMessage({ type: "armBoxSelect", tabId: tab.id })
      .catch(() => undefined)) as ArmBoxSelectResponse | undefined

    // Success → close the popup so the page is interactive and the user can drag.
    if (res?.ok) {
      window.close()
      return
    }
    setArming(false)
    setError("Couldn’t start here. Reload the GitHub page, then try again.")
  }

  const [label, caption] = match({ arming, isArmed, armable })
    .with({ arming: true }, () => ["Starting…", "Opening selection mode"])
    .with({ isArmed: true }, () => ["Stop selecting", "Cancel on this tab"])
    .with({ armable: true }, () => [
      "Select & group links",
      "Drag a box over links to group"
    ])
    .otherwise(() => ["Open a GitHub page", "Selection works on github.com"])

  return (
    <div className="fg">
      <style>{STYLE}</style>

      <header className="fg__head">
        <span className="fg__logo">
          <MarqueeGlyph size={17} />
        </span>
        <div>
          <div className="fg__title">Floodgate</div>
          <div className="fg__sub">GitHub tab tools</div>
        </div>
      </header>

      <button
        type="button"
        className={`fg__cta${isArmed ? " fg__cta--armed" : ""}`}
        disabled={disabled}
        onClick={() => void onTrigger()}
        aria-label={label}>
        <span className="fg__icn">
          {isArmed ? <StopGlyph /> : <MarqueeGlyph />}
        </span>
        <span className="fg__copy">
          <span className="fg__label">{label}</span>
          <span className="fg__cap">{caption}</span>
        </span>
        {!disabled && <Chevron />}
      </button>

      {error && <p className="fg__err">{error}</p>}

      <section className="fg__pin">
        <div className="fg__row">
          <span className="fg__rowlabel">Auto-pin PR tabs</span>
          <AutoPinSegmented on={autoPin} onChange={setPin} />
        </div>
        <p className="fg__note">
          When on, PR tabs (and watched-repo PRs) open pinned. Unpin one by hand
          and it stays that way.
        </p>

        <button
          type="button"
          className="fg__btn2"
          disabled={organizing || tab?.windowId == null}
          onClick={() => void onOrganize()}>
          {organizing ? "Organizing…" : "Organize Pins"}
        </button>
        <p className="fg__note">
          Groups PR tabs by repo (pinned tabs, each group, and the rest,
          separately), then closes ones that are already merged or duplicated.
        </p>
        {organizeMsg && <p className="fg__msg">{organizeMsg}</p>}

        <button
          type="button"
          className="fg__btn2"
          disabled={reconciling}
          onClick={() => void onReconcile()}>
          {reconciling ? "Reconciling…" : "Reconcile Tabs"}
        </button>
        <p className="fg__note">
          Opens every currently-open PR across your watched repos that isn’t
          already open — catching up on the backlog.
        </p>
        {reconcileMsg && <p className="fg__msg">{reconcileMsg}</p>}
      </section>

      <footer className="fg__foot">
        <button
          type="button"
          className="fg__link"
          onClick={() => chrome.runtime.openOptionsPage()}>
          Open settings
        </button>
      </footer>
    </div>
  )
}

const STYLE = `
  :root { color-scheme: dark; }
  html, body { margin: 0; }
  body { background: #1a1a1b; }
  * { box-sizing: border-box; }

  .fg {
    --surface: #242426;
    --surface-2: #2c2c2f;
    --line: rgba(255, 255, 255, 0.09);
    --line-2: rgba(255, 255, 255, 0.16);
    --text: #ededee;
    --muted: #a0a0a5;
    --faint: #6f6f75;
    --accent: #35e0c4;
    --accent-ink: #06231c;
    --danger: #ff7d7d;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

    width: 320px;
    padding: 18px 16px 14px;
    background: #1a1a1b;
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    animation: fg-in 0.3s ease both;
  }
  @keyframes fg-in { from { opacity: 0; } to { opacity: 1; } }

  .fg__head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .fg__logo {
    flex: none;
    width: 30px; height: 30px;
    display: grid; place-items: center;
    border-radius: 8px;
    color: var(--accent-ink);
    background: var(--accent);
  }
  .fg__title { font-size: 15px; font-weight: 600; line-height: 1.1; }
  .fg__sub { font-size: 12px; color: var(--faint); margin-top: 2px; }

  .fg__cta {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 14px;
    border-radius: 12px;
    border: 1px solid var(--line-2);
    background: var(--surface);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.18s, background 0.18s, transform 0.12s;
  }
  .fg__cta:hover:not(:disabled) { border-color: var(--accent); background: var(--surface-2); }
  .fg__cta:active:not(:disabled) { transform: translateY(1px); }
  .fg__cta:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fg__cta:disabled { cursor: default; opacity: 0.6; }
  .fg__cta--armed { border-color: rgba(255, 125, 125, 0.45); }
  .fg__cta--armed:hover:not(:disabled) { border-color: var(--danger); background: var(--surface-2); }

  .fg__icn {
    flex: none;
    width: 34px; height: 34px;
    display: grid; place-items: center;
    border-radius: 9px;
    color: var(--accent);
    background: rgba(53, 224, 196, 0.12);
  }
  .fg__cta--armed .fg__icn { color: var(--danger); background: rgba(255, 125, 125, 0.12); }
  .fg__cta:disabled .fg__icn { color: var(--muted); background: rgba(255, 255, 255, 0.05); }

  .fg__copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .fg__label { font-size: 16px; font-weight: 600; line-height: 1.15; }
  .fg__cap { font-size: 12px; color: var(--muted); line-height: 1.3; }

  .fg__chev {
    flex: none;
    margin-left: auto;
    color: var(--faint);
    transition: transform 0.15s, color 0.18s;
  }
  .fg__cta:hover:not(:disabled) .fg__chev { color: var(--accent); transform: translateX(2px); }
  .fg__cta--armed:hover:not(:disabled) .fg__chev { color: var(--danger); }

  .fg__err { margin: 8px 2px 0; font-size: 12px; line-height: 1.35; color: var(--danger); }

  .fg__pin { margin-top: 18px; }
  .fg__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .fg__rowlabel { font-size: 13px; font-weight: 500; }
  .fg__note { margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--faint); }
  .fg__msg { margin: 8px 2px 0; font-size: 12px; line-height: 1.35; color: var(--muted); }

  .fg__btn2 {
    margin-top: 12px;
    display: inline-flex;
    align-items: center;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1px solid var(--line-2);
    background: var(--surface);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.18s, background 0.18s, transform 0.12s;
  }
  .fg__btn2:hover:not(:disabled) { border-color: var(--accent); background: var(--surface-2); }
  .fg__btn2:active:not(:disabled) { transform: translateY(1px); }
  .fg__btn2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fg__btn2:disabled { cursor: default; opacity: 0.6; }

  .seg {
    position: relative;
    display: flex;
    padding: 3px;
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--line);
    min-width: 112px;
  }
  .seg__thumb {
    position: absolute;
    top: 3px; bottom: 3px; left: 3px;
    width: calc(50% - 3px);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.1);
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s;
  }
  .seg[data-on="true"] .seg__thumb { transform: translateX(100%); background: var(--accent); }
  .seg__opt {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 5px 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--faint);
    transition: color 0.18s;
  }
  .seg__opt--active { color: var(--text); }
  .seg[data-on="true"] .seg__opt--on { color: var(--accent-ink); font-weight: 600; }
  .seg__opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 7px; }

  .fg__foot {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: flex-end;
  }
  .fg__link {
    border: 0;
    background: transparent;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: var(--muted);
    transition: color 0.18s;
  }
  .fg__link:hover { color: var(--accent); }
  .fg__link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
`

export default Popup
