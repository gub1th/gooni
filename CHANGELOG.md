# Changelog

Auto-maintained by `.github/workflows/version-bump.yml`. Each PR merge to
`main` whose squash subject starts with `feat:` or `fix:` triggers a bump
(minor or patch); a `!:` suffix or `BREAKING CHANGE` in the body bumps
major. Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) skip the bump.

## 0.13.2 — 2026-05-01 (patch)

- fix(memory): cap feedback-derived preferences in retrieval, add list_preferences MCP tool (#80)

## 0.13.1 — 2026-05-01 (patch)

- fix(chat): modal polish — bouncy release, drag hijack, side anchor, dropzone (#79)

## 0.13.0 — 2026-05-01 (minor)

- feat: focus mode ambient pad + mute, compact header stats, fix note→space hijack (#78)

## 0.12.0 — 2026-05-01 (minor)

- feat(chat): GooniPanel + composer redesign (#77)

## 0.11.0 — 2026-05-01 (minor)

- feat: extract selected text → new linked child note (#76)

## 0.10.0 — 2026-05-01 (minor)

- feat: claude activity stat — log MCP-tagged requests, surface on dashboard (#75)

## 0.9.1 — 2026-05-01 (patch)

- fix: stats sidebar + drop hairline, focus mode persistence/timer/new mascot, MCP backlog matching (#74)

## 0.9.0 — 2026-05-01 (minor)

- feat: Gemini-style chat input + dark mode theme + primary-focus mode overlay (#73)

## 0.8.0 — 2026-05-01 (minor)

- feat: list-item conflict detection via cosine similarity (#72)

## 0.7.2 — 2026-05-01 (patch)

- fix: sticky header → ListView (not Dashboard); concurrency-lock version-bump (#71)

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

