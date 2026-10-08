"""Async fetchers for the standard ATS platforms.

Each fetcher is ``async def fetch_<type>(session, board) -> list[raw]`` and
raises on failure (the collector wraps every board in try/except).
Normalization converts raw payloads into :class:`Job` via models.enrich_job.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urlparse

import aiohttp

from .models import (Board, Job, classify, decode_entities, enrich_job,
                     iso_date, now_iso, strip_html)
from .scoring import weighted_fit_score

UA = "Mozilla/5.0 (compatible; CareerRadar/1.0)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/36")

JSON_HEADERS = {"accept": "application/json", "user-agent": UA}
HTML_HEADERS = {"accept": "text/html", "user-agent": BROWSER_UA}


def safe_url(url: Any) -> Optional[str]:
    try:
        u = urlparse(str(url))
        return str(url) if u.scheme == "https" else None
    except Exception:
        return None


def board_url(board: Board) -> Optional[str]:
    t, tok = board.type, board.token
    slug = quote(str(tok))
    if t == "workday":
        return f"https://{tok}"
    if t == "icims":
        return f"https://{tok}/"
    if t == "oracle":
        parts = str(tok).split("/")
        return f"https://{parts[0]}/hcmUI/CandidateExperience/en/sites/{parts[1]}" if len(parts) > 1 else None
    if t == "greenhouse":
        return f"https://job-boards.greenhouse.io/{slug}"
    if t == "lever":
        return f"https://jobs.lever.co/{slug}"
    if t == "ashby":
        return f"https://jobs.ashbyhq.com/{slug}"
    if t == "smartrecruiters":
        return f"https://jobs.smartrecruiters.com/{slug}"
    if t == "workable":
        return f"https://apply.workable.com/{slug}"
    if t == "recruitee":
        return f"https://{slug}.recruitee.com/"
    if t == "breezy":
        return f"https://{slug}.breezy.hr/"
    if t == "bamboohr":
        return f"https://{slug}.bamboohr.com/careers/"
    if t == "teamtailor":
        return f"https://{slug}.teamtailor.com/"
    if t == "personio":
        return f"https://{slug}.jobs.personio.com/"
    if t == "pinpoint":
        return f"https://{slug}.pinpointhq.com/"
    if t == "rippling":
        return f"https://ats.rippling.com/{slug}/jobs"
    if t == "jazzhr":
        return f"https://{slug}.applytojob.com/apply"
    if t == "jobvite":
        return f"https://jobs.jobvite.com/{slug}"
    return None


def list_from(data: Any) -> Optional[List]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("items"), list) and data["items"] and isinstance(data["items"][0], dict) and "requisitionList" in data["items"][0]:
        return data["items"][0]["requisitionList"]
    for key in ("data", "jobs", "content", "offers", "results", "result",
                "items", "jobPostings"):
        if isinstance(data.get(key), list):
            return data[key]
    return None


async def _get_json(session: aiohttp.ClientSession, url: str, **kw) -> Any:
    async with session.get(url, headers=JSON_HEADERS, **kw) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        return await r.json()


async def _get_html(session: aiohttp.ClientSession, url: str, **kw) -> str:
    async with session.get(url, headers=HTML_HEADERS, **kw) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        return await r.text()


# ---------------------------------------------------------------------------
# HTML board parsing (jazzhr / icims / jobvite)
# ---------------------------------------------------------------------------

def location_near(html: str, from_idx: int) -> str:
    window = strip_html(html[from_idx:from_idx + 600])
    m = re.search(r"\b(Remote(?:\s*[-,]\s*[A-Z]{2})?|[A-Z][A-Za-z .]{1,40},\s*[A-Z]{2}\b|US-[A-Z]{2}-[A-Za-z .]{2,30})", window)
    return m.group(1).strip() if m else "Not listed"


def parse_html_jobs(board: Board, html: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()

    def push(title: str, url: str, location: Optional[str]):
        title = strip_html(title)
        if not title or not (3 <= len(title) <= 140):
            return
        if re.match(r"^(apply|apply now|view|view job|learn more|back|home|skip)", title, re.I):
            return
        if url in seen:
            return
        seen.add(url)
        out.append({"title": title, "url": url, "location": location or "Not listed"})

    if board.type == "jazzhr":
        for m in re.finditer(
                r'<a\s[^>]*href="((?:https:\/\/[a-z0-9-]+\.applytojob\.com)?\/apply\/[A-Za-z0-9]+[^"]*)"[^>]*>([\s\S]*?)<\/a>',
                html, re.I):
            raw = m.group(1)
            url = raw if raw.startswith("http") else f"https://{board.token}.applytojob.com{raw}"
            push(m.group(2), url.split("?")[0], location_near(html, m.end()))
    elif board.type == "icims":
        for m in re.finditer(
                r'<a\s[^>]*href="(https:\/\/[a-z0-9.-]+\.icims\.com\/jobs\/\d+\/[^"]*?\/job[^"]*)"[^>]*>([\s\S]*?)<\/a>',
                html, re.I):
            push(m.group(2), m.group(1).split("?")[0], location_near(html, m.end()))
    elif board.type == "jobvite":
        for m in re.finditer(r'<a\s[^>]*href="(\/[a-z0-9-]+\/job\/[A-Za-z0-9]+)"[^>]*>([\s\S]*?)<\/a>', html, re.I):
            anchor = m.group(2)
            in_anchor = re.search(r"jv-job-location[^>]*>([^<]+)", anchor, re.I)
            if in_anchor:
                title_html = re.sub(r"<[^>]*jv-job-location[^>]*>[^<]*<\/?[a-z]+>", " ", anchor, flags=re.I)
                loc = strip_html(in_anchor.group(1))
            else:
                after = html[m.end():m.end() + 600]
                after_m = re.search(r"jv-job-location[^>]*>([^<]+)", after, re.I)
                title_html = anchor
                loc = strip_html(after_m.group(1)) if after_m else location_near(html, m.end())
            push(title_html, f"https://jobs.jobvite.com{m.group(1)}", loc)
    return out


# ---------------------------------------------------------------------------
# Per-ATS fetchers (JSON)
# ---------------------------------------------------------------------------

async def fetch_greenhouse(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
    return list_from(data) or []


async def fetch_ashby(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
    return list_from(data) or []


async def fetch_lever(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://api.lever.co/v0/postings/{slug}?mode=json")
    return list_from(data) or []


async def fetch_smartrecruiters(session, board):
    slug = quote(str(board.token))
    out, offset, total = [], 0, float("inf")
    while offset < total and offset < 300:
        data = await _get_json(
            session,
            f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset={offset}")
        items = list_from(data) or []
        total = float(data.get("totalFound") or 0) if isinstance(data, dict) else 0
        out.extend(items)
        if len(items) < 100:
            break
        offset += 100
    return out


async def fetch_workable(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://apply.workable.com/api/v1/widget/accounts/{slug}")
    return list_from(data) or []


async def fetch_recruitee(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.recruitee.com/api/offers/")
    return list_from(data) or []


async def fetch_breezy(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.breezy.hr/json")
    return list_from(data) or []


async def fetch_bamboohr(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.bamboohr.com/careers/list")
    return list_from(data) or []


async def fetch_teamtailor(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.teamtailor.com/jobs.json")
    return list_from(data) or []


async def fetch_personio(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.jobs.personio.com/search.json")
    return list_from(data) or []


async def fetch_pinpoint(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://{slug}.pinpointhq.com/postings.json")
    return list_from(data) or []


async def fetch_rippling(session, board):
    slug = quote(str(board.token))
    data = await _get_json(session, f"https://ats.rippling.com/api/v1/board/{slug}/jobs")
    return list_from(data) or []


async def fetch_oracle(session, board):
    parts = str(board.token).split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise RuntimeError("Invalid Oracle board reference")
    host, site = parts[0], quote(parts[1])
    out, offset = [], 0
    while offset < 150:
        data = await _get_json(
            session,
            f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
            f"?onlyData=true&expand=requisitionList.workLocation,requisitionList.secondaryLocations"
            f"&finder=findReqs;siteNumber={site},sortBy=POSTING_DATES_DESC&limit=25&offset={offset}")
        items = list_from(data) or []
        if not items:
            break
        out.extend(items)
        if len(items) < 25:
            break
        offset += 25
    return out


async def fetch_workday(session, board):
    parts = str(board.token).split("/")
    if len(parts) < 3 or not all(parts[:3]):
        raise RuntimeError("Invalid Workday board reference")
    host, tenant, site = parts[0], parts[1], parts[2]
    url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    headers = {**JSON_HEADERS, "content-type": "application/json"}

    async def wd_search(term: str, max_pages: int):
        out = []
        for pg in range(max_pages):
            async with session.post(url, headers=headers, json={
                    "appliedFacets": {}, "limit": 20,
                    "offset": pg * 20, "searchText": term}) as r:
                if r.status != 200:
                    break
                d = await r.json()
            items = list_from(d) or []
            if not items:
                break
            out.extend(items)
            try:
                if len(out) >= int(d.get("total") or 0):
                    break
            except (TypeError, ValueError):
                pass
        return out

    # Targeted searches catch data roles that blind pagination misses.
    seen, out = set(), []
    for job in await wd_search("data", 5) + await wd_search(".net", 2):
        key = ((job.get("bulletFields") or [None])[0]
               or job.get("externalPath") or job.get("title"))
        if key and key not in seen:
            seen.add(key)
            out.append(job)
    return out


async def fetch_html_board(session, board):
    t = board.type
    if t == "jazzhr":
        html = await _get_html(session, f"https://{quote(str(board.token))}.applytojob.com/apply")
        return parse_html_jobs(board, html)
    if t == "jobvite":
        html = await _get_html(session, f"https://jobs.jobvite.com/{quote(str(board.token))}/jobs")
        return parse_html_jobs(board, html)
    if t == "icims":
        out: List[Dict] = []
        for ss in range(1, 202, 50):
            html = await _get_html(session, f"https://{board.token}/jobs/search?ss={ss}&in_iframe=1")
            items = parse_html_jobs(board, html)
            if not items:
                break
            known = {j["url"] for j in out}
            fresh = [j for j in items if j["url"] and j["url"] not in known]
            if not fresh and ss > 1:
                break
            out.extend(fresh)
            if len(items) < 40:
                break
        return out
    raise RuntimeError("Unsupported HTML ATS")


FETCHERS = {
    "greenhouse": fetch_greenhouse, "ashby": fetch_ashby, "lever": fetch_lever,
    "smartrecruiters": fetch_smartrecruiters, "workable": fetch_workable,
    "recruitee": fetch_recruitee, "breezy": fetch_breezy, "bamboohr": fetch_bamboohr,
    "teamtailor": fetch_teamtailor, "personio": fetch_personio,
    "pinpoint": fetch_pinpoint, "rippling": fetch_rippling,
    "oracle": fetch_oracle, "workday": fetch_workday,
    "jazzhr": fetch_html_board, "jobvite": fetch_html_board, "icims": fetch_html_board,
}

HTML_TYPES = {"jazzhr", "jobvite", "icims"}


# ---------------------------------------------------------------------------
# Normalization: raw payload -> (base dict, description, salary text)
# ---------------------------------------------------------------------------

def _norm_greenhouse(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("content") or ""
    loc = (j.get("location") or {}).get("name") if isinstance(j.get("location"), dict) else None
    return {"id": f"greenhouse:{tok}:{j.get('id') or j.get('absolute_url')}",
            "company": b.company, "source": "greenhouse", "title": title,
            "role": classify(title, desc), "location": loc or "Not listed",
            "workplace": None, "salary": None,
            "published": iso_date(j.get("first_published")),
            "publishedMeaning": "Original first publication from Greenhouse first_published",
            "applyUrl": safe_url(j.get("absolute_url"))}, desc, ""


def _norm_ashby(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("descriptionPlain") or j.get("descriptionHtml") or ""
    comp = (j.get("compensation") or {})
    salary_text = comp.get("scrapeableCompensationSalarySummary") or ""
    loc = j.get("locationName") or j.get("location")
    if isinstance(loc, dict):
        loc = loc.get("name")
    return {"id": f"ashby:{tok}:{j.get('id') or j.get('jobUrl') or j.get('applyUrl')}",
            "company": b.company, "source": "ashby", "title": title,
            "role": classify(title, desc), "location": loc or "Not listed",
            "workplace": j.get("workplaceType"), "isRemote": j.get("isRemote"),
            "salary": salary_text or None,
            "published": iso_date(j.get("publishedAt")),
            "publishedMeaning": "Ashby publishedAt; may be a republication",
            "applyUrl": safe_url(j.get("applyUrl") or j.get("jobUrl"))}, desc, salary_text


def _norm_lever(j, b, tok):
    title = j.get("text") or ""
    desc = j.get("descriptionPlain") or j.get("description") or ""
    sr = j.get("salaryRange") or {}
    salary_text = f"{sr.get('min')}–{sr.get('max')} {sr.get('currency') or ''}".strip("– ") if sr.get("min") else ""
    cats = j.get("categories") or {}
    locs = cats.get("allLocations") or []
    location = "; ".join(locs) if locs else cats.get("location")
    return {"id": f"lever:{tok}:{j.get('id') or j.get('hostedUrl')}",
            "company": b.company, "source": "lever", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": j.get("workplaceType"), "salary": salary_text or None,
            "published": iso_date(j.get("createdAt")),
            "publishedMeaning": "Original creation timestamp from Lever createdAt",
            "applyUrl": safe_url(j.get("applyUrl") or j.get("hostedUrl"))}, desc, salary_text


def _norm_smartrecruiters(j, b, tok):
    title = j.get("name") or ""
    sections = ((j.get("jobAd") or {}).get("sections")) or {}
    desc = ((sections.get("jobDescription") or {}).get("text") or ""
            + " " + (sections.get("qualifications") or {}).get("text") or "")
    loc = j.get("location") or {}
    location = ", ".join(x for x in [loc.get("city"), loc.get("region"), loc.get("country")] if x)
    return {"id": f"smartrecruiters:{tok}:{j.get('id')}",
            "company": b.company, "source": "smartrecruiters", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": "remote" if loc.get("remote") else None,
            "isRemote": bool(loc.get("remote")), "salary": None,
            "published": iso_date(j.get("releasedDate") or j.get("createdOn") or j.get("postingDate")),
            "publishedMeaning": "SmartRecruiters posting release/creation timestamp",
            "applyUrl": safe_url(f"https://jobs.smartrecruiters.com/{quote(str(tok))}/{quote(str(j.get('id') or ''))}")}, desc, ""


def _norm_workable(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("description") or j.get("description_html") or ""
    loc = j.get("location")
    if isinstance(loc, dict):
        location = ", ".join(x for x in [loc.get("city"), loc.get("region"), loc.get("country")] if x)
    elif isinstance(loc, str):
        location = loc
    else:
        location = ", ".join(x for x in [j.get("city"), j.get("state"), j.get("country")] if x)
    remote = j.get("telecommuting") or j.get("remote")
    return {"id": f"workable:{tok}:{j.get('shortcode') or j.get('id') or j.get('url')}",
            "company": b.company, "source": "workable", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": j.get("workplace") or ("remote" if remote else None),
            "isRemote": bool(remote), "salary": None,
            "published": iso_date(j.get("published_at") or j.get("published_on") or j.get("created_at")),
            "publishedMeaning": "Workable publication timestamp when supplied",
            "applyUrl": safe_url(j.get("application_url") or j.get("url") or j.get("shortlink"))}, desc, ""


def _norm_recruitee(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("description") or ""
    loc = j.get("location")
    if isinstance(loc, dict):
        location = ", ".join(x for x in [loc.get("city"), loc.get("state"), loc.get("country")] if x)
    else:
        location = loc or ", ".join(x for x in [j.get("city"), j.get("state"), j.get("country")] if x)
    return {"id": f"recruitee:{tok}:{j.get('id') or j.get('careers_url')}",
            "company": b.company, "source": "recruitee", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": "remote" if j.get("remote") else None,
            "isRemote": bool(j.get("remote")), "salary": None,
            "published": iso_date(j.get("published_at") or j.get("created_at")),
            "publishedMeaning": "Recruitee publication timestamp when supplied",
            "applyUrl": safe_url(j.get("careers_apply_url") or j.get("careers_url") or j.get("apply_url"))}, desc, ""


def _norm_breezy(j, b, tok):
    title = j.get("name") or j.get("title") or ""
    desc = j.get("description") or ""
    loc = j.get("location")
    location = loc if isinstance(loc, str) else ((loc or {}).get("name") if isinstance(loc, dict) else None)
    remote = (loc or {}).get("is_remote") if isinstance(loc, dict) else False
    return {"id": f"breezy:{tok}:{j.get('id') or j.get('url')}",
            "company": b.company, "source": "breezy", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": "remote" if remote else None, "isRemote": bool(remote),
            "salary": None,
            "published": iso_date(j.get("published_date") or j.get("published_at")),
            "publishedMeaning": "Breezy publication timestamp when supplied",
            "applyUrl": safe_url(j.get("apply_url") or j.get("url"))}, desc, ""


def _norm_bamboohr(j, b, tok):
    title = j.get("jobOpeningName") or j.get("title") or ""
    desc = j.get("description") or ""
    return {"id": f"bamboohr:{tok}:{j.get('id') or j.get('jobOpeningUrl')}",
            "company": b.company, "source": "bamboohr", "title": title,
            "role": classify(title, desc),
            "location": j.get("locationName") or j.get("location") or "Not listed",
            "workplace": None, "salary": None,
            "published": iso_date(j.get("datePosted") or j.get("createdDate")),
            "publishedMeaning": "BambooHR posting date when supplied",
            "applyUrl": safe_url(j.get("jobOpeningUrl") or j.get("url"))}, desc, ""


def _norm_teamtailor(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("content_html") or ""
    return {"id": f"teamtailor:{tok}:{j.get('id') or j.get('url')}",
            "company": b.company, "source": "teamtailor", "title": title,
            "role": classify(title, desc), "location": "Not listed",
            "workplace": None, "salary": None,
            "published": iso_date(j.get("date_published")),
            "publishedMeaning": "Teamtailor publication timestamp",
            "applyUrl": safe_url(j.get("url"))}, desc, ""


def _norm_personio(j, b, tok):
    title = j.get("name") or ""
    desc = j.get("description") or ""
    offices = j.get("offices") or []
    location = "; ".join(offices) if offices else j.get("office")
    return {"id": f"personio:{tok}:{j.get('id')}",
            "company": b.company, "source": "personio", "title": title,
            "role": classify(title, desc), "location": location or "Not listed",
            "workplace": None, "salary": None, "published": None,
            "publishedMeaning": "Personio search feed does not expose a publication date",
            "applyUrl": safe_url(f"https://{tok}.jobs.personio.com/job/{quote(str(j.get('id') or ''))}")}, desc, ""


def _norm_workday(j, b, tok):
    title = j.get("title") or ""
    host = str(tok).split("/")[0]
    posted = str(j.get("postedOn") or "")
    published = None
    now_ts = datetime.now(timezone.utc).timestamp()
    if re.search(r"today", posted, re.I):
        published = now_iso()
    elif re.search(r"yesterday", posted, re.I):
        published = datetime.fromtimestamp(now_ts - 86400, tz=timezone.utc).isoformat()
    else:
        m = re.search(r"(\d+)\+?\s*days?", posted, re.I)
        if m:
            days = int(m.group(1))
            published = datetime.fromtimestamp(now_ts - days * 86400, tz=timezone.utc).isoformat()
    parts = str(tok).split("/")
    site = parts[2] if len(parts) > 2 else ""
    return {"id": f"workday:{tok}:{((j.get('bulletFields') or [None])[0]) or j.get('externalPath') or title}",
            "company": b.company, "source": "workday", "title": title,
            "role": classify(title, ""), "location": j.get("locationsText") or "Not listed",
            "workplace": None, "salary": None, "published": published,
            "publishedMeaning": "Workday relative posting label converted to an approximate date",
            "applyUrl": safe_url(f"https://{host}/{site}{j.get('externalPath') or ''}")}, "", ""


def _norm_pinpoint(j, b, tok):
    title = j.get("title") or ""
    desc = j.get("description") or ""
    loc = j.get("location") or {}
    location = (loc.get("name")
                or ", ".join(x for x in [loc.get("city"), loc.get("province")] if x)
                or "Not listed")
    return {"id": f"pinpoint:{tok}:{j.get('id') or j.get('url')}",
            "company": b.company, "source": "pinpoint", "title": title,
            "role": classify(title, desc), "location": location,
            "workplace": j.get("workplace_type"),
            "salary": j.get("compensation") if j.get("compensation_visible") else None,
            "published": None,
            "publishedMeaning": "Pinpoint feed does not expose a publication date",
            "applyUrl": safe_url(j.get("url"))}, desc, ""


def _norm_rippling(j, b, tok):
    title = j.get("name") or ""
    wl = (j.get("workLocation") or {})
    return {"id": f"rippling:{tok}:{j.get('uuid') or j.get('url')}",
            "company": b.company, "source": "rippling", "title": title,
            "role": classify(title, ""), "location": wl.get("label") or "Not listed",
            "workplace": None, "salary": None, "published": None,
            "publishedMeaning": "Rippling board feed does not expose a publication date",
            "applyUrl": safe_url(j.get("url"))}, "", ""


def _norm_oracle(j, b, tok):
    title = j.get("Title") or ""
    if j.get("Language") and not re.match(r"^(us|en)", str(j.get("Language")), re.I):
        return None
    desc = "\n".join(x for x in [j.get("ShortDescriptionStr"),
                                 j.get("ExternalResponsibilitiesStr"),
                                 j.get("ExternalQualificationsStr")] if x)
    parts = str(tok).split("/")
    host, site = parts[0], parts[1] if len(parts) > 1 else ""
    wp_code = str(j.get("WorkplaceTypeCode") or j.get("WorkplaceType") or "")
    if re.search(r"remote", wp_code, re.I):
        workplace = "remote"
    elif re.search(r"hybrid", wp_code, re.I):
        workplace = "hybrid"
    elif re.search(r"onsite|on-site", wp_code, re.I):
        workplace = "onsite"
    else:
        workplace = None
    return {"id": f"oracle:{tok}:{j.get('Id') or title}",
            "company": b.company, "source": "oracle", "title": title,
            "role": classify(title, desc), "location": j.get("PrimaryLocation") or "Not listed",
            "workplace": workplace, "salary": None,
            "published": iso_date(j.get("PostedDate")),
            "publishedMeaning": "Oracle Recruiting PostedDate",
            "applyUrl": safe_url(f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{quote(str(j.get('Id') or ''))}")}, desc, ""


def _norm_html(j, b, tok):
    t = b.type
    meaning = {"jazzhr": "JazzHR board page does not expose a publication date in list view",
               "icims": "iCIMS board page does not expose a publication date in list view",
               "jobvite": "Jobvite board page does not expose a publication date in list view"}[t]
    title = j.get("title") or ""
    return {"id": f"{t}:{tok}:{j.get('url')}",
            "company": b.company, "source": t, "title": title,
            "role": classify(title, ""), "location": j.get("location") or "Not listed",
            "workplace": None, "salary": None, "published": None,
            "publishedMeaning": meaning, "applyUrl": safe_url(j.get("url"))}, "", ""


NORMALIZERS = {
    "greenhouse": _norm_greenhouse, "ashby": _norm_ashby, "lever": _norm_lever,
    "smartrecruiters": _norm_smartrecruiters, "workable": _norm_workable,
    "recruitee": _norm_recruitee, "breezy": _norm_breezy, "bamboohr": _norm_bamboohr,
    "teamtailor": _norm_teamtailor, "personio": _norm_personio,
    "workday": _norm_workday, "pinpoint": _norm_pinpoint, "rippling": _norm_rippling,
    "oracle": _norm_oracle,
    "jazzhr": _norm_html, "icims": _norm_html, "jobvite": _norm_html,
}


def normalize(board: Board, raw: Dict[str, Any], checked: str,
              applied_check=None) -> Optional[Job]:
    """Normalize one raw payload into a Job (or None to skip)."""
    fn = NORMALIZERS.get(board.type)
    if not fn:
        return None
    try:
        res = fn(raw, board, board.token)
    except Exception:
        return None
    if res is None:
        return None
    base, description, salary_text = res
    if not base or not base.get("role") or not base.get("applyUrl"):
        return None
    base["checked"] = checked
    base["boardKey"] = board.key
    job = enrich_job(base, description, salary_text,
                     applied_check=applied_check)
    job.fitScore = weighted_fit_score(job, description)
    return job
