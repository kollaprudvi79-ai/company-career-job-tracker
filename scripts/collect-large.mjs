import { readFile, writeFile } from 'node:fs/promises';

const sources = JSON.parse(await readFile(new URL('../directory-sources.json', import.meta.url)));
let previous = { jobs: [] };
try { previous = JSON.parse(await readFile(new URL('../jobs.json', import.meta.url))); } catch {}

function classify(title) {
  const s = String(title).toLowerCase();
  if (/data engineer|analytics engineer|etl developer|data platform engineer/.test(s)) return 'Data Engineer';
  if (/data scientist|applied scientist|decision scientist/.test(s)) return 'Data Scientist';
  if (/ai engineer|machine learning engineer|ml engineer|llm engineer|mlops engineer|generative ai engineer|applied ai engineer/.test(s)) return 'AI Engineer';
  if (/data analyst|business intelligence analyst|bi analyst|reporting analyst|product analyst|analytics analyst/.test(s)) return 'Data Analyst';
  if ((/full.?stack|software (engineer|developer)|application developer|\.net developer|asp\.net developer/.test(s)) && /\.net|asp\.net|c#/.test(s)) return 'Full Stack .NET';
  return null;
}
function safe(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
function salary(value = '') {
  const m = String(value).replace(/<[^>]+>/g, ' ').match(/(?:USD|\$)\s?([\d,]+)\s*(?:-|–|to)\s*(?:USD|\$)?\s?([\d,]+)/i);
  return m ? `$${m[1]}–$${m[2]}` : null;
}
function endpoint(source) {
  const slug = encodeURIComponent(source.token);
  if (source.type === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  if (source.type === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  if (source.type === 'lever') return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  throw Error('Unsupported ATS');
}
function normalize(j, x, checked) {
  const title = j.title || j.text || '';
  const role = classify(title);
  if (!role) return null;
  const target = x.type === 'greenhouse' ? j.absolute_url : x.type === 'ashby' ? (j.applyUrl || j.jobUrl) : (j.applyUrl || j.hostedUrl);
  const applyUrl = safe(target);
  if (!applyUrl) return null;
  let salaryText = null;
  if (x.type === 'ashby') salaryText = j.compensation?.scrapeableCompensationSalarySummary || null;
  else if (x.type === 'lever') salaryText = j.salaryRange ? `${j.salaryRange.min}–${j.salaryRange.max} ${j.salaryRange.currency || ''}` : salary(j.descriptionPlain);
  const location = x.type === 'greenhouse' ? j.location?.name : x.type === 'lever' ? j.categories?.location : j.location;
  return { id: `${x.type}:${x.token}:${j.id || applyUrl}`, company: x.company, source: x.type, title, role, location: location || 'Not listed', workplace: x.type === 'lever' || x.type === 'ashby' ? j.workplaceType || null : null, salary: salaryText, published: x.type === 'ashby' ? j.publishedAt || null : null, publishedMeaning: x.type === 'ashby' ? 'Last published; may be a republish' : 'Original publication date unavailable', applyUrl, checked };
}
const now = Date.now();
const batch = Number(process.env.BATCH_SIZE) || 1200;
const offset = Number(process.env.BATCH_OFFSET) || 0;
const selected = sources.slice(offset, offset + batch);
if (!selected.length) throw Error('Batch offset beyond directory');
let cursor = 0;
const results = [];
async function worker() {
  while (cursor < selected.length) {
    const x = selected[cursor++];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const checked = new Date().toISOString();
    try {
      const response = await fetch(endpoint(x), { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const data = await response.json();
      const list = Array.isArray(data) ? data : data.jobs;
      if (!Array.isArray(list)) throw Error('Invalid feed');
      const jobs = list.map(j => normalize(j, x, checked)).filter(Boolean);
      results.push({ company: x.company, type: x.type, ok: true, checkedAt: checked, matched: jobs.length, jobs });
    } catch (e) {
      results.push({ company: x.company, type: x.type, ok: false, checkedAt: checked, error: String(e.message), matched: 0, jobs: [] });
    } finally { clearTimeout(timer); }
  }
}
await Promise.all(Array.from({ length: 12 }, () => worker()));
const checkedKeys = new Set(selected.map(s => `${s.type}:${s.token.toLowerCase()}`));
const oldJobs = (previous.jobs || []).filter(j => !checkedKeys.has(`${j.source}:${j.id?.split(':')[1]?.toLowerCase()}`) && Date.now() - Date.parse(j.checked) < 86400000).map(j => ({ ...j, stale: true }));
const jobs = [...new Map([...oldJobs, ...results.flatMap(r => r.jobs)].map(j => [j.id, j])).values()];
const statuses = results.map(({ jobs: unused, ...status }) => status);
const checkedAt = new Date().toISOString();
const recentCount = jobs.filter(j => !j.stale && j.published && now - Date.parse(j.published) >= 0 && now - Date.parse(j.published) <= 86400000).length;
const coverage = { discovered: sources.length, attempted: results.length, success: statuses.filter(s => s.ok).length, failed: statuses.filter(s => !s.ok).length, batchOffset: offset, batchSize: batch };
await writeFile(new URL('../jobs.json', import.meta.url), JSON.stringify({ checkedAt, jobs, statuses, recentCount, coverage, note: 'LastRound AI directory, CC BY 4.0. Success/failure reflects this batch only. Other batch jobs expire after 24 hours.' }));
console.log(JSON.stringify({ coverage, jobs: jobs.length, recentCount }));
if (!coverage.success) process.exitCode = 1;
