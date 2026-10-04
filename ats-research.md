# Career Radar — ATS Platform Research (2026-10-04)

Goal: determine which ATS platforms expose a **public, unauthenticated JSON API**
usable by a server-side sweeper (curl-style HTTP, no browser, no login, no keys).
Each verdict below was verified live with curl against a real employer's board.

## Verdict summary

| Platform | Verdict | Access shape |
|---|---|---|
| SAP SuccessFactors | **FEASIBLE** | Public JSON API (POST) |
| Infinite BrassRing | **FEASIBLE** | Public JSON API (2-step: GET token, POST) |
| ADP Workforce Now | **FEASIBLE** | Public JSON API (GET, OData pagination) |
| UKG / UltiPro | **FEASIBLE** | Public JSON API (POST) |
| Hireology | **FEASIBLE** | Public JSON API (GET) |
| Dover | **FEASIBLE** | Public JSON API (GET; list lacks descriptions) |
| Phenom | **FEASIBLE*** | *No JSON endpoint — SSR-embedded SEO JSON blob (single GET)* |
| Paylocity | **FEASIBLE*** | *No JSON endpoint — SSR-embedded `window.pageData` JSON (single GET)* |
| Zoho Recruit | NOT FEASIBLE (JSON) | Fallback: public RSS 2.0 XML feed / embedded JSON in HTML |
| CareerPlug | NOT FEASIBLE (JSON) | Fallback: HTML table + schema.org JSON-LD on detail pages |
| Dayforce / Ceridian | NOT FEASIBLE | Cloudflare 403 on JSON API from plain-HTTP clients |

\* Phenom and Paylocity are implementable today with one unauthenticated GET plus
JSON extraction from the HTML — no separate JSON endpoint exists.

---

## 1. SAP SuccessFactors — FEASIBLE

- **Human page:** `https://<tenant-career-domain>/` (e.g. `https://jobs.danfoss.com/`; search UI at `/search/`). Branded Career Site Builder (CSB) boards at customer domains.
- **JSON API:** `POST {origin}/services/recruiting/v1/jobs`, `Content-Type: application/json`
  ```json
  {"keywords":"","locale":"en_GB","location":"","pageNumber":0,"sortBy":"recent"}
  ```
  Response: `{"totalJobs": N, "jobSearchResult": [{"response": {"id","unifiedStandardTitle","unifiedUrlTitle","jobLocationShort":[...],"unifiedStandardStart":"M/D/YY", ...}}]}` — 10/page, `pageNumber` 0-based.
- **Verified:** Danfoss — `POST https://jobs.danfoss.com/services/recruiting/v1/jobs` → HTTP 200, `totalJobs: 641`; pagination confirmed. Detail URL: `{origin}/job/{unifiedUrlTitle}/{id}-{locale}` (HTTP 200 verified).
- **Notes:** No company ID/token needed — origin is the identifier. **Locale-gated:** fetch `{origin}/search/`, extract `locale=xx_XX` from language-switcher links, query each, dedup by id (`en_GB`→641 vs `da_DK`→26 on Danfoss). Some tenants need a handshake (GET `/search/` → `CSRFToken` + JSESSIONID → POST with `x-csrf-token` + `Referer`); Danfoss didn't. Non-CSB (RMK/jobs2web) tenants 401 here — fallback `GET {origin}/tile-search-results/?startrow=N` (HTML tiles, verified on jobs.zf.com). Bot gating varies by tenant network (jobs.sap.com Cloudflare-challenges datacenter IPs; Danfoss/ZF fine).

## 2. Infinite BrassRing — FEASIBLE

- **Human page:** `https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid={PARTNERID}&siteid={SITEID}`
- **JSON API (two-step, no auth):**
  1. `GET` the home URL (normal UA) → session cookie + `__RequestVerificationToken` hidden input from HTML.
  2. `POST https://sjobs.brassring.com/TgNewUI/Search/Ajax/MatchedJobs` with headers `RFT: <token>`, `X-Requested-With: XMLHttpRequest`, `Content-Type: application/json`:
     ```json
     {"PartnerId":"25632","SiteId":"5649","Keyword":"","Location":"","KeywordCustomSolrFields":"JobTitle,Location","LocationCustomSolrFields":"Location","FacetFilterFields":null,"TurnOffHttps":false,"Latitude":0,"Longitude":0,"PowerSearchOptions":{"PowerSearchOption":[]},"encryptedsessionvalue":""}
     ```
     → `{"Jobs":{"Job":[{"Questions":[{QuestionName,Value}...]}]}, "JobsCount": N, ...}` — descriptions included.
  3. Pagination: `POST https://sjobs.brassring.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs` with **lowercase** keys: `{"partnerId":"25632","siteId":"5649","pageNumber":2,"pageSize":50,"sortField":"lastupdated","sortOrder":"desc"}`
