# Changelog

Auto-maintained by `.github/workflows/version-bump.yml`. Each PR merge to
`main` whose squash subject starts with `feat:` or `fix:` triggers a bump
(minor or patch); a `!:` suffix or `BREAKING CHANGE` in the body bumps
major. Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) skip the bump.

## 0.7.1 — 2026-05-01 (patch)

- fix: migrate MCP focus tools to /items, stack greeting above stats, drop dead Plan-from-todo branch (#70)

## 0.7.0 — 2026-05-01 (minor)

- feat(eval): conversation-segment audit loop with trace flags + dispatch to CC (#69)

## 0.6.0 — 2026-05-01 (minor)

- feat: dashboard polish — sticky header, graph nav fix, recent-notes pager, settings into modal (#68)

## 0.5.2 — 2026-05-01 (patch)

- fix(notes): prevent autosave wipe + save-on-leave skip + silent failures (#66)
- (backfilled by hand: workflow run for #66 raced with #67's bump and was dropped — concurrency lock added in a follow-up)

## 0.5.1 — 2026-04-30 (patch)

- fix: focuses card UI — single shared card, pulse-only primary dot, compact inline form (#65)

## 0.5.0 — 2026-04-30 (minor)

- feat: focuses dashboard redesign — status dots, scale badges, primary inline (#64)

## 0.4.0 — 2026-04-30 (minor)

- feat: daily nudge → FastAPI + Settings UI; brain map polish (#63)

## 0.3.2 — 2026-04-30 (patch)

- fix: plan view UX + memory pills + similarity score on related (#62)

## 0.3.1 — 2026-04-30 (patch)

- fix: focus add lands in focus list; primary toggle in modal; visual polish (#60)

## 0.3.0 — 2026-04-30 (minor)

- feat: Gooni's Take — daily snapshot inside Dev Activity popover (#59)

## 0.2.0 — 2026-04-30 (minor)

- feat: react-query + skeletons; expand-mode wording; vercel build fix (#58)

