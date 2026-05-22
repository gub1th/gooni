# Changelog

Auto-maintained by `.github/workflows/version-bump.yml`. Each PR merge to
`main` whose squash subject starts with `feat:` or `fix:` triggers a bump
(minor or patch); a `!:` suffix or `BREAKING CHANGE` in the body bumps
major. Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) skip the bump.

## 0.152.0 — 2026-05-22 (minor)

- feat(chat): hoist doing todos in state_block + deterministic anti-hallucination guard (#326)

## 0.151.0 — 2026-05-22 (minor)

- feat(backlog): Jira-style "+ Add card" pinned at column bottom (#325)

## 0.150.0 — 2026-05-22 (minor)

- feat(ui): plaza polish + sidebar v2.1 — vibrant pinned coin, scoped chat orb, modal z-fix (#324)

## 0.149.0 — 2026-05-22 (minor)

- feat(dashboard): lowercase headers, white todo cards, float orphan hint (#323)

## 0.148.0 — 2026-05-22 (minor)

- feat(bot): prose-only replies — ban numbered/bullet lists by default (#322)

## 0.147.0 — 2026-05-21 (minor)

- feat(ui): card-ify open todos + Today's todos header + chevron-collapse done (#321)

## 0.146.0 — 2026-05-21 (minor)

- feat(backlog): surface 🤖 claude picked up pill on tickets (#206)

## 0.145.0 — 2026-05-21 (minor)

- feat(reactions): Confluence-style emoji reactions on notes + comments (#303)

## 0.144.0 — 2026-05-21 (minor)

- feat(sidebar): redesign v2 — Dashboard row + Notes/Spaces/Lists sections + smaller fonts (#319)

## 0.143.0 — 2026-05-21 (minor)

- feat(ui): todo redesign — warm palette, chain modal, close flow, retro-link, ack voice (#318)

## 0.142.0 — 2026-05-21 (minor)

- feat(notes): toggle blocks + outline panel + optional note icon (#317)

## 0.141.0 — 2026-05-21 (minor)

- feat(notes): persistent top bar — sticky title + island moves left (#316)

## 0.140.2 — 2026-05-21 (patch)

- fix(note-card): single continuous highlight on multi-line selections (#315)

## 0.140.1 — 2026-05-21 (patch)

- fix(ui): Today regressions — restore todos, demote synth, honest Whoop freshness (#314)

## 0.140.0 — 2026-05-21 (minor)

- feat(ui): banner LiveTimer + Claude-style collapsed icon rail (#313)

## 0.139.0 — 2026-05-21 (minor)

- feat(ui): minimal sidebar + publish CTA + global scrollbar (#312)

## 0.138.0 — 2026-05-20 (minor)

- feat(ui): G3.9 animations — cascade ink-trail on done + FLIP move animation (#311)

## 0.137.1 — 2026-05-20 (patch)

- fix(ui): regressions from G3.9 loop-close — uniform active rows, slate plus buttons, hidden toggle, phantom drag line (#310)

## 0.137.0 — 2026-05-20 (minor)

- feat: G3.9 loop-close — show_due_window + focus rebind via chat + chip-click navigation (#309)

## 0.136.0 — 2026-05-20 (minor)

- feat(ui): G3.9 frontend follow-up — inline action cards + drag-reorder (#308)

## 0.135.0 — 2026-05-20 (minor)

- feat(fts): FTS5 keyword index for notes, todos, memories (#306)

## 0.134.0 — 2026-05-20 (minor)

- feat(chat): G3.9 — edit shape + implicit done + recall tools + disambiguation + chain inline (#307)

## 0.133.2 — 2026-05-20 (patch)

- fix(promises): /promises validates 5-state lifecycle, not legacy alias (#305)

## 0.133.1 — 2026-05-20 (patch)

- fix(ui): drop today-age pill — color reserved for late states (#304)

## 0.133.0 — 2026-05-20 (minor)

- feat(ui): G3.5-polish — doing-state pulse + orphan hover fix + modal Claude-ify + Lineage section (#302)

## 0.132.0 — 2026-05-20 (minor)

- feat(promises): G3.1 — drop lock-in, collapse to 3-state, vague-flag drives ack (#301)

## 0.131.0 — 2026-05-20 (minor)

- feat(todos): group active w/ primary; counter to top (#300)

## 0.130.0 — 2026-05-20 (minor)

- feat(todos): three-tier hierarchy — primary, active, pending (#299)

## 0.129.0 — 2026-05-20 (minor)

- feat(todos): live timer on primary card — seconds → minutes → hours → days (#298)

## 0.128.0 — 2026-05-20 (minor)

- feat(coupling+accountability): G3 — everything maps to focus + recurrence counter + memory citation (#297)

## 0.127.0 — 2026-05-20 (minor)

- feat(notes): URL-paste smartcards + drop-position attachments + MCP attach tool (#296)

## 0.126.0 — 2026-05-20 (minor)

- feat(notes): inline note cards — pastel 'I did this' markers (#295)

## 0.125.0 — 2026-05-20 (minor)

- feat: G3.5 Todo Continuity + chat cost cuts + creative coin polish (#294)

## 0.124.1 — 2026-05-20 (patch)

- fix(ui): polish bundle + URL-derive view state (#293)

## 0.124.0 — 2026-05-20 (minor)

- feat(todos): router-level dispatch for destructive actions (G1.1) (#292)

## 0.123.2 — 2026-05-19 (patch)

- fix(routes): add view: undefined to remaining nav call sites (#291)

## 0.123.1 — 2026-05-19 (patch)

- fix(sidebar): restore dead clicks after AppShell hoist (#290)

## 0.123.0 — 2026-05-19 (minor)

- feat(voice): honorific anchor + character-attack ban + recovery beat (G0.1) (#289)

## 0.122.0 — 2026-05-19 (minor)

- feat(backlog): self-PM urgency + friction-event log (G2) (#288)

## 0.121.0 — 2026-05-19 (minor)

- feat(todos): groom mutation surface + capability honesty (G1) (#287)

## 0.120.0 — 2026-05-19 (minor)

- feat(persona): Alfred voice load-bearing across every channel (G0) (#282)

## 0.119.0 — 2026-05-19 (minor)

- feat(mcp): set_backlog_state + promote_backlog_to_primary tools (#281)

## 0.118.0 — 2026-05-19 (minor)

- feat(backlog): primary-ticket singleton + dashboard north-star banner (#280)

## 0.117.1 — 2026-05-19 (patch)

- fix(routes): strip duplicate sidebar/chrome from index + memories (#279)

## 0.117.0 — 2026-05-19 (minor)

- feat(synthesizer): note-graduation hooks (PR-E) (#278)

## 0.116.0 — 2026-05-19 (minor)

- feat(promise): voice-of-reason evaluator (PR-D) (#277)

## 0.115.0 — 2026-05-19 (minor)

- feat(promise): Promise Integrity Score widget (PR-C) (#276)

## 0.114.0 — 2026-05-19 (minor)

- feat(dashboard): swap NeuralBrain for compact mascot avatar + inline stat strip (#275)

## 0.113.0 — 2026-05-19 (minor)

- feat(promise): proposed state + lock-in transition w/ auto-habit (PR-B) (#274)

## 0.112.0 — 2026-05-19 (minor)

- feat(todos): click-to-edit modal + hide hollow space-star until hover (#273)

## 0.111.0 — 2026-05-19 (minor)

- feat(notes,promise): Note.status graduation lifecycle + promise complexity classifier (#272)

## 0.110.1 — 2026-05-19 (patch)

- fix(stats+nav): section freshness chips + dev-activity TZ + brain-node nav (#271)

## 0.110.0 — 2026-05-19 (minor)

- feat(lists): supports-edges + async venue enrich on add_item (#270)

## 0.109.1 — 2026-05-19 (patch)

- fix(orchestrator): ack precision + extractor false-positive fix (#268)

## 0.109.0 — 2026-05-18 (minor)

- feat(dashboard): nav simplify + Stats merge + Backlog rework + eval-color fix (#269)

## 0.108.5 — 2026-05-18 (patch)

- fix(eval): pdf export captures full segment, not just first page (#267)

## 0.108.4 — 2026-05-18 (patch)

- fix(notes): re-sync editorEmpty after setContent(emitUpdate:false) (#266)

## 0.108.3 — 2026-05-18 (patch)

- fix(sidebar): persist scroll position across route changes (#265)

## 0.108.2 — 2026-05-18 (patch)

- fix(stats): dev-take theme chip stacks above body (kill jagged column) (#264)

## 0.108.1 — 2026-05-18 (patch)

- fix(whoop): migrate API URLs from v1 → v2 (v1 sunset) (#262)

## 0.108.0 — 2026-05-18 (minor)

- feat(eval): clickable baselines + per-case detail panel (#261)

## 0.107.0 — 2026-05-18 (minor)

- feat(spaces): cover image upload + stats header (notes / last touched / top tags) (#259)

## 0.106.0 — 2026-05-18 (minor)

- feat(orchestrator): ReAct verify step against ToolCall audit (v6) (#257)

## 0.105.0 — 2026-05-18 (minor)

- feat(reflexion): conv-rollup + reflection FK + quality score (v5) (#256)

## 0.104.0 — 2026-05-18 (minor)

- feat(memory): PATCH /memories supports type change + promote 19 prefs to facts (#255)

## 0.103.1 — 2026-05-18 (patch)

- fix(sidebar): pin star always visible + thin overlay scrollbar (#253)

## 0.103.0 — 2026-05-18 (minor)

- feat(prompt): cosine-rank focuses + drop list dump (items 3-4 of #282) (#252)

## 0.102.1 — 2026-05-18 (patch)

- fix(notes): release Cmd/Ctrl-F to native browser find (#251)

## 0.102.0 — 2026-05-18 (minor)

- feat(capability,reflexion): cosine dedup at promotion + reflexion specificity (#250)

## 0.101.0 — 2026-05-18 (minor)

- feat(prompt): locked PERSONA block + cadence split + behavioral cap (#249)

## 0.100.0 — 2026-05-18 (minor)

- feat(notes,eval,dashboard): tags + chat-bubble comments + extract hardening + promise drawer + audit redesign (#247)

## 0.99.0 — 2026-05-18 (minor)

- feat(eval): prod-snapshot eval runner + labeled baselines (#246)

## 0.98.0 — 2026-05-18 (minor)

- feat(notes,eval): attachments + link cards + eval-page bug bundle + pin spaces (#245)

## 0.97.0 — 2026-05-18 (minor)

- feat(eval): v3 pipeline cutover — kill pure_signal + time block + 401 fix (#244)

## 0.96.0 — 2026-05-18 (minor)

- feat(dashboard): primary-todo border draws + breathes instead of zooming (#243)

## 0.95.0 — 2026-05-18 (minor)

- feat(auth): refresh PasswordGate to match the /public theme (#242)

## 0.94.0 — 2026-05-18 (minor)

- feat(public): add gooni link next to mcp in header meta line (#241)

## 0.93.0 — 2026-05-18 (minor)

- feat(public): skeletons for cold load — kill the flash + layout shift (#240)

## 0.92.0 — 2026-05-17 (minor)

- feat(alembic): harden _alembic_upgrade against half-applied state (#239)

## 0.91.3 — 2026-05-17 (patch)

- fix(creative): no camera shift on note open, hide peek under reader (#238)

## 0.91.2 — 2026-05-17 (patch)

- fix(creative): lift NotePeekCard out of Canvas via peekBus (#237)

## 0.91.1 — 2026-05-17 (patch)

- fix(creative): remove drei Html proximity label from NoteCoin (#236)

## 0.91.0 — 2026-05-17 (minor)

- feat(creative+public): walking-gooni plaza CTA, subtle paper coins, notebook icon (#235)

## 0.90.1 — 2026-05-17 (patch)

- fix(alembic): make promises+edges migration idempotent (PROD HOTFIX) (#234)

## 0.90.0 — 2026-05-17 (minor)

- feat(creative): click anywhere on landing overlay to drop in (#233)

## 0.89.0 — 2026-05-17 (minor)

- feat(habits): polarity-aware streaks + weekday labels (#230)

## 0.88.0 — 2026-05-17 (minor)

- feat(chat): WA promises + 5-phase orchestrator rebuild (#229)

## 0.87.0 — 2026-05-17 (minor)

- feat(wa): promises layer + edges graph + Jarvis voice + cadence + fly-revive (#210)

## 0.86.1 — 2026-05-17 (patch)

- fix(creative+public): calmer cross-nav pills (#226)

## 0.86.0 — 2026-05-17 (minor)

- feat(creative): coin polish — DOM peek, world-Y spin, pickup SFX, read state, proximity glow (#225)

## 0.85.0 — 2026-05-17 (minor)

- feat(creative): public notes as floating coins on tiles + bold /creative ↔ /public cross-nav (#221)

## 0.84.0 — 2026-05-17 (minor)

- feat(ops+eval): ops sub-tabs, per-column backlog scroll, single status entry, pending backfill (#220)

## 0.83.0 — 2026-05-17 (minor)

- feat(creative): sky-island plaza — Quaternius GLTFs, stacking, NPCs, nametags (#219)

## 0.82.0 — 2026-05-17 (minor)

- feat(ops): calm Claude-app theme + open-full deeplink, slow race on card border (#218)

## 0.81.0 — 2026-05-17 (minor)

- feat(audit): merge Eval + Chat audit into single Conversations tab (#217)

## 0.80.0 — 2026-05-17 (minor)

- feat(eval): "live" active-conversation badge on segments (#216)

## 0.79.1 — 2026-05-17 (patch)

- fix(todo): primary-card race SVG drifting to random spot (#215)

## 0.79.0 — 2026-05-17 (minor)

- feat(eval+dashboard): chat-bubble eval transcripts, ops surface polish, todo/habit parity (#214)

## 0.78.0 — 2026-05-16 (minor)

- feat(dashboard): fold Build into Ops + eval drilldown + scrollable kanban + composer/note fixes (#213)

## 0.77.1 — 2026-05-16 (patch)

- fix(api): unwrap eval/segments response so OpsMode .map() works (#212)

## 0.77.0 — 2026-05-16 (minor)

- feat(frontend): app-wide error boundary + 404 page with Gooni mascot (#211)

## 0.76.0 — 2026-05-16 (minor)

- feat(dashboard): glow-up — focus halos, themed dev take, focus-on-write composer (#209)

## 0.75.0 — 2026-05-16 (minor)

- feat(backlog): notes column + pr_url-on-close MCP support (#208)

## 0.74.0 — 2026-05-16 (minor)

- feat(gooni): per-turn Reflexion loop + capability inventory (self-knowledge substrate) (#207)

## 0.73.0 — 2026-05-16 (minor)

- feat(dashboard): Ops mode — eval queue + backlog + tool-call failures (#205)

## 0.72.0 — 2026-05-16 (minor)

- feat(dashboard): Today/Build/Pulse mode toggle + Gooni-health scoring (#204)

## 0.71.2 — 2026-05-16 (patch)

- fix(alembic): also make wa_processed_ids migration idempotent (#203)

## 0.71.1 — 2026-05-16 (patch)

- fix(alembic): make habits migration idempotent (PROD DOWN) (#202)

## 0.71.0 — 2026-05-14 (minor)

- feat(dashboard): Todos/Focuses tab toggle + synth audit + focus drill-down (#201)

## 0.70.1 — 2026-05-14 (patch)

- fix(chat): kill WhatsApp double-fire on slow turns + harden web chat against double-send race (#200)

## 0.70.0 — 2026-05-14 (minor)

- feat(habits): daily binary tracker w/ 7-day strip widget + log_habit chat tool (#199)

## 0.69.3 — 2026-05-14 (patch)

- fix(list): drop stale due_date kwarg from ListItem insert path (#198)

## 0.69.2 — 2026-05-12 (patch)

- fix(alembic): idempotent migrations for partial-deploy recovery (PROD DOWN) (#197)

## 0.69.1 — 2026-05-12 (patch)

- fix(alembic): merge focus-drift + is_public_pinned heads (#196)

## 0.69.0 — 2026-05-12 (minor)

- feat(focus): hybrid binding + drift detection + rename/fork lineage (#193)

## 0.68.0 — 2026-05-12 (minor)

- feat(focus): synthesizer + state-binding + FocusCandidate persistence (#189)

## 0.67.1 — 2026-05-12 (patch)

- fix(whoop): key snapshots on local TZ + pick newest scored record (#195)

## 0.67.0 — 2026-05-12 (minor)

- feat(editor): H1/H2 in bubble menu + cap heading levels to [1, 2] (#194)

## 0.66.0 — 2026-05-12 (minor)

- feat(public): typographic polish — display serif + refined rows + footer (#192)

## 0.65.0 — 2026-05-12 (minor)

- feat(public): is_public_pinned hero card + replace AuraOrb w/ shared mascot (#191)

## 0.64.0 — 2026-05-12 (minor)

- feat(notes): status pills + space dropdown filters on All Notes (#190)

## 0.63.0 — 2026-05-11 (minor)

- feat(notes): public-only filter toggle on All Notes view (#188)

## 0.62.0 — 2026-05-11 (minor)

- feat(chat): SSE streaming for web chat — live pipeline + tool cards (#187)

## 0.61.1 — 2026-05-11 (patch)

- fix(alembic): make tool_calls migration idempotent (#185)

## 0.61.0 — 2026-05-10 (minor)

- feat(chat): tool_calls audit table — substrate for anti-hallucination + ReAct (#184)

## 0.60.0 — 2026-05-10 (minor)

- feat(chat): tool surface parity + multi-bubble bot replies + todos-only morning nudge (#183)

## 0.59.2 — 2026-05-10 (patch)

- fix(todos): done-today uses local midnight; doing dot is amber not green (#176)

## 0.59.1 — 2026-05-10 (patch)

- fix(alembic): make 5e6cca5584da leetcode_snapshots create idempotent (#175)

## 0.59.0 — 2026-05-10 (minor)

- feat(notes): apple-notes editor pass — system font, slim column, floating action pill (#173)

## 0.58.0 — 2026-05-10 (minor)

- feat(stats): leetcode card — streak/today/week + 53x7 heatmap (#174)

## 0.57.0 — 2026-05-10 (minor)

- feat(notes): note ux batch — empty-body fix, floating publish, memories panel, comment avatars, apple-notes editor lean (#172)

## 0.56.1 — 2026-05-10 (patch)

- fix(notes): empty-overwrite guard catches TipTap empty doc + chip click awaits save (#171)

## 0.56.0 — 2026-05-10 (minor)

- feat(dashboard): mockup v2 — TakeTabs at top, 3-col focus grid, primary card w/ demote (#170)

## 0.55.0 — 2026-05-10 (minor)

- feat(mcp): dedicated backlog tools — read/add/find_similar/delete_backlog_item (#169)

## 0.54.0 — 2026-05-10 (minor)

- feat(dashboard): revamp — Whoop strip + focus cards + todo list (state enum, primary→Todo, color palette) (#168)

## 0.53.1 — 2026-05-09 (patch)

- fix(notes): TipTap composer + HTML rendering for comments (in-app + public) (#167)

## 0.53.0 — 2026-05-09 (minor)

- feat(profile): user avatar + comment polish (timezone, markdown, claude icon) (#166)

## 0.52.1 — 2026-05-09 (patch)

- fix(notes): stop spurious writes on open + redesign delete/cleanup/comments (#165)

## 0.52.0 — 2026-05-09 (minor)

- feat(sidebar): top-level Todos + Backlog shortcuts (#164)

## 0.51.0 — 2026-05-09 (minor)

- feat(gooni-panel): chat ↔ note mode toggle in chat panel (#163)

## 0.50.0 — 2026-05-09 (minor)

- feat(items): paginate /items at root level (default cap 50) (#161)

## 0.49.0 — 2026-05-09 (minor)

- feat(prod): defer embedding cols + drop dead similarity/questions code (#158)

## 0.48.0 — 2026-05-09 (minor)

- feat: usage cards on stats only, primary-focus empty CTAs, drop suggest, brain bump (#159)

## 0.47.0 — 2026-05-09 (minor)

- feat(prod): per-request memory trace middleware to attribute OOM spikes (#157)

## 0.46.0 — 2026-05-09 (minor)

- feat(sidebar): move recent-notes + ink/typing animations to Sidebar (5 rows) (#156)

## 0.45.1 — 2026-05-09 (patch)

- fix(items): import list_service in /items/today-todos handler (#155)

## 0.45.0 — 2026-05-08 (minor)

- feat(notes): Confluence-style comment threads on notes (#152)

## 0.44.5 — 2026-05-08 (patch)

- fix(prod): richer mem watchdog + localStorage save fallback for failed PATCHes (#153)

## 0.44.4 — 2026-05-08 (patch)

- fix(prod): force unbuffered Python stdout so watchdog logs reach Fly (#150)

## 0.44.3 — 2026-05-08 (patch)

- fix(prod): strip print(prompt) debug + add memory watchdog (#148)

## 0.44.2 — 2026-05-08 (patch)

- fix(db): halt notes.excerpt backfill hot-loop driving Fly OOM (#146)

## 0.44.1 — 2026-05-07 (patch)

- fix(db): re-add notes.excerpt dropped by 40c7d78ffa45 (#144)

## 0.44.0 — 2026-05-07 (minor)

- feat(db): adopt Alembic for schema migrations on SQLite (#142)

## 0.43.0 — 2026-05-07 (minor)

- feat(takes): persist Gooni's Take + new Dev Take, daily, in DB (#141)

## 0.42.0 — 2026-05-07 (minor)

- feat(notes): R2 image uploads + lite list payloads (PR #134 OOM fix) (#139)

## 0.41.0 — 2026-05-07 (minor)

- feat(mcp): add is_draft + is_pinned params to add_note + edit_note (#138)

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

