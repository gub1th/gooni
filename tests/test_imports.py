"""Import smoke test — every module must at least import.

Born from the v2-nuke fallout: two subsystems (proactive_nudge, the eval
harness) sat broken in prod for a day because they imported models the nuke
had deleted. Both hid behind lazy boundaries — a function-body import and a
subprocess — so `python -c "from app.main import app"` never walked them.
This walks EVERY module under app/ + evals/ + scripts/ + mcp_servers/ so the
next table drop can't strand an importer anywhere.

(mcp_servers/ used to be `mcp/`, which shadowed the pip `mcp` SDK and had to be
syntax-checked via ast instead of imported. Renamed — it's a real import now,
which is also the regression test for that shadowing ever coming back.)

Run: python tests/test_imports.py   (no LLM, no network; touches local DB
only through the usual import-time alembic upgrade in app.main)
"""
import importlib
import pkgutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Some modules read env at import time (evals.judge builds an OpenAI client);
# load .env first, same as scripts/telegram_bot.py does.
from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")


def _walk(pkg) -> list[str]:
    return [
        name
        for _, name, _ in pkgutil.walk_packages(pkg.__path__, prefix=pkg.__name__ + ".")
    ]


def main() -> int:
    import app
    import evals
    import mcp_servers
    import scripts

    failures: list[str] = []
    checked = 0
    for pkg in (app, evals, mcp_servers, scripts):
        for name in _walk(pkg):
            checked += 1
            try:
                importlib.import_module(name)
            except Exception as e:  # noqa: BLE001 — we want the full report
                failures.append(f"{name}: {type(e).__name__}: {e}")

    # The pip `mcp` SDK must resolve to site-packages, not to anything in the
    # repo. This is the shadowing regression guard: if a top-level `mcp/`
    # package ever reappears, `mcp.server.fastmcp` stops existing and /mcp
    # silently 404s in prod. Assert the real SDK, from outside the repo.
    checked += 1
    try:
        import mcp.server.fastmcp as _sdk

        sdk_path = Path(_sdk.__file__).resolve()
        if REPO_ROOT in sdk_path.parents:
            failures.append(
                f"pip `mcp` SDK is shadowed by a repo path: {sdk_path}"
            )
    except Exception as e:  # noqa: BLE001
        failures.append(f"mcp.server.fastmcp: {type(e).__name__}: {e}")

    if failures:
        print(f"FAIL — {len(failures)}/{checked} modules broken:")
        for f in failures:
            print(f"  {f}")
        return 1
    print(f"OK — {checked} modules import clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
