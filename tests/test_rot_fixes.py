"""Net for the three file-resolved surfaces that were silently wrong in prod.

All three were found by the 2026-08-10 rot audit, all three had the same
shape — a lookup that missed, a handler that turned the miss into an empty
answer, and no test anywhere in the router. They are grouped in one file
because they share one lesson: an empty result must never be the observable
consequence of a broken lookup.

None of this needs a server or prod data — every path resolves from
`__file__`, which is exactly why all three were wrong on every checkout and
nobody could tell.

Usage:
  source venv/bin/activate
  python tests/test_rot_fixes.py
"""

import ast
import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp.name}")

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from pathlib import Path  # noqa: E402

from app.routers import eval as eval_router  # noqa: E402
from app.routers import public as public_router  # noqa: E402
from app.services import eval_service  # noqa: E402


def check(fails: list[str], ok: bool, msg: str) -> None:
    if not ok:
        fails.append(msg)


# ── 1. eval reader dirs must be the ones the runner writes ───────────────────


def test_eval_dirs(fails: list[str]) -> None:
    """The reader resolved `<repo>/app/evals`; the writer writes `<repo>/evals`.

    Asserted against the WRITER's own expression rather than a hardcoded path,
    so moving either side fails here instead of going quiet again.
    """
    repo = Path(_ROOT).resolve()
    writer_baselines = repo / "evals" / "baselines"
    writer_reports = repo / "evals" / "reports"

    check(fails, eval_router._EVAL_BASELINES_DIR == writer_baselines,
          f"baselines reader {eval_router._EVAL_BASELINES_DIR} != writer {writer_baselines}")
    check(fails, eval_router._EVAL_REPORTS_DIR == writer_reports,
          f"reports reader {eval_router._EVAL_REPORTS_DIR} != writer {writer_reports}")

    # The committed baselines must actually come back. `> 0` is the whole
    # point — the bug's signature was a well-formed empty list.
    on_disk = len(list(writer_baselines.glob("baseline_*.json")))
    served = eval_router.list_eval_baselines()["baselines"]
    check(fails, on_disk > 0, "no committed baselines on disk — test cannot prove anything")
    check(fails, len(served) == on_disk,
          f"GET /eval/baselines served {len(served)} of {on_disk} committed baselines")

    by_key = eval_router.list_eval_runs()["baselines_by_key"]
    check(fails, len(by_key) > 0, "GET /eval/runs returned no baseline metadata")


def test_missing_baselines_dir_is_loud(fails: list[str]) -> None:
    """A missing baselines dir must 500, not return an empty list.

    This is the guard that would have surfaced the path bug on day one.
    """
    from fastapi import HTTPException

    original = eval_router._EVAL_BASELINES_DIR
    eval_router._EVAL_BASELINES_DIR = Path(_ROOT) / "definitely" / "not" / "here"
    try:
        eval_router.list_eval_baselines()
    except HTTPException as exc:
        check(fails, exc.status_code == 500,
              f"missing baselines dir raised {exc.status_code}, expected 500")
    except Exception as exc:  # noqa: BLE001
        fails.append(f"missing baselines dir raised {type(exc).__name__}, expected HTTPException")
    else:
        fails.append("missing baselines dir returned quietly instead of raising")
    finally:
        eval_router._EVAL_BASELINES_DIR = original


# ── 2. /public/mcp must describe the real MCP surface ────────────────────────


def test_public_mcp(fails: list[str]) -> None:
    from app.mcp_surface.tools import STDIO_TOOLS

    out = public_router.get_public_mcp_config()

    check(fails, len(out["tools"]) == len(STDIO_TOOLS),
          f"/public/mcp showed {len(out['tools'])} tools, registry has {len(STDIO_TOOLS)}")
    check(fails, {t["name"] for t in out["tools"]} == set(STDIO_TOOLS),
          "/public/mcp tool names do not match the registry")
    check(fails, all(t["description"] for t in out["tools"]),
          "some /public/mcp tools have an empty description")
    check(fails, len(out["servers"]) > 0,
          "/public/mcp showed no servers — the public showcase is empty")

    # No secrets. Env VALUES must never appear; only the key names.
    for server in out["servers"]:
        check(fails, "/" not in (server["command"] or ""),
              f"/public/mcp leaked an absolute command path: {server['command']}")
        check(fails, "/" not in (server["script"] or ""),
              f"/public/mcp leaked an absolute script path: {server['script']}")
        check(fails, isinstance(server["env_keys"], list),
              "/public/mcp env_keys is not a list of key names")


