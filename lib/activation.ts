/**
 * Whether box-select can be armed on a tab with this URL. `chrome.action.onClicked`
 * fires on every tab, but the box-select content script now only runs on
 * github.com (the extension is scoped to GitHub). Guarding here prevents a stuck
 * "ON" badge on tabs where arming can never take effect.
 */
export function isArmableUrl(url: string | undefined): boolean {
  if (!url || !url.startsWith("https://")) return false
  try {
    return new URL(url).hostname === "github.com"
  } catch {
    return false
  }
}
