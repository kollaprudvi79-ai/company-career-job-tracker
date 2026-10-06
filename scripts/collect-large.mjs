import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessJob, classify, enrichJob, isoDate, isUsJob, normalizeCompany, remoteAssessment, tsentaProfile } from './job-utils.mjs';
import { isExtraType, extraBoardUrl, fetchExtraJobs, normalizeExtraJob } from './ats-extra.mjs';

const sources = JSON.parse(await readFile(new URL('../directory-sources.json', import.meta.url)));
let previous = { jobs: [] };
try { previous = JSON.parse(await readFile(new URL('../jobs.json', import.meta.url))); } catch {}
// Historical date repair map (built Oct 6 2026): job id -> earliest commit
// timestamp containing it. Used in buildSnapshot() to restore true first-seen
// dates and clamp polluted Workday published dates. Stored as chunks
// (first-seen-map-00.json ...) due to push size limits; missing = no-op.
let dateRepairMap = {};
try { dateRepairMap = JSON.parse(await readFile(new URL('../first-seen-map.json', import.meta.url))); }
catch {
  for (let i = 0; i < 12; i++) {
    try { Object.assign(dateRepairMap, JSON.parse(await readFile(new URL(`../first-seen-map-${String(i).padStart(2, '0')}.json`, import.meta.url)))); }
    catch { break; }
  }
}
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
  const extra = extraBoardUrl(source);
  if (extra) return extra;
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
function finish(x, base, description, structuredSalaryText, checked) {
  const job = enrichJob({ ...base, checked, alreadyApplied: isAlreadyApplied(base) }, { description, structuredSalaryText }, Date.now());
  return { ...job, tsentaProfile: tsentaProfile(job.role), boardKey: `${x.type}:${String(x.token || '').toLowerCase()}` };
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
  } else if (isExtraType(x.type)) {
    const r = normalizeExtraJob(j, x, checked);
    if (!r) return null;
    base = r.base;
    description = r.description || '';
    structuredSalaryText = r.structuredSalaryText || '';
  }
  if (!base || !base.role || !base.applyUrl) return null;
  return finish(x, base, description, structuredSalaryText, checked);
}

