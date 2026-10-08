"""Job aggregator fetchers: HN Who's Hiring, RemoteOK, LandedJobs.

Each fetcher returns List[Dict] with keys:
  title, company, location, url, description, salary, source, published
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List

import aiohttp

UA = {"User-Agent": "CareerRadar/1.0 (+https://github.com/kollaprudvi79-ai/company-career-job-tracker)"}

TARGET_ROLE_RE = re.compile(
    r"data\s+(scientist|engineer|analyst)|machine\s+learning|ml\s+engineer|"
    r"ai\s+engineer|artificial\s+intelligence|analytics|business\s+intelligence",
    re.IGNORECASE,
)


def _is_target_role(title: str) -> bool:
    if not title:
        return False
    return bool(TARGET_ROLE_RE.search(title))


async def fetch_hn_hiring(session: aiohttp.ClientSession) -> List[Dict[str, Any]]:
    """Hacker News 'Who's Hiring' October 2026 thread via Algolia API."""
    jobs: List[Dict[str, Any]] = []
    try:
        url = "https://hn.algolia.com/api/v1/items/49922569"
        async with session.get(url, headers=UA, timeout=aiohttp.ClientTimeout(total=30)) as r:
            if r.status != 200:
                return jobs
            data = await r.json()
        for comment in data.get("children", []):
            text = comment.get("text") or ""
            # Extract first line as title-ish, look for data roles
            first_line = text.split("<p>")[0][:200]
            clean = re.sub(r"<[^>]+>", "", first_line).strip()
            if not _is_target_role(clean):
                # Check full text for role mentions
                if not _is_target_role(text[:500]):
                    continue
            author = comment.get("author", "HN")
            jobs.append({
                "title": clean[:120] or "HN Hiring Post",
                "company": author,
                "location": "See post",
                "url": f"https://news.ycombinator.com/item?id={comment.get('id')}",
                "description": re.sub(r"<[^>]+>", "", text)[:2000],
                "salary": "",
                "source": "hn_hiring",
                "published": datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        print(f"[aggregators] hn_hiring failed: {e}")
    return jobs


async def fetch_remoteok(session: aiohttp.ClientSession) -> List[Dict[str, Any]]:
    """RemoteOK public API."""
    jobs: List[Dict[str, Any]] = []
    try:
        url = "https://remoteok.com/api"
        headers = {**UA, "Accept-Encoding": "gzip, deflate"}
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as r:
            if r.status != 200:
                return jobs
            data = await r.json(content_type=None)
        # First item is metadata, skip it
        for item in data[1:101]:
            title = item.get("position", "")
            if not _is_target_role(title):
                continue
            jobs.append({
                "title": title,
                "company": item.get("company", ""),
                "location": item.get("location", "Remote"),
                "url": item.get("url", ""),
                "description": re.sub(r"<[^>]+>", "", item.get("description", ""))[:2000],
                "salary": f"${item.get('salary_min', '')}-${item.get('salary_max', '')}" if item.get("salary_min") else "",
                "source": "remoteok",
                "published": item.get("date") or datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        print(f"[aggregators] remoteok failed: {e}")
    return jobs


LANDED_REPOS = [
    "data-scientist-jobs", "data-engineer-jobs", "ai-engineer-jobs",
    "machine-learning-engineer-jobs", "llm-engineer-jobs", "data-analyst-jobs",
    "analytics-engineer-jobs", "backend-engineer-jobs", "software-engineer-jobs",
    "fullstack-engineer-jobs", "devops-engineer-jobs", "frontend-engineer-jobs",
    "product-manager-jobs", "data-architect-jobs", "bi-analyst-jobs",
    "research-scientist-jobs",
]


async def _fetch_landed_repo(session: aiohttp.ClientSession, repo: str) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    try:
        url = f"https://raw.githubusercontent.com/landedjobs/{repo}/main/jobs.json"
        headers = {**UA, "Accept-Encoding": "gzip, deflate"}
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as r:
            if r.status != 200:
                return jobs
            data = await r.json(content_type=None)
        items = data if isinstance(data, list) else data.get("jobs", [])
        for item in items:
            # LandedJobs uses 'role' field, not 'title'
            title = item.get("role") or item.get("title", "")
            if not _is_target_role(title):
                continue
            jobs.append({
                "title": title,
                "company": item.get("company", ""),
                "location": item.get("location", ""),
                "url": item.get("applyUrl") or item.get("url", ""),
                "description": item.get("description", "")[:2000],
                "salary": item.get("salary", ""),
                "source": "landedjobs",
                "published": item.get("datePosted") or datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        print(f"[aggregators] landedjobs/{repo} failed: {e}")
    return jobs


async def fetch_landedjobs(session: aiohttp.ClientSession) -> List[Dict[str, Any]]:
    """All LandedJobs repos concurrently."""
    results = await asyncio.gather(
        *[_fetch_landed_repo(session, repo) for repo in LANDED_REPOS],
        return_exceptions=True,
    )
    jobs: List[Dict[str, Any]] = []
    for r in results:
        if isinstance(r, list):
            jobs.extend(r)
    return jobs


async def fetch_all_aggregators(session: aiohttp.ClientSession | None = None) -> List[Dict[str, Any]]:
    """Run all aggregator fetchers concurrently, deduplicate by URL."""
    close_session = False
    if session is None:
        session = aiohttp.ClientSession(trust_env=True)
        close_session = True
    try:
        results = await asyncio.gather(
            fetch_hn_hiring(session),
            fetch_remoteok(session),
            fetch_landedjobs(session),
            return_exceptions=True,
        )
        jobs: List[Dict[str, Any]] = []
        seen_urls: set = set()
        for r in results:
            if isinstance(r, list):
                for j in r:
                    url = j.get("url", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        jobs.append(j)
                    elif not url:
                        jobs.append(j)
        return jobs
    finally:
        if close_session:
            await session.close()
