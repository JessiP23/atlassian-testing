#!/usr/bin/env python3
"""Turn Claude Code's JSON result into a priced usage report.

Reads the file produced by `claude -p ... --output-format json`, prices the
token counts at Bedrock rates, writes `usage.json` into the run directory, and
appends a table to the GitHub step summary when available.

Prices are USD per million tokens and can be overridden with environment
variables so the numbers track whatever AWS bills for the configured model.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def price(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


# Bedrock global-endpoint list prices for Claude Opus 5 (Sept 2026).
# Cache reads are 10% of input; cache writes are 125% of input.
INPUT = price("PRICE_INPUT_PER_M", 5.00)
OUTPUT = price("PRICE_OUTPUT_PER_M", 25.00)
CACHE_READ = price("PRICE_CACHE_READ_PER_M", INPUT * 0.10)
CACHE_WRITE = price("PRICE_CACHE_WRITE_PER_M", INPUT * 1.25)


def main() -> int:
    result_path = Path(os.environ.get("CLAUDE_RESULT_JSON", "/tmp/claude-result.json"))
    run_dir = Path(os.environ.get("RUN_DIR", ".github/agentic/run"))
    if not result_path.is_file():
        print(f"No Claude result at {result_path}; skipping usage report")
        return 0

    try:
        data = json.loads(result_path.read_text())
    except json.JSONDecodeError as err:
        print(f"Claude result is not valid JSON: {err}", file=sys.stderr)
        return 0

    # `claude -p --output-format json` yields a single result object; the
    # stream-json variant yields a list whose last element is the result.
    if isinstance(data, list):
        data = next((d for d in reversed(data) if d.get("type") == "result"), {})

    final_message = (data.get("result") or "").strip()
    if final_message:
        print("=== Claude final message ===")
        print(final_message[:4000])
        print("=== end ===\n")

    usage = data.get("usage") or {}
    in_tok = int(usage.get("input_tokens", 0))
    out_tok = int(usage.get("output_tokens", 0))
    cache_read = int(usage.get("cache_read_input_tokens", 0))
    cache_write = int(usage.get("cache_creation_input_tokens", 0))

    cost = (
        in_tok * INPUT + out_tok * OUTPUT + cache_read * CACHE_READ + cache_write * CACHE_WRITE
    ) / 1_000_000

    report = {
        "model": os.environ.get("BEDROCK_OPUS_MODEL", ""),
        "num_turns": data.get("num_turns"),
        "duration_ms": data.get("duration_ms"),
        "duration_api_ms": data.get("duration_api_ms"),
        "is_error": data.get("is_error", False),
        "tokens": {
            "input": in_tok,
            "output": out_tok,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "total_context_served": in_tok + cache_read + cache_write,
        },
        "prices_per_million_usd": {
            "input": INPUT,
            "output": OUTPUT,
            "cache_read": CACHE_READ,
            "cache_write": CACHE_WRITE,
        },
        "estimated_cost_usd": round(cost, 4),
        "claude_code_reported_cost_usd": data.get("total_cost_usd"),
    }

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "usage.json").write_text(json.dumps(report, indent=2) + "\n")

    minutes = (data.get("duration_ms") or 0) / 60_000
    lines = [
        "### Bedrock Opus usage",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Model | `{report['model']}` |",
        f"| Turns | {report['num_turns']} |",
        f"| Wall time | {minutes:.1f} min |",
        f"| Input tokens (uncached) | {in_tok:,} |",
        f"| Cache reads | {cache_read:,} |",
        f"| Cache writes | {cache_write:,} |",
        f"| Output tokens | {out_tok:,} |",
        f"| **Estimated cost** | **${cost:.2f}** |",
        "",
        f"Priced at ${INPUT}/M in, ${OUTPUT}/M out, ${CACHE_READ:.2f}/M cache read, "
        f"${CACHE_WRITE:.2f}/M cache write. Override with `PRICE_*_PER_M` env vars.",
    ]
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