const APP_VERSION = '20261004b';
const now = Date.now();
const batch = Number(process.env.BATCH_SIZE) || 3000;
const hasEnvOffset = process.env.BATCH_OFFSET !== undefined && process.env.BATCH_OFFSET !== '';
const requestedOffset = hasEnvOffset ? Number(process.env.BATCH_OFFSET) : Number(collectorState.nextOffset);
const offset = Number.isFinite(requestedOffset) && sources.length ? ((requestedOffset % sources.length) + sources.length) % sources.length : 0;
const selected = sources.length ? Array.from({ length: Math.min(batch, sources.length) }, (_, i) => sources[(offset + i) % sources.length]) : [];
if (!selected.length) throw Error('No sources selected');
// Board prioritization: sort by historical yield (matching jobs per board) so
// high-value boards are checked first. If sweep is interrupted, the best boards
// are already done. Yield from previous jobs.json boardKey counts.
try {
  const prevJobs = JSON.parse(await readFile(new URL('../jobs.json', import.meta.url), 'utf8'));
  const yieldMap = new Map();
  for (const j of (prevJobs.jobs || [])) {
    const bk = j.boardKey;
    if (bk) yieldMap.set(bk, (yieldMap.get(bk) || 0) + 1);
  }
  selected.sort((a, b) => {
    const ya = yieldMap.get(`${a.type}:${a.token}`) || 0;
    const yb = yieldMap.get(`${b.type}:${b.token}`) || 0;
    return yb - ya; // descending: high-yield first
  });
  console.log(`Prioritized ${selected.length} boards by yield (${yieldMap.size} boards have history)`);
} catch (e) {
  console.log('Board prioritization skipped (no previous jobs.json):', String((e && e.message) || e).slice(0, 100));
}
const nextOffset = sources.length ? (offset + selected.length) % sources.length : 0;
let cursor = 0;
const results = [];
async function worker() {
  while (cursor < selected.length) {
    const x = selected[cursor++];
    const controller = new AbortController();
    // Extra ATS types run multi-step flows (handshakes, pagination, detail
    // fetches) — give them a longer per-board budget.
    const timer = setTimeout(() => controller.abort(), isExtraType(x.type) ? 60000 : 12000);
    const checked = new Date().toISOString();
    try {
      let list;
      if (isExtraType(x.type)) {
        list = await fetchExtraJobs(x, controller.signal);
      } else {
      const req = requestFor(x);
      const response = await fetch(req.url, { ...req.options, signal: controller.signal, headers: { accept: req.html ? 'text/html' : 'application/json', ...(req.options.headers || {}) } });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      if (req.html) list = parseHtmlJobs(x, await response.text());
      else {
        const data = await response.json();
        list = listFrom(data);
        // Workday: use targeted searches for data roles instead of blind pagination.
        // Generic fetch misses data jobs on large boards (e.g., McKesson 630 jobs, we saw 60).
        // Search "data" catches data engineer/scientist/analyst/AI roles; ".net" catches .NET devs.
        if (x.type === 'workday') {
          const [host, tenant, site] = x.token.split('/');
          const wdUrl = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
          const wdHeaders = { accept: 'application/json', 'content-type': 'application/json' };
          async function wdSearch(term, maxPages) {
            const out = [];
            for (let pg = 0; pg < maxPages; pg++) {
              try {
                const r = await fetch(wdUrl, { method: 'POST', signal: controller.signal, headers: wdHeaders,
                  body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: pg * 20, searchText: term }) });
                if (!r.ok) break;
                const d = await r.json();
                const items = listFrom(d);
                if (!Array.isArray(items) || !items.length) break;
                out.push(...items);
                if (out.length >= Number(d?.total || 0)) break;
              } catch { break; }
            }
            return out;
          }
          try {
            const dataJobs = await wdSearch('data', 5);   // up to 100 data-role jobs
            const netJobs = await wdSearch('.net', 2);    // up to 40 .NET jobs
            // Deduplicate by requisition ID, prefer data-search results
            const seen = new Set();
            list = [];
            for (const j of [...dataJobs, ...netJobs]) {
              const key = j?.bulletFields?.[0] || j?.externalPath || j?.title;
              if (key && !seen.has(key)) { seen.add(key); list.push(j); }
            }
          } catch { /* fall back to generic list from initial fetch */ }
        }
        // SmartRecruiters: paginate when more than 100 jobs exist. Cap at 300.
        if (x.type === 'smartrecruiters' && Array.isArray(list) && list.length >= 100 && Number(data?.totalFound) > list.length) {
          const total = Number(data.totalFound);
          const maxJobs = Math.min(total, 300);
          const slug = encodeURIComponent(x.token);
          for (let off = 100; off < maxJobs; off += 100) {
            try {
              const r2 = await fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${off}`, { signal: controller.signal, headers: { accept: 'application/json' } });
              if (!r2.ok) break;
              const more = listFrom(await r2.json());
              if (!Array.isArray(more) || !more.length) break;
              list = [...list, ...more];
            } catch { break; }
          }
        }
        // Oracle: paginate when more than 25 jobs exist. Cap at 150.
        if (x.type === 'oracle' && Array.isArray(list) && list.length >= 25) {
          const [host, site] = x.token.split('/');
          for (let off = 25; off < 150; off += 25) {
            try {
              const r2 = await fetch(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation,requisitionList.secondaryLocations&finder=findReqs;siteNumber=${encodeURIComponent(site)},sortBy=POSTING_DATES_DESC&limit=25&offset=${off}`, { signal: controller.signal, headers: { accept: 'application/json' } });
              if (!r2.ok) break;
              const d2 = await r2.json();
              const more = listFrom(d2);
              if (!Array.isArray(more) || !more.length) break;
              list = [...list, ...more];
            } catch { break; }
          }
        }
      } // end inner else (JSON branch)
      } // end outer else (standard single-request types)
      if (!Array.isArray(list)) throw Error('Invalid feed');
      const jobs = list.map(j => normalize(j, x, checked)).filter(Boolean);
      results.push({ company: x.company, type: x.type, token: x.token, ok: true, checkedAt: checked, matched: jobs.length, jobs });
    } catch (e) {
      results.push({ company: x.company, type: x.type, token: x.token, ok: false, checkedAt: checked, error: String(e.message), matched: 0, jobs: [] });
    } finally { clearTimeout(timer); }
    // Live progress streaming: every PROGRESS_EVERY boards, write a partial
    // snapshot and push it so the site updates during the run, not just after.
    if (results.length - lastFlushCount >= PROGRESS_EVERY) {
      lastFlushCount = results.length;
      await flushProgress();
    }
  }
}

