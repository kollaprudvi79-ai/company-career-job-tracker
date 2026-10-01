import {readFile,writeFile} from 'node:fs/promises';
import {excludedEmployer} from './employer-filter.mjs';
const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url)));
const directory=await read('../directory-sources.json');
const filtered=directory.filter(x=>!excludedEmployer(x.company));
await writeFile(new URL('../directory-sources.json',import.meta.url),JSON.stringify(filtered));
const data=await read('../jobs.json');
data.jobs=(data.jobs||[]).filter(j=>!excludedEmployer(j.company));
data.statuses=(data.statuses||[]).filter(s=>!excludedEmployer(s.company));
if(data.coverage){data.coverage.discovered=filtered.length;data.coverage.attempted=data.statuses.length;data.coverage.success=data.statuses.filter(s=>s.ok).length;data.coverage.failed=data.statuses.filter(s=>!s.ok).length;}
data.recentCount=data.jobs.filter(j=>!j.stale&&j.published&&Date.now()-Date.parse(j.published)>=0&&Date.now()-Date.parse(j.published)<=86400000).length;
data.note='Known staffing and consulting firms excluded by a conservative name list; ambiguous firms may remain and require review. Counts refer to the current batch.';
await writeFile(new URL('../jobs.json',import.meta.url),JSON.stringify(data));
console.log(JSON.stringify({excluded:directory.length-filtered.length,remaining:filtered.length,jobs:data.jobs.length}));