- **Verified:** Best Buy (25632/5649) → `JobsCount: 3452`, 50 jobs/page; page 2 disjoint. Known pairs: Home Depot 25526/5032, Walgreens 26336/5014.
- **Notes:** Sort is unstable across pages — sweep both sorts (date + title) and dedup on `partnerid + reqid` (99.3%+ coverage per Sept 2026 source). Location field names vary per tenant (`formtext12/10` vs `location`). Discover pairs from employer career-page links or Wayback CDX (727 pairs found Sept 2026, ~98 boards with open roles, ~72k jobs). No rate limits observed; pace modestly.

## 3. ADP Workforce Now — FEASIBLE

- **Human page:** `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid={cid}&ccId={ccId}&lang=en_US` (Web Components SPA — renders nothing in plain HTML; use the API below, which is what the SPA calls).
- **JSON API (list, paginated):**
  ```
  GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid={cid}&ccId={ccId}&lang=en_US&locale=en_US&$top=20&$skip={N}
  ```
- **JSON API (detail):**
  ```
  GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/{itemID}?cid={cid}&ccId={ccId}&lang=en_US&locale=en_US
  ```
  (Path param must be `itemID`, not `clientRequisitionID`; description field is `requisitionDescription` (HTML).)
- **Verified:** Performance Energy Services (`cid=d2c28c89-…`, `ccId=19000101_000001`) → real job JSON; Skyworks (second tenant) → `meta.totalNumber: 151`. Detail fetch → 7,218-char description.
- **Notes:** `$top` hard-capped at 20 server-side; paginate `$skip` 0/20/40… until ≥ `meta.totalNumber`. Fields: `requisitionTitle`, `postDate` (ISO+offset), `workLevelCode.shortName`, `requisitionLocations[]` (city/state/postal), `customFieldGroup`. Discover `cid`/`ccId` from any `recruitment.html?cid=…&ccId=…` link (ccId isn't always the default). Covers ADP Workforce Now career centers only — `myjobs.adp.com` needs an `orgoid` header (not verified). No rate limits observed.

## 4. UKG / UltiPro — FEASIBLE

- **Human page:** `https://{host}/{TENANT}/JobBoard/{BOARD_GUID}/` (e.g. Grocery Outlet: `https://recruiting.ultipro.com/GRO1006/JobBoard/4c6ab91f-73c0-bb4f-ad81-094171fac4c7/`)
- **JSON API:**
  ```
  POST https://{HOST}/{TENANT}/JobBoard/{BOARD_GUID}/JobBoardView/LoadSearchResults
  Content-Type: application/json
  {"opportunitySearch":{"Top":50,"Skip":0}}
  ```
  `{HOST}` ∈ `recruiting.ultipro.com`, `recruiting2.ultipro.com`, `recruiting.ultipro.ca`. Empty `{}` body returns zero results — the `opportunitySearch` envelope is required.
- **Verified:** Grocery Outlet → HTTP 200 `application/json`, `totalCount: 90`; fields `Id`, `Title`, `RequisitionNumber`, `FullTime`, `PostedDate`, `BriefDescription`, `Locations[].Address`.
- **Notes:** Paginate `Top`/`Skip` against `totalCount`. Detail page: `/{TENANT}/JobBoard/{GUID}/OpportunityDetail?opportunityId={Id}`. Discovery: tenant shortname + GUID visible in indexed career/job-detail URLs. **Skip legacy tenants** (`.../JobBoard/SearchJobs.aspx`, no GUID — no JSON API). No rate limits observed.

## 5. Hireology — FEASIBLE

- **Human page:** `https://careers.hireology.com/{slug}` (e.g. `https://careers.hireology.com/brightstarcareapi`); job pages `/{slug}/{job_id}/description`.
- **JSON API:**
  ```
  GET https://api.hireology.com/v2/public/careers/{slug}?page={N}&page_size={M}
  ```
  Unauthenticated, plain GET. Returns `{data:[...], count, page, page_size}` with **full HTML job descriptions inline** — no per-job fan-out needed.
- **Verified:** `brightstarcareapi` → HTTP 200, 9 real jobs; second tenant `alwaysbestcareseniorservices-katytx` → HTTP 200. `page_size=1` slicing confirmed; paginate while `page*page_size < count`. (Older v1 endpoint returned `{"data":[]}` — use v2.)
- **Notes:** Slug = path segment after `careers.hireology.com/`. Filter `status == "Open"`. Boards lean franchise/retail/healthcare — existing fit filters will exclude most. No rate limits observed.

## 6. Dover — FEASIBLE (discovery-grade; no descriptions)

- **Human page:** `https://app.dover.com/{company-slug}/careers/{clientId}` (`{clientId}` = UUID)
- **JSON API (list):** `GET https://app.dover.com/api/v1/careers-page/{clientId}/jobs?limit={N}&offset={M}` → DRF-style `{count, next, previous, results[]}` (default limit=300; pagination verified).
- **JSON API (company):** `GET https://app.dover.com/api/v1/careers-page/{clientId}` → `{id, slug, name, logo, careers_page_info}`
- **Verified:** People Services, Inc. (`184b9017-8674-41f6-90f9-e7f231ca911e`) → `count: 3`, real jobs with `id`, `locations[]`, `workplace_type` (ONSITE/REMOTE), `is_published`.
- **Notes:** **List has no descriptions or posted dates** — good for discovery/counts, thin for fit matching. Boards discoverable via `site:app.dover.com careers` search; modest volume (~60+ historical customers, hundreds of employers max). Invalid IDs → clean 404. No rate limits observed.

## 7. Phenom — FEASIBLE* (embedded SEO JSON, no JSON endpoint)

- **Human page:** `https://{careers-host}/{locale}/{lang}/search-results` (e.g. `https://careers.honda.com/us/en/search-results`, `https://careers.abb/global/en/search-results`)
- **Data source:** the page HTML embeds an `eagerLoadRefineSearch` JSON blob (SEO eager-load). GET page with browser UA → brace-match from the `"eagerLoadRefineSearch"` key → jobs at `blob.data.jobs[]`, count at `blob.totalHits`.
- **Verified:** Honda → 280 hits, 10/page ("District Parts & Service Sr. Specialist", jobId 12866, posted 2026-09-30); ABB → 2160 hits. Pagination `?keywords=&from={N}&s=1` verified disjoint (page size 10; `start`/`num` ignored).
- **Notes:** Fields: `title`, `jobId`/`reqId`, `postedDate` (prefer over detail JSON-LD `datePosted`, which can drift), `city`/`state`/`country`/`cityStateCountry`, `department`, `type`, `descriptionTeaser`, `salary`, `latitude`/`longitude`. Detail pages carry schema.org `JobPosting` JSON-LD. Phenom's internal `widgets` API is not publicly documented. Some tenants sit behind bot protection — Honda/ABB answered plain curl; re-verify per tenant, keep requests minimal.

## 8. Paylocity — FEASIBLE* (embedded JSON, no JSON endpoint)

- **Human page:** `https://recruiting.paylocity.com/recruiting/jobs/All/{companyGuid}` (optional trailing slug). Official `api.paylocity.com/recruiting/v2/api/feed/jobs/` needs OAuth — does NOT count.
- **Data source:** page HTML contains `window.pageData = {...};` with the full job list. GET with browser UA (follow redirects; GET not HEAD) → quote/escape-aware brace-match from `window.pageData =` (descriptions contain semicolons/braces — naive regex fails).
- **Verified:** City of Columbia (`8f0bcd76-3ee7-42f2-b040-83afc6e6d564`) → 10 real jobs. Detail: `/Recruiting/Jobs/Details/{JobId}/{companyGuid}` (both segments required; JobId alone 500s) → 200. Posting URL: `/Recruiting/Jobs/Details/{JobId}`.
- **Notes:** `pageData.Jobs[]`: `JobId`, `JobTitle`, `LocationName`, `PublishedDate` (ISO+offset), `HiringDepartment`, `IsRemote`, `IsInternal` (**filter `false`** — internal postings must be excluded), `JobLocation{City,State,Zip}`. No pagination — one GET returns the full board. GUIDs not derivable from domains — harvest from careers-page links or Wayback CDX (Sep-2026 study: 16,936 candidate boards, 10,789 live, 146,046 jobs). Dead boards return 200 without `pageData` (or 302 → JobNotFound) — treat "pageData absent" as dead. No rate limits observed (~17k GETs in the cited study, zero refusals).

## 9. Zoho Recruit — NOT FEASIBLE as JSON API (fallbacks exist)

- **Human page:** `https://{portal}.zohorecruit.com/jobs/Careers` (page name can vary; also `zohorecruit.eu` for EU). Verified live: Cayman Airways, 5 openings.
- **Why not:** no unauthenticated JSON endpoint. The only XHR on the page is a chatbot resume-upload POST. Documented API is OAuth-gated.
- **Working fallbacks (both verified, unauthenticated):**
  - **RSS 2.0 (XML):** `GET https://{portal}.zohorecruit.com/jobs/Careers/rss` → real `<item>`s (title, deep-link, guid, pubDate, description with `Category:`/`Location:` lines). Discriminate by body: real RSS vs 49-byte `Oops! It seems that the joblist has been removed.` (alive, zero jobs) vs small HTML error (dead tenant). Used by datascry/openroles (May 2026).
  - **Embedded JSON:** page HTML has `<input type="hidden" id="jobs" value="[{&#34;Industry&#34;:...}]">` — `html.unescape` then parse; verified all 5 Cayman jobs (`Posting_Title`, `City`, `Country`, `Job_Type`, numeric `id`). Matches ever-jobs Spec 299 (June 2026).
- **Notes:** No pagination needed (full list in one request). Portal slugs discoverable via search/company links; no public directory; check both `.com` and `.eu`.

## 10. CareerPlug — NOT FEASIBLE as JSON API (HTML fallback)

- **Human page:** `https://{tenant}.careerplug.com/jobs` (verified: vytwo-technologies, ~30 jobs/page, `?page=N` pagination; zero XHR/`.json` on the page).
- **Why not:** server-rendered HTML only. `Accept: application/json` and `/jobs.json` → **HTTP 406 `{"error":"not_acceptable"}`**. Matches 2025–2026 GitHub sources (ever-jobs, freehire, openroles) — all HTML-scrape.
- **Fallback if wanted:** parse the HTML job table (`<a aria-label="Title in City, ST" href="/jobs/{id}">`, ~30/page, stop on repeat) → per-job `/jobs/{id}` pages carry schema.org `JobPosting` JSON-LD (title, datePosted, hiringOrganization — verified on ahu-technologies-inc). Tenant subdomains need external discovery (no directory).

## 11. Dayforce / Ceridian — NOT FEASIBLE

- **Human page:** `https://jobs.dayforcehcm.com/{culture}/{clientNamespace}/CANDIDATEPORTAL` (verified HTTP 200; HTML has no job data — `__NEXT_DATA__` is metadata only).
- **Why not:** the JSON route exists — `POST https://jobs.dayforcehcm.com/api/geo/{clientNamespace}/jobposting/search` (`{"clientNamespace","jobBoardCode":"CANDIDATEPORTAL","cultureCode":"en-US","paginationStart":0}` → `{jobPostings[], maxCount, count}`, 25/page) — but **Cloudflare edge-returns HTTP 403** on every plain-HTTP POST regardless of UA, headers, cookies, or TLS impersonation (curl_cffi tested). Block is pre-routing; no token obtainable via plain fetch. Legacy shards (`us60.` etc.) 301→500. Corroborated by ever-jobs docs (~Sep 2026).
- **Would need:** a real browser session / Cloudflare-passing client — outside the sweeper's no-browser model. Endpoint pattern is documented above for a future browser-fingerprint layer.

---

## Recommended implementation order (easiest first)

1. **Hireology** — single GET, clean JSON, inline descriptions.
2. **ADP** — single GET, clean JSON, OData pagination.
3. **Dover** — single GET, clean JSON (thin payload).
4. **UKG/UltiPro** — JSON POST, clean API.
5. **SuccessFactors** — JSON POST, locale discovery + per-tenant CSRF variance.
6. **BrassRing** — 2-step flow, anti-forgery token + session cookie.
7. **Phenom / Paylocity** — single GET + embedded-JSON extraction (brace matcher).
8. **Zoho Recruit** — RSS XML feed (or embedded-JSON decode).
9. **CareerPlug** — HTML table + JSON-LD (only if HTML scraping is ever accepted).
10. **Dayforce** — blocked; revisit only with a browser-fingerprint layer.

*Not researched (per scope): Gem, Polymer, Join (sourcing tools, no public boards); Indeed, Naukri (aggregators).*