def test_public_mcp_reads_registry_not_the_dead_ast_walk(fails: list[str]) -> None:
    """The old implementation AST-walked `mcp_servers/server.py` for
    `@mcp.tool()`. Since the MCP convergence that file has none, so the walk
    would find nothing even from a correct path. Assert that stays true, so
    nobody "fixes" this back to the file-parsing version.
    """
    server_py = Path(_ROOT) / "mcp_servers" / "server.py"
    tree = ast.parse(server_py.read_text())
    decorated = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and any("tool" in ast.dump(d) for d in node.decorator_list)
    ]
    check(fails, decorated == [],
          "mcp_servers/server.py has decorated tools again — reconsider the /public/mcp source")


# ── 3. the eval tools legend must exist and cover every step key ─────────────


def test_tool_legend(fails: list[str]) -> None:
    legend = eval_service.tool_legend()
    check(fails, len(legend) > 0, "tool_legend() is empty")
    for entry in legend:
        check(fails, set(entry) == {"key", "name", "description"},
              f"legend entry has wrong keys: {sorted(entry)}")
        check(fails, bool(entry["description"]),
              f"legend entry {entry['key']} has no description")

    from app.tools import registry as tool_registry

    keys = {e["key"] for e in legend}
    missing_tools = {t.name for t in tool_registry} - keys
    check(fails, not missing_tools, f"legend missing chat tools: {sorted(missing_tools)}")


def test_legend_covers_every_trace_step(fails: list[str]) -> None:
    """Every step key TraceBuilder can emit needs a legend entry.

    Steps are the one half of the legend that cannot be derived from a
    registry, so this is what stops the hand-written half from rotting the way
    the whole thing did.
    """
    src = (Path(_ROOT) / "app" / "services" / "trace_builder.py").read_text()
    tree = ast.parse(src)
    emitted: set[str] = set()
    for node in ast.walk(tree):
        # `self.step("key", ...)` inside TraceBuilder, and the literal seeded
        # into `self._steps` by __init__.
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "step" and node.args \
                and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            emitted.add(node.args[0].value)
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and k.value == "key" \
                        and isinstance(v, ast.Constant) and isinstance(v.value, str):
                    emitted.add(v.value)

    # Ad-hoc keys passed at call sites outside trace_builder.
    for path in (Path(_ROOT) / "app" / "services" / "orchestrator").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr == "step" and node.args \
                    and isinstance(node.args[0], ast.Constant) \
                    and isinstance(node.args[0].value, str):
                emitted.add(node.args[0].value)

    documented = {key for key, _, _ in eval_service._STEP_LEGEND}
    check(fails, emitted, "found no trace step keys — the scanner is broken, not the legend")
    undocumented = emitted - documented
    check(fails, not undocumented,
          f"trace steps with no legend entry: {sorted(undocumented)} "
          "(add them to eval_service._STEP_LEGEND)")


def main() -> int:
    fails: list[str] = []
    for fn in (
        test_eval_dirs,
        test_missing_baselines_dir_is_loud,
        test_public_mcp,
        test_public_mcp_reads_registry_not_the_dead_ast_walk,
        test_tool_legend,
        test_legend_covers_every_trace_step,
    ):
        try:
            fn(fails)
        except Exception as exc:  # noqa: BLE001
            import traceback
            fails.append(f"{fn.__name__} raised {type(exc).__name__}: {exc}\n"
                         + traceback.format_exc())

    if fails:
        print("--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("--- PASS --- rot fixes: eval dirs, /public/mcp, tools legend")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
