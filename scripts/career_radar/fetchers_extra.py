"""Async fetchers for extra ATS platforms (multi-step / embedded-JSON flows).

Port of ats-extra.mjs. Platforms: hireology, adp, dover, ukg,
successfactors, brassring, phenom, paylocity, zoho, careerplug.

Cookie-sensitive flows (brassring, successfactors) use a dedicated
per-board ClientSession so cookies stay isolated between boards.
Dayforce is intentionally NOT implemented (Cloudflare-blocked).
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import aiohttp

from .models import Board, Job, classify, decode_entities, enrich_job, iso_date, strip_html
from .fetchers import safe_url
from .scoring import weighted_fit_score

EXTRA_TYPES = frozenset([
    "hireology", "adp", "dover", "ukg", "successfactors",
    "brassring", "phenom", "paylocity", "zoho", "careerplug",
])

UA = "Mozilla/5.0 (compatible; CareerRadar/1.0)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/36")


def is_extra_type(t: str) -> bool:
    return t in EXTRA_TYPES


def extra_board_url(board: Board) -> Optional[str]:
    tok = str(board.token or "")
    t = board.type
    if t == "hireology":
        return f"https://careers.hireology.com/{quote(tok)}"
    if t == "adp":
        parts = tok.split("/")
        return (f"https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"
                f"?cid={quote(parts[0] if len(parts) > 0 else '')}"
                f"&ccId={quote(parts[1] if len(parts) > 1 else '')}&lang=en_US")
    if t == "dover":
        return f"https://app.dover.com/careers/{quote(tok)}"
    if t == "ukg":
        parts = tok.split("/")
        return f"https://{parts[0]}/{parts[1]}/JobBoard/{quote(parts[2] if len(parts) > 2 else '')}/" if len(parts) >= 2 else None
    if t == "successfactors":
        return f"{tok.rstrip('/')}/search/"
    if t == "brassring":
        parts = tok.split("/")
        return (f"https://sjobs.brassring.com/TGnewUI/Search/Home/Home"
                f"?partnerid={quote(parts[0] if parts else '')}"
                f"&siteid={quote(parts[1] if len(parts) > 1 else '')}")
    if t == "phenom":
        base = tok.rstrip("/")
        return f"https://{base}" if "/" in base else f"https://{base}/search-results"
    if t == "paylocity":
        return f"https://recruiting.paylocity.com/recruiting/jobs/All/{quote(tok)}"
    if t == "zoho":
        parts = tok.split("/")
        tld = parts[1] if len(parts) > 1 else "com"
        return f"https://{parts[0]}.zohorecruit.{tld}/jobs/Careers"
    if t == "careerplug":
        return f"https://{quote(tok)}.careerplug.com/jobs"
    return None


# ---------------------------------------------------------------------------
# JSON extraction helpers (quote-aware brace matcher)
# ---------------------------------------------------------------------------

def brace_match(text: str, start: int):
    open_c = text[start]
    close_c = {"{": "}", "[": "]"}.get(open_c)
    if not close_c:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == open_c:
                depth += 1
            elif c == close_c:
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
    return None


def extract_json_after(html: str, key_idx: int):
    bi = html.find("{", key_idx)
    if bi < 0:
        return None
    return brace_match(html, bi)


# ---------------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------------

async def _fetch_hireology(session, board):
    slug = quote(str(board.token).strip())
    out = []
    for page in range(1, 41):
        async with session.get(
                f"https://api.hireology.com/v2/public/careers/{slug}?page={page}&page_size=50",
                headers={"accept": "application/json", "user-agent": UA}) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            d = await r.json()
        items = d.get("data") if isinstance(d, dict) and isinstance(d.get("data"), list) else []
        out.extend(j for j in items if str(j.get("status") or "").lower() == "open")
        count = int(d.get("count") or 0) if isinstance(d, dict) else 0
        if page * 50 >= count or not items:
            break
    return out


async def _fetch_adp(session, board):
    parts = str(board.token).split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise RuntimeError("Invalid ADP token (want cid/ccId)")
    cid, cc_id = parts[0], parts[1]
    base = ("https://workforcenow.adp.com/mascsr/default/careercenter/public/"
            "events/staffing/v1/job-requisitions")
    q = f"cid={quote(cid)}&ccId={quote(cc_id)}&lang=en_US&locale=en_US"
    out, total, skip = [], float("inf"), 0
    while skip < total and skip <= 2000:
        async with session.get(f"{base}?{q}&$top=20&$skip={skip}",
                               headers={"accept": "application/json", "user-agent": UA}) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            d = await r.json()
        total = float((d.get("meta") or {}).get("totalNumber") or 0)
        items = d.get("jobRequisitions") if isinstance(d.get("jobRequisitions"), list) else []
        if not items:
            break
        out.extend(items)
        skip += 20
    # Detail descriptions only for title-matched roles (bounded).
    detailed = 0
    for j in out:
        if detailed >= 25:
            break
        if not classify(j.get("requisitionTitle") or "", ""):
            continue
        try:
            async with session.get(
                    f"{base}/{quote(str(j.get('itemID')))}?{q}",
                    headers={"accept": "application/json", "user-agent": UA}) as dr:
                if dr.status != 200:
                    continue
                dd = await dr.json()
            if dd.get("requisitionDescription"):
                j["requisitionDescription"] = dd["requisitionDescription"]
                detailed += 1
        except Exception:
            pass
    for j in out:
        j["_cid"], j["_ccId"] = cid, cc_id
    return out


async def _fetch_dover(session, board):
    client_id = quote(str(board.token).strip())
    out, offset = [], 0
    while offset <= 3000:
        async with session.get(
                f"https://app.dover.com/api/v1/careers-page/{client_id}/jobs?limit=300&offset={offset}",
                headers={"accept": "application/json", "user-agent": UA}) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            d = await r.json()
        items = d.get("results") if isinstance(d.get("results"), list) else []
        out.extend(j for j in items
                   if j.get("is_published") is not False and j.get("is_sample") is not True)
        if not d.get("next") or not items:
            break
        offset += 300
    return out


async def _fetch_ukg(session, board):
    parts = str(board.token).split("/")
    if len(parts) < 3 or not all(parts[:3]):
        raise RuntimeError("Invalid UKG token (want host/tenant/guid)")
    host, tenant, guid = parts[0], parts[1], parts[2]
    url = f"https://{host}/{tenant}/JobBoard/{quote(guid)}/JobBoardView/LoadSearchResults"
    out, total, skip = [], float("inf"), 0
    while skip < total and skip <= 2000:
        async with session.post(url, json={"opportunitySearch": {"Top": 50, "Skip": skip}},
                                headers={"content-type": "application/json",
                                         "accept": "application/json",
                                         "user-agent": UA}) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            d = await r.json()
        total = float(d.get("totalCount") or 0)
        items = d.get("opportunities") if isinstance(d.get("opportunities"), list) else []
        if not items:
            break
        out.extend(items)
        skip += 50
    return out


async def _fetch_successfactors(session, board):
    # Dedicated session: CSRF + cookies must stay isolated per board.
    origin = str(board.token).rstrip("/")
    if not re.match(r"^https://[^/]+$", origin):
        raise RuntimeError("Invalid SuccessFactors token (want origin URL)")
    async with aiohttp.ClientSession(headers={"user-agent": BROWSER_UA}) as s:
        async with s.get(f"{origin}/search/", headers={"accept": "text/html"}) as sr:
            if sr.status != 200:
                raise RuntimeError(f"HTTP {sr.status}")
            shtml = await sr.text()
            cookies = "; ".join(f"{k}={v.value}" for k, v in sr.cookies.items())
        locales = {"en_GB"}
        locales.update(m.group(1) for m in re.finditer(r"[?&]locale=([a-z]{2}_[A-Z]{2})", shtml, re.I))
        locales.update(m.group(1) for m in re.finditer(r"['\"]locale['\"]\s*[:=]\s*['\"]([a-z]{2}_[A-Z]{2})['\"]", shtml, re.I))
        cm = re.search(r'"CSRFToken"\s*:\s*"([^"]+)"|name="CSRFToken"[^>]*value="([^"]+)"', shtml)
        csrf = (cm.group(1) or cm.group(2)) if cm else None
        headers = {"content-type": "application/json", "accept": "application/json",
                   "user-agent": BROWSER_UA, "referer": f"{origin}/search/"}
        if cookies:
            headers["cookie"] = cookies
        if csrf:
            headers["x-csrf-token"] = csrf
        seen, out, first = set(), [], True
        for locale in list(locales)[:8]:
            total, empty_streak = float("inf"), 0
            page = 0
            while page * 10 < total and page < 100:
                async with s.post(f"{origin}/services/recruiting/v1/jobs", headers=headers,
                                  json={"keywords": "", "locale": locale, "location": "",
                                        "pageNumber": page, "sortBy": "recent"}) as r:
                    if r.status == 401:
                        if first:
                            raise RuntimeError("HTTP 401 (non-CSB tenant)")
                        break
                    if r.status != 200:
                        raise RuntimeError(f"HTTP {r.status}")
                    first = False
                    d = await r.json()
                t = float(d.get("totalJobs") or 0)
                if t > 0:
                    total = t
                items = d.get("jobSearchResult") if isinstance(d.get("jobSearchResult"), list) else []
                if not items:
                    empty_streak += 1
                    if empty_streak >= 2:
                        break
                    page += 1
                    continue
                empty_streak = 0
                for w in items:
                    j = w.get("response") or w
                    jid = str(j.get("id") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    j["_locale"], j["_origin"] = locale, origin
                    out.append(j)
                page += 1
    return out


def _br_question(j, names):
    qs = j.get("Questions")
    if not isinstance(qs, list):
        return ""
    want = {n.lower() for n in names}
    for q in qs:
        if str(q.get("QuestionName") or "").lower() in want:
            v = str(q.get("Value") or "").strip()
            if v:
                return v
    return ""


async def _fetch_brassring(session, board):
    parts = str(board.token).split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise RuntimeError("Invalid BrassRing token (want partnerid/siteid)")
    partnerid, siteid = parts[0], parts[1]
    home_url = (f"https://sjobs.brassring.com/TGnewUI/Search/Home/Home"
                f"?partnerid={quote(partnerid)}&siteid={quote(siteid)}")
    # Dedicated session: anti-forgery token + cookies are per-board state.
    async with aiohttp.ClientSession(headers={"user-agent": BROWSER_UA}) as s:
        async with s.get(home_url, headers={"accept": "text/html"}) as hr:
            if hr.status != 200:
                raise RuntimeError(f"HTTP {hr.status}")
            hhtml = await hr.text()
            cookies = "; ".join(f"{k}={v.value}" for k, v in hr.cookies.items())
        tm = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', hhtml)
        if not tm:
            raise RuntimeError("No anti-forgery token on BrassRing home page")
        headers = {"user-agent": BROWSER_UA, "accept": "application/json",
                   "content-type": "application/json",
                   "X-Requested-With": "XMLHttpRequest", "RFT": tm.group(1),
                   "Referer": home_url}
        if cookies:
            headers["cookie"] = cookies
        seen, out = set(), []

        def push_jobs(jobs):
            for j in jobs or []:
                reqid = _br_question(j, ["reqid", "jobreqid", "requisitionid", "jobid"])
                key = f"{partnerid}:{reqid}"
                if not reqid or key in seen:
                    continue
                seen.add(key)
                j["_partnerid"], j["_siteid"] = partnerid, siteid
                out.append(j)

        async with s.post("https://sjobs.brassring.com/TgNewUI/Search/Ajax/MatchedJobs",
                          headers=headers,
                          json={"PartnerId": partnerid, "SiteId": siteid, "Keyword": "",
                                "Location": "", "KeywordCustomSolrFields": "JobTitle,Location",
                                "LocationCustomSolrFields": "Location", "FacetFilterFields": None,
                                "TurnOffHttps": False, "Latitude": 0, "Longitude": 0,
                                "PowerSearchOptions": {"PowerSearchOption": []},
                                "encryptedsessionvalue": ""}) as r1:
            if r1.status != 200:
                raise RuntimeError(f"HTTP {r1.status}")
            d1 = await r1.json()
        push_jobs((d1.get("Jobs") or {}).get("Job"))
        total = int(d1.get("JobsCount") or 0)
        for sort_field, sort_order in (("lastupdated", "desc"), ("title", "asc")):
            for page_number in range(2, 31):
                if (page_number - 1) * 50 >= total:
                    break
                try:
                    async with s.post(
                            "https://sjobs.brassring.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs",
                            headers=headers,
                            json={"partnerId": partnerid, "siteId": siteid,
                                  "pageNumber": page_number, "pageSize": 50,
                                  "sortField": sort_field, "sortOrder": sort_order}) as rp:
                        if rp.status != 200:
                            break
                        dp = await rp.json()
                    jobs = (dp.get("Jobs") or {}).get("Job")
                    if not isinstance(jobs, list) or not jobs:
                        break
                    push_jobs(jobs)
                except Exception:
                    break
    return out


async def _fetch_phenom(session, board):
    tok = str(board.token).rstrip("/")
    base = f"https://{tok}" if "/" in tok else f"https://{tok}/search-results"
    out, total, frm = [], float("inf"), 0
    while frm < total and frm <= 2000:
        async with session.get(f"{base}?keywords=&from={frm}&s=1",
                               headers={"accept": "text/html", "user-agent": BROWSER_UA}) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            html = await r.text()
        ki = html.find('"eagerLoadRefineSearch"')
        if ki < 0:
            if frm == 0:
                raise RuntimeError("No eagerLoadRefineSearch blob (tenant may bot-block)")
            break
        blob = extract_json_after(html, ki)
        if not blob:
            break
        try:
            import json as _json
            d = _json.loads(blob)
        except Exception:
            break
        total = float(d.get("totalHits") or 0)
        items = (d.get("data") or {}).get("jobs")
        if not isinstance(items, list) or not items:
            break
        host = tok.split("/")[0]
        path = "/".join(tok.split("/")[1:])
        for j in items:
            j["_phenomHost"], j["_phenomPath"] = host, path
            out.append(j)
        if len(items) < 10:
            break
        frm += 10
    return out


async def _fetch_paylocity(session, board):
    guid = str(board.token).strip()
    async with session.get(
            f"https://recruiting.paylocity.com/recruiting/jobs/All/{quote(guid)}",
            headers={"accept": "text/html", "user-agent": BROWSER_UA}) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        html = await r.text()
    ki = html.find("window.pageData")
    if ki < 0:
        raise RuntimeError("No pageData (dead board)")
    blob = extract_json_after(html, ki)
    if not blob:
        raise RuntimeError("pageData extraction failed")
    import json as _json
    try:
        d = _json.loads(blob)
    except Exception:
        raise RuntimeError("pageData JSON invalid")
    out = []
    for j in d.get("Jobs") if isinstance(d.get("Jobs"), list) else []:
        if j.get("IsInternal") is not False:
            continue
        j["_guid"] = guid
        out.append(j)
    return out


async def _fetch_zoho(session, board):
    parts = str(board.token).split("/")
    if not parts[0]:
        raise RuntimeError("Invalid Zoho token (want portal[/tld])")
    tld = parts[1] if len(parts) > 1 else "com"
    async with session.get(
            f"https://{parts[0]}.zohorecruit.{tld}/jobs/Careers/rss",
            headers={"user-agent": UA,
                     "accept": "application/rss+xml, application/xml, text/xml"}) as r:
        text = await r.text()
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
    if len(text) < 500 and re.search(r"joblist has been removed", text, re.I):
        return []
    out = []
    for m in re.finditer(r"<item>([\s\S]*?)</item>", text):
        seg = m.group(1)

        def tag(n):
            mm = re.search(rf"<{n}>([\s\S]*?)</{n}>", seg)
            return decode_entities(mm.group(1)).strip() if mm else ""

        out.append({"title": tag("title"), "link": tag("link"), "guid": tag("guid"),
                    "pubDate": tag("pubDate"), "description": tag("description")})
    return out


def _extract_jobposting_ld(html: str):
    import json as _json
    for m in re.finditer(r'<script type="application\/ld\+json">([\s\S]*?)<\/script>', html, re.I):
        try:
            d = _json.loads(m.group(1))
        except Exception:
            continue
        arr = d if isinstance(d, list) else [d]
        for item in arr:
            t = item.get("@type")
            if t == "JobPosting" or (isinstance(t, list) and "JobPosting" in t):
                return item
    return None


async def _fetch_careerplug(session, board):
    tenant = str(board.token).strip()
    headers = {"user-agent": BROWSER_UA, "accept": "text/html"}
    out, seen = [], set()
    for page in range(1, 21):
        if len(out) >= 60:
            break
        async with session.get(f"https://{quote(tenant)}.careerplug.com/jobs?page={page}",
                               headers=headers) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            html = await r.text()
        links = []
        for m in re.finditer(r"<a\b[^>]*>", html, re.I):
            tag_html = m.group(0)
            href = (re.search(r'href="(\/jobs\/[A-Za-z0-9_-]+)"', tag_html) or [None, None])[1]
            label = (re.search(r'aria-label="([^"]*)"', tag_html) or [None, None])[1]
            if href and label and href not in seen:
                seen.add(href)
                links.append((href, decode_entities(label)))
        if not links:
            break
        for href, label in links:
            if len(out) >= 60:
                break
            lm = re.match(r"^(.*?)\s+in\s+([A-Za-z .'\-]+,\s*[A-Z]{2}(?:\s+\d{5})?)$", label)
            title = (lm.group(1) if lm else label).strip()
            location = lm.group(2).strip() if lm else "Not listed"
            if not title or not classify(title, ""):
                continue
            try:
                async with session.get(f"https://{quote(tenant)}.careerplug.com{href}",
                                       headers=headers) as dr:
                    if dr.status != 200:
                        continue
                    ld = _extract_jobposting_ld(await dr.text())
                out.append({"title": title,
                            "url": f"https://{tenant}.careerplug.com{href}",
                            "location": location, "ld": ld})
            except Exception:
                pass
    return out


EXTRA_FETCHERS = {
    "hireology": _fetch_hireology, "adp": _fetch_adp, "dover": _fetch_dover,
    "ukg": _fetch_ukg, "successfactors": _fetch_successfactors,
    "brassring": _fetch_brassring, "phenom": _fetch_phenom,
    "paylocity": _fetch_paylocity, "zoho": _fetch_zoho,
    "careerplug": _fetch_careerplug,
}


async def fetch_extra(session: aiohttp.ClientSession, board: Board) -> List[Dict[str, Any]]:
    fn = EXTRA_FETCHERS.get(board.type)
    if not fn:
        raise RuntimeError("Unsupported extra ATS")
    return await fn(session, board)


# ---------------------------------------------------------------------------
# Normalization: raw payload -> Job
# ---------------------------------------------------------------------------

def _id(tok: str, key: Any) -> str:
    return f"{tok}:{key}"


def normalize_extra(board: Board, raw: Dict[str, Any], checked: str,
                    applied_check=None) -> Optional[Job]:
    tok = str(board.token or "")
    t = board.type
    base: Optional[Dict] = None
    description = ""
    jid = lambda k: f"{t}:{tok}:{k}"

    if t == "hireology":
        j = raw
        title = j.get("name") or ""
        description = j.get("job_description") or ""
        loc = (j.get("locations") or [{}])[0] or {}
        location = ", ".join(x for x in [loc.get("city"), loc.get("state")] if x)
        base = {"id": jid(j.get("id")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location or "Not listed",
                "workplace": "remote" if j.get("remote") else None,
                "isRemote": bool(j.get("remote")), "salary": None,
                "published": iso_date(j.get("created_at")),
                "publishedMeaning": "Hireology job creation timestamp",
                "applyUrl": safe_url(j.get("career_site_url")
                    or f"https://careers.hireology.com/{quote(tok)}/{j.get('id')}/description")}
    elif t == "adp":
        j = raw
        title = j.get("requisitionTitle") or ""
        description = j.get("requisitionDescription") or ""
        loc = (j.get("requisitionLocations") or [{}])[0] or {}
        nc = (loc.get("nameCode") or {})
        location = (nc.get("shortName") or "").strip() or ", ".join(
            x for x in [((loc.get("address") or {}).get("cityName")),
                        ((loc.get("address") or {}).get("countrySubdivisionLevel1") or {}).get("codeValue")] if x)
        apply_url = safe_url(
            f"https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"
            f"?cid={quote(j.get('_cid') or '')}&ccId={quote(j.get('_ccId') or '')}"
            f"&jobId={quote(str(j.get('clientRequisitionID') or j.get('itemID') or ''))}&lang=en_US")
        base = {"id": jid(j.get("itemID") or j.get("clientRequisitionID")),
                "company": board.company, "source": t, "title": title,
                "role": classify(title, description), "location": location or "Not listed",
                "workplace": "remote" if re.search(r"remote", location, re.I) else None,
                "isRemote": bool(re.search(r"remote", location, re.I)), "salary": None,
                "published": iso_date(j.get("postDate")),
                "publishedMeaning": "ADP requisition post date", "applyUrl": apply_url}
    elif t == "dover":
        j = raw
        title = j.get("title") or ""
        locs = j.get("locations") or []
        loc = next((l for l in locs if l.get("is_primary")), locs[0] if locs else {})
        location = (loc or {}).get("name") or ((loc or {}).get("location_option") or {}).get("display_name")
        wt = j.get("workplace_type") or ""
        workplace = ("remote" if re.search(r"remote", wt, re.I)
                     else "hybrid" if re.search(r"hybrid", wt, re.I) else None)
        base = {"id": jid(j.get("id")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location or "Not listed", "workplace": workplace,
                "isRemote": workplace == "remote", "salary": None, "published": None,
                "publishedMeaning": "Dover feed does not expose a publication date",
                "applyUrl": safe_url(f"https://app.dover.com/careers/{quote(tok)}")}
    elif t == "ukg":
        j = raw
        parts = tok.split("/")
        title = j.get("Title") or ""
        description = j.get("BriefDescription") or ""
        addr = ((j.get("Locations") or [{}])[0] or {}).get("Address") or {}
        location = (", ".join(x for x in [addr.get("City"),
                                          (addr.get("State") or {}).get("Code") or (addr.get("State") or {}).get("Name")] if x)
                    or "; ".join(l.get("LocalizedDescription") for l in j.get("Locations") or [] if l.get("LocalizedDescription")))
        base = {"id": jid(j.get("Id")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location or "Not listed", "workplace": None,
                "isRemote": False, "salary": None,
                "published": iso_date(j.get("PostedDate")),
                "publishedMeaning": "UKG posting timestamp",
                "applyUrl": safe_url(f"https://{parts[0]}/{parts[1]}/JobBoard/{quote(parts[2] if len(parts) > 2 else '')}/OpportunityDetail?opportunityId={quote(str(j.get('Id') or ''))}")}
    elif t == "successfactors":
        j = raw
        title = j.get("unifiedStandardTitle") or ""
        location = "; ".join(s.strip() for s in j.get("jobLocationShort") or [] if str(s).strip())
        published = None
        dm = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", str(j.get("unifiedStandardStart") or ""))
        if dm:
            yy = f"20{dm.group(3)}" if len(dm.group(3)) == 2 else dm.group(3)
            published = iso_date(f"{yy}-{dm.group(2).zfill(2)}-{dm.group(1).zfill(2)}")
        origin = (j.get("_origin") or tok).rstrip("/")
        base = {"id": jid(j.get("id")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location or "Not listed", "workplace": None,
                "isRemote": False, "salary": None, "published": published,
                "publishedMeaning": "SuccessFactors posting start date",
                "applyUrl": safe_url(f"{origin}/job/{j.get('unifiedUrlTitle')}/{j.get('id')}-{j.get('_locale') or 'en_GB'}")}
    elif t == "brassring":
        j = raw

        def q(names):
            qs = j.get("Questions")
            if not isinstance(qs, list):
                return ""
            want = {n.lower() for n in names}
            for qq in qs:
                if str(qq.get("QuestionName") or "").lower() in want:
                    v = str(qq.get("Value") or "").strip()
                    if v:
                        return v
            return ""

        title = q(["jobtitle", "title"])
        description = q(["jobdescription", "description"])
        city = q(["formtext12", "city", "locationcity"])
        state = q(["formtext10", "state", "locationstate", "province"])
        location = ", ".join(x for x in [city, state] if x) or q(["location", "joblocation", "primarylocation"])
        published = None
        lm = re.match(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", q(["lastupdated", "posteddate", "dateposted"]))
        if lm:
            mon = {"jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05",
                   "jun": "06", "jul": "07", "aug": "08", "sep": "09", "oct": "10",
                   "nov": "11", "dec": "12"}.get(lm.group(2).lower())
            if mon:
                published = iso_date(f"{lm.group(3)}-{mon}-{lm.group(1).zfill(2)}")
        reqid = q(["reqid", "jobreqid", "requisitionid", "jobid"])
        base = {"id": jid(f"{j.get('_partnerid')}:{reqid}"),
                "company": board.company, "source": t, "title": title,
                "role": classify(title, description),
                "location": location or "Not listed", "workplace": None,
                "isRemote": bool(re.search(r"remote", location, re.I)), "salary": None,
                "published": published, "publishedMeaning": "BrassRing last-updated date",
                "applyUrl": safe_url(
                    f"https://sjobs.brassring.com/TGnewUI/Search/Home/Home"
                    f"?partnerid={quote(j.get('_partnerid') or '')}"
                    f"&siteid={quote(j.get('_siteid') or '')}")}
    elif t == "phenom":
        j = raw
        title = j.get("title") or ""
        description = j.get("descriptionTeaser") or ""
        location = (j.get("cityStateCountry")
                    or ", ".join(x for x in [j.get("city"), j.get("state"), j.get("country")] if x)
                    or j.get("locationName") or "Not listed")
        remote_sig = bool(re.search(r"remote", f"{j.get('workLocation') or ''} {location}", re.I))
        path = "/".join(quote(p) for p in (j.get("_phenomPath") or "").split("/") if p)
        base = {"id": jid(j.get("jobId") or j.get("reqId")),
                "company": board.company, "source": t, "title": title,
                "role": classify(title, description), "location": location,
                "workplace": "remote" if remote_sig else None, "isRemote": remote_sig,
                "salary": j.get("salary") or j.get("salaryRange"),
                "published": iso_date(j.get("postedDate")),
                "publishedMeaning": "Phenom posting date",
                "applyUrl": safe_url(f"https://{j.get('_phenomHost')}/{path}/job/{quote(str(j.get('jobId') or j.get('reqId') or ''))}")}
    elif t == "paylocity":
        j = raw
        title = j.get("JobTitle") or ""
        description = j.get("Description") or ""
        jl = j.get("JobLocation") or {}
        loc_name = j.get("LocationName") or ""
        city_state = ", ".join(x for x in [jl.get("City"), jl.get("State")] if x)
        location = (f"{loc_name} ({city_state})" if loc_name and jl.get("City") and loc_name not in (jl.get("City") or "")
                    else city_state or loc_name or "Not listed")
        base = {"id": jid(j.get("JobId")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location, "workplace": "remote" if j.get("IsRemote") else None,
                "isRemote": bool(j.get("IsRemote")), "salary": None,
                "published": iso_date(j.get("PublishedDate")),
                "publishedMeaning": "Paylocity publication timestamp",
                "applyUrl": safe_url(f"https://recruiting.paylocity.com/recruiting/jobs/Details/{quote(str(j.get('JobId') or ''))}")}
    elif t == "zoho":
        j = raw
        title = strip_html(j.get("title")) or ""
        description = strip_html(j.get("description"))
        lm = re.search(r"Location:\s*([^\n<]+)", str(j.get("description") or ""), re.I)
        location = strip_html(lm.group(1)) if lm else "Not listed"
        base = {"id": jid(j.get("guid") or j.get("link")),
                "company": board.company, "source": t, "title": title,
                "role": classify(title, description), "location": location,
                "workplace": "remote" if re.search(r"remote", location, re.I) else None,
                "isRemote": bool(re.search(r"remote", location, re.I)), "salary": None,
                "published": iso_date(j.get("pubDate")),
                "publishedMeaning": "Zoho RSS publication date",
                "applyUrl": safe_url(j.get("link") or j.get("guid"))}
    elif t == "careerplug":
        j = raw
        ld = j.get("ld") or {}
        title = j.get("title") or strip_html(ld.get("title")) or ""
        description = strip_html(ld.get("description"))
        location = j.get("location") or "Not listed"
        base = {"id": jid(j.get("url")), "company": board.company, "source": t,
                "title": title, "role": classify(title, description),
                "location": location,
                "workplace": "remote" if re.search(r"remote", location, re.I) else None,
                "isRemote": bool(re.search(r"remote", location, re.I)), "salary": None,
                "published": iso_date(ld.get("datePosted")),
                "publishedMeaning": "CareerPlug JSON-LD datePosted",
                "applyUrl": safe_url(j.get("url"))}

    if not base:
        return None
    if not base.get("role") or not base.get("applyUrl"):
        return None
    base["checked"] = checked
    base["boardKey"] = board.key
    job = enrich_job(base, description, "", applied_check=applied_check)
    job.fitScore = weighted_fit_score(job, description)
    return job
