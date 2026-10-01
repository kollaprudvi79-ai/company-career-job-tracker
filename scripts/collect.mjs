import { readFile, writeFile } from 'node:fs/promises';
import { classify, enrichJob, isoDate, normalizeCompany, tsentaProfile } from './job-utils.mjs';

const sources = JSON.parse(await readFile(new URL('../sources.json', import.meta.url)));
let previous = { jobs: [], statuses: [] };
try { previous = JSON.parse(await readFile(new URL('../jobs.json', import.meta.url))); } catch {}
let appliedCompanies = [];
try { appliedCompanies = JSON.parse(await readFile(new URL('../applied-companies.json', import.meta.url))); } catch {}
const appliedSet = new Set(appliedCompanies.map(normalizeCompany));
const safe = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

async function load(source) {
  const { type, token, company } = source;
  const u = type === 'greenhouse'
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
    : type === 'lever'
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 20000);
  const checked = new Date().toISOString();
  try {
    const r = await fetch(u, { signal: c.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = Array.isArray(data) ? data : data.jobs;
    if (!Array.isArray(raw)) throw Error('Invalid jobs feed');
    const jobs = raw.filter(x => type !== 'ashby' || x.isListed !== false).map(x => {
      const title = x.title || x.text || '';
      const description = type === 'ashby' ? (x.descriptionPlain || x.descriptionHtml || '') : type === 'lever' ? (x.descriptionPlain || x.description || '') : (x.content || '');
      const role = classify(title, description);
      const applyUrl = safe(type === 'ashby' ? x.applyUrl || x.jobUrl : type === 'lever' ? x.applyUrl || x.hostedUrl : x.absolute_url);
      const structuredSalaryText = type === 'ashby' ? (x.compensation?.scrapeableCompensationSalarySummary || '') : type === 'lever' && x.salaryRange ? `${x.salaryRange.min}–${x.salaryRange.max} ${x.salaryRange.currency || ''}` : '';
      const location = type === 'ashby' ? (x.locationName || x.location || 'Not listed') : type === 'lever' ? (x.categories?.allLocations?.join('; ') || x.categories?.location || 'Not listed') : (x.location?.name || 'Not listed');
      const base = {
        id: `${type}:${token}:${x.id || applyUrl}`,
        company,
        source: type,
        title,
        role,
        location,
        workplace: type === 'ashby' || type === 'lever' ? x.workplaceType || null : null,
        isRemote: type === 'ashby' ? x.isRemote : undefined,
        salary: structuredSalaryText || null,
        published: type === 'ashby' ? isoDate(x.publishedAt) : type === 'lever' ? isoDate(x.createdAt) : isoDate(x.first_published),
        publishedMeaning: type === 'ashby' ? 'Ashby publishedAt; may be a republication' : type === 'lever' ? 'Original creation timestamp from Lever createdAt' : 'Original first publication from Greenhouse first_published',
        applyUrl,
        checked,
        alreadyApplied: appliedSet.has(normalizeCompany(company)),
      };
      const job = enrichJob(base, { description, structuredSalaryText }, Date.now());
      return { ...job, tsentaProfile: tsentaProfile(job.role) };
    }).filter(x => x.role && x.applyUrl);
    return { status: { company, type, token, ok: true, checkedAt: checked, matched: jobs.length }, jobs };
  } catch (e) {
    return { status: { company, type, token, ok: false, checkedAt: checked, error: String(e.message), matched: 0 }, jobs: [] };
  } finally { clearTimeout(timer); }
}

const results = await Promise.all(sources.map(load));
const successful = results.filter(r => r.status.ok);
let jobs = results.flatMap(r => r.jobs);
for (const r of results.filter(r => !r.status.ok)) jobs.push(...(previous.jobs || []).filter(j => j.company === r.status.company && Date.now() - Date.parse(j.checked) < 86400000).map(j => ({ ...j, stale: true })));
jobs = [...new Map(jobs.map(j => [j.id, j])).values()].sort((a, b) => Number(b.fit) - Number(a.fit) || (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
const statuses = results.map(r => r.status);
const checkedAt = new Date().toISOString();
const snapshot = { checkedAt, jobs, statuses, note: 'Seed-feed snapshot. Greenhouse uses first_published, Lever uses createdAt, and Ashby publishedAt may be a republication.', recentCount: jobs.filter(j => !j.stale && j.within7d).length, coverage: { discovered: sources.length, attempted: statuses.length, success: successful.length, failed: statuses.length - successful.length, fitCount: jobs.filter(j => j.fit).length } };
await writeFile(new URL('../jobs.json', import.meta.url), JSON.stringify(snapshot));
console.log(JSON.stringify({ checkedAt, successful: successful.length, total: sources.length, jobs: jobs.length, failures: statuses.filter(s => !s.ok) }));
if (!successful.length) process.exitCode = 1;
