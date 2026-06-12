export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Axis-aligned intersection test. Edge contact counts as intersecting, matching
 * the "box touches the link" capture semantics (R4).
 */
export function rectsIntersect(a: Box, b: Box): boolean {
  return (
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top
  )
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * Whether a raw `href` attribute value points at an openable http/https target.
 * Rejects empty values, same-page fragments, and non-web schemes (javascript:,
 * mailto:, tel:, data:, …). Relative URLs are eligible because they resolve
 * against the page's http/https origin (R6).
 */
export function isEligibleHref(href: string | null | undefined): boolean {
  if (!href) return false
  const value = href.trim()
  if (value === "" || value.startsWith("#")) return false
  const scheme = value.match(SCHEME)?.[1]?.toLowerCase()
  if (scheme) return scheme === "http" || scheme === "https"
  // No explicit scheme → relative / protocol-relative → resolves to http(s).
  return true
}

/**
 * Canonical form for dedupe: drop the fragment and a trailing slash, keep the
 * query string (R6). Falls back to plain string trimming for non-absolute input.
 */
export function normalizeHref(href: string): string {
  try {
    const url = new URL(href)
    url.hash = ""
    const normalized = url.toString()
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
  } catch {
    const withoutHash = href.split("#")[0]
    return withoutHash.length > 1 && withoutHash.endsWith("/")
      ? withoutHash.slice(0, -1)
      : withoutHash
  }
}

/**
 * Dedupe by normalized href, preserving first-seen order and returning the
 * original href strings.
 */
export function dedupe(hrefs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const href of hrefs) {
    const key = normalizeHref(href)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(href)
    }
  }
  return out
}
