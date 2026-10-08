"""Advanced scoring algorithms for Career Radar.

1. TF-IDF near-duplicate detection (the repost problem: same role, new req ID).
2. Yield-based board prioritization (jobs found / sweeps checked).
3. Weighted 0-100 fit score complementing the binary fit flag.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

from .models import Job, normalize_company, STAFFING_RE

# ---------------------------------------------------------------------------
# 1. TF-IDF near-duplicate detection
# ---------------------------------------------------------------------------

DUP_THRESHOLD = 0.85

_STATE_ABBR = {
    "AL": "alabama", "AK": "alaska", "AZ": "arizona", "AR": "arkansas",
    "CA": "california", "CO": "colorado", "CT": "connecticut", "DE": "delaware",
    "FL": "florida", "GA": "georgia", "HI": "hawaii", "ID": "idaho",
    "IL": "illinois", "IN": "indiana", "IA": "iowa", "KS": "kansas",
    "KY": "kentucky", "LA": "louisiana", "ME": "maine", "MD": "maryland",
    "MA": "massachusetts", "MI": "michigan", "MN": "minnesota",
    "MS": "mississippi", "MO": "missouri", "MT": "montana", "NE": "nebraska",
    "NV": "nevada", "NH": "new hampshire", "NJ": "new jersey",
    "NM": "new mexico", "NY": "new york", "NC": "north carolina",
    "ND": "north dakota", "OH": "ohio", "OK": "oklahoma", "OR": "oregon",
    "PA": "pennsylvania", "RI": "rhode island", "SC": "south carolina",
    "SD": "south dakota", "TN": "tennessee", "TX": "texas", "UT": "utah",
    "VT": "vermont", "VA": "virginia", "WA": "washington",
    "WV": "west virginia", "WI": "wisconsin", "WY": "wyoming",
    "DC": "district of columbia",
}


def _norm_location(loc: str) -> str:
    """Normalize a location so 'Austin, TX' == 'Austin, Texas'."""
    s = str(loc or "").strip()
    s = re.sub(r",\s*([A-Z]{2})\b",
               lambda m: ", " + _STATE_ABBR.get(m.group(1), m.group(1)), s)
    s = re.sub(r"\b([A-Z]{2})$",
               lambda m: _STATE_ABBR.get(m.group(1), m.group(1)), s.strip())
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def tfidf_dedupe(jobs: List[Job], threshold: float = DUP_THRESHOLD) -> List[Job]:
    """Flag near-duplicate jobs (same company, near-identical title + location).

    Compares titles with TF (no IDF — IDF down-weights the shared terms that
    define a repost) cosine similarity inside per-company groups, gated on
    normalized-location equality so distinct openings in different cities are
    never merged. The canonical job (earliest firstSeen, then highest
    fitScore) keeps its place; the rest get ``duplicateOf`` set.
    Falls back to exact-ID matching (already done upstream) when sklearn is
    unavailable.
    """
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
    except ImportError:
        return jobs  # exact-ID dedup upstream is the fallback

    # Group indices by normalized company so we only compare within a company.
    groups: Dict[str, List[int]] = {}
    for i, job in enumerate(jobs):
        if job.duplicateOf:
            continue
        key = normalize_company(job.company)
        if key:
            groups.setdefault(key, []).append(i)

    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        texts = [str(jobs[i].title or "") for i in idxs]
        try:
            vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2),
                                  min_df=1, use_idf=False,
                                  norm="l2").fit_transform(texts)
        except ValueError:
            continue  # empty vocabulary
        # Sparse cosine similarity; only upper triangle matters.
        sim = cosine_similarity(vec, dense_output=False).tocoo()

        # Union-find over pairs above threshold.
        parent = {i: i for i in range(len(idxs))}

        def find(a: int) -> int:
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        for r, c, v in zip(sim.row, sim.col, sim.data):
            if r < c and v >= threshold:
                a, b = idxs[r], idxs[c]
                # Same normalized location required: protects distinct
                # openings that share a title in different cities.
                if _norm_location(jobs[a].location) == _norm_location(jobs[b].location):
                    union(r, c)

        clusters: Dict[int, List[int]] = {}
        for i in range(len(idxs)):
            clusters.setdefault(find(i), []).append(idxs[i])

        for members in clusters.values():
            if len(members) < 2:
                continue
            # Canonical = earliest firstSeen, tie-break on fitScore desc.
            def sort_key(i: int) -> Tuple[str, int]:
                j = jobs[i]
                return (j.firstSeen or "9999", -(j.fitScore or 0))
            members.sort(key=sort_key)
            canonical_id = jobs[members[0]].id
            for i in members[1:]:
                if jobs[i].id != canonical_id:
                    jobs[i].duplicateOf = canonical_id
    return jobs


# ---------------------------------------------------------------------------
# 2. Yield-based board prioritization
# ---------------------------------------------------------------------------

def board_yield(board_key: str, state: Dict) -> float:
    """Historical yield: jobs found / sweeps checked. 0 when unknown."""
    entry = (state.get("boardYield") or {}).get(board_key)
    if not entry or not entry.get("checks"):
        return 0.0
    return entry.get("jobs", 0) / entry["checks"]


def order_by_yield(boards, state: Dict):
    """Sort boards by historical yield, descending (stable).

    High-value boards are checked first so an interrupted sweep has already
    covered the best sources. Boards with no history keep relative order.
    """
    scored = [(board_yield(b.key, state), i, b) for i, b in enumerate(boards)]
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [b for _, _, b in scored]


def record_yield(state: Dict, results: List[Dict]) -> Dict:
    """Update per-board {checks, jobs} counters from this sweep's results."""
    yields = state.setdefault("boardYield", {})
    for r in results:
        key = f"{r.get('type')}:{str(r.get('token') or '').lower()}"
        entry = yields.setdefault(key, {"checks": 0, "jobs": 0})
        entry["checks"] += 1
        entry["jobs"] += int(r.get("matched") or 0)
    # Bound growth: drop boards unseen for a long time is unnecessary;
    # 48k keys x small dict is fine (~a few MB).
    return state


