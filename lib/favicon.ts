import type { FaviconSpec, StatusColor } from "./pr-status"

/** Canonical fill color per status — shared by the canvas favicon and SVG legend. */
export const STATUS_HEX: Record<StatusColor, string> = {
  green: "#2da44e",
  amber: "#bf8700",
  red: "#cf222e",
  grey: "#8c959f",
  purple: "#8250df"
}

/**
 * Shared geometry for both renderers so the SVG legend can never drift from the
 * real (canvas) favicon: a rounded square split into two halves with a thin
 * transparent gap down the middle, plus an optional "+" centered low in the
 * left (review) half. The "+" centers on the *painted* left region, which the
 * 1px rounded-rect clip inset shifts slightly right of the geometric center.
 */
function geometry(size: number) {
  const mid = size / 2
  const half = Math.round(size * 0.06) // half the middle gap (~4px at 32px)
  const radius = size * 0.22
  return {
    radius,
    leftWidth: mid - half,
    rightX: mid + half,
    rightWidth: size - (mid + half),
    plus: {
      cx: (1 + (mid - half)) / 2, // center of the painted left region
      cy: size / 2, // vertical center of the half
      arm: Math.round(size * 0.15), // half-length of each bar
      thick: Math.round(size * 0.1) // bar thickness (lighter stroke)
    },
    // Unread dot: nestled into the top-right, centered on the corner arc center
    // so it stays inside the rounded-rect clip in both renderers. A white halo
    // ring keeps it legible on any half-color. Sits over the right (check) half,
    // clear of the "+" (low-left), so the two never collide.
    dot: {
      cx: size - 1 - radius,
      cy: 1 + radius,
      rOuter: size * 0.2, // white ring radius
      rInner: size * 0.15 // accent fill radius
    }
  }
}

/** Accent for the unread dot — the extension's blue, distinct from the 5 status hues. */
export const UNREAD_DOT_HEX = "#1a73e8"

/**
 * Render the favicon to a PNG data URI for `<link rel="icon">`. Drawn at a fixed
 * resolution and downscaled by the browser into the favicon slot. Content-script
 * / canvas only.
 */
export function drawFavicon(
  spec: FaviconSpec,
  size = 32,
  opts: { unread?: boolean } = {}
): string {
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")
  if (!ctx) return ""
  const g = geometry(size)

  roundRect(ctx, 1, 1, size - 2, size - 2, g.radius)
  ctx.clip()

  if (spec.whole) {
    // Single solid square (lifecycle state) — no gap, no "+".
    ctx.fillStyle = STATUS_HEX[spec.left]
    ctx.fillRect(0, 0, size, size)
    if (opts.unread) drawDot(ctx, g)
    return canvas.toDataURL("image/png")
  }

  ctx.fillStyle = STATUS_HEX[spec.left]
  ctx.fillRect(0, 0, g.leftWidth, size)
  ctx.fillStyle = STATUS_HEX[spec.right]
  ctx.fillRect(g.rightX, 0, g.rightWidth, size)

  if (spec.plus) {
    const p = g.plus
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(p.cx - p.arm, p.cy - p.thick / 2, p.arm * 2, p.thick) // horizontal
    ctx.fillRect(p.cx - p.thick / 2, p.cy - p.arm, p.thick, p.arm * 2) // vertical
  }

  if (opts.unread) drawDot(ctx, g)

  return canvas.toDataURL("image/png")
}

/** Top-right unread dot: white halo + accent fill. Drawn inside the clip. */
function drawDot(
  ctx: CanvasRenderingContext2D,
  g: ReturnType<typeof geometry>
): void {
  const d = g.dot
  ctx.fillStyle = "#ffffff"
  ctx.beginPath()
  ctx.arc(d.cx, d.cy, d.rOuter, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = UNREAD_DOT_HEX
  ctx.beginPath()
  ctx.arc(d.cx, d.cy, d.rInner, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Render the same favicon as a crisp, resolution-independent SVG string. Used by
 * the options-page legend; shares geometry() with drawFavicon so the two stay
 * pixel-for-pixel consistent. Embed via `data:image/svg+xml,${encodeURIComponent(...)}`.
 */
export function faviconSvg(
  spec: FaviconSpec,
  size = 64,
  opts: { unread?: boolean } = {}
): string {
  const g = geometry(size)
  let body: string
  let plus = ""
  if (spec.whole) {
    body = `<rect width="${size}" height="${size}" fill="${STATUS_HEX[spec.left]}"/>`
  } else {
    body =
      `<rect width="${g.leftWidth}" height="${size}" fill="${STATUS_HEX[spec.left]}"/>` +
      `<rect x="${g.rightX}" width="${g.rightWidth}" height="${size}" fill="${STATUS_HEX[spec.right]}"/>`
    if (spec.plus) {
      const p = g.plus
      plus =
        `<rect x="${p.cx - p.arm}" y="${p.cy - p.thick / 2}" width="${p.arm * 2}" height="${p.thick}" fill="#fff"/>` +
        `<rect x="${p.cx - p.thick / 2}" y="${p.cy - p.arm}" width="${p.thick}" height="${p.arm * 2}" fill="#fff"/>`
    }
  }
  // Dot lives inside the clip group (like the canvas) so the two renderers match.
  const dot = opts.unread
    ? `<circle cx="${g.dot.cx}" cy="${g.dot.cy}" r="${g.dot.rOuter}" fill="#fff"/>` +
      `<circle cx="${g.dot.cx}" cy="${g.dot.cy}" r="${g.dot.rInner}" fill="${UNREAD_DOT_HEX}"/>`
    : ""
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><clipPath id="c"><rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="${g.radius}"/></clipPath></defs>` +
    `<g clip-path="url(#c)">${body}${dot}</g>${plus}` +
    `</svg>`
  )
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