// ---- Live progress streaming helpers ----
const PROGRESS_EVERY = Math.max(1000, Number(process.env.PROGRESS_FLUSH_EVERY) || 8000);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT_NOTE = 'Employer ATS snapshot. Greenhouse uses first_published, Lever uses createdAt, and Ashby publishedAt may be a republication. Fit flags are computed from ATS title, location, description, salary, and applied-company data. Imported directory rows are candidates until their feed responds.';
let lastFlushCount = 0;

function buildSnapshot() {
  const nowTs = Date.now();
  const nowIso = new Date(nowTs).toISOString();
  // firstSeen: timestamp this job was FIRST pulled by a sweep. Preserved across
  // runs so the site can surface genuinely new jobs per run instead of relying
  // on ATS published dates (often missing, or republications).
  // published is likewise frozen at first sight: coarse ATS labels (e.g. Workday
  // "Posted today") would otherwise re-stamp to "now" on every hourly pull,
  // making old jobs look perpetually fresh.
  const prevJobs = new Map();
  for (const j of (previous.jobs || [])) { if (j && j.id && !prevJobs.has(j.id)) prevJobs.set(j.id, j); }
  const okKeys = new Set(results.filter(r => r.ok).map(r => `${r.type}:${String(r.token || '').toLowerCase()}`));
  const oldJobs = (previous.jobs || [])
    .filter(j => !okKeys.has(j.boardKey || `${j.source}:${String(j.id || '').split(':')[1]?.toLowerCase()}`) && nowTs - Date.parse(j.checked) < 36 * 3600000)
    .map(j => ({ ...j, stale: true }));
  const jobs = [...new Map([...oldJobs, ...results.flatMap(r => r.jobs)].map(j => [j.id, j])).values()]
    .map(j => {
      const pj = prevJobs.get(j.id);
      let fs = j.firstSeen || (pj && pj.firstSeen) || j.checked || nowIso;
      let pub = (pj && pj.published) || j.published;
      let pubMean = (pj && pj.publishedMeaning) || j.publishedMeaning;
      // Historical repair (Oct 6 2026): restore the true first-seen date from
      // git history, and clamp Workday published dates that were re-stamped to
      // "now" by hourly pulls before the freeze. Idempotent: a repaired job is
      // a no-op on later runs.
      const hist = dateRepairMap[j.id];
      if (hist && hist < fs) fs = hist;
      if (j.source === 'workday' && pub && fs && pub > fs) {
        pub = fs;
        pubMean = 'Workday relative posting label converted to an approximate date; reset to first-seen date (label was re-stamped by hourly pulls before the freeze)';
      }
      if (fs === j.firstSeen && pub === j.published) return j;
      return assessJob({ ...j, firstSeen: fs, published: pub, publishedMeaning: pubMean }, nowTs);
    })
    .filter(j => isUsJob(j) && !(j.flags && j.flags.restricted) && remoteAssessment({ location: j.location || '', description: j.descriptionText || '' }).remoteType !== 'non-us')
    .sort((a, b) => Number(b.fit) - Number(a.fit) || (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
  const statuses = results.map(({ jobs: unused, ...status }) => status);
  const checkedAt = new Date().toISOString();
  const recentCount = jobs.filter(j => !j.stale && j.within7d).length;
  const fitCount = jobs.filter(j => j.fit).length;
  const coverage = { discovered: sources.length, attempted: results.length, success: statuses.filter(s => s.ok).length, failed: statuses.filter(s => !s.ok).length, batchOffset: offset, batchSize: batch, nextOffset, rotationRuns: Math.ceil(sources.length / batch), fitCount, recent7dCount: recentCount };
  return { checkedAt, jobs, statuses, recentCount, fitCount, coverage };
}

function gitPushBestEffort(message) {
  const opts = { cwd: REPO_ROOT, stdio: 'pipe', timeout: 180000 };
  try {
    execFileSync('git', ['add', 'jobs.json', 'collector-state.json'], opts);
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], opts);
      return; // nothing changed
    } catch { /* staged changes present, proceed */ }
    execFileSync('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', message], opts);
    try { execFileSync('git', ['pull', '--rebase', '-Xours', 'origin', 'main'], opts); } catch { /* best effort */ }
    execFileSync('git', ['push', 'origin', 'main'], opts);
    console.log('progress snapshot pushed:', message);
  } catch (e) {
    console.error('progress push failed (non-fatal):', String((e && e.message) || e).slice(0, 200));
  }
}

