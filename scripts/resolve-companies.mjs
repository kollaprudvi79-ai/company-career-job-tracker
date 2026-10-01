// Maintenance resolver: find public Greenhouse boards for a list of companies
// (env INPUT=json list file, OUTPUT=json boards file, both repo-root relative).
//
// Safety rule: a guessed Greenhouse token is accepted ONLY when the board-info
// endpoint returns a company name that core-matches the list entry (Greenhouse
// returns the real board name, so attribution is verified). Lever/Ashby
// guesses are never used. Output is merged by scripts/ingest.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { excludedEmployer } from './employer-filter.mjs';

const INPUT = process.env.INPUT || 'ibis-companies.json';
const OUTPUT = process.env.OUTPUT || 'ibis-boards.json';
const root = new URL('../', import.meta.url);
const companies = JSON.parse(await readFile(new URL(INPUT, root)));
const directory = JSON.parse(await readFile(new URL('directory-sources.json', root)));

const STOP = new Set(['inc', 'llc', 'corp', 'corporation', 'company', 'co', 'ltd', 'plc', 'group', 'holdings', 'holding', 'technologies', 'technology', 'systems', 'system', 'international', 'global', 'industries', 'enterprises', 'the', 'and', 'of']);
const norm = (s = '') => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
function coreOf(name) { return norm(name).split(' ').filter(w => w && !STOP.has(w)).join(' '); }
const dirCores = directory.map(d => coreOf(d.company));
const coveredByCore = c => { const cc = coreOf(c); return dirCores.some(dc => dc === cc || (cc && dc && (dc.startsWith(cc) || cc.startsWith(dc)))); };
const existingTokens = new Set(directory.filter(d => d.type === 'greenhouse').map(d => d.token.toLowerCase()));

function tokenCandidates(name) {
  const words = norm(name).split(' ').filter(w => w && !STOP.has(w));
  if (!words.length) return [];
  return [...new Set([words.join(''), words.slice(0, 2).join(''), words[0]].filter(t => t.length >= 3))];
}
function nameMatches(listName, boardName) {
  const a = coreOf(listName);
  const b = coreOf(boardName);
  if (!a || !b) return false;
  if (a === b) return true;
  const aw = a.split(' ').length;
  const bw = b.split(' ').length;
  return aw >= 2 && bw >= 2 && (b.startsWith(a) || a.startsWith(b));
}

const todo = companies.filter(c => !coveredByCore(c) && !excludedEmployer(c));
console.log(`${INPUT}: ${companies.length} companies; already covered by name: ${companies.length - todo.length}; resolving: ${todo.length}`);
const found = [];
let checked = 0;
const WORKERS = 16;
let idx = 0;
async function worker() {
  while (idx < todo.length) {
    const company = todo[idx++];
    for (const token of tokenCandidates(company)) {
      if (existingTokens.has(token)) continue;
      checked++;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}`, { signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const info = await r.json();
        if (info && info.name && nameMatches(company, info.name) && !excludedEmployer(info.name)) {
          found.push({ company: info.name, type: 'greenhouse', token });
          existingTokens.add(token);
          break;
        }
      } catch {}
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
await writeFile(new URL(OUTPUT, root), JSON.stringify(found, null, 2));
console.log(`Resolved ${found.length} verified Greenhouse boards from ${checked} candidate checks -> ${OUTPUT}`);
for (const f of found) console.log(' -', f.company, '=>', f.token);
