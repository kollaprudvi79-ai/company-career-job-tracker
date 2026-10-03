import { readFile, writeFile } from 'node:fs/promises';
import { classify, enrichJob, isoDate, isUsJob, normalizeCompany, remoteAssessment, tsentaProfile } from './job-utils.mjs';

const sources = JSON.parse(await readFile(new URL('../directory-sources.json', import.meta.url)));
let previous = { jobs: [] };
try { previous = JSON.parse(await readFile(new URL('../jobs.json', import.meta.url))); } catch {}
let collectorState = {};
try { collectorState = JSON.parse(await readFile(new URL('../collector-state.json', import.meta.url))); } catch {}
let appliedCompanies = [];
try { appliedCompanies = JSON.parse(await readFile(new URL('../applied-companies.json', import.meta.url))); } catch {}
const appliedSet = new Set(appliedCompanies.map(normalizeCompany));
const appliedTokens = new Set(appliedCompanies.map(x => normalizeCompany(x).replace(/\s+/g, '')));

function safe(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
function boardUrl(source) {
  if (source.type === 'workday') return `https://${source.token}`;
  if (source.type === 'icims') return `https://${source.token}/`;
  if (source.type === 'oracle') { const [host, site] = source.token.split('/'); return `https://${host}/hcmUI/CandidateExperience/en/sites/${site}`; }
  const slug = encodeURIComponent(source.token);
  if (source.type === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
  if (source.type === 'lever') return `https://jobs.lever.co/${slug}`;
  if (source.type === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
  if (source.type === 'smartrecruiters') return `https://jobs.smartrecruiters.com/${slug}`;
  if (source.type === 'workable') return `https://apply.workable.com/${slug}`;
  if (source.type === 'recruitee') return `https://${slug}.recruitee.com/`;
  if (source.type === 'breezy') return `https://${slug}.breezy.hr/`;
  if (source.type === 'bamboohr') return `https://${slug}.bamboohr.com/careers/`;
  if (source.type === 'teamtailor') return `https://${slug}.teamtailor.com/`;
  if (source.type === 'personio') return `https://${slug}.jobs.personio.com/`;
  if (source.type === 'pinpoint') return `https://${slug}.pinpointhq.com/`;
  if (source.type === 'rippling') return `https://ats.rippling.com/${slug}/jobs`;
  if (source.type === 'jazzhr') return `https://${slug}.applytojob.com/apply`;
  if (source.type === 'jobvite') return `https://jobs.jobvite.com/${slug}`;
  return null;
}
function requestFor(source) {
  const slug = encodeURIComponent(source.token);
  if (source.type === 'greenhouse') return { url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, options: {} };
  if (source.type === 'ashby') return { url: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, options: {} };
  if (source.type === 'lever') return { url: `https://api.lever.co/v0/postings/${slug}?mode=json`, options: {} };
  if (source.type === 'smartrecruiters') return { url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=0`, options: {} };
  if (source.type === 'workable') return { url: `https://apply.workable.com/api/v1/widget/accounts/${slug}`, options: {} };
  if (source.type === 'recruitee') return { url: `https://${slug}.recruitee.com/api/offers/`, options: {} };
  if (source.type === 'breezy') return { url: `https://${slug}.breezy.hr/json`, options: {} };
  if (source.type === 'bamboohr') return { url: `https://${slug}.bamboohr.com/careers/list`, options: {} };
  if (source.type === 'teamtailor') return { url: `https://${slug}.teamtailor.com/jobs.json`, options: {} };
  if (source.type === 'personio') return { url: `https://${slug}.jobs.personio.com/search.json`, options: {} };
  if (source.type === 'pinpoint') return { url: `https://${slug}.pinpointhq.com/postings.json`, options: {} };
  if (source.type === 'rippling') return { url: `https://ats.rippling.com/api/v1/board/${slug}/jobs`, options: {} };
  if (source.type === 'jazzhr') return { url: `https://${slug}.applytojob.com/apply`, options: {}, html: true };
  if (source.type === 'jobvite') return { url: `https://jobs.jobvite.com/${slug}/jobs`, options: {}, html: true };
  if (source.type === 'icims') return { url: `https://${source.token}/jobs/search?ss=1&in_iframe=1`, options: {}, html: true };
  if (source.type === 'oracle') {
    const [host, site] = source.token.split('/');
    if (!host || !site) throw Error('Invalid Oracle board reference');
    return { url: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation,requisitionList.secondaryLocations&finder=findReqs;siteNumber=${encodeURIComponent(site)},sortBy=POSTING_DATES_DESC&limit=25`, options: {} };
  }
  if (source.type === 'workday') {
    const [host, tenant, site] = source.token.split('/');
    if (!host || !tenant || !site) throw Error('Invalid Workday board reference');
    return { url: `https://${host}/wday/cxs/${tenant}/${site}/jobs`, options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }) } };
  }
  throw Error('Unsupported ATS');
}
function listFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items) && data.items[0]?.requisitionList) return data.items[0].requisitionList;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.jobs)) return data.jobs;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.offers)) return data.offers;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.jobPostings)) return data.jobPostings;
  return null;
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function locationNear(html, fromIdx) {
  const window = stripTags(html.slice(fromIdx, fromIdx + 600));
  const m = window.match(/\b(Remote(?:\s*[-,]\s*[A-Z]{2})?|[A-Z][A-Za-z .]{1,40},\s*[A-Z]{2}\b|US-[A-Z]{2}-[A-Za-z .]{2,30})/);
  return m ? m[1].trim() : 'Not listed';
}
function parseHtmlJobs(x, html) {
  const out = [];
  const seen = new Set();
  const push = (title, url, location) => {
    title = stripTags(title);
    if (!title || title.length < 3 || title.length > 140) return;
    if (/^(apply|apply now|view|view job|learn more|back|home|skip)/i.test(title)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, location: location || 'Not listed' });
  };
  if (x.type === 'jazzhr') {
    const re = /<a\s[^>]*href="((?:https:\/\/[a-z0-9-]+\.applytojob\.com)?\/apply\/[A-Za-z0-9]+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1].startsWith('http') ? m[1] : `https://${x.token}.applytojob.com${m[1]}`;
      push(m[2], url.split('?')[0], locationNear(html, re.lastIndex));
    }
  } else if (x.type === 'icims') {
    const re = /<a\s[^>]*href="(https:\/\/[a-z0-9.-]+\.icims\.com\/jobs\/\d+\/[^"]*?\/job[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) push(m[2], m[1].split('?')[0], locationNear(html, re.lastIndex));
  } else if (x.type === 'jobvite') {
    const re = /<a\s[^>]*href="(\/[a-z0-9-]+\/job\/[A-Za-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const inAnchor = m[2].match(/jv-job-location[^>]*>([^<]+)/i);
      const titleHtml = inAnchor ? m[2].replace(/<[^>]*jv-job-location[^>]*>[^<]*<\/?[a-z]+>/i, ' ') : m[2];
      const after = !inAnchor ? html.slice(re.lastIndex, re.lastIndex + 600).match(/jv-job-location[^>]*>([^<]+)/i) : null;
      push(titleHtml, `https://jobs.jobvite.com${m[1]}`, inAnchor ? stripTags(inAnchor[1]) : after ? stripTags(after[1]) : locationNear(html, re.lastIndex));
    }
  }
  return out;
}
function isAlreadyApplied(source) {
  const byName = appliedSet.has(normalizeCompany(source.company));
  const byToken = appliedTokens.has(normalizeCompany(source.token).replace(/\s+/g, '')) || appliedTokens.has(String(source.token || '').toLowerCase());
  return byName || byToken;
}
function finish(base, description, structuredSalaryText, checked) {
  const job = enrichJob({ ...base, checked, alreadyApplied: isAlreadyApplied(base) }, { description, structuredSalaryText }, Date.now());
  return { ...job, tsentaProfile: tsentaProfile(job.role) };
}
function normalize(j, x, checked) {
  let base = null;
  let description = '';
  let structuredSalaryText = '';
  if (x.type === 'greenhouse') {
    const title = j.title || '';
    description = j.content || '';
    base = { id: `${x.type}:${x.token}:${j.id || j.absolute_url}`, company: x.company, source: x.type, title, role: classify(title, description), location: j.location?.name || 'Not listed', workplace: null, salary: null, published: isoDate(j.first_published), publishedMeaning: 'Original first publication from Greenhouse first_published', applyUrl: safe(j.absolute_url) };
  } else if (x.type === 'ashby') {
    const title = j.title || '';
    description = j.descriptionPlain || j.descriptionHtml || '';
    structuredSalaryText = j.compensation?.scrapeableCompensationSalarySummary || '';
    const location = j.locationName || j.location || j.location?.name || 'Not listed';
    base = { id: `${x.type}:${x.token}:${j.id || j.jobUrl || j.applyUrl}`, company: x.company, source: x.type, title, role: classify(title, description), location, workplace: j.workplaceType || null, isRemote: j.isRemote, salary: structuredSalaryText || null, published: isoDate(j.publishedAt), publishedMeaning: 'Ashby publishedAt; may be a republication', applyUrl: safe(j.applyUrl || j.jobUrl) };
  } else if (x.type === 'lever') {
    const title = j.text || '';
    description = j.descriptionPlain || j.description || '';
    structuredSalaryText = j.salaryRange ? `${j.salaryRange.min}–${j.salaryRange.max} ${j.salaryRange.currency || ''}` : '';
    const locations = j.categories?.allLocations?.length ? j.categories.allLocations.join('; ') : j.categories?.location;
    base = { id: `${x.type}:${x.token}:${j.id || j.hostedUrl}`, company: x.company, source: x.type, title, role: classify(title, description), location: locations || 'Not listed', workplace: j.workplaceType || null, salary: structuredSalaryText || null, published: isoDate(j.createdAt), publishedMeaning: 'Original creation timestamp from Lever createdAt', applyUrl: safe(j.applyUrl || j.hostedUrl) };
  } else if (x.type === 'smartrecruiters') {
    const title = j.name || '';
    description = j.jobAd?.sections?.jobDescription?.text || j.jobAd?.sections?.qualifications?.text || '';
    const loc = j.location ? [j.location.city, j.location.region, j.location.country].filter(Boolean).join(', ') : 'Not listed';
    base = { id: `${x.type}:${x.token}:${j.id}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc || 'Not listed', workplace: j.location?.remote ? 'remote' : null, isRemote: Boolean(j.location?.remote), salary: null, published: isoDate(j.releasedDate || j.createdOn || j.postingDate), publishedMeaning: 'SmartRecruiters posting release/creation timestamp', applyUrl: safe(`https://jobs.smartrecruiters.com/${encodeURIComponent(x.token)}/${encodeURIComponent(j.id || '')}`) };
  } else if (x.type === 'workable') {
    const title = j.title || '';
    description = j.description || j.description_html || '';
    const loc = j.location ? (typeof j.location === 'string' ? j.location : [j.location.city, j.location.region, j.location.country].filter(Boolean).join(', ')) : ([j.city, j.state, j.country].filter(Boolean).join(', ') || 'Not listed');
    base = { id: `${x.type}:${x.token}:${j.shortcode || j.id || j.url}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc || 'Not listed', workplace: j.workplace || (j.telecommuting || j.remote ? 'remote' : null), isRemote: Boolean(j.telecommuting || j.remote), salary: null, published: isoDate(j.published_at || j.published_on || j.created_at), publishedMeaning: 'Workable publication timestamp when supplied', applyUrl: safe(j.application_url || j.url || j.shortlink) };
  } else if (x.type === 'recruitee') {
    const title = j.title || '';
    description = j.description || '';
    const loc = j.location || [j.city, j.state, j.country].filter(Boolean).join(', ') || 'Not listed';
    base = { id: `${x.type}:${x.token}:${j.id || j.careers_url}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc, workplace: j.remote ? 'remote' : null, isRemote: Boolean(j.remote), salary: null, published: isoDate(j.published_at || j.created_at), publishedMeaning: 'Recruitee publication timestamp when supplied', applyUrl: safe(j.careers_apply_url || j.careers_url || j.apply_url) };
  } else if (x.type === 'breezy') {
    const title = j.name || j.title || '';
    description = j.description || '';
    const loc = typeof j.location === 'string' ? j.location : (j.location?.name || 'Not listed');
    base = { id: `${x.type}:${x.token}:${j.id || j.url}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc, workplace: j.location?.is_remote ? 'remote' : null, isRemote: Boolean(j.location?.is_remote), salary: null, published: isoDate(j.published_date || j.published_at), publishedMeaning: 'Breezy publication timestamp when supplied', applyUrl: safe(j.apply_url || j.url) };
  } else if (x.type === 'bamboohr') {
    const title = j.jobOpeningName || j.title || '';
    description = j.description || '';
    base = { id: `${x.type}:${x.token}:${j.id || j.jobOpeningUrl}`, company: x.company, source: x.type, title, role: classify(title, description), location: j.locationName || j.location || 'Not listed', workplace: null, salary: null, published: isoDate(j.datePosted || j.createdDate), publishedMeaning: 'BambooHR posting date when supplied', applyUrl: safe(j.jobOpeningUrl || j.url) };
  } else if (x.type === 'teamtailor') {
    const title = j.title || '';
    description = j.content_html || '';
    base = { id: `${x.type}:${x.token}:${j.id || j.url}`, company: x.company, source: x.type, title, role: classify(title, description), location: 'Not listed', workplace: null, salary: null, published: isoDate(j.date_published), publishedMeaning: 'Teamtailor publication timestamp', applyUrl: safe(j.url) };
  } else if (x.type === 'personio') {
    const title = j.name || '';
    description = j.description || '';
    const loc = (j.offices && j.offices.length ? j.offices.join('; ') : j.office) || 'Not listed';
    base = { id: `${x.type}:${x.token}:${j.id}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc, workplace: null, salary: null, published: null, publishedMeaning: 'Personio search feed does not expose a publication date', applyUrl: safe(`https://${x.token}.jobs.personio.com/job/${encodeURIComponent(j.id || '')}`) };
  } else if (x.type === 'workday') {
    const title = j.title || '';
    const [host, , site] = x.token.split('/');
    let published = null;
    const posted = String(j.postedOn || '');
    if (/today/i.test(posted)) published = new Date().toISOString();
    else if (/yesterday/i.test(posted)) published = new Date(Date.now() - 86400000).toISOString();
    else { const m = posted.match(/(\d+)\+?\s*days?/i); if (m) published = new Date(Date.now() - Number(m[1]) * 86400000).toISOString(); }
    base = { id: `${x.type}:${x.token}:${j.bulletFields?.[0] || j.externalPath || title}`, company: x.company, source: x.type, title, role: classify(title, ''), location: j.locationsText || 'Not listed', workplace: null, salary: null, published, publishedMeaning: 'Workday relative posting label converted to an approximate date', applyUrl: safe(`https://${host}/${site}${j.externalPath || ''}`) };
  } else if (x.type === 'pinpoint') {
    const title = j.title || '';
    description = j.description || '';
    const loc = j.location?.name || [j.location?.city, j.location?.province].filter(Boolean).join(', ') || 'Not listed';
    base = { id: `${x.type}:${x.token}:${j.id || j.url}`, company: x.company, source: x.type, title, role: classify(title, description), location: loc, workplace: j.workplace_type || null, salary: j.compensation_visible ? (j.compensation || null) : null, published: null, publishedMeaning: 'Pinpoint feed does not expose a publication date', applyUrl: safe(j.url) };
  } else if (x.type === 'rippling') {
    const title = j.name || '';
    base = { id: `${x.type}:${x.token}:${j.uuid || j.url}`, company: x.company, source: x.type, title, role: classify(title, ''), location: j.workLocation?.label || 'Not listed', workplace: null, salary: null, published: null, publishedMeaning: 'Rippling board feed does not expose a publication date', applyUrl: safe(j.url) };
  } else if (x.type === 'oracle') {
    const title = j.Title || '';
    if (j.Language && !/^(us|en)/i.test(String(j.Language))) return null;
    description = [j.ShortDescriptionStr, j.ExternalResponsibilitiesStr, j.ExternalQualificationsStr].filter(Boolean).join('\n');
    const [host, site] = x.token.split('/');
    const wpCode = String(j.WorkplaceTypeCode || j.WorkplaceType || '');
    const workplace = /remote/i.test(wpCode) ? 'remote' : /hybrid/i.test(wpCode) ? 'hybrid' : /onsite|on-site/i.test(wpCode) ? 'onsite' : null;
    base = { id: `${x.type}:${x.token}:${j.Id || title}`, company: x.company, source: x.type, title, role: classify(title, description), location: j.PrimaryLocation || 'Not listed', workplace, salary: null, published: isoDate(j.PostedDate), publishedMeaning: 'Oracle Recruiting PostedDate', applyUrl: safe(`https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${encodeURIComponent(j.Id || '')}`) };
  } else if (x.type === 'jazzhr' || x.type === 'icims' || x.type === 'jobvite') {
    const title = j.title || '';
    const meaning = x.type === 'jazzhr' ? 'JazzHR board page does not expose a publication date in list view' : x.type === 'icims' ? 'iCIMS board page does not expose a publication date in list view' : 'Jobvite board page does not expose a publication date in list view';
    base = { id: `${x.type}:${x.token}:${j.url}`, company: x.company, source: x.type, title, role: classify(title, ''), location: j.location || 'Not listed', workplace: null, salary: null, published: null, publishedMeaning: meaning, applyUrl: safe(j.url) };
  }
  if (!base || !base.role || !base.applyUrl) return null;
  return finish(base, description, structuredSalaryText, checked);
}

const APP_VERSION = '20261003c';
const now = Date.now();
const batch = Number(process.env.BATCH_SIZE) || 3000;
const hasEnvOffset = process.env.BATCH_OFFSET !== undefined && process.env.BATCH_OFFSET !== '';
const requestedOffset = hasEnvOffset ? Number(process.env.BATCH_OFFSET) : Number(collectorState.nextOffset);
const offset = Number.isFinite(requestedOffset) && sources.length ? ((requestedOffset % sources.length) + sources.length) % sources.length : 0;
const selected = sources.length ? Array.from({ length: Math.min(batch, sources.length) }, (_, i) => sources[(offset + i) % sources.length]) : [];
if (!selected.length) throw Error('No sources selected');
const nextOffset = sources.length ? (offset + selected.length) % sources.length : 0;
let cursor = 0;
const results = [];
async function worker() {
  while (cursor < selected.length) {
    const x = selected[cursor++];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const checked = new Date().toISOString();
    try {
      const req = requestFor(x);
      const response = await fetch(req.url, { ...req.options, signal: controller.signal, headers: { accept: req.html ? 'text/html' : 'application/json', ...(req.options.headers || {}) } });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      let list;
      if (req.html) list = parseHtmlJobs(x, await response.text());
      else {
        const data = await response.json();
        list = listFrom(data);
        // Workday CXS caps limit at 20 and board ordering is not reliably
        // newest-first; walk two more pages so fresh postings ranked past
        // page 1 are not lost.
        if (x.type === 'workday' && Array.isArray(list) && list.length >= 20 && Number(data?.total) > list.length) {
          for (const off of [20, 40]) {
            try {
              const r2 = await fetch(req.url, { ...req.options, signal: controller.signal, headers: { accept: 'application/json', ...(req.options.headers || {}) }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: off, searchText: '' }) });
              if (!r2.ok) break;
              const more = listFrom(await r2.json());
              if (!Array.isArray(more) || !more.length) break;
              list = [...list, ...more];
            } catch { break; }
          }
        }
      }
      if (!Array.isArray(list)) throw Error('Invalid feed');
      const jobs = list.map(j => normalize(j, x, checked)).filter(Boolean);
      results.push({ company: x.company, type: x.type, token: x.token, ok: true, checkedAt: checked, matched: jobs.length, jobs });
    } catch (e) {
      results.push({ company: x.company, type: x.type, token: x.token, ok: false, checkedAt: checked, error: String(e.message), matched: 0, jobs: [] });
    } finally { clearTimeout(timer); }
  }
}
await Promise.all(Array.from({ length: 12 }, () => worker()));
// Full-sweep mode: keep jobs from boards that failed this run as stale (up to
// 36h) instead of dropping them, so one flaky board doesn't wipe its jobs.
const okKeys = new Set(results.filter(r => r.ok).map(r => `${r.type}:${String(r.token || '').toLowerCase()}`));
const oldJobs = (previous.jobs || [])
  .filter(j => !okKeys.has(`${j.source}:${String(j.id || '').split(':')[1]?.toLowerCase()}`) && now - Date.parse(j.checked) < 36 * 3600000)
  .map(j => ({ ...j, stale: true }));
