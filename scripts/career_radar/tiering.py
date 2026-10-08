"""Smart board selection for each sweep.

Every sweep checks:
  T1 HOT: boards with jobs first seen in the last ``hot_days`` + every board
          from directory-extra.json (universities, hospitals, nonprofits).
  T2 ROTATING: a deterministic 1/``slices`` slice of all remaining boards,
          advancing each sweep (persisted via ``rotationIdx`` in state).

With 24 workers / 8s timeouts the per-sweep board budget is ~7,000-8,000
(~5 min). ``slices=16`` keeps a sweep inside that budget while covering the
full directory roughly every 10h (16 sweeps x 40 min).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List

from .models import Board, Job

HOT_DAYS = 7
ROTATION_SLICES = 16


def _hash_key(key: str) -> int:
    """Deterministic FNV-style hash matching the JS ((h*31 + c) >>> 0)."""
    h = 0
    for ch in key:
        h = ((h * 31) + ord(ch)) & 0xFFFFFFFF
    return h


def select_boards(boards: List[Board], previous_jobs: List[Job],
                  state: Dict, hot_days: int = HOT_DAYS,
                  slices: int = ROTATION_SLICES, full: bool = False):
    """Return (selected, info) for this sweep; advances rotationIdx in state.
    
    If full=True, selects ALL boards (full directory sweep).
    """
    if full:
        # Full sweep: check every board
        info = {
            "total": len(boards),
            "selected": len(boards),
            "hot": 0,
            "extra": 0,
            "slice": 0,
            "slice_idx": 0,
            "slices": 1,
            "mode": "full",
        }
        return boards, info
    now_ms = datetime.now(timezone.utc).timestamp() * 1000

    # Latest firstSeen per board from the previous snapshot.
    board_last_seen: Dict[str, float] = {}
    for job in previous_jobs:
        if not job.boardKey:
            continue
        try:
            fs = datetime.fromisoformat(
                job.firstSeen.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            fs = 0
        if fs > board_last_seen.get(job.boardKey, 0):
            board_last_seen[job.boardKey] = fs

    hot_cutoff = now_ms - hot_days * 24 * 3600 * 1000
    hot_keys = {k for k, fs in board_last_seen.items() if fs >= hot_cutoff}

    rotation_idx = int(state.get("rotationIdx") or 0) % slices
    state["rotationIdx"] = rotation_idx + 1
    # Keep lastDeepSweep populated for backward compatibility.
    if not state.get("lastDeepSweep"):
        state["lastDeepSweep"] = datetime.now(timezone.utc).isoformat()

    selected: List[Board] = []
    n_hot = n_extra = n_slice = 0
    for board in boards:
        if board.from_extra:
            selected.append(board)
            n_extra += 1
            continue
        if board.key in hot_keys:
            selected.append(board)
            n_hot += 1
            continue
        if _hash_key(board.key) % slices == rotation_idx:
            selected.append(board)
            n_slice += 1

    info = {
        "total": len(boards),
        "selected": len(selected),
        "hot": n_hot,
        "extra": n_extra,
        "slice": n_slice,
        "slice_idx": rotation_idx + 1,
        "slices": slices,
    }
    return selected, info
