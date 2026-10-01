import { readFile, writeFile } from 'node:fs/promises';
import { excludedEmployer } from './employer-filter.mjs';

const PRIMARY_URL = 'https://raw.githubusercontent.com/fyrosofttech/lastroundai-hiring-data/main/ats-directory/lastroundai-ats-company-directory-2026-08.csv';
const EXTRA_TYPES = ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable', 'recruitee', 'breezy', 'bamboohr', 'teamtailor', 'personio'];
const EXTRA_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
const validToken = /^[a-z0-9][a-z0-9._-]{1,90}$/;
const validWorkdayToken = /^[a-z0-9][a-z0-9._/-]{1,180}$/;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...body] = rows.filter(r => r.some(v => String(v).trim()));
  const keys = headers.map(h => h.trim().toLowerCase());
  return body.map(values => Object.fromEntries(keys.map((k, i) => [k, (values[i] || '').trim()])));
}

function add(out, seen, { company, type, token }) {
  if (!company || !type || !token) return;
  token = String(token).toLowerCase();
  if (!(type === 'workday' ? validWorkdayToken : validToken).test(token)) return;
  const key = `${type}:${token}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ company: String(company).trim(), type, token });
}

async function loadPrimary(out, seen) {
  const response = await fetch(PRIMARY_URL, { headers: { accept: 'text/csv,text/plain;q=0.9' } });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const raw = parseCsv(await response.text());
  if (raw.length < 1000) throw Error(`Unexpected directory size ${raw.length}`);
  for (const r of raw) {
    const rawType = (r.ats_vendor || '').toLowerCase();
    const url = r.board_url || '';
    const inferred = url.includes('ashbyhq.com') ? 'ashby' : url.includes('lever.co') ? 'lever' : url.includes('greenhouse.io') ? 'greenhouse' : rawType;
    const type = ['ashby', 'lever', 'greenhouse'].includes(inferred) ? inferred : null;
    if (!type) continue;
    let token = (r.board_slug || '').toLowerCase();
    if (!token && url) {
      try { token = new URL(url).pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() || ''; } catch {}
    }
    add(out, seen, { company: r.company_name, type, token });
  }
  return raw.length;
}

async function loadExtras(out, seen) {
  const counts = {};
  for (const type of EXTRA_TYPES) {
    try {
      const response = await fetch(`${EXTRA_BASE}/${type}.csv`, { headers: { accept: 'text/csv,text/plain;q=0.9' } });
      if (!response.ok) { counts[type] = `HTTP ${response.status}`; continue; }
      const raw = parseCsv(await response.text());
      const before = out.length;
      for (const r of raw) add(out, seen, { company: r.name, type, token: r.slug });
      counts[type] = out.length - before;
    } catch (e) { counts[type] = String(e.message); }
  }
  return counts;
}

async function loadWorkday(out, seen) {
  try {
    const response = await fetch(`${EXTRA_BASE}/workday.csv`, { headers: { accept: 'text/csv,text/plain;q=0.9' } });
    if (!response.ok) return `HTTP ${response.status}`;
    const raw = parseCsv(await response.text());
    const before = out.length;
    for (const r of raw) {
      let host = '';
      try { host = new URL(r.url || '').host; } catch {}
      if (!host || !r.slug) continue;
      add(out, seen, { company: r.name, type: 'workday', token: `${host}/${r.slug}` });
    }
    return out.length - before;
  } catch (e) { return String(e.message); }
}

async function loadIbisBoards(out, seen) {
  // Extra name-verified Greenhouse boards resolved outside the public
  // inventories: ibis-boards.json (IBISWorld list) and transport-boards.json
  // (transport/trucking/airline/rail/logistics carriers), both produced by
  // scripts/resolve-companies.mjs with board-name verification.
  let added = 0;
  for (const file of ['ibis-boards.json', 'transport-boards.json']) {
    try {
      const boards = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url)));
      const before = out.length;
      for (const b of Array.isArray(boards) ? boards : []) add(out, seen, b);
      added += out.length - before;
    } catch {}
  }
  return added;
}

const out = [];
const seen = new Set();
const primaryRows = await loadPrimary(out, seen);
const extraCounts = await loadExtras(out, seen);
extraCounts.workday = await loadWorkday(out, seen);
extraCounts.ibis = await loadIbisBoards(out, seen);
let seeds = [];
try { seeds = JSON.parse(await readFile(new URL('../sources.json', import.meta.url))); } catch {}
for (const s of seeds) add(out, seen, s);
const filtered = out.filter(x => !excludedEmployer(x.company));
// Priority pass: Prudhvi asked for transport/trucking/logistics/airline/rail
// employers to be visible. Boards matching transport-companies.json rotate
// FIRST in every cycle so carriers get re-checked at the start of each sweep
// instead of sitting mid-directory. Stable sort keeps all other boards in
// their existing relative order.
try {
  const list = JSON.parse(await readFile(new URL('../transport-companies.json', import.meta.url), 'utf8'));
  const stop = new Set(['inc', 'llc', 'corp', 'corporation', 'company', 'co', 'ltd', 'plc', 'group', 'holdings', 'holding', 'technologies', 'technology', 'systems', 'system', 'international', 'global', 'industries', 'enterprises', 'the', 'and', 'of']);
  const nrm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const core = s => nrm(s).split(' ').filter(w => w && !stop.has(w)).join(' ');
  const wanted = [...new Set((Array.isArray(list) ? list : []).map(core).filter(Boolean))];
  const rank = row => { const c = core(row.company); for (const w of wanted) { if (c === w || c.startsWith(w + ' ') || w.startsWith(c + ' ')) return 0; } return 1; };
  filtered.sort((a, b) => rank(a) - rank(b));
} catch {}
await writeFile(new URL('../directory-sources.json', import.meta.url), JSON.stringify(filtered));
const byType = {};
for (const x of filtered) byType[x.type] = (byType[x.type] || 0) + 1;
console.log(JSON.stringify({ primaryRows, extraCounts, imported: filtered.length, excluded: out.length - filtered.length, byType }));