const jobs = [...new Map([...oldJobs, ...results.flatMap(r => r.jobs)].map(j => [j.id, j])).values()]
  .filter(j => isUsJob(j) && !(j.flags && j.flags.restricted) && remoteAssessment({ location: j.location || '', description: j.descriptionText || '' }).remoteType !== 'non-us')
  .sort((a, b) => Number(b.fit) - Number(a.fit) || (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
const statuses = results.map(({ jobs: unused, ...status }) => status);
const checkedAt = new Date().toISOString();
const recentCount = jobs.filter(j => !j.stale && j.within7d).length;
const fitCount = jobs.filter(j => j.fit).length;
const coverage = { discovered: sources.length, attempted: results.length, success: statuses.filter(s => s.ok).length, failed: statuses.filter(s => !s.ok).length, batchOffset: offset, batchSize: batch, nextOffset, rotationRuns: Math.ceil(sources.length / batch), fitCount, recent7dCount: recentCount };
await writeFile(new URL('../collector-state.json', import.meta.url), JSON.stringify({ nextOffset, updatedAt: checkedAt, batchSize: batch, discovered: sources.length }, null, 2));
await writeFile(new URL('../jobs.json', import.meta.url), JSON.stringify({ checkedAt, appVersion: APP_VERSION, jobs, statuses, recentCount, coverage, note: 'Employer ATS snapshot. Greenhouse uses first_published, Lever uses createdAt, and Ashby publishedAt may be a republication. Fit flags are computed from ATS title, location, description, salary, and applied-company data. Imported directory rows are candidates until their feed responds.' }));
console.log(JSON.stringify({ coverage, jobs: jobs.length, recentCount, fitCount }));
if (!coverage.success) process.exitCode = 1;
