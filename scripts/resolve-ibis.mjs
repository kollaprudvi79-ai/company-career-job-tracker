// One-time maintenance resolver: find public Greenhouse boards for IBISWorld
// companies (ibis-companies.json) that the bulk inventories missed.
//
// Safety rule (from hard lessons): a guessed Greenhouse token is accepted
// ONLY when the board-info endpoint returns a company name that matches the
// IBISWorld company. Greenhouse returns the real board name, so attribution
// is verified. Lever/Ashby guesses are never used (no name check possible).
// Output: ibis-boards.json, merged by scripts/ingest.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { excludedEmployer } from './employer-filter.mjs';

const companies = JSON.parse(await readFile(new URL('../ibis-companies.json', import.meta.url)));
const directory = JSON.parse(await readFile(new URL('../directory-sources.json', import.meta.url)));

const STOP = new Set(['inc', 'llc', 'corp', 'corporation', 'company', 'co', 'ltd', 'plc', 'group', 'holdings', 'holding', 'technologies', 'technology', 'systems', 'system', 'international', 'global', 'industries', 'enterprises', 'the', 'and', 'of']);
const norm = (s = '') => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const dirCores = directory.map(d => coreOf(d.company));
const coveredByCore = c => { const cc = coreOf(c); return dirCores.some(dc => dc === cc || (cc && dc && (dc.startsWith(cc) || cc.startsWith(dc)))); };
const existingTokens = new Set(directory.filter(d => d.type === 'greenhouse').map(d => d.token.toLowerCase()));

function tokenCandidates(name) {
  const words = norm(name).split(' ').filter(w => w && !STOP.has(w));
  if (!words.length) return [];
  const full = words.join('');
  const firstTwo = words.slice(0, 2).join('');
  const first = words[0];
  return [...new Set([full, firstTwo, first].filter(t => t.length >= 3))];
}
function nameMatches(ibisName, boardName) {
  const a = coreOf(ibisName);
  const b = coreOf(boardName);
  if (!a || !b) return false;
  if (a === b) return true;
  // Prefix matches need at least two distinctive words on both sides,
  // otherwise short board names ("Air", "CMA") match unrelated companies.
  const aw = a.split(' ').length;
  const bw = b.split(' ').length;
  if (aw >= 2 && bw >= 2 && (b.startsWith(a) || a.startsWith(b))) return true;
  return false;
}
function coreOf(name) {
  return norm(name).split(' ').filter(w => w && !STOP.has(w)).join(' ');
}

const todo = companies.filter(c => !coveredByCore(c) && !excludedEmployer(c));
console.log(`IBIS companies: ${companies.length}; already covered by name: ${companies.length - todo.length}; resolving: ${todo.length}`);

const found = [];
let cursor = 0, checked = 0;
async function worker() {
  while (cursor < todo.length) {
    const company = todo[cursor++];
    for (const token of tokenCandidates(company)) {
      if (existingTokens.has(token)) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}`, { signal: controller.signal });
        clearTimeout(timer);
        checked++;
        if (!res.ok) continue;
        const info = await res.json().catch(() => null);
        if (info && info.name && nameMatches(company, info.name) && !excludedEmployer(info.name)) {
          found.push({ company: info.name, type: 'greenhouse', token });
          existingTokens.add(token);
          break;
        }
      } catch { checked++; }
    }
  }
}
await Promise.all(Array.from({ length: 16 }, () => worker()));
await writeFile(new URL('../ibis-boards.json', import.meta.url), JSON.stringify(found, null, 1));
console.log(`Resolved ${found.length} verified Greenhouse boards from ${checked} candidate checks`);
