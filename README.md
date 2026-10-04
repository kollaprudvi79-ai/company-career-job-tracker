# Career Radar

Job tracker for Data Analyst, Data Engineer, Data Scientist, AI Engineer, and Full Stack .NET roles. It reads employer ATS feeds directly — no aggregators — and publishes a static dashboard to GitHub Pages.

## Directory sources

The board directory (`directory-sources.json`) is rebuilt by `scripts/ingest.mjs` from public ATS inventories:

- **LastRound AI ATS Company Directory** (August 2026), CC BY 4.0 — https://github.com/fyrosofttech/lastroundai-hiring-data (https://creativecommons.org/licenses/by/4.0/)
- **kalil0321/ats-scrapers** company inventories, MIT License — https://github.com/kalil0321/ats-scrapers
- **IBISWorld company list** (Prudhvi's own reference list, `ibis-companies.json`): companies are matched to boards already in the inventories by name; the rest are resolved by `scripts/resolve-ibis.mjs`, which accepts a guessed Greenhouse token **only** when the board-info endpoint returns a matching company name (verified attribution) and writes `ibis-boards.json`.

The snapshot is **USA-only**: jobs whose primary location or description marks them outside the US are dropped before publishing; US-onsite and location-unknown jobs remain for review, and the fit view still requires verified US remote.

Imported boards are **candidates**, not verified active feeds: a board only counts as monitored after its feed responds in a collection batch. Staffing/consulting firms on a conservative exclusion list (`scripts/employer-filter.mjs`) are removed before publishing.

Currently imports candidate boards across 27 ATS platforms: Greenhouse, Ashby, Lever, SmartRecruiters, Workable, Recruitee, Breezy, BambooHR, Teamtailor, Personio, Pinpoint, Rippling, JazzHR, Jobvite, iCIMS, Oracle, Workday, Hireology, ADP, Dover, UKG/UltiPro, SuccessFactors, BrassRing, Phenom, Paylocity, Zoho Recruit, and CareerPlug. Dayforce is excluded — its JSON API is Cloudflare-blocked from plain-HTTP clients. This is deliberately **not** a "100,000+ companies" claim — only boards with a public feed the collector can actually read are included.

## Collection

`.github/workflows/collect-jobs.yml` runs every 3 hours (and on demand):

1. `scripts/ingest.mjs` — rebuilds the directory
2. `scripts/collect-large.mjs` — checks one rotating batch of boards (default 3,000; rotation position persists in `collector-state.json`, so the full directory is covered in turn), normalizes postings, and writes `jobs.json`
3. `scripts/filter-directory.mjs` — applies employer exclusions to the snapshot before commit

Freshness semantics per ATS:

- **Greenhouse**: `first_published` from the `?content=true` list feed (original publication)
- **Lever**: `createdAt` from the postings feed (original creation)
- **Ashby**: `publishedAt` (may be a republication)
- **Workday**: relative `postedOn` label converted to an approximate date
- Teamtailor/Personio/BambooHR etc.: feed timestamp where the ATS exposes one; otherwise "date unavailable"

Each job is annotated by `scripts/job-utils.mjs` with: a role lane (Data Engineer / Data Scientist / AI Engineer / Data Analyst / Full Stack .NET) and matching Tsenta profile, US-remote verification from primary-location fields, parsed salary range, and flags for excluded title levels, internships, Java/Spring-centric JDs, stated sponsorship restrictions, government/clearance/citizenship restrictions, high experience asks, below-$125k listed salary, and companies already applied to (`applied-companies.json`). A job is marked **fit** only when it is fresh within 7 days, verifiably US-remote, and clear of every block — the dashboard defaults to that fit view.

## Hosting

GitHub Pages (workflow `.github/workflows/deploy-pages.yml`) is the live deployment. `vercel.json`/`api/jobs.js` remain as an optional serverless variant over the seed feeds in `sources.json` (Stripe, Robinhood, Lyft, HubSpot, 1Password).

Manual run: repository Actions → Collect employer jobs → Run workflow.
