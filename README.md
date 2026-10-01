# Career Radar — GitHub Pages
Static dashboard with five initial employer ATS feeds (Stripe, Robinhood, Lyft, HubSpot, 1Password). GitHub Actions collects a jobs.json snapshot every three hours (scheduled runs may be delayed) and on manual dispatch. No server-side GitHub Pages API. Front end fetches jobs.json, so it is updated when GitHub Actions commits a new snapshot and Pages publishes it. First run needed before jobs appear.

Scope: FIVE employer feeds, NOT every employer in the IBISWorld PDF. Direct URLs from public Greenhouse and Ashby feeds. Greenhouse original publication time unavailable in list feed and its jobs are under 'Date unavailable'; Ashby publishedAt may represent republication. Salaries may not be listed. Errors are visible in Source health. No sponsorship claims.

If Pages is configured main/root, visit the site after the Pages build; run 'Collect employer jobs' under Actions -> Run workflow to initialize. Scheduled refresh every three hours is best effort. Set repository Actions workflow permissions to allow contents write if the collector cannot commit snapshots. If Pages root previously pointed to Vercel, ensure dashboard loads ./jobs.json through pages.js.
