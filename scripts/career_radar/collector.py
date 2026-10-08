"""Main sweep orchestrator (asyncio).

Pipeline per sweep:
  1. Load directory sources + previous snapshot + state.
  2. Tiered board selection (hot 7d + directory-extra + rotating 1/16 slice),
     ordered by historical yield so the best boards run first.
  3. Fetch with 24 concurrent workers, per-board timeout (8s standard /
     25s for multi-step extra ATS), every board wrapped in try/except.
  4. Stream progress: partial jobs.json + git push every N boards.
  5. Build final snapshot (firstSeen freeze, date repair, TF-IDF dedup,
     weighted fit scores), write jobs.json + collector-state.json +
     sweep-history.json, final git push.

jobs.json schema is identical to the Node collector:
{checkedAt, appVersion, jobs[], statuses[], recentCount, coverage{}, note}.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import aiohttp

from .fetchers import FETCHERS, normalize
from .fetchers_extra import EXTRA_TYPES, fetch_extra, is_extra_type, normalize_extra
from .models import Board, BoardStatus, Job, assess_job, is_us_job, now_iso
from .scoring import order_by_yield, record_yield, tfidf_dedupe, weighted_fit_score
from .tiering import (CONT_HOT_DAYS, CONT_ROTATION_SLICES, HOT_DAYS,
                      ROTATION_SLICES, select_boards)

APP_VERSION = "20261007py"
WORKDAY_CLAMP_MS = 30 * 24 * 3600 * 1000


# ---------------------------------------------------------------------------
# Small IO helpers
# ---------------------------------------------------------------------------

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def merge_sources(sources: List[Dict], extra: List[Dict]) -> List[Board]:
    seen, out = set(), []
    for s in (sources or []) + (extra or []):
        company = str(s.get("company") or "").strip()
        stype = str(s.get("type") or "").strip()
        token = str(s.get("token") or "").strip()
        if not company or not stype or not token:
            continue
        key = f"{stype}:{token.lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append(Board(company=company, type=stype, token=token,
                         from_extra=bool(s.get("_fromExtra"))))
    return out


def applied_check_factory(applied_path: Path):
    names = load_json(applied_path, [])
    normed = {re.sub(r"[^a-z0-9]+", " ", str(n).lower()).strip()
              for n in (names or []) if n}

    def check(job: Job) -> bool:
        c = re.sub(r"[^a-z0-9]+", " ", str(job.company or "").lower()).strip()
        return any(c == n or c in n for n in normed)
    return check


def load_first_seen_map(repo: Path) -> Dict[str, str]:
    merged: Dict[str, str] = {}
    for name in ["first-seen-map.json"] + [f"first-seen-map-{i}.json" for i in range(1, 11)]:
        d = load_json(repo / name, None)
        if isinstance(d, dict):
            merged.update(d)
    return merged


def employer_type(company: str, jobs: List[Job]) -> str:
    c = (company or "").lower()
    if re.search(r"\buniversity\b|\bcollege\b|\binstitute\b|\bschool\b|\bacademy\b", c):
        return "university"
    for j in jobs:
        if (j.company or "").lower() == c:
            loc = str(j.location or "").lower()
            if re.search(r"hospital|medical center|health system|clinic", loc):
                return "nonprofit"
    if re.search(r"hospital|health|medical|clinic|red cross|feeding|habitat|"
                 r"nature conservancy|cancer society|boys & girls|united way|"
                 r"goodwill|ymca|salvation army|charity|foundation|nonprofit", c):
        return "nonprofit"
    return "other"


# ---------------------------------------------------------------------------
# Board fetching
# ---------------------------------------------------------------------------

async def fetch_board(session: aiohttp.ClientSession, board: Board,
                      std_timeout: float, extra_timeout: float,
                      applied_check) -> Tuple[Dict[str, Any], List[Job]]:
    """Fetch + normalize one board. Never raises: returns (status, jobs)."""
    checked = now_iso()
    status = {"company": board.company, "type": board.type, "token": board.token,
              "ok": False, "checkedAt": checked, "matched": 0, "error": None}
    try:
        if is_extra_type(board.type):
            raw = await asyncio.wait_for(fetch_extra(session, board), timeout=extra_timeout)
            jobs = []
            for r in raw:
                try:
                    job = normalize_extra(board, r, checked, applied_check)
                    if job:
                        jobs.append(job)
                except Exception:
                    pass
        else:
            fetcher = FETCHERS.get(board.type)
            if not fetcher:
                raise RuntimeError("Unsupported ATS")
            raw = await asyncio.wait_for(fetcher(session, board), timeout=std_timeout)
            jobs = []
            for r in raw:
                try:
                    job = normalize(board, r, checked, applied_check)
                    if job:
                        jobs.append(job)
                except Exception:
                    pass
        status["ok"] = True
        status["matched"] = len(jobs)
        if len(jobs) == 0 and board.type not in EXTRA_TYPES:
            status["error"] = "No jobs matched (unverified board)"
        return status, jobs
    except asyncio.TimeoutError:
        status["error"] = "timeout"
        return status, []
    except Exception as e:
        status["error"] = str(e)[:300]
        return status, []


# ---------------------------------------------------------------------------
# Snapshot build
# ---------------------------------------------------------------------------

def build_snapshot(results: List[Tuple[Dict, List[Job]]],
                   previous_jobs: List[Job],
                   date_repair_map: Dict[str, str],
                   now_ms: int) -> Dict[str, Any]:
    ok_keys = {f"{s['type']}:{str(s['token'] or '').lower()}"
               for s, _ in results if s.get("ok")}

    old_jobs = []
    for j in previous_jobs:
        if j.boardKey in ok_keys:
            continue
        try:
            checked_ms = datetime.fromisoformat(
                j.checked.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            checked_ms = 0
        if now_ms - checked_ms < 36 * 3600 * 1000:
            j.stale = True
            old_jobs.append(j)

    merged: Dict[str, Job] = {}
    for j in old_jobs:
        if j.id and j.id not in merged:
            merged[j.id] = j
    for _, jobs in results:
        for j in jobs:
            if j.id and j.id not in merged:
                merged[j.id] = j

    prev_by_id = {j.id: j for j in previous_jobs if j.id}
    now_iso_s = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat()

    final: List[Job] = []
    for j in merged.values():
        prev = prev_by_id.get(j.id) if j.id else None
        j.firstSeen = j.firstSeen or (prev.firstSeen if prev else None) or j.checked or now_iso_s
        pub = j.published or (prev.published if prev else None)
        if pub and date_repair_map.get(j.id or ""):
            rep = date_repair_map[j.id]
            try:
                if datetime.fromisoformat(rep.replace("Z", "+00:00")) < \
                   datetime.fromisoformat(pub.replace("Z", "+00:00")):
                    pub = rep
            except Exception:
                pass
        if j.source == "workday" and pub:
            try:
                pub_ms = datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp() * 1000
                if now_ms - pub_ms > WORKDAY_CLAMP_MS:
                    pub = None
            except Exception:
                pass
        j.published = pub
        assess_job(j, now_ms)
        if j.fitScore is None:
            # Old snapshot rows predate scoring; score from title/location only.
            j.fitScore = weighted_fit_score(j, "")
        final.append(j)

    # Near-duplicate detection (reposts with new req IDs).
    tfidf_dedupe(final)

    filtered = [j for j in final
                if is_us_job(j) and not (j.flags or {}).get("restricted")
                and j.remoteType != "non-us"]

    def _pub_ts(j: Job) -> float:
        try:
            return datetime.fromisoformat(
                (j.published or j.firstSeen or now_iso_s
                 ).replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0

    # Fit first, newest first — same ordering as the Node collector.
    filtered.sort(key=lambda j: (not j.fit, -_pub_ts(j)))

    recent_count = sum(1 for j in filtered
                       if j.firstSeen and now_ms - datetime.fromisoformat(
                           j.firstSeen.replace("Z", "+00:00")).timestamp() * 1000
                       <= 24 * 3600 * 1000)

    fit_count = sum(1 for j in filtered if j.fit)
    recent7d = sum(1 for j in filtered if j.within7d)

    return {
        "jobs": [j.to_dict() for j in filtered],
        "recentCount": recent_count,
        "fitCount": fit_count,
        "recent7dCount": recent7d,
    }


def compute_sweep_history_entry(jobs: List[Dict], selected: List[Board]) -> Dict[str, Any]:
    new_jobs = sum(1 for j in jobs if j.get("within24h"))
    uni = sum(1 for j in jobs if employer_type(j.get("company"), []) == "university")
    nonp = sum(1 for j in jobs if employer_type(j.get("company"), []) == "nonprofit")
    return {
        "sweep": datetime.now(timezone.utc).isoformat(),
        "newJobs": new_jobs, "universityJobs": uni, "nonprofitJobs": nonp,
        "totalJobs": len(jobs), "boards": len(selected),
    }


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------

def git_push(repo: Path, message: str) -> bool:
    """Add + commit + push. Returns False (never raises) on any failure."""
    if not (repo / ".git").exists():
        return False
    try:
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True,
                       capture_output=True, timeout=90)
        subprocess.run(
            ["git", "-c", "user.name=Career Radar", "-c", "user.email=career-radar@localhost",
             "commit", "-m", message, "--allow-empty"],
            cwd=repo, check=True, capture_output=True, timeout=90)
        subprocess.run(["git", "push", "origin", "main"], cwd=repo, check=True,
                       capture_output=True, timeout=180)
        return True
    except Exception as e:
        print(f"[git] push failed: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Sweep:
    def __init__(self, repo: Path, workers: int = 24,
                 std_timeout: float = 8.0, extra_timeout: float = 25.0,
                 progress_every: int = 3000, full: bool = False,
                 continuous: bool = False, max_hours: float = 5.5,
                 iteration_sleep: float = 10.0):
        self.repo = repo
        self.workers = workers
        self.std_timeout = std_timeout
        self.extra_timeout = extra_timeout
        self.progress_every = progress_every
        self.full = full
        self.continuous = continuous
        self.max_hours = max_hours
        self.iteration_sleep = iteration_sleep
        self.results: List[Tuple[Dict, List[Job]]] = []
        self.done = 0
        self.flush_lock = asyncio.Lock()
        self.session: aiohttp.ClientSession | None = None

    async def flush_progress(self, total: int, previous_jobs, date_repair_map,
                             state: Dict, final: bool = False):
        if self.flush_lock.locked():
            return
        async with self.flush_lock:
            try:
                now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
                snap = await asyncio.to_thread(
                    build_snapshot, list(self.results), previous_jobs,
                    date_repair_map, now_ms)
                statuses = [s for s, _ in self.results]
                attempted = len(self.results)
                coverage = {
                    "discovered": 0,
                    "attempted": attempted,
                    "success": sum(1 for s in statuses if s.get("ok")),
                    "failed": sum(1 for s in statuses if not s.get("ok")),
                    "sweepInProgress": not final,
                    "sweepTotal": total,
                    "nextOffset": state.get("nextOffset", 0),
                    "fitCount": snap["fitCount"],
                    "recent7dCount": snap["recent7dCount"],
                }
                write_json(self.repo / "jobs.json", {
                    "checkedAt": now_iso(),
                    "appVersion": APP_VERSION,
                    "jobs": snap["jobs"],
                    "statuses": statuses,
                    "recentCount": snap["recentCount"],
                    "coverage": coverage,
                    "note": ("Career Radar employer job snapshot. Board URLs are ATS "
                             "career pages; open a board URL manually to verify an opening."),
                })
                state["sweepInProgress"] = not final
                state["sweepAttempted"] = attempted
                state["sweepTotal"] = total
                write_json(self.repo / "collector-state.json", state)
                pushed = await asyncio.to_thread(
                    git_push, self.repo,
                    f"Sweep progress {attempted}/{total} boards" if not final
                    else "Refresh employer jobs snapshot")
                print(f"[progress] {attempted}/{total} boards"
                      f"{' (pushed)' if pushed else ''}", flush=True)
            except Exception as e:
                # A failed progress push must never fail the sweep.
                print(f"[progress] flush failed: {e}", file=sys.stderr)

    async def worker(self, queue: asyncio.Queue, applied_check,
                     previous_jobs, date_repair_map, state: Dict, total: int):
        while True:
            try:
                board = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            status, jobs = await fetch_board(
                self.session, board, self.std_timeout, self.extra_timeout,
                applied_check)
            self.results.append((status, jobs))
            self.done += 1
            if self.done % 250 == 0 or self.done == total:
                print(f"[sweep] {self.done}/{total}", flush=True)
            if self.progress_every and self.done % self.progress_every == 0:
                await self.flush_progress(total, previous_jobs, date_repair_map, state)

    async def _run_iteration(self, hot_days: int = HOT_DAYS,
                           slices: int = ROTATION_SLICES,
                           full: bool | None = None) -> Dict[str, Any]:
        """Run one full sweep iteration: select, fetch, snapshot, push."""
        if full is None:
            full = self.full
        # Fresh per-iteration accumulation (continuous mode reuses the Sweep).
        self.results = []
        self.done = 0
        repo = self.repo
        sources = load_json(repo / "directory-sources.json", [])
        extra = load_json(repo / "directory-extra.json", [])
        boards = merge_sources(sources if isinstance(sources, list) else [],
                               extra if isinstance(extra, list) else [])
        prev_data = load_json(repo / "jobs.json", {}) or {}
        previous_jobs = [Job.from_dict(j) for j in (prev_data.get("jobs") or [])]
        date_repair_map = load_first_seen_map(repo)
        state = load_json(repo / "collector-state.json", {}) or {}
        applied_check = applied_check_factory(repo / "applied-companies.json")

        # Board selection: full sweep or tiered (hot + rotating slice).
        selected, tier_info = select_boards(boards, previous_jobs, state,
                                            hot_days=hot_days,
                                            slices=slices,
                                            full=full)
        # Yield-based ordering: best boards first.
        selected = order_by_yield(selected, state)

        # Batch/offset (compat with the JS collector; default covers all).
        batch = int(os.environ.get("BATCH_SIZE") or 100000)
        offset = int(os.environ.get("BATCH_OFFSET") or state.get("nextOffset") or 0)
        n = len(selected)
        batch_sel = ([selected[(offset + i) % n] for i in range(min(batch, n))]
                     if n else [])
        state["nextOffset"] = (offset + len(batch_sel)) % n if n else 0
        state["sweepInProgress"] = True
        state["sweepAttempted"] = 0
        state["sweepTotal"] = len(batch_sel)
        state["rotationRuns"] = int(state.get("rotationRuns") or 0) + 1
        write_json(repo / "collector-state.json", state)

        print(f"[sweep] {len(boards)} boards total; selected {len(batch_sel)} "
              f"(hot {tier_info['hot']}, extra {tier_info['extra']}, "
              f"slice {tier_info['slice_idx']}/{tier_info['slices']}); "
              f"{self.workers} workers", flush=True)

        queue: asyncio.Queue = asyncio.Queue()
        for b in batch_sel:
            queue.put_nowait(b)

        connector = aiohttp.TCPConnector(limit=50)
        req_timeout = aiohttp.ClientTimeout(total=60, sock_connect=10)
        t0 = datetime.now(timezone.utc)
        async with aiohttp.ClientSession(connector=connector,
                                         timeout=req_timeout) as session:
            self.session = session
            workers = [asyncio.create_task(
                self.worker(queue, applied_check, previous_jobs,
                            date_repair_map, state, len(batch_sel)))
                for _ in range(self.workers)]
            await asyncio.gather(*workers)
        elapsed = (datetime.now(timezone.utc) - t0).total_seconds()

        # Final snapshot.
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        snap = await asyncio.to_thread(build_snapshot, list(self.results),
                                       previous_jobs, date_repair_map, now_ms)
        statuses = [s for s, _ in self.results]
        coverage = {
            "discovered": 0,
            "attempted": len(statuses),
            "success": sum(1 for s in statuses if s.get("ok")),
            "failed": sum(1 for s in statuses if not s.get("ok")),
            "batchOffset": offset,
            "batchSize": batch,
            "nextOffset": state["nextOffset"],
            "rotationRuns": state["rotationRuns"],
            "fitCount": snap["fitCount"],
            "recent7dCount": snap["recent7dCount"],
        }
        write_json(repo / "jobs.json", {
            "checkedAt": now_iso(),
            "appVersion": APP_VERSION,
            "jobs": snap["jobs"],
            "statuses": statuses,
            "recentCount": snap["recentCount"],
            "coverage": coverage,
            "note": ("Career Radar employer job snapshot. Board URLs are ATS "
                     "career pages; open a board URL manually to verify an opening."),
        })

        # Yield tracking + state.
        record_yield(state, statuses)
        state["sweepInProgress"] = False
        state["sweepAttempted"] = len(statuses)
        state["lastRun"] = {"ok": True, "at": now_iso(),
                            "boards": len(statuses), "jobs": len(snap["jobs"]),
                            "elapsedSec": round(elapsed, 1)}
        write_json(repo / "collector-state.json", state)

        # Sweep history (last 14 days, matching the JS pipeline).
        hist_path = repo / "sweep-history.json"
        hist = load_json(hist_path, []) or []
        if not isinstance(hist, list):
            hist = []
        hist.append(compute_sweep_history_entry(snap["jobs"], batch_sel))
        cutoff = (datetime.now(timezone.utc).timestamp() - 14 * 86400) * 1000
        hist = [h for h in hist
                if (datetime.fromisoformat(h["sweep"].replace("Z", "+00:00")).timestamp() * 1000) >= cutoff]
        write_json(hist_path, hist[-400:])

        await self.flush_progress(len(batch_sel), previous_jobs, date_repair_map,
                                  state, final=True)

        summary = {
            "ok": True, "boards": len(statuses),
            "jobs": len(snap["jobs"]), "fit": snap["fitCount"],
            "recent24h": snap["recentCount"], "elapsedSec": round(elapsed, 1),
            "tier": tier_info,
        }
        print(json.dumps(summary))
        return summary

    async def run(self) -> Dict[str, Any]:
        """Entry point: single sweep, or the continuous 24/7 loop."""
        if self.continuous:
            return await self.run_continuous()
        return await self._run_iteration()

    async def run_continuous(self) -> Dict[str, Any]:
        """Loop sweep iterations until the hour budget elapses.

        Each iteration checks HOT boards (jobs found in the last 24h) plus a
        tiny 1/48 rotating slice, then commits + pushes immediately. A
        workflow triggers the next run before this one exits, so chained runs
        give unbroken 24/7 coverage. State (rotationIdx, boardYield) persists
        via git after every iteration, so a kill mid-iteration resumes cleanly
        from the last committed state.
        """
        t_start = datetime.now(timezone.utc)
        max_secs = self.max_hours * 3600.0
        # Conservative first-iteration estimate; adapts from measured times.
        est_iter_secs = 300.0
        completed = 0
        total_boards = 0
        total_jobs = 0
        total_new = 0
        last_ok = True

        while True:
            elapsed = (datetime.now(timezone.utc) - t_start).total_seconds()
            if elapsed + est_iter_secs > max_secs:
                print(f"[continuous] stop: {elapsed / 3600:.2f}h elapsed + "
                      f"~{est_iter_secs / 60:.1f}m est. iteration would exceed "
                      f"{self.max_hours}h budget", flush=True)
                break
            completed += 1
            print(f"[continuous] iteration {completed}, "
                  f"elapsed {elapsed / 3600:.2f}h/{self.max_hours}h",
                  flush=True)
            t_iter = datetime.now(timezone.utc)
            try:
                summary = await self._run_iteration(
                    hot_days=CONT_HOT_DAYS,
                    slices=CONT_ROTATION_SLICES,
                    full=False,
                )
            except Exception as e:
                print(f"[continuous] iteration {completed} failed: {e}",
                      file=sys.stderr)
                completed -= 1
                last_ok = False
                break
            iter_secs = (datetime.now(timezone.utc) - t_iter).total_seconds()
            est_iter_secs = max(180.0, iter_secs * 1.5)
            total_boards += summary.get("boards", 0)
            total_jobs += summary.get("jobs", 0)
            total_new += summary.get("recent24h", 0)

            elapsed = (datetime.now(timezone.utc) - t_start).total_seconds()
            if elapsed >= max_secs:
                print(f"[continuous] budget reached: "
                      f"{elapsed / 3600:.2f}h/{self.max_hours}h", flush=True)
                break
            sleep_for = min(float(self.iteration_sleep),
                            max(0.0, max_secs - elapsed))
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

        total_elapsed = (datetime.now(timezone.utc) - t_start).total_seconds()
        final = {
            "ok": last_ok,
            "mode": "continuous",
            "iterations": completed,
            "boards": total_boards,
            "jobs": total_jobs,
            "recent24h": total_new,
            "elapsedSec": round(total_elapsed, 1),
        }
        print(json.dumps(final))
        return final
