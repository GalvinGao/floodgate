# AGENTS.md

Floodgate is a Chrome extension (MV3) for working with GitHub pull requests.
See [README.md](README.md) for what it does and how to develop it.

## Commands

```bash
pnpm dev    # load build/chrome-mv3-dev via chrome://extensions → Load unpacked
pnpm test   # unit tests for lib/
pnpm build  # production build → build/chrome-mv3-prod
```

Run `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm exec prettier --write` on
touched files before committing.

## Conventions

### No specific org / company / private references

Keep this repo free of references to any specific organization, company,
employer, private repository, internal project, or individual user. This
applies everywhere: code, tests, comments, fixtures, commit messages, and docs.

Use neutral placeholders instead:

- owner/repo → `acme/api`, or `o/r` for terse cases
- a PR number → a literal like `409`
- a commit SHA → any 40-char hex string

When a real-world URL motivates a change (e.g. a PR link from a private repo),
strip the identifying parts and restate it generically before it lands in the
codebase. The behavior should be general, never keyed to one org's names.
