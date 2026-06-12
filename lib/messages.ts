// --- PR status favicon ---
import type { PrRef } from "./github-pr"
import type { PrStatus } from "./pr-status"

/** Shared message shapes for content ↔ background IPC (raw chrome messaging). */

/** Background → content (via chrome.tabs.sendMessage). */
export type BackgroundCommand = { type: "arm" } | { type: "disarm" }

/** Content → background (via chrome.runtime.sendMessage). */
export type CreateTabGroupRequest = {
  type: "createTabGroup"
  links: string[]
  groupName: string
}
export type ContentDisarmed = { type: "contentDisarmed" }
export type ContentRequest = CreateTabGroupRequest | ContentDisarmed

export type CreateTabGroupResponse = {
  ok: boolean
  opened: number
  failed: number
}

/** Content/Options → background (via chrome.runtime.sendMessage). */
export type RegisterPr = { type: "registerPr"; ref: PrRef; visible: boolean }
export type UnregisterPr = { type: "unregisterPr" }
/** Content → background: this tab's Page-Visibility state changed. */
export type VisibilityChanged = { type: "visibility"; visible: boolean }
export type TokenChanged = { type: "tokenChanged" }
export type TokenCleared = { type: "tokenCleared" }

/** Options → background: manage watched repos. */
export type AddWatchedRepo = {
  type: "addWatchedRepo"
  owner: string
  repo: string
}
export type RemoveWatchedRepo = {
  type: "removeWatchedRepo"
  owner: string
  repo: string
}

export type FaviconRequest =
  | RegisterPr
  | UnregisterPr
  | VisibilityChanged
  | TokenChanged
  | TokenCleared
  | AddWatchedRepo
  | RemoveWatchedRepo

export type RegisterPrResponse =
  | { hasToken: false }
  | { hasToken: true; status?: PrStatus; error?: boolean }

/** Response to `addWatchedRepo` (drives the Options inline feedback, W12). */
export type AddWatchedRepoResponse =
  | { ok: true }
  | {
      ok: false
      error:
        | "invalid"
        | "duplicate"
        | "no-token"
        | "no-access"
        | "network"
        | "rate-limit"
    }

/**
 * Background → favicon content script (via chrome.tabs.sendMessage).
 * `unread` drives the corner dot; absent/false means no dot.
 */
export type PrStatusPush = {
  type: "prStatus"
  status: PrStatus
  unread?: boolean
}
export type PrErrorPush = { type: "prError" }
export type RestoreFavicon = { type: "restoreFavicon" }
export type FaviconCommand = PrStatusPush | PrErrorPush | RestoreFavicon
