"""Ingestion CLI: rebuild the local retrieval index from content/profile.json.

WHY this exists: `npm run index:rebuild` had no entry point. The AI service builds its index lazily at
startup (`AIService.ensure_index`), which means the only way to rebuild was to start a server. That is
not a usable workflow when iterating on chunking, and it silently leaves a stale index in place
because "rebuild-if-empty" never fires once chunks exist.

WHY it is a separate module rather than a flag on main.py: importing the ASGI app must never have CLI
side effects, and `python -m services.ai.app.main` is the process entry point.

Usage:
    python -m services.ai.app.ingest            # rebuild from scratch
    python -m services.ai.app.ingest --stats    # report counts only, change nothing
"""

from __future__ import annotations

import argparse
import json
import sys

from .chunking import chunk_profile
from .config import ConfigError, load_config
from .hybrid import HybridIndex


def rebuild(*, quiet: bool = False) -> int:
    """Drop the existing bot1 index and re-chunk the profile into it.

    Returns the number of chunks written.

    WHY delete-then-insert instead of upsert alone: `upsert` keys on a chunk id derived from the text.
    If chunking changes and an old chunk id no longer appears in the new output, upsert would leave
    the stale row behind forever and it would keep matching queries. Deleting the bot1 scope first
    makes the index a true function of the current profile rather than an accumulation.
    """
    config = load_config()

    profile = json.loads(config.profile_path.read_text(encoding="utf-8"))
    index = HybridIndex(config.index_path)

    before = index.count("bot1")
    # WHY delete-then-insert instead of upsert alone: `upsert` keys on a chunk id derived from the text.
    # If chunking changes and an old chunk id no longer appears in the new output, upsert would leave
    # the stale row behind forever and it would keep matching queries. Deleting the scope first makes
    # the index a true function of the current profile rather than an accumulation.
    #
    # WHY scope the delete to (bot1, "static"): Drop-Zone documents ingested for bot3 under a session
    # must survive a profile rebuild. Only the static resume scope is derived from profile.json.
    # "static" is the session id chunking.py assigns to every profile chunk (Chunk.session_id).
    index.delete_by_filter("bot1", "static")

    chunks = chunk_profile(profile)
    written = index.upsert(chunks)

    if not quiet:
        print(f"index      : {config.index_path}")
        print(f"bot1 before: {before} chunk(s)")
        print(f"bot1 after : {written} chunk(s) written, {index.count('bot1')} present")
        if written == 0:
            # WHY a non-zero exit on an empty index: an empty index makes every bot1 answer fall back
            # to "no sources". Reporting success would hide a silently broken site.
            print("ERROR: chunking produced zero chunks; the index is unusable.", file=sys.stderr)
            return 1
    return 0


def stats() -> int:
    """Report index counts without modifying anything."""
    config = load_config()
    index = HybridIndex(config.index_path)
    print(f"index      : {config.index_path}")
    print(f"bot1 chunks: {index.count('bot1')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild the local retrieval index.")
    parser.add_argument(
        "--stats", action="store_true",
        help="report chunk counts without rebuilding",
    )
    args = parser.parse_args()

    try:
        return stats() if args.stats else rebuild()
    except ConfigError as exc:
        print(f"[ingest] configuration error: {exc}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print(f"[ingest] failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())