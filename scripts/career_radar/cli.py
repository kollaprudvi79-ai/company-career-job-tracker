"""Entry point for the Career Radar Python collector.

Usage:
    python -m career_radar.cli --repo-root /path/to/repo

Environment overrides:
    BATCH_SIZE, BATCH_OFFSET, PROGRESS_FLUSH_EVERY, WORKERS,
    BOARD_TIMEOUT (standard), EXTRA_BOARD_TIMEOUT
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Career Radar async job-board collector")
    p.add_argument("--repo-root", default=os.environ.get("REPO_ROOT") or os.getcwd(),
                   help="Repo dir containing directory-sources.json etc. (default: cwd)")
    p.add_argument("--workers", type=int,
                   default=int(os.environ.get("WORKERS") or 24),
                   help="Concurrent board workers (default 24)")
    p.add_argument("--timeout", type=float,
                   default=float(os.environ.get("BOARD_TIMEOUT") or 8.0),
                   help="Per-board timeout seconds for standard ATS (default 8)")
    p.add_argument("--extra-timeout", type=float,
                   default=float(os.environ.get("EXTRA_BOARD_TIMEOUT") or 25.0),
                   help="Per-board timeout seconds for extra ATS (default 25)")
    p.add_argument("--progress-every", type=int,
                   default=int(os.environ.get("PROGRESS_FLUSH_EVERY") or 3000),
                   help="Boards between progress flushes + git pushes (default 3000)")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    from .collector import Sweep
    sweep = Sweep(
        repo=Path(args.repo_root),
        workers=args.workers,
        std_timeout=args.timeout,
        extra_timeout=args.extra_timeout,
        progress_every=args.progress_every,
    )
    try:
        summary = asyncio.run(sweep.run())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as e:
        print(f"fatal: {e}", file=sys.stderr)
        return 1
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
