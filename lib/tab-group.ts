import { nextGroupColor, type GroupColor } from "./color"

/**
 * The slice of Chrome's tab APIs that tab-group creation needs, injected so the
 * orchestration is unit-testable without a live browser.
 */
export interface TabGroupApi {
  /** Open a background tab and resolve its tab id (or undefined on failure). */
  create(url: string): Promise<number | undefined>
  /** Group the given tab ids and resolve the new group id. */
  group(tabIds: number[]): Promise<number>
  /** Set the group's title and color. */
  update(
    groupId: number,
    info: { title: string; color: GroupColor }
  ): Promise<void>
}

export interface OpenAndGroupResult {
  groupId: number | null
  opened: number
  failed: number
  colorUsed: GroupColor | null
}

/**
 * Open every link as a background tab, then wrap the successfully-opened tabs in
 * one group titled `groupName` (R9, R10).
 *
 * When `leadTabId` is given (the page the selection was made on), it is included
 * as the group's first tab. Freshly created tabs append at the end of the strip,
 * so they always carry higher indices than the pre-existing lead tab; since
 * Chrome orders a group by tab-strip index, the lead tab lands first.
 *
 * Uses `Promise.allSettled` so a single failed `create` (popup-blocked, 404,
 * no-access) does not abort the batch — the group still forms from the tabs that
 * opened (the accepted partial-open behavior). Grouping is skipped entirely when
 * the link set is empty or every create failed, so `chrome.tabs.group` is never
 * called with an empty id list (a lone lead tab is not worth a singleton group).
 */
export async function openAndGroup(
  links: string[],
  groupName: string,
  colorCounter: number,
  api: TabGroupApi,
  leadTabId?: number
): Promise<OpenAndGroupResult> {
  if (links.length === 0) {
    return { groupId: null, opened: 0, failed: 0, colorUsed: null }
  }

  const settled = await Promise.allSettled(links.map((url) => api.create(url)))

  const tabIds: number[] = []
  let failed = 0
  for (const result of settled) {
    if (result.status === "fulfilled" && typeof result.value === "number") {
      tabIds.push(result.value)
    } else {
      failed++
    }
  }

  if (tabIds.length === 0) {
    return { groupId: null, opened: 0, failed, colorUsed: null }
  }

  const groupTabIds = leadTabId != null ? [leadTabId, ...tabIds] : tabIds
  const groupId = await api.group(groupTabIds)
  const color = nextGroupColor(colorCounter)
  await api.update(groupId, { title: groupName, color })

  return { groupId, opened: tabIds.length, failed, colorUsed: color }
}
