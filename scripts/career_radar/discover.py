"""Board discovery: find NEW, ACTIVE hiring companies across ATS platforms.

Pulls role feeds that link straight to employer ATS postings, extracts the
ATS board behind every posting URL, then VALIDATES each candidate board by
test-fetching its ATS API. Only boards returning >= 1 active job listing are
kept. Output: discovered-boards.json — [{company, type, token}].

Designed to run hourly via the workflow: it skips boards already in
directory-sources.json so each run only validates genuinely new candidates.

Usage:
    python -m career_radar.discover --repo-root /path/to/repo --workers 20
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

import aiohttp

from .fetchers import FETCHERS
from .models import Board

UA = "Mozilla/5.0 (compatible; CareerRadar/1.0 discovery)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/36")

# Token hygiene (ported from discover.mjs).
VALID_TOKEN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,90}$")
VALID_LONG_TOKEN = re.compile(r"^[a-z0-9][a-z0-9._/-]{1,180}$")
RESERVED = frozenset({
    "www", "api", "en", "us", "jobs", "careers", "login", "signup", "about",
    "help", "support", "static", "assets", "embed", "search", "company",
    "companies", "job", "apply", "home", "index",
})

# Only extract ATS types we can validate via FETCHERS.
SUPPORTED_TYPES = set(FETCHERS.keys())

URL_RE = re.compile(r"https?://[^\s\"'<>\])}]+")
TRAILING_PUNCT = re.compile(r"[.,;]+$")


def _log(*a: Any) -> None:
    print(datetime.now(timezone.utc).isoformat(), *a, flush=True)


class CandidateSet:
    """Deduped candidate boards: key -> {company, type, token}."""

    def __init__(self) -> None:
        self._boards: Dict[str, Dict[str, str]] = {}

    def add(self, btype: str, token: str, company: str = "") -> None:
        if btype not in SUPPORTED_TYPES:
            return
        token = str(token or "").lower().strip()
        if btype in ("workday", "oracle", "icims"):
            if not VALID_LONG_TOKEN.match(token):
                return
        elif not VALID_TOKEN.match(token):
            return
        if token in RESERVED:
            return
        key = f"{btype}:{token}"
        if key not in self._boards:
            self._boards[key] = {
                "company": str(company or token)[:120],
                "type": btype,
                "token": token,
            }

    def __len__(self) -> int:
        return len(self._boards)

    def items(self) -> List[Dict[str, str]]:
        return list(self._boards.values())

    def keys(self) -> Set[str]:
        return set(self._boards.keys())


def _seg(pathname: str, i: int) -> str:
    parts = [p for p in pathname.split("/") if p]
    return parts[i] if i < len(parts) else ""


def from_url(raw: str, company: str, out: CandidateSet) -> None:
    """Extract an ATS board from a posting URL (ported from discover.mjs)."""
    try:
        u = urlparse(raw)
    except Exception:
        return
    if u.scheme not in ("http", "https") or not u.hostname:
        return
    h = u.hostname.lower()
    p = u.path or ""

    if h in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        out.add("greenhouse", _seg(p, 0), company)
    elif h == "jobs.lever.co":
        out.add("lever", _seg(p, 0), company)
    elif h == "jobs.ashbyhq.com":
        out.add("ashby", _seg(p, 0), company)
    elif h == "jobs.smartrecruiters.com":
        out.add("smartrecruiters", _seg(p, 0), company)
    elif h == "apply.workable.com":
        out.add("workable", _seg(p, 0), company)
    elif h == "jobs.jobvite.com":
        out.add("jobvite", _seg(p, 0), company)
    elif h == "ats.rippling.com":
        if p.startswith("/api/v1/board/"):
            out.add("rippling", _seg(p, 3), company)
        else:
            out.add("rippling", _seg(p, 0), company)
    elif re.match(r"^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$", h):
        tenant = h.split(".")[0]
        site = _seg(p, 0)
        if site and site not in ("wday", "d"):
            out.add("workday", f"{h}/{tenant}/{site}", company)
    elif h.endswith(".applytojob.com"):
        out.add("jazzhr", h[: -len(".applytojob.com")], company)
    elif h.endswith(".pinpointhq.com"):
        out.add("pinpoint", h[: -len(".pinpointhq.com")], company)
    elif h.endswith(".recruitee.com"):
        out.add("recruitee", h[: -len(".recruitee.com")], company)
    elif h.endswith(".breezy.hr"):
        out.add("breezy", h[: -len(".breezy.hr")], company)
    elif h.endswith(".bamboohr.com"):
        out.add("bamboohr", h[: -len(".bamboohr.com")], company)
    elif h.endswith(".teamtailor.com"):
        out.add("teamtailor", h[: -len(".teamtailor.com")], company)
    elif h.endswith(".jobs.personio.com"):
        out.add("personio", h[: -len(".jobs.personio.com")], company)
    elif h.endswith(".jobs.personio.de"):
        out.add("personio", h[: -len(".jobs.personio.de")], company)
    elif h.endswith(".icims.com") and p.startswith("/jobs/"):
        out.add("icims", h, company)
    elif h.endswith(".oraclecloud.com"):
        parts = p.split("/")
        try:
            si = parts.index("sites")
            if si + 1 < len(parts) and parts[si + 1]:
                out.add("oracle", f"{h}/{parts[si + 1]}", company)
        except ValueError:
            pass


def scan_text(text: str, company: str, out: CandidateSet) -> None:
    for m in URL_RE.finditer(str(text or "")):
        from_url(TRAILING_PUNCT.sub("", m.group(0)), company, out)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

async def get_json(session: aiohttp.ClientSession, url: str,
                   timeout: float = 30.0) -> Optional[Any]:
    try:
        async with session.get(
            url,
            headers={"user-agent": UA, "accept": "application/json",
                     "accept-encoding": "gzip, deflate"},
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as r:
            if r.status != 200:
                return None
            # content_type=None: raw.githubusercontent serves JSON as text/plain
            return await r.json(content_type=None)
    except Exception:
        return None


async def get_html(session: aiohttp.ClientSession, url: str,
                   timeout: float = 20.0) -> str:
    try:
        async with session.get(
            url,
            headers={"user-agent": BROWSER_UA, "accept": "text/html",
                     "accept-encoding": "gzip, deflate"},
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as r:
            return await r.text() if r.status == 200 else ""
    except Exception:
        return ""


async def resolve_redirect(session: aiohttp.ClientSession, url: str,
                           max_hops: int = 3) -> str:
    current = url
    for _ in range(max_hops):
        try:
            async with session.get(
                current,
                headers={"user-agent": UA},
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as r:
                if 300 <= r.status < 400:
                    loc = r.headers.get("location")
                    if not loc:
                        return current
                    from urllib.parse import urljoin
                    current = urljoin(current, loc)
                    continue
                return current
        except Exception:
            return current
    return current


async def pool(items: List[Any], size: int, fn) -> None:
    """Bounded-concurrency worker pool."""
    it = iter(items)
    lock = asyncio.Lock()

    async def worker() -> None:
        while True:
            async with lock:
                try:
                    item = next(it)
                except StopIteration:
                    return
            try:
                await fn(item)
            except Exception:
                pass

    await asyncio.gather(*[worker() for _ in range(max(1, min(size, len(items))))])


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

# Fallback if the GitHub org API is unreachable.
LANDED_FALLBACK = [
    "data-scientist-jobs", "data-engineer-jobs", "ai-engineer-jobs",
    "machine-learning-engineer-jobs", "llm-engineer-jobs",
    "backend-engineer-jobs", "frontend-engineer-jobs",
    "fullstack-engineer-jobs", "devops-engineer-jobs",
    "software-engineer-jobs", "product-manager-jobs",
    "data-analyst-jobs", "qa-engineer-jobs", "mobile-engineer-jobs",
    "security-engineer-jobs", "platform-engineer-jobs",
]


async def landedjobs_repos(session: aiohttp.ClientSession) -> List[str]:
    """All *-jobs repos under the landedjobs org (daily-refreshed feeds)."""
    data = await get_json(
        session, "https://api.github.com/orgs/landedjobs/repos?per_page=100")
    if isinstance(data, list):
        repos = [r.get("name", "") for r in data
                 if r.get("name", "").endswith("-jobs")]
        if repos:
            return sorted(set(repos))
    return LANDED_FALLBACK


async def source_landedjobs(session: aiohttp.ClientSession,
                            out: CandidateSet,
                            max_repos: int = 4) -> None:
    repos = await landedjobs_repos(session)
    _log("landedjobs repos:", len(repos))
    # Rotate: process a slice each run so hourly runs stay fast (~9 min);
    # full repo coverage every ceil(len/4) hours.
    if max_repos and len(repos) > max_repos:
        slot = datetime.now(timezone.utc).hour % ((len(repos) + max_repos - 1) // max_repos)
        repos = repos[slot * max_repos:(slot + 1) * max_repos]
        _log(f"landedjobs rotated slice (slot {slot}):", repos)

    async def handle_job(j: Dict[str, Any]) -> None:
        company = j.get("company") or j.get("company_name") or ""
        raw = j.get("applyUrl") or j.get("apply_url") or j.get("url") or ""
        if not raw:
            return
        if "go.landed.jobs" in raw:
            resolved = await resolve_redirect(session, raw)
            html = await get_html(session, resolved)
            if html:
                scan_text(html, company, out)
            else:
                from_url(resolved, company, out)
        else:
            from_url(raw, company, out)

    for repo in repos:
        data = await get_json(
            session,
            f"https://raw.githubusercontent.com/landedjobs/{repo}/main/jobs.json")
        if isinstance(data, dict):
            postings = data.get("jobs") or []
        elif isinstance(data, list):
            postings = data
        else:
            continue
        await pool(postings, 10, handle_job)
        _log("landedjobs", repo, "postings", len(postings),
             "candidates", len(out))


async def source_remoteok(session: aiohttp.ClientSession,
                          out: CandidateSet) -> None:
    data = await get_json(session, "https://remoteok.com/api")
    postings = data if isinstance(data, list) else []
    n = 0
    for j in postings:
        if not isinstance(j, dict) or not j.get("company"):
            continue
        n += 1
        company = j.get("company", "")
        if isinstance(j.get("url"), str):
            from_url(j["url"], company, out)
        scan_text(j.get("description") or "", company, out)
    _log("remoteok postings", n, "candidates", len(out))


async def source_hn(session: aiohttp.ClientSession, out: CandidateSet) -> None:
    """Latest monthly 'Who is hiring' thread (startup-heavy, direct ATS links)."""
    try:
        search = await get_json(
            session,
            "https://hn.algolia.com/api/v1/search_by_date?"
            "query=%22Who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=1")
        hits = (search or {}).get("hits") or []
        story_id = hits[0].get("objectID") if hits else None
        if not story_id:
            return
        for page in range(2):
            comments = await get_json(
                session,
                f"https://hn.algolia.com/api/v1/search?"
                f"tags=comment,story_{story_id}&hitsPerPage=1000&page={page}")
            chits = (comments or {}).get("hits") or []
            if not chits:
                break
            for c in chits:
                scan_text(c.get("comment_text") or "", "", out)
            nb = (comments or {}).get("nbPages") or 0
            if nb and page + 1 >= nb:
                break
        _log("hn whoishiring done, candidates", len(out))
    except Exception as e:
        _log("hn skip:", e)


async def source_yc(session: aiohttp.ClientSession, out: CandidateSet) -> None:
    """Y Combinator jobs page — scan for employer ATS links."""
    html = await get_html(session, "https://www.ycombinator.com/jobs",
                          timeout=30.0)
    if html:
        scan_text(html, "", out)
        _log("yc jobs scanned, candidates", len(out))
    else:
        _log("yc jobs unreachable")


# Curated GitHub repos whose raw files list job postings with ATS links.
# Kept small and defensive: any failure is skipped silently.
AWESOME_SOURCES = [
    # (raw_url, is_json)
    ("https://raw.githubusercontent.com/remoteintech/remote-jobs/main/README.md", False),
]


async def source_awesome(session: aiohttp.ClientSession,
                         out: CandidateSet) -> None:
    for url, is_json in AWESOME_SOURCES:
        try:
            if is_json:
                data = await get_json(session, url)
                scan_text(json.dumps(data), "", out)
            else:
                html = await get_html(session, url)
                scan_text(html, "", out)
        except Exception:
            continue
    _log("awesome lists done, candidates", len(out))


# ---------------------------------------------------------------------------
# Validation: test-fetch each candidate's ATS API, keep only active boards
# ---------------------------------------------------------------------------

async def validate_board(session: aiohttp.ClientSession,
                         cand: Dict[str, str],
                         timeout: float = 10.0) -> Optional[Dict[str, str]]:
    """Return the candidate if its ATS API yields >= 1 job, else None."""
    fn = FETCHERS.get(cand["type"])
    if not fn:
        return None
    board = Board(company=cand["company"], type=cand["type"],
                  token=cand["token"])
    try:
        raw = await asyncio.wait_for(fn(session, board), timeout=timeout)
        if isinstance(raw, list) and len(raw) >= 1:
            return cand
    except Exception:
        pass
    return None


async def validate_all(cands: List[Dict[str, str]],
                       workers: int = 20) -> List[Dict[str, str]]:
    valid: List[Dict[str, str]] = []
    lock = asyncio.Lock()
    connector = aiohttp.TCPConnector(limit=workers * 2)

    async with aiohttp.ClientSession(connector=connector,
                                     trust_env=True) as session:
        it = iter(cands)

        async def worker() -> None:
            while True:
                async with lock:
                    try:
                        cand = next(it)
                    except StopIteration:
                        return
                try:
                    res = await validate_board(session, cand)
                except Exception:
                    res = None
                if res:
                    async with lock:
                        valid.append(res)

        await asyncio.gather(*[worker() for _ in range(max(1, workers))])
    return valid


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_existing_keys(repo: Path) -> Set[str]:
    """Board keys already in directory-sources.json (skip re-discovery)."""
    keys: Set[str] = set()
    for name in ("directory-sources.json", "directory-extra.json"):
        p = repo / name
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text())
            boards = data if isinstance(data, list) else data.get("boards", [])
            for b in boards:
                if isinstance(b, dict) and b.get("type") and b.get("token"):
                    keys.add(f"{b['type']}:{str(b['token']).lower()}")
        except Exception:
            continue
    return keys


async def run(repo: Path, workers: int = 20,
              validate_workers: int = 20,
              max_repos: int = 4) -> Dict[str, Any]:
    out = CandidateSet()
    connector = aiohttp.TCPConnector(limit=50)
    async with aiohttp.ClientSession(connector=connector,
                                     trust_env=True) as session:
        try:
            await source_landedjobs(session, out, max_repos=max_repos)
        except Exception as e:
            _log("source landedjobs failed:", e)
        for name, src in (
            ("remoteok", source_remoteok),
            ("hn", source_hn),
            ("yc", source_yc),
            ("awesome", source_awesome),
        ):
            try:
                await src(session, out)
            except Exception as e:
                _log(f"source {name} failed:", e)

    _log("raw candidates:", len(out))

    # Drop anything already in the directory.
    existing = load_existing_keys(repo)
    fresh = [c for c in out.items()
             if f"{c['type']}:{c['token']}" not in existing]
    _log(f"new candidates (not in directory): {len(fresh)} "
         f"(skipped {len(out) - len(fresh)} existing)")

    # Validate: only boards with >= 1 live job.
    valid = await validate_all(fresh, workers=validate_workers)
    _log(f"VALIDATED active boards: {len(valid)}")

    by_type: Dict[str, int] = {}
    for b in valid:
        by_type[b["type"]] = by_type.get(b["type"], 0) + 1

    out_path = repo / "discovered-boards.json"
    # Merge with previous output so rotated slices don't lose boards.
    merged: Dict[str, Dict[str, str]] = {}
    if out_path.exists():
        try:
            for b in json.loads(out_path.read_text()):
                if isinstance(b, dict) and b.get("type") and b.get("token"):
                    merged[f"{b['type']}:{b['token']}"] = b
        except Exception:
            pass
    for b in valid:
        merged[f"{b['type']}:{b['token']}"] = b
    # Drop anything that has since entered the main directory.
    merged = {k: b for k, b in merged.items() if k not in existing}
    final = list(merged.values())
    out_path.write_text(json.dumps(final, indent=1))
    _log("wrote", out_path, len(final), "boards",
         f"({len(valid)} new this run)", json.dumps(by_type))

    return {"candidates": len(out), "fresh": len(fresh),
            "valid": len(valid), "total": len(final), "byType": by_type}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Career Radar board discovery")
    p.add_argument("--repo-root",
                   default=os.environ.get("REPO_ROOT") or os.getcwd(),
                   help="Repo dir (default: cwd)")
    p.add_argument("--workers", type=int,
                   default=int(os.environ.get("DISCOVER_WORKERS") or 20),
                   help="Validation workers (default 20)")
    p.add_argument("--max-repos", type=int,
                   default=int(os.environ.get("DISCOVER_MAX_REPOS") or 4),
                   help="LandedJobs repos per run (rotated; default 4)")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    summary = asyncio.run(run(Path(args.repo_root), workers=args.workers,
                              validate_workers=args.workers,
                              max_repos=args.max_repos))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
