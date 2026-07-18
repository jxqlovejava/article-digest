#!/usr/bin/env python3
"""Convert HTML (stdin or file) → Markdown via Microsoft MarkItDown.

Usage:
  python3 scripts/markitdown_html.py < page.html
  python3 scripts/markitdown_html.py page.html

Exit codes:
  0 success (markdown on stdout)
  2 markitdown not installed
  3 conversion error
"""
from __future__ import annotations

import io
import sys


def main() -> int:
    try:
        from markitdown import MarkItDown
    except ImportError:
        sys.stderr.write("markitdown not installed\n")
        return 2

    if len(sys.argv) > 1 and sys.argv[1] not in ("-", "--"):
        path = sys.argv[1]
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            sys.stderr.write(f"read error: {e}\n")
            return 3
    else:
        data = sys.stdin.buffer.read()

    if not data.strip():
        sys.stderr.write("empty input\n")
        return 3

    md = MarkItDown()
    try:
        # Prefer stream API so we never need a real path on disk
        result = md.convert_stream(io.BytesIO(data), file_extension=".html")
        text = (result.text_content or "").strip()
    except Exception as e:  # noqa: BLE001 — surface any convert failure
        sys.stderr.write(f"convert error: {e}\n")
        return 3

    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