async function flushProgress() {
  try {
    const snap = buildSnapshot();
    snap.coverage.sweepInProgress = true;
    snap.coverage.sweepTotal = selected.length;
    snap.coverage.nextOffset = offset;
    await writeFile(new URL('../jobs.json', import.meta.url), JSON.stringify({ checkedAt: snap.checkedAt, appVersion: APP_VERSION, jobs: snap.jobs, statuses: snap.statuses, recentCount: snap.recentCount, coverage: snap.coverage, note: SNAPSHOT_NOTE }));
    // Keep nextOffset at the run's start offset until the run completes, so a
    // failed run retries the same range instead of skipping boards.
    await writeFile(new URL('../collector-state.json', import.meta.url), JSON.stringify({ nextOffset: offset, updatedAt: snap.checkedAt, batchSize: batch, discovered: sources.length, sweepInProgress: true, sweepAttempted: snap.coverage.attempted, sweepTotal: selected.length }, null, 2));
  } catch (e) {
    console.error('progress flush write failed (non-fatal):', String((e && e.message) || e).slice(0, 200));
    return;
  }
  gitPushBestEffort(`Sweep progress ${results.length}/${selected.length} boards`);
}

await Promise.all(Array.from({ length: 12 }, () => worker()));
// Full-sweep mode: keep jobs from boards that failed this run as stale (up to
// 36h) instead of dropping them, so one flaky board doesn't wipe its jobs.
const snap = buildSnapshot();
await writeFile(new URL('../collector-state.json', import.meta.url), JSON.stringify({ nextOffset, updatedAt: snap.checkedAt, batchSize: batch, discovered: sources.length }, null, 2));
await writeFile(new URL('../jobs.json', import.meta.url), JSON.stringify({ checkedAt: snap.checkedAt, appVersion: APP_VERSION, jobs: snap.jobs, statuses: snap.statuses, recentCount: snap.recentCount, coverage: snap.coverage, note: SNAPSHOT_NOTE }));
// AI quality scoring (Python): re-scores jobs for experience match, role relevance,
// company quality. Runs on final snapshot only (not progress flushes). Non-fatal if missing.
try {
  const scriptPath = new URL('./ai_classifier.py', import.meta.url);
  const jobsPath = new URL('../jobs.json', import.meta.url);
  execFileSync('python3', [scriptPath.pathname, jobsPath.pathname, '--rescore'], { timeout: 180000, stdio: 'pipe' });
  console.log('AI classifier rescored jobs.json');
} catch (e) {
  console.error('AI classifier skipped (non-fatal):', String((e && e.message) || e).slice(0, 200));
}
console.log(JSON.stringify({ coverage: snap.coverage, jobs: snap.jobs.length, recentCount: snap.recentCount, fitCount: snap.fitCount }));
if (!snap.coverage.success) process.exitCode = 1;
