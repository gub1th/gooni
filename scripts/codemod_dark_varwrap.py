#!/usr/bin/env python3
"""Codemod #2: wrap OFF-palette hardcoded hex in `var(--gooni-ROLE, <hex>)`.

Complements codemod_dark_tokens.py (which handled the 7 byte-identical-to-
fallback hexes -> `color.*` tokens). Here we tackle the long tail of one-off
grays / near-blacks / white surfaces that AREN'T palette values, so we can't
swap them to a token without shifting LIGHT mode. The var-wrap keeps the
original hex as the fallback -> light renders byte-identical, dark flips.

Generic classification — NO hand-enumerated hex list. For each
`<prop>: "<hex>"` standalone literal in a style object:
  1. parse the hex -> (r,g,b)
  2. saturation = max-min. High saturation => a colored accent (brand/status,
     theme-independent) => SKIP. We only theme-wrap GRAYS + whites.
  3. role chosen by the CSS PROPERTY it's assigned to + the gray's lightness:
       color/fill-ish  -> text (dark) | muted (mid) | faint (light);  white SKIPPED (text-on-accent ambiguous)
       background-ish  -> card (only when near-white; dark bgs left alone)
       border/outline  -> border
Anything not matching a known property, or a colored accent, is left untouched
for the manual judgment pass.

Only matches a STANDALONE quoted literal directly after `prop:` — ternaries
(`background: x ? "#fff" : ...`) and array/standalone literals are skipped on
purpose (property is ambiguous there) and fall to the manual pass.

Run:  python3 scripts/codemod_dark_varwrap.py           # dry-run
      python3 scripts/codemod_dark_varwrap.py --write
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "src")

# Paths that aren't themed DOM — Three.js / canvas materials choke on a CSS
# var(). (Public portfolio used to be excluded as "always-light"; Daniel opted
# to theme it dark too, so it's now in scope.)
EXCLUDE = ("/creative/", "/animations/")

COLOR_PROPS = {"color", "fill", "stroke", "caretColor", "textDecorationColor", "WebkitTextFillColor"}
BG_PROPS = {"background", "backgroundColor"}
BORDER_PROPS = {"borderColor", "outlineColor"}

# prop: "#hex"  — quote adjacent both sides so compound strings + var-fallbacks are skipped.
RE = re.compile(r"(?P<prop>\b[A-Za-z][A-Za-z]+)(?P<sep>\s*:\s*)(?P<q>['\"])(?P<hex>#[0-9a-fA-F]{3,8})(?P=q)")


def parse(hexv: str) -> tuple[int, int, int] | None:
    h = hexv.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) not in (6, 8):
        return None
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None


def role_for(prop: str, hexv: str) -> str | None:
    rgb = parse(hexv)
    if rgb is None:
        return None
    r, g, b = rgb
    sat = max(r, g, b) - min(r, g, b)
    if sat > 0x24:           # colored accent (brand/status) — theme-independent
        return None
    lum = (r + g + b) // 3
    if prop in COLOR_PROPS:
        if lum > 0xC8:       # near-white text => likely on an accent bg; leave it
            return None
        if lum < 0x55:
            return "text"
        if lum < 0xA5:
            return "muted"
        return "faint"
    if prop in BG_PROPS:
        # Only flip a TRUE near-white surface. Tinted pastels (#FEE2E2 error
        # chip, #E1F5EE success chip) are low-saturation but semantically
        # colored — flattening them to card erases the signal, so the sat
        # gate must be tight here, not the generic 0x24 accent gate above.
        return "card" if (lum > 0xE0 and sat < 0x10) else None
    if prop in BORDER_PROPS:
        return "border"
    return None


def process(file_path: str, write: bool) -> int:
    with open(file_path, encoding="utf-8") as fh:
        src = fh.read()

    def repl(m: re.Match) -> str:
        role = role_for(m.group("prop"), m.group("hex"))
        if role is None:
            return m.group(0)
        q = m.group("q")
        return f'{m.group("prop")}{m.group("sep")}{q}var(--gooni-{role}, {m.group("hex")}){q}'

    new, n = RE.subn(repl, src)
    # subn counts all matches incl. no-ops; recount real changes
    if new == src:
        return 0
    if write:
        with open(file_path, "w", encoding="utf-8") as fh:
            fh.write(new)
    return sum(1 for _ in re.finditer(r"var\(--gooni-", new)) - sum(1 for _ in re.finditer(r"var\(--gooni-", src))


def main() -> int:
    write = "--write" in sys.argv
    total, files = 0, 0
    for dirpath, _dirs, names in os.walk(ROOT):
        for name in names:
            if not name.endswith(".tsx"):
                continue
            fp = os.path.join(dirpath, name)
            if any(x in fp.replace(os.sep, "/") for x in EXCLUDE):
                continue
            n = process(fp, write)
            if n:
                files += 1
                total += n
                print(f"{n:4d}  {os.path.relpath(fp, ROOT)}")
    print(f"\n{'applied' if write else 'would change'}: {total} literals across {files} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
