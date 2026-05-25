#!/usr/bin/env python3
"""One-shot codemod: replace UNAMBIGUOUS hardcoded light-hex literals with the
theme `color.*` tokens so dark mode works.

ONLY the 7 hexes whose values are byte-identical to the token's baked-in light
fallback (see ui/tokens.ts). That makes every swap a no-op in light mode and a
correct flip in dark mode — zero judgment, zero risk. White / off-palette grays
/ pastel chips are intentionally NOT handled here (they need human judgment:
white = surface-card vs text-on-accent).

Match rule: only a STANDALONE quoted literal — quote immediately on both sides
of the hex (`"#1C1C1E"`). That naturally skips:
  - compound strings  "1px solid #8E8E93"  (no quote adjacent to #)
  - var fallbacks      var(--gooni-text, #1C1C1E)  (no quote adjacent)
Context-aware emit:
  - JSX attr  fill="#E5E5EA"  -> fill={ctok.border}
  - JS value  color: "#1C1C1E" -> color: ctok.text

Run:  python scripts/codemod_dark_tokens.py            # dry-run, prints diff stat
      python scripts/codemod_dark_tokens.py --write    # apply
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "src")

# hex (lowercased) -> token field on the color object
MAP = {
    "#1c1c1e": "text",
    "#8e8e93": "muted",
    "#aeaeb2": "faint",
    "#fafafa": "bg",
    "#e5e5ea": "border",
    "#f2f2f7": "hover",
    "#c7c7cc": "disabled",
}

HEX_ALT = "|".join(re.escape(h[1:]) for h in MAP)  # strip leading '#'; pattern re-adds it
# group1 = optional '=' (JSX attr), group2 = quote, group3 = hex
LITERAL_RE = re.compile(rf"(=?)(['\"])(#(?:{HEX_ALT}))\2", re.IGNORECASE)

IMPORT_CTOK_RE = re.compile(r"import\s*\{[^}]*\bcolor\s+as\s+ctok\b[^}]*\}\s*from\s*['\"][^'\"]*(?:ui|tokens)['\"]")
IMPORT_COLOR_RE = re.compile(r"import\s*\{[^}]*\bcolor\b(?!\s+as)[^}]*\}\s*from\s*['\"][^'\"]*(?:ui|tokens)['\"]")


def alias_for(src: str) -> str | None:
    if IMPORT_CTOK_RE.search(src):
        return "ctok"
    if IMPORT_COLOR_RE.search(src):
        return "color"
    return None


def rel_ui_path(file_path: str) -> str:
    rel = os.path.relpath(file_path, ROOT)              # e.g. components/notes/Foo.tsx
    depth = len(rel.split(os.sep)) - 1                   # dirs between src and file
    return "../" * depth + "ui"


def process(file_path: str, write: bool) -> int:
    with open(file_path, encoding="utf-8") as fh:
        src = fh.read()
    alias = alias_for(src)
    used = alias or "ctok"

    def repl(m: re.Match) -> str:
        eq, _q, hexv = m.group(1), m.group(2), m.group(3).lower()
        token = f"{used}.{MAP[hexv]}"
        return f"={{{token}}}" if eq == "=" else token

    new, n = LITERAL_RE.subn(repl, src)
    if n == 0:
        return 0

    # Inject import if the file had no token import and we created references.
    if alias is None:
        imp = f'import {{ color as ctok }} from "{rel_ui_path(file_path)}";\n'
        # place after the last existing top-of-file import line
        lines = new.splitlines(keepends=True)
        last_imp = 0
        for i, ln in enumerate(lines):
            if ln.startswith("import "):
                last_imp = i + 1
        lines.insert(last_imp, imp)
        new = "".join(lines)

    if write:
        with open(file_path, "w", encoding="utf-8") as fh:
            fh.write(new)
    return n


def main() -> int:
    write = "--write" in sys.argv
    total, files = 0, 0
    for dirpath, _dirs, names in os.walk(ROOT):
        for name in names:
            if not name.endswith(".tsx"):
                continue
            fp = os.path.join(dirpath, name)
            n = process(fp, write)
            if n:
                files += 1
                total += n
                print(f"{n:4d}  {os.path.relpath(fp, ROOT)}")
    verb = "applied" if write else "would change"
    print(f"\n{verb}: {total} literals across {files} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
