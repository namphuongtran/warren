#!/usr/bin/env python3
"""Print a branch name <type>/<issue>-<slug> for a GitHub issue, for repos that gate branch names.

    warren-branch-name.py <issue-number> <title> [labels, comma-separated]

type: the title's conventional prefix (feat, fix, refactor, chore, docs, test, ci, perf), else
`fix` for a `bug` label, else `feat`. slug: the title without that prefix, ASCII, lowercase,
a-z0-9 and dashes, at most 40 characters.
"""
import re
import sys
import unicodedata

TYPES = ("feat", "fix", "refactor", "chore", "docs", "test", "ci", "perf")
num, title = sys.argv[1], sys.argv[2]
labels = [l.strip().lower() for l in (sys.argv[3] if len(sys.argv) > 3 else "").split(",")]

m = re.match(r"^\s*([a-z]+)(\([^)]*\))?!?:\s*(.*)$", title, re.I)
if m and m.group(1).lower() in TYPES:
    kind, rest = m.group(1).lower(), m.group(3)
else:
    kind, rest = ("fix" if "bug" in labels else "feat"), title

rest = rest.replace("đ", "d").replace("Đ", "D")
ascii_ = unicodedata.normalize("NFKD", rest).encode("ascii", "ignore").decode()
slug = re.sub(r"[^a-z0-9]+", "-", ascii_.lower()).strip("-")[:40].rstrip("-") or "issue"
print(f"{kind}/{num}-{slug}")
