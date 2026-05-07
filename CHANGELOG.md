# Changelog

Auto-maintained by `.github/workflows/version-bump.yml`. Each PR merge to
`main` whose squash subject starts with `feat:` or `fix:` triggers a bump
(minor or patch); a `!:` suffix or `BREAKING CHANGE` in the body bumps
major. Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) skip the bump.

## 0.40.0 — 2026-05-07 (minor)

- feat(memory): track retrieval count + last-retrieved timestamp (#136)

## 0.39.0 — 2026-05-07 (minor)

- feat(memories): MemoryBrain visualization + skills (seed-draft, wrap-session) (#135)

## 0.38.0 — 2026-05-07 (minor)

- feat(modal): reusable Modal primitive + DeriveTodoModal replaces window.prompt (#132)

## 0.37.2 — 2026-05-07 (patch)

- fix(focus): show crown on dashboard primary-focus spotlight (#131)

## 0.37.1 — 2026-05-07 (patch)

- fix(dashboard): recent notes cards equal width regardless of title length (#130)

## 0.37.0 — 2026-05-07 (minor)

- feat(digest+todos): user-prompt digest, focus↔todo M2M, theme settings (#129)

## 0.36.2 — 2026-05-07 (patch)

- fix(whoop): auto-generate OAuth state so Whoop accepts the redirect (#128)

## 0.36.1 — 2026-05-07 (patch)

- fix(focus): swap primary-focus star → yellow crown (#127)

## 0.36.0 — 2026-05-07 (minor)

- feat(notes): viewer counts, extract→child nav, parent backlink (#126)

## 0.35.0 — 2026-05-07 (minor)

- feat(notes): draft system + sidebar DRAFTS/RECENT sections (#125)

## 0.34.0 — 2026-05-06 (minor)

- feat(composer): Cmd+E global quick-capture composer (#123)

## 0.33.0 — 2026-05-06 (minor)

- feat(eval): orchestrator-level golden harness + audit UI tab (#121)

## 0.32.0 — 2026-05-06 (minor)

- feat(stats): UsageCards on dashboard — today + this month, OpenAI/Claude toggle (#122)

## 0.31.0 — 2026-05-05 (minor)

- feat(stats): Whoop today section in StatsView; Settings → connect/disconnect only (#120)

## 0.30.0 — 2026-05-05 (minor)

- feat(notes): auto-titles via gpt-4o-mini + claude-activity 24h window (#119)

## 0.29.1 — 2026-05-05 (patch)

- fix(stats): unified Activity tile grid (#118)

## 0.29.0 — 2026-05-04 (minor)

- feat(public): hover-prefetch + cached list, skeleton + spinner loading (#117)

## 0.28.1 — 2026-05-04 (patch)

- fix(ui): hide list pills + drop dashboard stats/claude cards + source-note → modal (#116)

## 0.28.0 — 2026-05-04 (minor)

- feat(backlog): Jira-style 3-col board + drag/click split + Claude rules (#56/#125) (#113)

## 0.27.1 — 2026-05-04 (patch)

- fix(focus): UX cleanup — animated check, drag-reorder, primary timer (#112)

## 0.27.0 — 2026-05-04 (minor)

- feat(notes): Confluence-style discovery in All Notes empty state (#111)

## 0.26.0 — 2026-05-04 (minor)

- feat: focus-flow redesign + public unpublish-with-undo + FAB visibility fix (#109)

## 0.25.0 — 2026-05-04 (minor)

- feat(notes): Figure node — resize/align/caption + drop RELATED/QUESTIONS panels (#108)

## 0.24.1 — 2026-05-04 (patch)

- fix(notes): drop keepalive on updateNote so image saves don't fail (#107)

## 0.24.0 — 2026-05-04 (minor)

- feat(whoop): OAuth scaffold + daily snapshot endpoint (#75/#150) (#106)

## 0.23.0 — 2026-05-03 (minor)

- feat(ui): unify composer + chat send button (#122-124) (#103)

## 0.22.1 — 2026-05-03 (patch)

- fix(uploader): exchange password via /auth before posting (#102)

## 0.22.0 — 2026-05-03 (minor)

- feat(notes): tag-to-backlog button on note editor (#145) (#101)

## 0.21.0 — 2026-05-03 (minor)

- feat(claude-usage): prod-sync via ingest endpoint + auto-hide on empty (#97)

## 0.20.1 — 2026-05-03 (patch)

- fix(dash+stats): UX polish + Expand bug + worth_expanding gate (#95)

## 0.20.0 — 2026-05-03 (minor)

- feat(llm): default to gpt-5.4 + add new pricing entries (#94)

## 0.19.0 — 2026-05-02 (minor)

- feat(stats): Claude Code usage (personal) + daily token chart (#93)

## 0.18.1 — 2026-05-02 (patch)

- fix(notes): no-edit PATCH no longer bumps updated_at + lucide toolbar (#91)

## 0.18.0 — 2026-05-02 (minor)

- feat(stats): dedicated stats view + OpenAI usage + Settings tabs refactor (#90)

## 0.17.0 — 2026-05-02 (minor)

- feat(planner): chat-driven calendar — propose/confirm/write + edit/delete (#89)

## 0.16.0 — 2026-05-02 (minor)

- feat(eval): trace cards graphable at a glance (#98 + #100 + #101) (#88)

## 0.15.1 — 2026-05-02 (patch)

- fix(quality): eval#83 fixes + golden eval set + tone register (#87)

## 0.15.0 — 2026-05-02 (minor)

- feat(backlog): batch UX polish + dev streak click + MCP note refs (#86)

## 0.14.0 — 2026-05-01 (minor)

- feat: dashboard FlipStat — single-column header, rotating stat card (#85)

## 0.13.6 — 2026-05-01 (patch)

- fix(focus): mute actually mutes + nicer Wii-vibe ambience (#84)

## 0.13.5 — 2026-05-01 (patch)

- fix(memory): tone-correction extraction goes specific (rule + evidence + anti_pattern) (#83)

## 0.13.4 — 2026-05-01 (patch)

- fix(dashboard,mascot): restore card-style stats + fix mascot dropzone (#82)

## 0.13.3 — 2026-05-01 (patch)

- fix(memory): tighten preference dedup at write-time, anti-examples in extractor (#81)

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

