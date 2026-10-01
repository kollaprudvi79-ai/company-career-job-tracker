import sources from '../sources.json' with { type: 'json' };
import { classify, enrichJob, isoDate, tsentaProfile } from '../scripts/job-utils.mjs';

const safe = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const load = async source => {
  const { type, token, company } = source;
  const u = type === 'greenhouse'
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
    : type === 'lever'
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  const checked = new Date().toISOString();
  try {
    const r = await fetch(u, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = Array.isArray(data) ? data : data.jobs;
    if (!Array.isArray(raw)) throw Error('Invalid feed');
    const jobs = raw.filter(x => type !== 'ashby' || x.isListed !== false).map(x => {
      const title = x.title || x.text || '';
      const description = type === 'ashby' ? (x.descriptionPlain || x.descriptionHtml || '') : type === 'lever' ? (x.descriptionPlain || x.description || '') : (x.content || '');
      const role = classify(title, description);
      const link = safe(type === 'ashby' ? x.applyUrl || x.jobUrl : type === 'lever' ? x.applyUrl || x.hostedUrl : x.absolute_url);
      const structuredSalaryText = type === 'ashby' ? (x.compensation?.scrapeableCompensationSalarySummary || '') : type === 'lever' && x.salaryRange ? `${x.salaryRange.min}–${x.salaryRange.max} ${x.salaryRange.currency || ''}` : '';
      const location = type === 'ashby' ? (x.locationName || x.location || 'Not listed') : type === 'lever' ? (x.categories?.allLocations?.join('; ') || x.categories?.location || 'Not listed') : (x.location?.name || 'Not listed');
      const base = {
        id: `${type}:${token}:${x.id || link}`,
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
        checked,
        applyUrl: link,
      };
      const job = enrichJob(base, { description, structuredSalaryText }, Date.now());
      return { ...job, tsentaProfile: tsentaProfile(job.role) };
    }).filter(x => x.role && x.applyUrl);
    return { status: { company, type, token, ok: true, checkedAt: checked, matched: jobs.length }, jobs };
  } catch (e) {
    return { status: { company, type, token, ok: false, checkedAt: checked, error: String(e.message), matched: 0 }, jobs: [] };
  } finally { clearTimeout(timer); }
};

export default async function handler(req, res) {
  const results = await Promise.all(sources.map(load));
  const jobs = [...new Map(results.flatMap(r => r.jobs).map(j => [j.id, j])).values()];
  const now = Date.now();
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=300');
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    jobs: jobs.sort((a, b) => Number(b.fit) - Number(a.fit) || (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0)),
    statuses: results.map(r => r.status),
    note: 'Greenhouse uses first_published, Lever uses createdAt, and Ashby publishedAt may be a republication. Fit flags are computed from ATS fields and descriptions.',
    recentCount: jobs.filter(j => j.within7d).length,
  });
}