# ---------------------------------------------------------------------------
# 3. Weighted 0-100 fit score
# ---------------------------------------------------------------------------

ROLE_PHRASES: Dict[str, List[str]] = {
    "Data Engineer": ["data engineer", "analytics engineer", "etl developer",
                      "data platform engineer", "data infrastructure engineer"],
    "Data Analyst": ["data analyst", "business intelligence analyst", "bi analyst",
                     "reporting analyst", "analytics analyst", "business analyst"],
    "Data Scientist": ["data scientist", "applied scientist", "decision scientist"],
    "AI Engineer": ["ai engineer", "machine learning engineer", "ml engineer",
                    "llm engineer", "mlops engineer", "generative ai engineer",
                    "applied ai engineer"],
    "Full Stack .NET": [".net", "asp.net", "c#", "dotnet"],
}

SKILL_KEYWORDS = [
    "python", "sql", "spark", "aws", "azure", "gcp", "machine learning",
    "deep learning", "llm", "rag", "etl", "airflow", "dbt", "snowflake",
    "databricks", "kubernetes", "docker", "tensorflow", "pytorch", "pandas",
    "numpy", "tableau", "power bi", "powerbi", "statistics", "nlp",
    "mlops", "kafka", "hadoop", "redshift", "bigquery", "terraform",
    "ci/cd", "rest api", "graphql", "elasticsearch", "redis",
]


def weighted_fit_score(job: Job, description: str = "") -> int:
    """0-100 score: title 40 / location 20 / description keywords 20 /
    salary 10 / company 10. Complements (does not replace) the binary fit."""
    score = 0
    title = str(job.title or "").lower()

    # --- Title match (40) ---
    phrases = ROLE_PHRASES.get(job.role or "", [])
    if any(p in title for p in phrases):
        score += 40
    elif job.role:
        score += 22  # role classified via description, weaker title signal

    # --- Location (20) ---
    rt = job.remoteType
    if rt == "us-remote":
        score += 20
    elif rt in ("onsite", "hybrid"):
        score += 14
    elif rt == "not-remote":
        score += 12  # US city; relocation-open policy
    elif rt == "remote-unknown":
        score += 8

    # --- Description keywords (20) ---
    text = f"{title} {str(description or '').lower()}"
    hits = sum(1 for kw in SKILL_KEYWORDS if kw in text)
    if hits >= 8:
        score += 20
    elif hits >= 6:
        score += 16
    elif hits >= 4:
        score += 12
    elif hits >= 2:
        score += 8
    elif hits >= 1:
        score += 4

    # --- Salary (10) ---
    if job.salaryMin and job.salaryMin >= 125000:
        score += 10
    elif job.salaryMax and job.salaryMax >= 125000:
        score += 7
    elif not job.salaryMax:
        score += 4  # not listed: neutral

    # --- Company (10) ---
    flags = job.flags or {}
    if flags.get("restricted"):
        score += 0
    elif STAFFING_RE.search(job.company or ""):
        score += 0
    else:
        score += 10

    return max(0, min(100, score))
