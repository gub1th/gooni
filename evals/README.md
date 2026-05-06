# Eval harness

Orchestrator-level golden tests + LLM-as-judge for Gooni's chat replies.

## Run

```bash
source venv/bin/activate
python -m evals.run_orchestrator --baseline   # full run, save baseline + scorecard
python -m evals.run_orchestrator --case 001_smoke_basic_question --verbose
python -m evals.run_orchestrator --no-cache   # ignore per-case cache
```

Output:
- **`evals/reports/report_<ts>_v<PV>_<model>.html`** — per-run HTML scorecard. Gitignored. Browse via the **Eval runs** tab in the audit page.
- **`evals/baselines/baseline_v<PV>_<model>.json`** — only with `--baseline`. Tracked in git. Ground-truth snapshot, overwrites in place per `(PROMPT_VERSION, model)`.
- **`evals/cache/<key>.json`** — per-case cache. Gitignored. Skip pipeline + judge calls when nothing relevant changed.

## What invalidates scores

The cache key + baseline diff watch every input that affects a reply:

| Input | How tracked | Bust trigger |
|---|---|---|
| Case body (rubric, seeds, min_scores) | per-case JSON | edit fixture |
| Pipeline model (`llm_client.chat_model`) | runtime | swap model |
| Default judge model | env (`EVAL_JUDGE_MODEL`) | swap default |
| `PROMPT_VERSION` constant | manual constant in `app/services/trace_builder.py` | **manual bump only** |
| Pipeline source files | sha256 of 9 files | **edit any of them** (auto) |
| Eval scratch DB | env (`EVAL_DATABASE_URL`) | swap DB URL |

## ⚠️ `PROMPT_VERSION` is manual

Lives in **`app/services/trace_builder.py`** as a string constant (`PROMPT_VERSION = "v1"`). Bump it when you make a generational change to the chat pipeline that should *segregate* prior eval ratings (e.g. ReAct loop ships, master prompt rewritten end-to-end).

Day-to-day source edits **do not** require bumping it — the pipeline source hash auto-busts caches/baselines on any file edit. `PROMPT_VERSION` is the coarse human-readable label for "different generation."

**Forgetting to bump is fine for caches** (auto-detection covers it). It's only relevant for the baseline filename and JSON metadata so you can label "this baseline was the v2 generation."

The eval UI surfaces a yellow **Pipeline drift** banner whenever any of the 9 pipeline source files have changed since the latest baseline ran, naming which files drifted. That's the safety net — you'll notice without needing to track it manually.

## Pipeline source files watched

Edit any of these → cache + baseline diff trigger:

```
app/services/orchestrator.py
app/services/conversation_service.py
app/services/memory_service.py
app/services/memory_extraction.py
app/services/item_service.py
app/services/feedback_detector.py
app/services/trace_builder.py
app/llm/prompts.py
app/llm/client.py
```

If you find a file affecting reply output that isn't here, add it to `_PIPELINE_SOURCE_FILES` in `evals/run_orchestrator.py`.

## Reports vs baselines

| | Report | Baseline |
|---|---|---|
| Format | HTML scorecard | JSON snapshot |
| Lifecycle | per run, timestamped, never overwrites | per `(PROMPT_VERSION, model)`, overwrites in place |
| Purpose | browse ONE run's replies + scores | reference for diffing across runs |
| Committed | no (gitignored) | yes (git history = quality timeline) |

## Per-case cache

Each cache file at `evals/cache/<16-char-key>.json` stores the **full result** of one case (reply, scores, judge notes, fails, tool calls, master_prompt size, context summary).

Cache key:
```
sha256(json({
  "case": <full case body>,
  "pipeline_model": "gpt-5.4",
  "judge_default": "gpt-4o-mini",
  "prompt_version": "v1",
  "pipeline_source_hash": <sha256[:12] of 9 source files>,
  "eval_db": "sqlite:///./db/gooni-eval.db",
}, sort_keys=True))[:16]
```

Same inputs → cache hit → skip pipeline + judge → ~$0 cost.
Any input changes → cache miss → rerun + rewrite cache.

## Closed env

The harness sets `DATABASE_URL=sqlite:///./db/gooni-eval.db` **before** importing app modules. Each case seeds against an empty starting state, runs, tears down. Live prefs / memories / focuses **never leak in**. Override the eval DB path via `EVAL_DATABASE_URL`.

## Adding cases

Edit `evals/fixtures/orchestrator.json`. See the `schema` field at the top for every accepted case field. Bump the `id` with the next sequential number prefix (`014_`, `015_`, ...).

Mine real failures from `EvalSegment` rows where you flagged a reply as bad — those are higher-signal than synthetic cases.
