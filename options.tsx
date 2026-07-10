import {
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode
} from "react"

import { faviconSvg, STATUS_HEX } from "~lib/favicon"
import { validateToken } from "~lib/github-api"
import { prUrl, refKey, type PrRef } from "~lib/github-pr"
import type { AddWatchedRepoResponse } from "~lib/messages"
import {
  toFaviconSpec,
  type CheckState,
  type FaviconSpec,
  type PrStatus,
  type ReviewState,
  type StatusColor
} from "~lib/pr-status"
import { REGISTRY_KEY, type RegistrySnapshot } from "~lib/registry"
import { formatRelative } from "~lib/relative-time"
import {
  AUTO_PIN_KEY,
  hasTokenValue,
  isAutoPinOn,
  TOKEN_KEY
} from "~lib/settings"
import {
  LAST_FETCHED_KEY,
  parseOwnerRepo,
  WATCHED_KEY,
  type WatchedRepo,
  type WatchedSnapshot
} from "~lib/watched"

/** Crisp, scalable SVG favicon as an <img>-ready data URI. */
const svgSrc = (spec: FaviconSpec, unread = false) =>
  `data:image/svg+xml,${encodeURIComponent(faviconSvg(spec, 64, { unread }))}`

type Status =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "ok"; login?: string; warn: boolean }
  | { kind: "error"; message: string }

/**
 * A <button> whose `hoverStyle` is merged over `style` while hovered (and
 * skipped when disabled). Inline styles can't carry a CSS `:hover`, so the page
 * tracks it in state — keeping the existing inline-style idiom intact.
 */
function HoverButton({
  style,
  hoverStyle,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { hoverStyle?: CSSProperties }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      {...rest}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
        ...style,
        ...(hovered && !disabled ? hoverStyle : null)
      }}
    />
  )
}

/** Small rounded color chip matching a favicon half's fill. */
function Swatch({ color }: { color: StatusColor }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        flex: "none",
        borderRadius: 4,
        background: STATUS_HEX[color],
        border: "1px solid rgba(27,31,36,0.15)"
      }}
    />
  )
}

function KeyRow({
  color,
  children
}: {
  color: StatusColor
  children: ReactNode
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "5px 0"
      }}>
      <Swatch color={color} />
      <span>{children}</span>
    </li>
  )
}

