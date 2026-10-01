// Mine Common Crawl's CDX index for public ATS board URLs and extract
// board tokens for every ATS the collector supports. Output is a boards
// file ([{company,type,token}]) that scripts/ingest.mjs merges. Company
// names are unknown from URLs alone, so the token stands in as the name;
// the board either responds to the collector or it does not.
// NOTE: path-prefix queries (host/a*) time out on the CDX server;
// matchType=host/domain range scans return fast, so tokens are
// extracted client-side from the returned URLs.
import { writeFile } from 'node:fs/promises';

const OUT = process.env.OUT || new URL('../cc-boards.json', import.meta.url).pathname;
const VALID = /^[a-z0-9][a-z0-9._-]{1,90}$/;
const RESERVED = new Set(['www', 'api', 'en', 'us', 'jobs', 'careers', 'login', 'signup', 'sign-up', 'about', 'pricing', 'customers', 'blog', 'help', 'support', 'developers', 'static', 'assets', 'embed', 'widget', 'widgets', 'search', 'companies', 'company', 'job', 'apply', 'home', 'index', 'null', 'undefined', 'favicon.ico', 'robots.txt', 'sitemap.xml']);
const boards = new Map();
const log = (...a) => console.log(new Date().toISOString(), ...a);

function add(type, token, company) {
  token = String(token || '').toLowerCase();
  if (type === 'workday' || type === 'oracle' || type === 'icims') {
    if (!/^[a-z0-9][a-z0-9._/-]{1,180}$/.test(token)) return;
  } else if (!VALID.test(token)) return;
  if (RESERVED.has(token)) return;
  const key = `${type}:${token}`;
  if (!boards.has(key)) boards.set(key, { company: company || token, type, token });
}
async function save() { await writeFile(OUT, JSON.stringify([...boards.values()])); }
async function cdx(index, host, matchType, limit, extra = '') {
  const url = `https://index.commoncrawl.org/${index}-index?url=${encodeURIComponent(host)}&matchType=${matchType}&output=json&fl=url&limit=${limit}${extra}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'CareerRadar CC miner' } });
      if (!r.ok) { log('CDX HTTP', r.status, host, matchType); return []; }
      const text = await r.text();
      const urls = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const u = JSON.parse(line).url; if (u) urls.push(u); } catch {}
      }
      return urls;
    } catch (e) { log('CDX ERR', e.message, host, matchType, 'attempt', attempt); }
    finally { clearTimeout(t); }
  }
  return [];
}
function pathToken(raw) {
  try {
    const seg = new URL(raw).pathname.split('/').filter(Boolean)[0] || '';
    if (/^[a-z]{2}-[A-Z]{2}$/.test(seg)) return '';
    return seg;
  } catch { return ''; }
}
function hostToken(raw, suffix) {
  try {
    const h = new URL(raw).host;
    if (!h.endsWith(suffix)) return '';
    const t = h.slice(0, -suffix.length);
    return t && !t.includes('.') ? t : '';
  } catch { return ''; }
}

const coll = await (await fetch('https://index.commoncrawl.org/collinfo.json')).json();
const index = coll[0].id;
log('Using index', index);

const HOST_ATS = [
  ['greenhouse', 'job-boards.greenhouse.io'],
  ['lever', 'jobs.lever.co'],
  ['ashby', 'jobs.ashbyhq.com'],
  ['smartrecruiters', 'jobs.smartrecruiters.com'],
  ['workable', 'apply.workable.com'],
  ['jobvite', 'jobs.jobvite.com'],
  ['rippling', 'ats.rippling.com'],
];
for (const [type, host] of HOST_ATS) {
  const before = boards.size;
  const urls = await cdx(index, host, 'host', 60000);
  for (const u of urls) add(type, pathToken(u));
  await save(); log('host', type, 'urls', urls.length, 'boards total', boards.size, '(added', boards.size - before, ')');
}
const DOMAIN_ATS = [
  ['recruitee', 'recruitee.com', '.recruitee.com'],
  ['breezy', 'breezy.hr', '.breezy.hr'],
  ['bamboohr', 'bamboohr.com', '.bamboohr.com'],
  ['teamtailor', 'teamtailor.com', '.teamtailor.com'],
  ['personio', 'personio.com', '.jobs.personio.com'],
  ['personio', 'personio.de', '.jobs.personio.de'],
  ['jazzhr', 'applytojob.com', '.applytojob.com'],
  ['pinpoint', 'pinpointhq.com', '.pinpointhq.com'],
];
for (const [type, domain, suffix] of DOMAIN_ATS) {
  const before = boards.size;
  const urls = await cdx(index, domain, 'domain', 60000);
  for (const u of urls) add(type, hostToken(u, suffix));
  await save(); log('domain', type, domain, 'urls', urls.length, 'boards total', boards.size, '(added', boards.size - before, ')');
}
{
  const before = boards.size;
  const urls = await cdx(index, 'myworkdayjobs.com', 'domain', 60000);
  for (const u of urls) {
    try {
      const url = new URL(u); const m = url.host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
      if (!m) continue;
      const site = url.pathname.split('/').filter(Boolean)[0] || '';
      if (!site || ['wday', 'd', 'favicon.ico'].includes(site)) continue;
      add('workday', `${url.host}/${m[1]}/${site}`, m[1]);
    } catch {}
  }
  await save(); log('domain workday urls', urls.length, 'boards total', boards.size, '(added', boards.size - before, ')');
}
{
  const before = boards.size;
  const deny = new Set(['www.icims.com', 'api.icims.com', 'cdn02.icims.com', 'app.icims.com', 'login.icims.com', 'images.icims.com', 'social.icims.com', 'icims.com']);
  const urls = await cdx(index, 'icims.com', 'domain', 60000);
  for (const u of urls) {
    try {
      const url = new URL(u); const h = url.host;
      if (deny.has(h) || !h.endsWith('.icims.com')) continue;
      if (!url.pathname.startsWith('/jobs/')) continue;
      add('icims', h, h.replace(/^careers-/, '').replace(/\.icims\.com$/, ''));
    } catch {}
  }
  await save(); log('domain icims urls', urls.length, 'boards total', boards.size, '(added', boards.size - before, ')');
}
{
  const before = boards.size;
  const urls = await cdx(index, 'oraclecloud.com', 'domain', 40000, '&filter=original:.*CandidateExperience.*');
  for (const u of urls) {
    try {
      const url = new URL(u);
      const parts = url.pathname.split('/');
      const si = parts.indexOf('sites');
      if (si < 0 || !parts[si + 1]) continue;
      add('oracle', `${url.host}/${parts[si + 1]}`, url.host.split('.')[0]);
    } catch {}
  }
  await save(); log('domain oracle urls', urls.length, 'boards total', boards.size, '(added', boards.size - before, ')');
}
await save();
const byType = {};
for (const b of boards.values()) byType[b.type] = (byType[b.type] || 0) + 1;
log('DONE total boards', boards.size, JSON.stringify(byType));
