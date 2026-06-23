# Floodgate — _for GitHub_

[<img alt="Available in the Chrome Web Store" height="58" src="https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png" />](https://chromewebstore.google.com/detail/floodgate/mdbhlpponkfcnihbolinmgdglggapepk)

<img width="558" height="680" alt="image" src="https://github.com/user-attachments/assets/ca419cab-1916-4932-81ec-b0c61735d802" />

Floodgate is a Chrome extension (MV3) for working with GitHub pull requests. It:

- **shows each open PR's review and checks state in the tab favicon**, updated
  live;
- **marks PRs that changed while the tab was backgrounded** with an unread dot,
  cleared when you focus the tab;
- **auto-opens new PRs from watched repos** as inactive, pinned, deduped tabs;
- **opens a box-selected cluster of links** (e.g. a stack of PRs in an issue) as
  one named tab group.

Works on **github.com** only. The PR features need a GitHub token (a fine-grained
PAT with _Pull requests: Read_); set it in the extension's **Options** page.

## Install

Install from the
[Chrome Web Store](https://chromewebstore.google.com/detail/floodgate/mdbhlpponkfcnihbolinmgdglggapepk),
then open the **Options** page to add your GitHub token.

## Develop

```bash
pnpm install
pnpm dev    # then load build/chrome-mv3-dev via chrome://extensions → Load unpacked
pnpm test   # unit tests for lib/
pnpm build  # production build → build/chrome-mv3-prod
```