/** Visual guide to the split favicon. Renders the real drawFavicon output. */
function FaviconLegend() {
  const ex = useMemo(
    () => ({
      hero: svgSrc({ left: "green", right: "amber" }),
      plus: svgSrc({ left: "red", right: "green", plus: true }),
      lifecycle: [
        {
          uri: svgSrc({ left: "purple", right: "purple", whole: true }),
          text: "Merged"
        },
        {
          uri: svgSrc({ left: "grey", right: "grey", whole: true }),
          text: "Draft"
        },
        {
          uri: svgSrc({ left: "red", right: "red", whole: true }),
          text: "Closed"
        }
      ],
      combos: [
        {
          uri: svgSrc({ left: "green", right: "green" }),
          text: "Approved · all checks passing — good to merge"
        },
        {
          uri: svgSrc({ left: "red", right: "amber" }),
          text: "Changes requested · checks still running"
        },
        {
          uri: svgSrc({ left: "red", right: "green", plus: true }),
          text: "Changes requested, but new commits pushed since (note the +)"
        },
        {
          uri: svgSrc({ left: "grey", right: "red" }),
          text: "Not reviewed yet · a check failed"
        },
        {
          uri: svgSrc({ left: "grey", right: "grey" }),
          text: "Loading, or no status yet"
        }
      ]
    }),
    []
  )

  return (
    <section>
      <h3 style={{ margin: "0 0 6px" }}>How to read the favicon</h3>
      <p style={{ marginTop: 0 }}>
        On a pull-request tab the icon is split down the middle. The{" "}
        <strong>left half is the review state</strong> and the{" "}
        <strong>right half is the checks (CI) state</strong>.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          flexWrap: "wrap",
          margin: "16px 0"
        }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6
          }}>
          <img
            src={ex.hero}
            width={104}
            height={104}
            alt="Example PR favicon"
          />
          <div
            style={{
              display: "flex",
              width: 104,
              justifyContent: "space-between",
              fontSize: 12,
              fontWeight: 600,
              color: "#57606a"
            }}>
            <span>Review</span>
            <span>Checks</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Left · Review
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <KeyRow color="green">Approved</KeyRow>
              <KeyRow color="red">Changes requested</KeyRow>
              <KeyRow color="grey">Not reviewed</KeyRow>
            </ul>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Right · Checks
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <KeyRow color="green">All passing</KeyRow>
              <KeyRow color="amber">Running</KeyRow>
              <KeyRow color="red">Failed</KeyRow>
              <KeyRow color="grey">No checks</KeyRow>
            </ul>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "#f6f8fa",
          border: "1px solid #eaeef2",
          borderRadius: 8,
          padding: "10px 12px"
        }}>
        <img
          src={ex.plus}
          width={44}
          height={44}
          alt="Favicon with a plus mark"
        />
        <div style={{ fontSize: 13 }}>
          The <strong>“+” mark</strong> on the red half means changes were
          requested <em>and</em> new commits have been pushed since — a cue that
          the PR is ready for another look.
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Whole icon — PR lifecycle
        </div>
        <div style={{ fontSize: 13, color: "#57606a", marginBottom: 8 }}>
          When a PR isn’t open for review the icon is a single solid color:
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          {ex.lifecycle.map((l) => (
            <div
              key={l.text}
              style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src={l.uri} width={22} height={22} alt="" />
              <span style={{ fontSize: 13 }}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Examples</div>
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 10
          }}>
          {ex.combos.map((c) => (
            <li
              key={c.text}
              style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src={c.uri} width={28} height={28} alt="" />
              <span style={{ fontSize: 13 }}>{c.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// --- Monitored PR list -------------------------------------------------------

const REVIEW_TEXT: Record<ReviewState, string> = {
  approved: "Approved",
  changes: "Changes requested",
  none: "No review yet"
}
const CHECK_TEXT: Record<CheckState, string> = {
  success: "checks passing",
  pending: "checks running",
  failure: "checks failing",
  none: "no checks"
}

interface MonitoredItem {
  key: string
  ref: PrRef
  status?: PrStatus
  error?: boolean
  unread: boolean
  tabs: number
}

/** Collapse the per-tab registry into one row per unique PR. */
function coalesce(snapshot: RegistrySnapshot): MonitoredItem[] {
  const byKey = new Map<string, MonitoredItem>()
  for (const entry of Object.values(snapshot)) {
    if (!entry?.ref) continue
    const key = refKey(entry.ref)
    const item = byKey.get(key)
    if (item) {
      item.tabs++
      if (!item.status && entry.status) item.status = entry.status
      if (entry.error) item.error = true
      if (entry.unread) item.unread = true // unread if ANY of the PR's tabs is
    } else {
      byKey.set(key, {
        key,
        ref: entry.ref,
        status: entry.status,
        error: entry.error,
        unread: !!entry.unread,
        tabs: 1
      })
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function statusText(it: MonitoredItem): string {
  if (it.error) return "Couldn’t fetch — check token access"
  if (!it.status) return "Awaiting status…"
  const s = it.status
  if (s.state === "merged") return "Merged"
  if (s.state === "closed") return "Closed"
  if (s.isDraft) return "Draft"
  const base = `${REVIEW_TEXT[s.review]} · ${CHECK_TEXT[s.check]}`
  return s.commitsSinceChanges ? `${base} · new commits` : base
}

/** Live view of the PRs the background is currently tracking (storage.session). */
function MonitoredPrs() {
  const [items, setItems] = useState<MonitoredItem[]>([])

  useEffect(() => {
    let alive = true
    chrome.storage.session.get(REGISTRY_KEY).then((s) => {
      if (alive) setItems(coalesce(s[REGISTRY_KEY] ?? {}))
    })
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "session" && changes[REGISTRY_KEY]) {
        setItems(coalesce(changes[REGISTRY_KEY].newValue ?? {}))
      }
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [])

  const unreadCount = items.filter((it) => it.unread).length
  const heading =
    `Currently monitoring${items.length ? ` (${items.length})` : ""}` +
    (unreadCount === 0
      ? ""
      : unreadCount === 1
        ? " · 1 update"
        : ` · ${unreadCount} with updates`)

  return (
    <section>
      <h3 style={{ margin: "0 0 6px" }}>{heading}</h3>
      {items.length === 0 ? (
        <p style={{ marginTop: 0, color: "#57606a" }}>
          No PRs are being monitored. Open a GitHub pull request in a tab and
          it’ll show up here.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 8
          }}>
          {items.map((it) => (
            <li
              key={it.key}
              style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img
                src={svgSrc(
                  toFaviconSpec(it.status ?? "fetching"),
                  !!it.status && it.unread
                )}
                width={22}
                height={22}
                alt=""
                style={{ flex: "none" }}
              />
              <a
                href={prUrl(it.ref)}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 13,
                  color: "#0969da",
                  textDecoration: "none"
                }}>
                {it.key}
              </a>
              <span
                style={{
                  fontSize: 12,
                  color: it.error ? "#cf222e" : "#57606a"
                }}>
                {statusText(it)}
              </span>
              {it.tabs > 1 && (
                <span style={{ fontSize: 11, color: "#8c959f" }}>
                  ×{it.tabs} tabs
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// --- Watched repositories ----------------------------------------------------

const ADD_ERROR_MSG: Record<string, string> = {
  invalid: "Use owner/repo format (e.g. acme/api).",
  duplicate: "You’re already watching that repo.",
  "no-token": "Save a GitHub token first.",
  "no-access":
    "Couldn’t access that repo — check the name and your token’s access.",
  network: "Couldn’t reach GitHub — check your connection.",
  "rate-limit": "GitHub rate limit reached — try again in a minute."
}

/**
 * Freshness line for the watched poll. Reads the session-scoped last-poll stamp,
 * updates live as polls land, and re-renders every 30s so the relative label
 * keeps ticking. Hides itself until the first poll cycle has run.
 */
function LastFetched() {
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    chrome.storage.session.get(LAST_FETCHED_KEY).then((s) => {
      const v = s[LAST_FETCHED_KEY]
      if (alive && typeof v === "number") setFetchedAt(v)
    })
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "session" && changes[LAST_FETCHED_KEY]) {
        const v = changes[LAST_FETCHED_KEY].newValue
        setFetchedAt(typeof v === "number" ? v : null)
        setNow(Date.now()) // a fresh poll → recompute against "now" immediately
      }
    }
    chrome.storage.onChanged.addListener(onChange)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
      clearInterval(tick)
    }
  }, [])

  if (fetchedAt == null) return null
  const d = new Date(fetchedAt)
  return (
    <p style={{ fontSize: 12, color: "#8c959f", margin: "6px 0 0" }}>
      Last fetched{" "}
      <time dateTime={d.toISOString()} title={d.toLocaleString()}>
        {formatRelative(fetchedAt, now)}
      </time>
      .
    </p>
  )
}

/** Add/remove watched repos; new PRs in them open automatically. */
function WatchedRepos() {
  const [repos, setRepos] = useState<WatchedRepo[]>([])
  const [hasToken, setHasToken] = useState(false)
  const [input, setInput] = useState("")
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    chrome.storage.local.get([WATCHED_KEY, TOKEN_KEY]).then((local) => {
      if (!alive) return
      setRepos(Object.values((local[WATCHED_KEY] ?? {}) as WatchedSnapshot))
      setHasToken(hasTokenValue(local[TOKEN_KEY]))
    })
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local") return
      if (changes[WATCHED_KEY]) {
        setRepos(
          Object.values(
            (changes[WATCHED_KEY].newValue ?? {}) as WatchedSnapshot
          )
        )
      }
      if (changes[TOKEN_KEY]) {
        setHasToken(hasTokenValue(changes[TOKEN_KEY].newValue))
      }
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [])

  const add = async () => {
    const parsed = parseOwnerRepo(input)
    if (!parsed) {
      setError(ADD_ERROR_MSG.invalid)
      return
    }
    if (repos.some((r) => r.owner === parsed.owner && r.repo === parsed.repo)) {
      setError(ADD_ERROR_MSG.duplicate)
      return
    }
    setAdding(true)
    setError(null)
    const res = (await chrome.runtime
      .sendMessage({
        type: "addWatchedRepo",
        owner: parsed.owner,
        repo: parsed.repo
      })
      .catch(() => undefined)) as AddWatchedRepoResponse | undefined
    setAdding(false)
    // A dropped/undefined response still likely added the repo (the list updates
    // live via storage.onChanged); only surface an error the background returned.
    if (res && res.ok === false) {
      setError(ADD_ERROR_MSG[res.error] ?? "Couldn’t add that repo.")
      return
    }
    setInput("")
  }

  const remove = (r: WatchedRepo) => {
    chrome.runtime
      .sendMessage({ type: "removeWatchedRepo", owner: r.owner, repo: r.repo })
      .catch(() => {})
  }

  const sorted = [...repos].sort((a, b) =>
    `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`)
  )

  return (
    <section>
      <h3 style={{ margin: "0 0 6px" }}>Watched repositories</h3>
      <p style={{ marginTop: 0, color: "#57606a", fontSize: 13 }}>
        New PRs opened after you add a repo open automatically as inactive tabs
        (pinned only if auto-pin is on, below). Renovate and draft PRs are
        skipped.
      </p>

      <LastFetched />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          placeholder="owner/repo"
          disabled={!hasToken || adding}
          onChange={(e) => {
            setInput(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add()
          }}
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #d0d7de",
            font: "inherit",
            boxSizing: "border-box"
          }}
        />
        <HoverButton
          onClick={() => void add()}
          disabled={!hasToken || adding}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid #1f883d",
            background: hasToken ? "#1f883d" : "#94d3a2",
            color: "#fff",
            cursor: hasToken ? "pointer" : "default",
            font: "inherit"
          }}
          hoverStyle={{ background: "#1a7f37", border: "1px solid #1a7f37" }}>
          {adding ? "Adding…" : "Watch"}
        </HoverButton>
      </div>

      {!hasToken && (
        <p
          style={{
            fontSize: 12,
            color: repos.length > 0 ? "#bf8700" : "#57606a",
            margin: "6px 0 0"
          }}>
          {repos.length > 0
            ? "Polling paused — save a valid token above to resume watching."
            : "Save a GitHub token above to watch repositories."}
        </p>
      )}
      {error && (
        <p style={{ fontSize: 13, color: "#cf222e", margin: "6px 0 0" }}>
          {error}
        </p>
      )}

      {sorted.length === 0 ? (
        <p style={{ color: "#57606a", fontSize: 13, margin: "12px 0 0" }}>
          No watched repos yet.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "12px 0 0",
            display: "grid",
            gap: 6
          }}>
          {sorted.map((r) => {
            const key = `${r.owner}/${r.repo}`
            return (
              <li
                key={key}
                style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <a
                  href={`https://github.com/${key}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    flex: 1,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 13,
                    color: "#0969da",
                    textDecoration: "none"
                  }}>
                  {key}
                </a>
                <HoverButton
                  onClick={() => remove(r)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 6,
                    border: "1px solid #d0d7de",
                    background: "#fff",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 12
                  }}
                  hoverStyle={{
                    background: "#cf222e",
                    border: "1px solid #cf222e",
                    color: "#fff"
                  }}>
                  Remove
                </HoverButton>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// --- Auto-pin toggle ---------------------------------------------------------

/** Switch for auto-pinning PR tabs. On by default (key absent === on). */
function AutoPinToggle() {
  const [autoPin, setAutoPin] = useState(true)

  useEffect(() => {
    let alive = true
    chrome.storage.local.get(AUTO_PIN_KEY).then((local) => {
      if (alive) setAutoPin(isAutoPinOn(local[AUTO_PIN_KEY]))
    })
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && changes[AUTO_PIN_KEY]) {
        setAutoPin(isAutoPinOn(changes[AUTO_PIN_KEY].newValue))
      }
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [])

  const toggle = (next: boolean) => {
    setAutoPin(next)
    void chrome.storage.local.set({ [AUTO_PIN_KEY]: next })
  }

  return (
    <section>
      <h3 style={{ margin: "0 0 6px" }}>Pinning</h3>
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          cursor: "pointer"
        }}>
        <input
          type="checkbox"
          checked={autoPin}
          onChange={(e) => toggle(e.target.checked)}
          style={{ marginTop: 3, flex: "none" }}
        />
        <span>
          <span style={{ fontWeight: 600 }}>Auto-pin pull-request tabs</span>
          <span
            style={{
              display: "block",
              fontSize: 13,
              color: "#57606a",
              marginTop: 2
            }}>
            When on, opening a PR pins its tab (and watched-repo PRs open
            pinned). On by default — turn it off to keep PR tabs unpinned. A tab
            you unpin by hand is never re-pinned.
          </span>
        </span>
      </label>
    </section>
  )
}

function OptionsPage() {
  const [token, setToken] = useState("")
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  useEffect(() => {
    chrome.storage.local.get(TOKEN_KEY).then((stored) => {
      if (typeof stored[TOKEN_KEY] === "string") setToken(stored[TOKEN_KEY])
    })
  }, [])

  const save = async () => {
    setStatus({ kind: "validating" })
    const res = await validateToken(fetch, token)
    if (!res.ok) {
      const message =
        res.error === "auth"
          ? "Token invalid or expired — generate a new one."
          : res.error === "network"
            ? "Couldn't reach GitHub — check your connection."
            : "Token is empty or could not be validated."
      setStatus({ kind: "error", message })
      return
    }
    await chrome.storage.local.set({ [TOKEN_KEY]: token.trim() })
    chrome.runtime.sendMessage({ type: "tokenChanged" }).catch(() => {})
    setStatus({
      kind: "ok",
      login: res.login,
      warn: res.warn === "broad-scope"
    })
  }

  const clear = async () => {
    await chrome.storage.local.remove(TOKEN_KEY)
    chrome.runtime.sendMessage({ type: "tokenCleared" }).catch(() => {})
    setToken("")
    setStatus({ kind: "idle" })
  }

  return (
    <div
      style={{
        font: "14px/1.5 system-ui, -apple-system, sans-serif",
        maxWidth: 520,
        margin: "0 auto",
        padding: 24,
        color: "#1f2328"
      }}>
      <h2 style={{ margin: "0 0 2px" }}>
        Floodgate{" "}
        <span style={{ fontSize: 13, fontWeight: 400, color: "#8c959f" }}>
          · for GitHub
        </span>
      </h2>
      <p style={{ margin: "0 0 16px", color: "#57606a", fontSize: 13 }}>
        Shows review and check status for GitHub PRs, and auto-opens new PRs
        from watched repos.
      </p>
      <p>
        Paste a GitHub personal access token. The token is stored locally and
        used only to read PR review &amp; check status from{" "}
        <code>api.github.com</code>.
      </p>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
        GitHub token
      </label>
      <input
        type="password"
        value={token}
        placeholder="github_pat_… or ghp_…"
        onChange={(e) => setToken(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 6,
          border: "1px solid #d0d7de",
          font: "inherit",
          boxSizing: "border-box"
        }}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <HoverButton
          onClick={save}
          disabled={status.kind === "validating"}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid #1f883d",
            background: "#1f883d",
            color: "#fff",
            cursor: "pointer",
            font: "inherit"
          }}
          hoverStyle={{ background: "#1a7f37", border: "1px solid #1a7f37" }}>
          {status.kind === "validating" ? "Validating…" : "Save"}
        </HoverButton>
        <HoverButton
          onClick={clear}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid #d0d7de",
            background: "#fff",
            cursor: "pointer",
            font: "inherit"
          }}
          hoverStyle={{ background: "#f3f4f6", border: "1px solid #c9d1d9" }}>
          Clear
        </HoverButton>
      </div>

      {status.kind === "ok" && (
        <p style={{ color: "#1a7f37" }}>
          ✓ Valid{status.login ? ` — signed in as ${status.login}` : ""}.
          {status.warn
            ? " ⚠️ This token has broad write scopes; a read-only fine-grained PAT is recommended."
            : ""}
        </p>
      )}
      {status.kind === "error" && (
        <p style={{ color: "#cf222e" }}>{status.message}</p>
      )}

      <p style={{ fontSize: 13, color: "#57606a", marginTop: 12 }}>
        <strong>Required scopes</strong> — a fine-grained PAT with{" "}
        <em>Pull requests: Read</em> and <em>Commit statuses: Read</em> (add
        repo access for private repos). Avoid classic tokens with write scopes.
        If you uninstall the extension, revoke the token at{" "}
        <code>github.com/settings/tokens</code>.
      </p>

      <hr
        style={{ border: 0, borderTop: "1px solid #eaeef2", margin: "20px 0" }}
      />

      <WatchedRepos />

      <hr
        style={{ border: 0, borderTop: "1px solid #eaeef2", margin: "20px 0" }}
      />

      <AutoPinToggle />

      <hr
        style={{ border: 0, borderTop: "1px solid #eaeef2", margin: "20px 0" }}
      />

      <MonitoredPrs />

      <hr
        style={{ border: 0, borderTop: "1px solid #eaeef2", margin: "20px 0" }}
      />

      <FaviconLegend />
    </div>
  )
}

export default OptionsPage
