// Extra ATS platform support for Career Radar (Oct 2026).
// Platforms whose boards need multi-step flows or embedded-JSON extraction,
// which don't fit the single-request model in collect-large.mjs.
// Dayforce is intentionally NOT implemented: its JSON API is Cloudflare-
// blocked (HTTP 403) from plain-HTTP clients; it would need a real browser
// session / Cloudflare-passing client. Revisit with a browser-fingerprint layer.
import { classify, isoDate } from './job-utils.mjs';

export const EXTRA_TYPES = new Set([
  'hireology', 'adp', 'dover', 'ukg', 'successfactors',
  'brassring', 'phenom', 'paylocity', 'zoho', 'careerplug',
]);

const UA = 'Mozilla/5.0 (compatible; CareerRadar/1.0)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function isExtraType(t) { return EXTRA_TYPES.has(t); }

function safe(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

// Human career-board link for "View board".
export function extraBoardUrl(source) {
  const tok = String(source.token || '');
  switch (source.type) {
    case 'hireology': return `https://careers.hireology.com/${encodeURIComponent(tok)}`;
    case 'adp': {
      const [cid, ccId] = tok.split('/');
      return `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${encodeURIComponent(cid || '')}&ccId=${encodeURIComponent(ccId || '')}&lang=en_US`;
    }
    case 'dover': return `https://app.dover.com/careers/${encodeURIComponent(tok)}`;
    case 'ukg': {
      const [host, tenant, guid] = tok.split('/');
      return `https://${host}/${tenant}/JobBoard/${encodeURIComponent(guid || '')}/`;
    }
    case 'successfactors': return `${tok.replace(/\/+$/, '')}/search/`;
    case 'brassring': {
      const [p, s] = tok.split('/');
      return `https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=${encodeURIComponent(p || '')}&siteid=${encodeURIComponent(s || '')}`;
    }
    case 'phenom': return `https://${tok.replace(/\/+$/, '')}/search-results`;
    case 'paylocity': return `https://recruiting.paylocity.com/recruiting/jobs/All/${encodeURIComponent(tok)}`;
    case 'zoho': {
      const [portal, tld] = tok.split('/');
      return `https://${portal}.zohorecruit.${tld || 'com'}/jobs/Careers`;
    }
    case 'careerplug': return `https://${encodeURIComponent(tok)}.careerplug.com/jobs`;
    default: return null;
  }
}

// Quote-aware brace/bracket matcher. Returns the JSON substring starting at
// `start` (which must be '{' or '['), or null. Descriptions may contain
// braces/semicolons, so naive regex extraction fails.
function braceMatch(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

function extractJsonAfter(html, keyIdx) {
  const bi = html.indexOf('{', keyIdx);
  if (bi < 0) return null;
  return braceMatch(html, bi);
}

function getSetCookies(response) {
  try {
    if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  } catch {}
  return [];
}

function cookieHeader(response) {
  return getSetCookies(response).map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function stripTags(s) {
  return decodeXml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------- hireology: clean JSON, inline descriptions ----------
async function fetchHireology(x, signal) {
  const slug = encodeURIComponent(String(x.token).trim());
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const r = await fetch(`https://api.hireology.com/v2/public/careers/${slug}?page=${page}&page_size=50`,
      { signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const d = await r.json();
    const items = Array.isArray(d?.data) ? d.data : [];
    for (const j of items) if (String(j?.status || '').toLowerCase() === 'open') out.push(j);
    const count = Number(d?.count) || 0;
    if (page * 50 >= count || !items.length) break;
  }
  return out;
}

// ---------- adp: clean JSON (OData pagination); detail for role matches ----------
async function fetchAdp(x, signal) {
  const [cid, ccId] = String(x.token).split('/');
  if (!cid || !ccId) throw Error('Invalid ADP token (want cid/ccId)');
  const base = 'https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';
  const q = `cid=${encodeURIComponent(cid)}&ccId=${encodeURIComponent(ccId)}&lang=en_US&locale=en_US`;
  const out = [];
  let total = Infinity;
  for (let skip = 0; skip < total && skip <= 2000; skip += 20) {
    const r = await fetch(`${base}?${q}&$top=20&$skip=${skip}`,
      { signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const d = await r.json();
    total = Number(d?.meta?.totalNumber) || 0;
    const items = Array.isArray(d?.jobRequisitions) ? d.jobRequisitions : [];
    if (!items.length) break;
    out.push(...items);
  }
  // Descriptions live behind the detail endpoint; fetch them only for jobs
  // whose title already matches a target role (bounded).
  let detailed = 0;
  for (const j of out) {
    if (detailed >= 25) break;
    if (!classify(j?.requisitionTitle || '', '')) continue;
    try {
      const dr = await fetch(`${base}/${encodeURIComponent(String(j.itemID))}?${q}`,
        { signal, headers: { accept: 'application/json', 'user-agent': UA } });
      if (!dr.ok) continue;
      const dd = await dr.json();
      if (dd?.requisitionDescription) { j.requisitionDescription = dd.requisitionDescription; detailed++; }
    } catch {}
  }
  for (const j of out) { j._cid = cid; j._ccId = ccId; }
  return out;
}

// ---------- dover: clean JSON, thin payload (no descriptions/dates) ----------
async function fetchDover(x, signal) {
  const clientId = encodeURIComponent(String(x.token).trim());
  const out = [];
  for (let offset = 0; offset <= 3000; offset += 300) {
    const r = await fetch(`https://app.dover.com/api/v1/careers-page/${clientId}/jobs?limit=300&offset=${offset}`,
      { signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const d = await r.json();
    const items = Array.isArray(d?.results) ? d.results : [];
    for (const j of items) if (j?.is_published !== false && j?.is_sample !== true) out.push(j);
    if (!d?.next || !items.length) break;
  }
  return out;
}

// ---------- ukg/ultipro: JSON POST ----------
async function fetchUkg(x, signal) {
  const [host, tenant, guid] = String(x.token).split('/');
  if (!host || !tenant || !guid) throw Error('Invalid UKG token (want host/tenant/guid)');
  const url = `https://${host}/${tenant}/JobBoard/${encodeURIComponent(guid)}/JobBoardView/LoadSearchResults`;
  const out = [];
  let total = Infinity;
  for (let skip = 0; skip < total && skip <= 2000; skip += 50) {
    const r = await fetch(url, {
      signal, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({ opportunitySearch: { Top: 50, Skip: skip } }),
    });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const d = await r.json();
    total = Number(d?.totalCount) || 0;
    const items = Array.isArray(d?.opportunities) ? d.opportunities : [];
    if (!items.length) break;
    out.push(...items);
  }
  return out;
}

// ---------- successfactors: JSON POST + locale discovery + optional CSRF ----------
async function fetchSuccessfactors(x, signal) {
  const origin = String(x.token).replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) throw Error('Invalid SuccessFactors token (want origin URL)');
  const sr = await fetch(`${origin}/search/`, { signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
  if (!sr.ok) throw Error(`HTTP ${sr.status}`);
  const shtml = await sr.text();
  const locales = new Set(['en_GB']);
  for (const m of shtml.matchAll(/[?&]locale=([a-z]{2}_[A-Z]{2})/gi)) locales.add(m[1]);
  for (const m of shtml.matchAll(/["']locale["']\s*[:=]\s*["']([a-z]{2}_[A-Z]{2})["']/gi)) locales.add(m[1]);
  const localeList = [...locales].slice(0, 8);
  let csrf = null;
  const cm = shtml.match(/"CSRFToken"\s*:\s*"([^"]+)"|name="CSRFToken"[^>]*value="([^"]+)"/);
  if (cm) csrf = cm[1] || cm[2];
  const headers = {
    'content-type': 'application/json', accept: 'application/json',
    'user-agent': BROWSER_UA, referer: `${origin}/search/`,
  };
  const ck = cookieHeader(sr);
  if (ck) headers.cookie = ck;
  if (csrf) headers['x-csrf-token'] = csrf;
  const seen = new Set();
  const out = [];
  let first = true;
  // Note: the API's pagination can repeat ids across pages (unstable sort);
  // dedup by id below, so coverage per run is ~75-85% of totalJobs on large
  // boards — the 12h sweep rotation picks up the remainder over time.
  for (const locale of localeList) {
    let total = Infinity;
    let emptyStreak = 0;
    for (let pageNumber = 0; pageNumber * 10 < total && pageNumber < 100; pageNumber++) {
      const r = await fetch(`${origin}/services/recruiting/v1/jobs`, {
        signal, method: 'POST', headers,
        body: JSON.stringify({ keywords: '', locale, location: '', pageNumber, sortBy: 'recent' }),
      });
      if (r.status === 401) {
        // Non-CSB (RMK/jobs2web) tenant — this endpoint doesn't apply.
        if (first) throw Error('HTTP 401 (non-CSB tenant)');
        break;
      }
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      first = false;
      const d = await r.json();
      const t = Number(d?.totalJobs);
      if (t > 0) total = t; // ignore flaky zero/missing totals — don't abort pagination
      const items = Array.isArray(d?.jobSearchResult) ? d.jobSearchResult : [];
      if (!items.length) {
        // Tolerate one flaky empty page; two in a row ends pagination.
        if (++emptyStreak >= 2) break;
        continue;
      }
      emptyStreak = 0;
      for (const w of items) {
        const j = w?.response || w;
        const id = String(j?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        j._locale = locale;
        j._origin = origin;
        out.push(j);
      }
    }
  }
  return out;
}

// ---------- brassring: 2-step (GET token, POST jobs), both sort orders ----------
function brQuestion(j, names) {
  const qs = j?.Questions;
  if (!Array.isArray(qs)) return '';
  const want = new Set(names.map(n => n.toLowerCase()));
  for (const q of qs) {
    if (want.has(String(q?.QuestionName || '').toLowerCase())) {
      const v = String(q?.Value ?? '').trim();
      if (v) return v;
    }
  }
  return '';
}

async function fetchBrassring(x, signal) {
  const [partnerid, siteid] = String(x.token).split('/');
  if (!partnerid || !siteid) throw Error('Invalid BrassRing token (want partnerid/siteid)');
  const homeUrl = `https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=${encodeURIComponent(partnerid)}&siteid=${encodeURIComponent(siteid)}`;
  const hr = await fetch(homeUrl, { signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
  if (!hr.ok) throw Error(`HTTP ${hr.status}`);
  const hhtml = await hr.text();
  const tm = hhtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tm) throw Error('No anti-forgery token on BrassRing home page');
  const headers = {
    'user-agent': BROWSER_UA, accept: 'application/json', 'content-type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest', 'RFT': tm[1], 'Referer': homeUrl,
  };
  const ck = cookieHeader(hr);
  if (ck) headers.cookie = ck;
  const seen = new Set();
  const out = [];
  const pushJobs = (jobs) => {
    for (const j of jobs || []) {
      const reqid = brQuestion(j, ['reqid', 'jobreqid', 'requisitionid', 'jobid']);
      const key = `${partnerid}:${reqid}`;
      if (!reqid || seen.has(key)) continue;
      seen.add(key);
      j._partnerid = partnerid;
      j._siteid = siteid;
      out.push(j);
    }
  };
  const r1 = await fetch('https://sjobs.brassring.com/TgNewUI/Search/Ajax/MatchedJobs', {
    signal, method: 'POST', headers,
    body: JSON.stringify({
      PartnerId: partnerid, SiteId: siteid, Keyword: '', Location: '',
      KeywordCustomSolrFields: 'JobTitle,Location', LocationCustomSolrFields: 'Location',
      FacetFilterFields: null, TurnOffHttps: false, Latitude: 0, Longitude: 0,
      PowerSearchOptions: { PowerSearchOption: [] }, encryptedsessionvalue: '',
    }),
  });
  if (!r1.ok) throw Error(`HTTP ${r1.status}`);
  const d1 = await r1.json();
  pushJobs(d1?.Jobs?.Job);
  const total = Number(d1?.JobsCount) || 0;
  // Sort is unstable across pages — sweep date and title sorts, cap pages.
  for (const [sortField, sortOrder] of [['lastupdated', 'desc'], ['title', 'asc']]) {
    for (let pageNumber = 2; pageNumber <= 30; pageNumber++) {
      if ((pageNumber - 1) * 50 >= total) break;
      const rp = await fetch('https://sjobs.brassring.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs', {
        signal, method: 'POST', headers,
        body: JSON.stringify({ partnerId: partnerid, siteId: siteid, pageNumber, pageSize: 50, sortField, sortOrder }),
      });
      if (!rp.ok) break;
      let dp;
      try { dp = await rp.json(); } catch { break; }
      const jobs = dp?.Jobs?.Job;
      if (!Array.isArray(jobs) || !jobs.length) break;
      pushJobs(jobs);
    }
  }
  return out;
}

// ---------- phenom: SSR-embedded eagerLoadRefineSearch JSON ----------
async function fetchPhenom(x, signal) {
  const tok = String(x.token).replace(/\/+$/, '');
  const base = `https://${tok}/search-results`;
  const out = [];
  let total = Infinity;
  for (let from = 0; from < total && from <= 2000; from += 10) {
    const r = await fetch(`${base}?keywords=&from=${from}&s=1`,
      { signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const html = await r.text();
    const ki = html.indexOf('"eagerLoadRefineSearch"');
    if (ki < 0) {
      if (from === 0) throw Error('No eagerLoadRefineSearch blob (tenant may bot-block)');
      break;
    }
    const json = extractJsonAfter(html, ki);
    if (!json) break;
    let d;
    try { d = JSON.parse(json); } catch { break; }
    total = Number(d?.totalHits) || 0;
    const items = d?.data?.jobs;
    if (!Array.isArray(items) || !items.length) break;
    for (const j of items) { j._phenomHost = tok.split('/')[0]; j._phenomPath = tok.split('/').slice(1).join('/'); out.push(j); }
    if (items.length < 10) break;
  }
  return out;
}

// ---------- paylocity: SSR-embedded window.pageData JSON ----------
async function fetchPaylocity(x, signal) {
  const guid = String(x.token).trim();
  const r = await fetch(`https://recruiting.paylocity.com/recruiting/jobs/All/${encodeURIComponent(guid)}`,
    { signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  const html = await r.text();
  const ki = html.indexOf('window.pageData');
  if (ki < 0) throw Error('No pageData (dead board)');
  const json = extractJsonAfter(html, ki);
  if (!json) throw Error('pageData extraction failed');
  let d;
  try { d = JSON.parse(json); } catch { throw Error('pageData JSON invalid'); }
  const jobs = Array.isArray(d?.Jobs) ? d.Jobs : [];
  const out = [];
  for (const j of jobs) {
    if (j?.IsInternal !== false) continue; // internal postings must be excluded
    j._guid = guid;
    out.push(j);
  }
  return out;
}

// ---------- zoho: public RSS 2.0 feed ----------
async function fetchZoho(x, signal) {
  const [portal, tld = 'com'] = String(x.token).split('/');
  if (!portal) throw Error('Invalid Zoho token (want portal[/tld])');
  const r = await fetch(`https://${portal}.zohorecruit.${tld}/jobs/Careers/rss`,
    { signal, headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' } });
  const text = await r.text();
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  if (text.length < 500 && /joblist has been removed/i.test(text)) return []; // alive, zero jobs
  const out = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const seg = m[1];
    const tag = (n) => {
      const mm = seg.match(new RegExp(`<${n}>([\\s\\S]*?)<\\/${n}>`));
      return mm ? decodeXml(mm[1]).trim() : '';
    };
    out.push({ title: tag('title'), link: tag('link'), guid: tag('guid'), pubDate: tag('pubDate'), description: tag('description') });
  }
  return out;
}

// ---------- careerplug: HTML table + JSON-LD detail (role matches only) ----------
function extractJobPostingLd(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      const arr = Array.isArray(d) ? d : [d];
      for (const item of arr) {
        const t = item?.['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return item;
      }
    } catch {}
  }
  return null;
}

async function fetchCareerplug(x, signal) {
  const tenant = String(x.token).trim();
  const headers = { 'user-agent': BROWSER_UA, accept: 'text/html' };
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 20 && out.length < 60; page++) {
    const r = await fetch(`https://${encodeURIComponent(tenant)}.careerplug.com/jobs?page=${page}`, { signal, headers });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const html = await r.text();
    const links = [];
    for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
      const tagHtml = m[0];
      const href = (tagHtml.match(/href="(\/jobs\/[A-Za-z0-9_-]+)"/) || [])[1];
      const label = (tagHtml.match(/aria-label="([^"]*)"/) || [])[1];
      if (href && label && !seen.has(href)) { seen.add(href); links.push({ href, label: decodeXml(label) }); }
    }
    if (!links.length) break; // stop on repeat / exhaustion
    for (const { href, label } of links) {
      if (out.length >= 60) break;
      const lm = label.match(/^(.*?)\s+in\s+([A-Za-z .'\-]+,\s*[A-Z]{2}(?:\s+\d{5})?)$/);
      const title = (lm ? lm[1] : label).trim();
      const location = lm ? lm[2].trim() : 'Not listed';
      if (!title || !classify(title, '')) continue; // detail fetch only for role matches
      try {
        const dr = await fetch(`https://${encodeURIComponent(tenant)}.careerplug.com${href}`, { signal, headers });
        if (!dr.ok) continue;
        const ld = extractJobPostingLd(await dr.text());
        out.push({ title, url: `https://${tenant}.careerplug.com${href}`, location, ld });
      } catch {}
    }
  }
  return out;
}

export async function fetchExtraJobs(x, signal) {
  switch (x.type) {
    case 'hireology': return fetchHireology(x, signal);
    case 'adp': return fetchAdp(x, signal);
    case 'dover': return fetchDover(x, signal);
    case 'ukg': return fetchUkg(x, signal);
    case 'successfactors': return fetchSuccessfactors(x, signal);
    case 'brassring': return fetchBrassring(x, signal);
    case 'phenom': return fetchPhenom(x, signal);
    case 'paylocity': return fetchPaylocity(x, signal);
    case 'zoho': return fetchZoho(x, signal);
    case 'careerplug': return fetchCareerplug(x, signal);
    default: throw Error('Unsupported extra ATS');
  }
}

// Normalize a raw per-type job into {base, description, structuredSalaryText}.
// `base` matches the shape built by normalize() in collect-large.mjs.
export function normalizeExtraJob(j, x, checked) {
  const tok = String(x.token || '');
  let base = null;
  let description = '';
  const structuredSalaryText = '';
  const id = (key) => `${x.type}:${tok}:${key}`;

  if (x.type === 'hireology') {
    const title = j.name || '';
    description = j.job_description || '';
    const loc = j.locations?.[0];
    const location = loc ? [loc.city, loc.state].filter(Boolean).join(', ') : 'Not listed';
    base = {
      id: id(j.id), company: x.company, source: x.type, title, role: classify(title, description),
      location: location || 'Not listed', workplace: j.remote ? 'remote' : null, isRemote: Boolean(j.remote),
      salary: null, published: isoDate(j.created_at), publishedMeaning: 'Hireology job creation timestamp',
      applyUrl: safe(j.career_site_url || `https://careers.hireology.com/${encodeURIComponent(tok)}/${j.id}/description`),
    };
  } else if (x.type === 'adp') {
    const title = j.requisitionTitle || '';
    description = j.requisitionDescription || '';
    const loc = j.requisitionLocations?.[0];
    const location = loc?.nameCode?.shortName?.trim()
      || [loc?.address?.cityName, loc?.address?.countrySubdivisionLevel1?.codeValue].filter(Boolean).join(', ')
      || 'Not listed';
    const applyUrl = safe(`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${encodeURIComponent(j._cid || '')}&ccId=${encodeURIComponent(j._ccId || '')}&jobId=${encodeURIComponent(String(j.clientRequisitionID || j.itemID || ''))}&lang=en_US`);
    base = {
      id: id(j.itemID || j.clientRequisitionID), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: /remote/i.test(location) ? 'remote' : null, isRemote: /remote/i.test(location),
      salary: null, published: isoDate(j.postDate), publishedMeaning: 'ADP requisition post date', applyUrl,
    };
  } else if (x.type === 'dover') {
    const title = j.title || '';
    const loc = (j.locations || []).find(l => l.is_primary) || j.locations?.[0];
    const location = loc?.name || loc?.location_option?.display_name || 'Not listed';
    const workplace = /remote/i.test(j.workplace_type || '') ? 'remote' : /hybrid/i.test(j.workplace_type || '') ? 'hybrid' : null;
    base = {
      id: id(j.id), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace, isRemote: workplace === 'remote',
      salary: null, published: null, publishedMeaning: 'Dover feed does not expose a publication date',
      applyUrl: safe(`https://app.dover.com/careers/${encodeURIComponent(tok)}`),
    };
  } else if (x.type === 'ukg') {
    const [host, tenant, guid] = tok.split('/');
    const title = j.Title || '';
    description = j.BriefDescription || '';
    const addr = j.Locations?.[0]?.Address;
    const location = addr
      ? [addr.City, addr.State?.Code || addr.State?.Name].filter(Boolean).join(', ') || 'Not listed'
      : (j.Locations?.map(l => l?.LocalizedDescription).filter(Boolean).join('; ') || 'Not listed');
    base = {
      id: id(j.Id), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: null, isRemote: false,
      salary: null, published: isoDate(j.PostedDate), publishedMeaning: 'UKG posting timestamp',
      applyUrl: safe(`https://${host}/${tenant}/JobBoard/${encodeURIComponent(guid || '')}/OpportunityDetail?opportunityId=${encodeURIComponent(j.Id || '')}`),
    };
  } else if (x.type === 'successfactors') {
    const title = j.unifiedStandardTitle || '';
    const location = (j.jobLocationShort || []).map(s => String(s).trim()).filter(Boolean).join('; ') || 'Not listed';
    // unifiedStandardStart is DD/MM/YYYY
    let published = null;
    const dm = String(j.unifiedStandardStart || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (dm) {
      const yy = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
      published = isoDate(`${yy}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`);
    }
    const origin = (j._origin || tok).replace(/\/+$/, '');
    base = {
      id: id(j.id), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: null, isRemote: false,
      salary: null, published, publishedMeaning: 'SuccessFactors posting start date',
      applyUrl: safe(`${origin}/job/${j.unifiedUrlTitle}/${j.id}-${j._locale || 'en_GB'}`),
    };
  } else if (x.type === 'brassring') {
    const title = brQuestion(j, ['jobtitle', 'title']) || '';
    description = brQuestion(j, ['jobdescription', 'description']) || '';
    const city = brQuestion(j, ['formtext12', 'city', 'locationcity']);
    const state = brQuestion(j, ['formtext10', 'state', 'locationstate', 'province']);
    const locSingle = brQuestion(j, ['location', 'joblocation', 'primarylocation']);
    const location = [city, state].filter(Boolean).join(', ') || locSingle || 'Not listed';
    // lastupdated is DD-Mon-YYYY, e.g. 04-Oct-2026
    let published = null;
    const lm = brQuestion(j, ['lastupdated', 'posteddate', 'dateposted']).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (lm) {
      const mon = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }[lm[2].toLowerCase()];
      if (mon) published = isoDate(`${lm[3]}-${mon}-${lm[1].padStart(2, '0')}`);
    }
    base = {
      id: id(`${j._partnerid}:${brQuestion(j, ['reqid', 'jobreqid', 'requisitionid', 'jobid'])}`),
      company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: null, isRemote: /remote/i.test(location),
      salary: null, published, publishedMeaning: 'BrassRing last-updated date',
      applyUrl: safe(`https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=${encodeURIComponent(j._partnerid || '')}&siteid=${encodeURIComponent(j._siteid || '')}`),
    };
  } else if (x.type === 'phenom') {
    const title = j.title || '';
    description = j.descriptionTeaser || '';
    const location = j.cityStateCountry || [j.city, j.state, j.country].filter(Boolean).join(', ') || j.locationName || 'Not listed';
    base = {
      id: id(j.jobId || j.reqId), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: /remote/i.test(String(j.workLocation || '') + ' ' + location) ? 'remote' : null,
      isRemote: /remote/i.test(String(j.workLocation || '') + ' ' + location),
      salary: j.salary || j.salaryRange || null, published: isoDate(j.postedDate), publishedMeaning: 'Phenom posting date',
      applyUrl: safe(`https://${j._phenomHost}/${(j._phenomPath || '').split('/').map(encodeURIComponent).join('/')}/job/${encodeURIComponent(j.jobId || j.reqId || '')}`),
    };
  } else if (x.type === 'paylocity') {
    const title = j.JobTitle || '';
    description = j.Description || '';
    const jl = j.JobLocation || {};
    const location = j.LocationName && jl.City && !j.LocationName.includes(jl.City)
      ? `${j.LocationName} (${[jl.City, jl.State].filter(Boolean).join(', ')})`
      : ([jl.City, jl.State].filter(Boolean).join(', ') || j.LocationName || 'Not listed');
    base = {
      id: id(j.JobId), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: j.IsRemote ? 'remote' : null, isRemote: Boolean(j.IsRemote),
      salary: null, published: isoDate(j.PublishedDate), publishedMeaning: 'Paylocity publication timestamp',
      applyUrl: safe(`https://recruiting.paylocity.com/recruiting/jobs/Details/${encodeURIComponent(j.JobId)}`),
    };
  } else if (x.type === 'zoho') {
    const title = stripTags(j.title) || '';
    description = stripTags(j.description);
    const lm = String(j.description || '').match(/Location:\s*([^\n<]+)/i);
    const location = lm ? stripTags(lm[1]) : 'Not listed';
    base = {
      id: id(j.guid || j.link), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: /remote/i.test(location) ? 'remote' : null, isRemote: /remote/i.test(location),
      salary: null, published: isoDate(j.pubDate), publishedMeaning: 'Zoho RSS publication date',
      applyUrl: safe(j.link || j.guid),
    };
  } else if (x.type === 'careerplug') {
    const ld = j.ld || {};
    const title = j.title || stripTags(ld.title) || '';
    description = stripTags(ld.description) || '';
    const location = j.location || 'Not listed';
    base = {
      id: id(j.url), company: x.company, source: x.type, title, role: classify(title, description),
      location, workplace: /remote/i.test(location) ? 'remote' : null, isRemote: /remote/i.test(location),
      salary: null, published: isoDate(ld.datePosted), publishedMeaning: 'CareerPlug JSON-LD datePosted',
      applyUrl: safe(j.url),
    };
  }
  if (!base) return null;
  return { base, description, structuredSalaryText };
}
