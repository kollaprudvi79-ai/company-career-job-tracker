"""Core data models and job-classification utilities.

Python port of job-utils.mjs. All classification, filtering, salary parsing,
freshness, remote-assessment and fit-flag logic is preserved exactly so the
jobs.json schema and frontend behavior stay identical.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SALARY_FLOOR = 125000

# US state abbreviations for location verification
US_STATE_ABBRS = r"\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b"

def _is_us_location(loc: str) -> bool:
    """Check if location string contains US markers."""
    if not loc:
        return False
    import re as _re
    if _re.search(r"\b(united states|usa|u\.s\.a?\.)\b", loc, _re.I):
        return True
    if _re.search(US_STATE_ABBRS, loc):
        return True
    return False
FRESH_WINDOW_DAYS = 7

PROFILE_BY_ROLE = {
    "Data Engineer": "Data Engineer",
    "Data Analyst": "Data Analyst",
    "Data Scientist": "Data Scientist",
    "AI Engineer": "Data Scientist",
    "Full Stack .NET": ".NET Developer",
}


def tsenta_profile(role: Optional[str]) -> Optional[str]:
    return PROFILE_BY_ROLE.get(role or "")


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Board:
    company: str = ""
    type: str = ""
    token: str = ""
    from_extra: bool = False

    @property
    def key(self) -> str:
        return f"{self.type}:{str(self.token or '').lower()}"

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Board":
        return cls(
            company=d.get("company", ""),
            type=d.get("type", ""),
            token=d.get("token", ""),
            from_extra=bool(d.get("_fromExtra", False)),
        )


@dataclass
class Job:
    id: Optional[str] = None
    company: Optional[str] = None
    source: Optional[str] = None
    title: Optional[str] = None
    role: Optional[str] = None
    location: Optional[str] = None
    workplace: Optional[str] = None
    salary: Optional[str] = None
    salaryMin: Optional[int] = None
    salaryMax: Optional[int] = None
    published: Optional[str] = None
    publishedMeaning: Optional[str] = None
    applyUrl: Optional[str] = None
    usRemote: Optional[bool] = None
    remoteType: Optional[str] = None
    remoteReason: Optional[str] = None
    flags: Dict[str, Any] = field(default_factory=dict)
    fit: bool = False
    fitBlocks: List[str] = field(default_factory=list)
    fitNotes: List[str] = field(default_factory=list)
    firstSeen: Optional[str] = None
    checked: Optional[str] = None
    within24h: bool = False
    within7d: bool = False
    ageDays: Optional[float] = None
    boardKey: Optional[str] = None
    tsentaProfile: Optional[str] = None
    stale: Optional[bool] = None
    alreadyApplied: Optional[bool] = None
    descriptionText: Optional[str] = None
    # --- Python-rewrite additions (additive; frontend ignores unknown keys) ---
    fitScore: Optional[int] = None      # weighted 0-100 fit score (scoring.py)
    duplicateOf: Optional[str] = None  # id of canonical job if near-duplicate

    def to_dict(self) -> Dict[str, Any]:
        # Mirror JSON.stringify: drop None values like JS drops undefined.
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Job":
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class BoardStatus:
    company: str = ""
    type: str = ""
    token: str = ""
    ok: bool = False
    checkedAt: Optional[str] = None
    matched: int = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def strip_html(value: Any = "") -> str:
    s = str(value or "")
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def decode_entities(s: Any) -> str:
    s = str(s or "")
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"),
                 ("&nbsp;", " ")]:
        s = s.replace(a, b)
    return s


def iso_date(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)) or re.fullmatch(r"\d+", str(value)):
            d = datetime.fromtimestamp(int(value), tz=timezone.utc)
        else:
            s = str(value).strip()
            # Handle Z suffix for fromisoformat on older parsers
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_company(value: Any = "") -> str:
    s = str(value or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


# ---------------------------------------------------------------------------
# Role classification
# ---------------------------------------------------------------------------

def classify(title: Any = "", description: Any = "") -> Optional[str]:
    t = str(title or "").lower()
    text = f"{t} {strip_html(description).lower()}"
    if re.search(r"data engineer|analytics engineer|etl developer|data platform engineer|data infrastructure engineer", t):
        return "Data Engineer"
    if re.search(r"data scientist|applied scientist|decision scientist", t):
        return "Data Scientist"
    if re.search(r"ai engineer|machine learning engineer|ml engineer|llm engineer|mlops engineer|generative ai engineer|applied ai engineer|ai/ml engineer", t):
        return "AI Engineer"
    if re.search(r"data analyst|business intelligence analyst|bi analyst|reporting analyst|product analyst|analytics analyst|business analyst", t):
        return "Data Analyst"
    if re.search(r"\.net|asp\.net|c#|dotnet", t):
        return "Full Stack .NET"
    if (re.search(r"full.?stack|software (engineer|developer)|backend (engineer|developer)|application developer", t)
            and re.search(r"(\.net core|asp\.net|c#|dotnet|\.net framework)", text)):
        return "Full Stack .NET"
    return None


# ---------------------------------------------------------------------------
# Salary parsing
# ---------------------------------------------------------------------------

def _money_value(raw: str, suffix: str = "") -> Optional[int]:
    try:
        n = float(str(raw).replace(",", ""))
    except ValueError:
        return None
    if re.search(r"k", suffix, re.I) or n < 1000:
        n *= 1000
    return round(n)


def parse_salary(text: Any = "", structured_text: Any = "") -> Dict[str, Any]:
    haystack = f"{structured_text or ''} {strip_html(text)}"
    m = re.search(
        r"(?:USD|\$)\s?([\d,]+(?:\.\d+)?)\s?(k)?\s*(?:-|–|—|to)\s*(?:USD|\$)?\s?([\d,]+(?:\.\d+)?)\s?(k)?",
        haystack, re.I)
    if m:
        lo = _money_value(m.group(1), m.group(2) or "")
        hi = _money_value(m.group(3), m.group(4) or "")
        if lo and hi:
            return {"salary": f"${lo:,}–${hi:,}", "salaryMin": lo, "salaryMax": hi}
    m = re.search(r"(?:USD|\$)\s?([\d,]+(?:\.\d+)?)\s?(k)?\b", haystack, re.I)
    if m:
        v = _money_value(m.group(1), m.group(2) or "")
        if v:
            return {"salary": f"${v:,}", "salaryMin": v, "salaryMax": v}
    return {"salary": None, "salaryMin": None, "salaryMax": None}


# ---------------------------------------------------------------------------
# Title / text flags
# ---------------------------------------------------------------------------

def title_flags(title: Any = "") -> Dict[str, bool]:
    t = str(title or "")
    excluded_level = (
        bool(re.search(r"\b(staff|principal|lead|manager|director|vp|vice president|chief|architect|distinguished|fellow|head|senior)\b", t, re.I))
        or bool(re.search(r"\bsr\.?\s", t, re.I))
        or bool(re.search(r"\b(engineer|developer|analyst|scientist)\s+[4-9]\b", t, re.I))
        or bool(re.search(r"\bL[4-9]\b", t))
        or bool(re.search(r"\blevel\s*[4-9]\b", t, re.I))
    )
    intern = bool(re.search(r"\b(intern|internship|co-op|coop|new grad|entry[- ]level|graduate program)\b", t, re.I))
    return {"excludedLevel": excluded_level, "intern": intern}


def text_flags(title: Any = "", description: Any = "") -> Dict[str, Any]:
    text = strip_html(description)
    lower = f"{title} {text}".lower()
    java_centric = (
        bool(re.search(r"\b(java|spring boot|spring)\b", str(title or ""), re.I))
        or (len(re.findall(r"\bjava\b", lower)) >= 3 and bool(re.search(r"\bspring\b", lower)))
    )
    sponsorship_risk = bool(re.search(
        r"(no (visa )?sponsorship|not (provide|offer|able to provide)[^.]{0,60}sponsorship|"
        r"cannot sponsor|can not sponsor|unable to sponsor|without (visa )?sponsorship|"
        r"sponsorship is not available|not eligible for (visa )?sponsorship|"
        r"must be authorized to work[^.]{0,80}without sponsorship)", text, re.I))
    restricted = bool(re.search(
        r"(security clearance|ts\/sci|public trust|secret clearance|"
        r"u\.s\. citizenship is required|us citizenship is required|"
        r"must be (a )?u\.s\. citizen|must be (a )?us citizen|"
        r"department of defense|federal government|government clearance)", lower))
    years = [int(m.group(2) or m.group(1))
             for m in re.finditer(r"(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(\d{1,2})?\s*years?", lower)]
    years = [n for n in years if 0 < n <= 30]
    experience_max_years = max(years) if years else None
    non_us_text = bool(re.search(
        r"(\bir35\b|right to work in the (uk|united kingdom)|"
        r"must be (based|located|residing|living) in (the )?(uk|united kingdom|england|canada|india)|"
        r"uk[- ]based (only|role)|uk only role|canada[- ]based only|india[- ]based only|"
        r"must (live|reside) in (the )?(uk|canada|india))", text, re.I))
    return {"javaCentric": java_centric, "sponsorshipRisk": sponsorship_risk,
            "restricted": restricted, "experienceMaxYears": experience_max_years,
            "nonUsText": non_us_text}


# ---------------------------------------------------------------------------
# Location / remote assessment
# ---------------------------------------------------------------------------

US_STATES = ("Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|"
             "Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|"
             "Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|"
             "New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|"
             "Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|"
             "Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|"
             "District of Columbia")

NON_US = re.compile(
    r"canada|ontario|toronto|vancouver|montreal|calgary|waterloo|united kingdom|london|england|"
    r"scotland|wales|ireland|dublin|germany|berlin|munich|france|paris|india|bangalore|bengaluru|"
    r"hyderabad|pune|mumbai|delhi|jaipur|kolkata|ahmedabad|chennai|kochi|indore|lucknow|nagpur|"
    r"surat|coimbatore|thiruvananthapuram|australia|sydney|melbourne|perth|brisbane|adelaide|"
    r"singapore|tokyo|japan|brazil|sao paulo|mexico|mexico city|poland|warsaw|krakow|spain|madrid|"
    r"barcelona|netherlands|amsterdam|israel|tel aviv|sweden|stockholm|norway|oslo|denmark|"
    r"copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|czech|prague|portugal|lisbon|"
    r"italy|milan|rome|new zealand|auckland|hong kong|china|beijing|shanghai|shenzhen|south korea|"
    r"seoul|philippines|manila|vietnam|hanoi|indonesia|jakarta|malaysia|kuala lumpur|argentina|"
    r"buenos aires|chile|santiago|colombia|bogota|peru|lima|uruguay|montevideo|south africa|"
    r"cape town|johannesburg|nigeria|lagos|kenya|nairobi|egypt|cairo|uae|dubai|abu dhabi|saudi|"
    r"riyadh|qatar|doha|pakistan|islamabad|lahore|karachi|bangladesh|dhaka|sri lanka|colombo|"
    r"nepal|kathmandu|\bapac\b|\bemea\b|tbilisi|\buk\b", re.I)

_US_STATE_RE = re.compile(rf"\b({US_STATES})\b", re.I)
_US_ABBR_RE = re.compile(r"(?:^|[\s,])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b")


def remote_assessment(location: Any = "", workplace: Any = None,
                      is_remote: Any = None, description: Any = "") -> Dict[str, Any]:
    loc = str(location or "").strip()
    lower = loc.lower()
    text = strip_html(description).lower()
    wp = str(workplace or "").lower()
    remote_signal = bool(re.search(r"\bremote\b", lower)) or wp == "remote" or is_remote is True
    hybrid_signal = bool(re.search(r"hybrid", lower)) or wp == "hybrid"
    onsite_signal = (bool(re.search(r"on[- ]site|in[- ]office", lower))
                     or wp in ("onsite", "on-site"))
    has_non_us = bool(NON_US.search(loc))
    has_us = (bool(re.search(r"\b(united states|usa|u\.s\.a\.|u\.s\.)\b", loc, re.I))
              or bool(_US_STATE_RE.search(loc)) or bool(_US_ABBR_RE.search(loc)))
    text_us_remote = bool(re.search(
        r"(remote[^.]{0,80}(united states|usa|u\.s\.)|"
        r"(united states|usa|u\.s\.)[^.]{0,80}remote|"
        r"based in the united states|u\.s\.-based|us-based)", text, re.I))
    if has_non_us:
        return {"usRemote": False, "remoteType": "non-us",
                "remoteReason": "Primary location is outside the US"}
    if hybrid_signal or onsite_signal:
        return {"usRemote": False,
                "remoteType": "hybrid" if hybrid_signal else "onsite",
                "remoteReason": "Hybrid or onsite location"}
    if remote_signal and (has_us or text_us_remote):
        return {"usRemote": True, "remoteType": "us-remote",
                "remoteReason": "US remote signal verified from ATS fields"}
    if remote_signal:
        return {"usRemote": None, "remoteType": "remote-unknown",
                "remoteReason": "Remote is stated, but US eligibility is not explicit"}
    return {"usRemote": False, "remoteType": "not-remote",
            "remoteReason": "No remote signal in ATS fields"}


# ---------------------------------------------------------------------------
# Freshness / fit
# ---------------------------------------------------------------------------

def freshness(published: Optional[str], now_ms: Optional[int] = None) -> Dict[str, Any]:
    if not published:
        return {"ageDays": None, "within24h": False, "within7d": False}
    try:
        ts = datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return {"ageDays": None, "within24h": False, "within7d": False}
    now = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    age_ms = now - ts
    return {
        "ageDays": round((age_ms / 86400000) * 10) / 10,
        "within24h": 0 <= age_ms <= 86400000,
        "within7d": 0 <= age_ms <= FRESH_WINDOW_DAYS * 86400000,
    }


def is_us_job(job: Job) -> bool:
    return job.remoteType != "non-us" and not (job.flags or {}).get("nonUsText")


STAFFING_RE = re.compile(
    r"\b(jobgether|alten|guidehouse|booz allen|bah|randstad|teksystems|robert half|"
    r"kforce|apex systems|insight global|modis|experis|aston carter|synergisticit)\b", re.I)


def assess_job(job: Job, now_ms: Optional[int] = None) -> Job:
    """Port of assessJob: binary fit + human-readable blocks/notes. Unchanged."""
    flags = dict(job.flags or {})
    fresh = freshness(job.published, now_ms)
    blocks: List[str] = []
    notes: List[str] = []
    if not job.role:
        blocks.append("No target role lane")
    if not fresh["within7d"]:
        blocks.append("Outside 7-day window" if job.published else "Posting date unknown")
    if job.remoteType == "non-us":
        blocks.append(job.remoteReason or "Location outside the US")
    elif job.remoteType == "remote-unknown":
        blocks.append("Remote location not verified as US")
    elif not job.usRemote and not _is_us_location(job.location or ""):
        blocks.append("Location not verified as US")
    if flags.get("excludedLevel"):
        blocks.append("Excluded seniority/title level")
    if flags.get("intern"):
        blocks.append("Intern or entry-level")
    if flags.get("javaCentric"):
        blocks.append("Java/Spring-centric")
    if flags.get("sponsorshipRisk"):
        blocks.append("JD states sponsorship restriction")
    if flags.get("restricted"):
        blocks.append("Government, clearance, or citizenship restriction")
    if flags.get("nonUsText"):
        blocks.append("JD indicates location outside the US")
    if STAFFING_RE.search(job.company or ""):
        blocks.append("Staffing agency / consultancy")
    exp_max = flags.get("experienceMaxYears")
    if exp_max and exp_max >= 7:
        blocks.append(f"Experience ask may be {exp_max}+ years")
    if job.salaryMax and job.salaryMax < SALARY_FLOOR:
        blocks.append("Listed salary is below $125k")
    if job.alreadyApplied:
        notes.append("Company already applied")
    if job.salaryMin and job.salaryMin >= SALARY_FLOOR:
        notes.append("Listed salary meets $125k floor")
    elif job.salaryMax and job.salaryMax >= SALARY_FLOOR:
        notes.append("Listed salary range reaches $125k")
    elif not job.salaryMax:
        notes.append("Salary not listed")
    if job.remoteType in ("onsite", "hybrid"):
        notes.append("US onsite/hybrid — relocation open")
    elif job.remoteType == "remote-unknown":
        notes.append("Remote — US eligibility unverified")
    elif job.usRemote is True:
        notes.append("Verified US remote")

    job.flags = flags
    job.ageDays = fresh["ageDays"]
    job.within24h = fresh["within24h"]
    job.within7d = fresh["within7d"]
    job.fit = len(blocks) == 0
    job.fitBlocks = blocks
    job.fitNotes = notes
    return job


def enrich_job(base: Dict[str, Any], description: Any = "",
               structured_salary_text: Any = "", now_ms: Optional[int] = None,
               applied_check=None) -> Job:
    """Port of enrichJob: salary parse + flags + remote + assess."""
    salary = parse_salary(description, structured_salary_text or base.get("salary") or "")
    tf = title_flags(base.get("title"))
    xf = text_flags(base.get("title"), description)
    if re.search(r"\bgovernment\b|\.gov\b", str(base.get("company") or ""), re.I):
        xf["restricted"] = True
    remote = remote_assessment(
        location=base.get("location"), workplace=base.get("workplace"),
        is_remote=base.get("isRemote"), description=description)
    job = Job(
        id=base.get("id"), company=base.get("company"), source=base.get("source"),
        title=base.get("title"), role=base.get("role"), location=base.get("location"),
        workplace=base.get("workplace"),
        salary=salary["salary"] or base.get("salary"),
        salaryMin=salary["salaryMin"], salaryMax=salary["salaryMax"],
        published=base.get("published"), publishedMeaning=base.get("publishedMeaning"),
        applyUrl=base.get("applyUrl"),
        usRemote=remote["usRemote"], remoteType=remote["remoteType"],
        remoteReason=remote["remoteReason"],
        flags={**tf, **xf},
        checked=base.get("checked"),
        boardKey=base.get("boardKey"),
        tsentaProfile=tsenta_profile(base.get("role")),
    )
    if applied_check:
        job.alreadyApplied = applied_check(job)
    return assess_job(job, now_ms)
