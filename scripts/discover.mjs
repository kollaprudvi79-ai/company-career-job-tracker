// Daily discovery: pull role feeds that link straight to employer ATS
// postings (landedjobs daily-refreshed GitHub repos, RemoteOK API, HN
// "Who is hiring"), extract the ATS board behind every posting URL, and
// write discovered-boards.json. scripts/ingest.mjs merges it into the
// directory, so companies actively hiring for the target roles get added
// even when no static board inventory lists them.
import { writeFile } from 'node:fs/promises';

const OUT = process.env.OUT || new URL('../discovered-boards.json', import.meta.url).pathname;
const VALID = /^[a-z0-9][a-z0-9._-]{1,90}$/;
const RESERVED = new Set(['www', 'api', 'en', 'us', 'jobs', 'careers', 'login', 'signup', 'about', 'help', 'support', 'static', 'assets', 'embed', 'search', 'company', 'companies', 'job', 'apply', 'home', 'index']);
const boards = new Map();
const log = (...a) => console.log(new Date().toISOString(), ...a);

function add(type, token, company) {
  token = String(token || '').toLowerCase().trim();
  if (type === 'workday' || type === 'oracle' || type === 'icims') {
    if (!/^[a-z0-9][a-z0-9._/-]{1,180}$/.test(token)) return;
  } else if (!VALID.test(token)) return;
  if (RESERVED.has(token)) return;
  const key = `${type}:${token}`;
  if (!boards.has(key)) boards.set(key, { company: (company || token).toString().slice(0, 120), type, token });
}
function seg(pathname, i) { return pathname.split('/').filter(Boolean)[i] || ''; }
function fromUrl(raw, company) {
  let u;
  try { u = new URL(raw); } catch { return; }
  const h = u.host.toLowerCase(); const p = u.pathname;
  if (h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io') add('greenhouse', seg(p, 0), company);
  else if (h === 'jobs.lever.co') add('lever', seg(p, 0), company);
  else if (h === 'jobs.ashbyhq.com') add('ashby', seg(p, 0), company);
  else if (h === 'jobs.smartrecruiters.com') add('smartrecruiters', seg(p, 0), company);
  else if (h === 'apply.workable.com') add('workable', seg(p, 0), company);
  else if (h === 'jobs.jobvite.com') add('jobvite', seg(p, 0), company);
  else if (h === 'ats.rippling.com') {
    if (p.startsWith('/api/v1/board/')) add('rippling', seg(p, 3), company);
    else add('rippling', seg(p, 0), company);
  } else if (/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.test(h)) {
    const tenant = h.split('.')[0]; const site = seg(p, 0);
    if (site && !['wday', 'd'].includes(site)) add('workday', `${h}/${tenant}/${site}`, company);
  } else if (h.endsWith('.applytojob.com')) add('jazzhr', h.split('.')[0], company);
  else if (h.endsWith('.pinpointhq.com')) add('pinpoint', h.split('.')[0], company);
  else if (h.endsWith('.recruitee.com')) add('recruitee', h.slice(0, -'.recruitee.com'.length), company);
  else if (h.endsWith('.breezy.hr')) add('breezy', h.slice(0, -'.breezy.hr'.length), company);
  else if (h.endsWith('.bamboohr.com')) add('bamboohr', h.slice(0, -'.bamboohr.com'.length), company);
  else if (h.endsWith('.teamtailor.com')) add('teamtailor', h.slice(0, -'.teamtailor.com'.length), company);
  else if (h.endsWith('.jobs.personio.com')) add('personio', h.slice(0, -'.jobs.personio.com'.length), company);
  else if (h.endsWith('.jobs.personio.de')) add('personio', h.slice(0, -'.jobs.personio.de'.length), company);
  else if (h.endsWith('.icims.com') && p.startsWith('/jobs/')) add('icims', h, company);
  else if (h.endsWith('.oraclecloud.com')) {
    const parts = p.split('/'); const si = parts.indexOf('sites');
    if (si >= 0 && parts[si + 1]) add('oracle', `${h}/${parts[si + 1]}`, company);
  }
}
function scanText(text, company) {
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s"'<>\])}]+/g)) fromUrl(m[0].replace(/[.,;]+$/, ''), company);
}
async function getJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'CareerRadar discovery' } }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

async function resolveRedirect(url) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(current, { signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': 'CareerRadar discovery' } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return current;
        current = new URL(loc, current).toString();
        continue;
      }
      return current;
    } catch { return current; } finally { clearTimeout(t); }
  }
  return current;
}
async function fetchHtml(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } });
    return r.ok ? await r.text() : '';
  } catch { return ''; } finally { clearTimeout(t); }
}
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// landedjobs role repos (daily refreshed; applyUrl is a go.landed.jobs
// shortlink that 302-redirects to the employer's ATS posting)
const LANDED = ['data-scientist-jobs', 'data-engineer-jobs', 'ai-engineer-jobs', 'machine-learning-engineer-jobs', 'llm-engineer-jobs'];
for (const repo of LANDED) {
  const data = await getJson(`https://raw.githubusercontent.com/landedjobs/${repo}/main/jobs.json`);
  const list = Array.isArray(data) ? data : data?.jobs || [];
  await pool(list, 20, async (j) => {
    const company = j.company || j.company_name || '';
    const raw = j.applyUrl || j.apply_url || j.url || '';
    if (!raw) return;
    if (raw.includes('go.landed.jobs')) {
      // shortlink -> landed.jobs job page -> direct employer ATS URL
      const resolved = await resolveRedirect(raw);
      const html = await fetchHtml(resolved);
      if (html) scanText(html, company);
      else fromUrl(resolved, company);
    } else fromUrl(raw, company);
  });
  log('landedjobs', repo, 'postings', list.length, 'boards so far', boards.size);
}
// RemoteOK public API (apply links sit in the JD HTML; credit Remote OK)
{
  const data = await getJson('https://remoteok.com/api');
  const list = Array.isArray(data) ? data : [];
  for (const j of list) {
    if (!j || typeof j !== 'object' || !j.company) continue;
    if (typeof j.url === 'string') fromUrl(j.url, j.company);
    scanText(j.description || '', j.company);
  }
  log('remoteok postings', list.length, 'boards so far', boards.size);
}
// HN "Who is hiring" latest monthly thread (startup-heavy, direct ATS links)
try {
  const search = await getJson('https://hn.algolia.com/api/v1/search_by_date?query=%22Who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=1');
  const storyId = search?.hits?.[0]?.objectID;
  if (storyId) {
    for (let page = 0; page < 3; page++) {
      const comments = await getJson(`https://hn.algolia.com/api/v1/search?tags=comment,story_${storyId}&hitsPerPage=1000&page=${page}`);
      if (!comments?.hits?.length) break;
      for (const c of comments.hits) scanText(c.comment_text || '', '');
      if (comments.nbPages && page + 1 >= comments.nbPages) break;
    }
  }
  log('hn whoishiring done, boards so far', boards.size);
} catch (e) { log('hn skip', e.message); }

await writeFile(OUT, JSON.stringify([...boards.values()]));
const byType = {};
for (const b of boards.values()) byType[b.type] = (byType[b.type] || 0) + 1;
log('DONE discovered boards', boards.size, JSON.stringify(byType));
