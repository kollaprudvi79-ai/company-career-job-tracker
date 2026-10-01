export const SALARY_FLOOR = 125000;
export const FRESH_WINDOW_DAYS = 7;

const PROFILE_BY_ROLE = {
  'Data Engineer': 'Data Engineer',
  'Data Analyst': 'Data Analyst',
  'Data Scientist': 'Data Scientist',
  'AI Engineer': 'Data Scientist',
  'Full Stack .NET': '.NET Developer',
};

export function tsentaProfile(role) {
  return PROFILE_BY_ROLE[role] || null;
}

export function classify(title, description = '') {
  const t = String(title || '').toLowerCase();
  const text = `${t} ${stripHtml(description).toLowerCase()}`;
  if (/data engineer|analytics engineer|etl developer|data platform engineer|data infrastructure engineer/.test(t)) return 'Data Engineer';
  if (/data scientist|applied scientist|decision scientist/.test(t)) return 'Data Scientist';
  if (/ai engineer|machine learning engineer|ml engineer|llm engineer|mlops engineer|generative ai engineer|applied ai engineer|ai\/ml engineer/.test(t)) return 'AI Engineer';
  if (/data analyst|business intelligence analyst|bi analyst|reporting analyst|product analyst|analytics analyst|business analyst/.test(t)) return 'Data Analyst';
  if (/\.net|asp\.net|c#|dotnet/.test(t)) return 'Full Stack .NET';
  if ((/full.?stack|software (engineer|developer)|backend (engineer|developer)|application developer/.test(t)) && /(\.net core|asp\.net|c#|dotnet|\.net framework)/.test(text)) return 'Full Stack .NET';
  return null;
}

export function stripHtml(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function moneyValue(raw, suffix = '') {
  let n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/k/i.test(suffix) || n < 1000) n *= 1000;
  return Math.round(n);
}

export function parseSalary(text = '', structuredText = '') {
  const haystack = `${structuredText || ''} ${stripHtml(text)}`;
  const range = haystack.match(/(?:USD|\$)\s?([\d,]+(?:\.\d+)?)\s?(k)?\s*(?:-|–|—|to)\s*(?:USD|\$)?\s?([\d,]+(?:\.\d+)?)\s?(k)?/i);
  if (range) {
    const min = moneyValue(range[1], range[2] || '');
    const max = moneyValue(range[3], range[4] || '');
    if (min && max) return { salary: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')}`, salaryMin: min, salaryMax: max };
  }
  const single = haystack.match(/(?:USD|\$)\s?([\d,]+(?:\.\d+)?)\s?(k)?\b/i);
  if (single) {
    const value = moneyValue(single[1], single[2] || '');
    if (value) return { salary: `$${value.toLocaleString('en-US')}`, salaryMin: value, salaryMax: value };
  }
  return { salary: null, salaryMin: null, salaryMax: null };
}

export function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function titleFlags(title = '') {
  const t = String(title || '');
  const excludedLevel = /\b(staff|principal|lead|manager|director|vp|vice president|chief|architect|distinguished|fellow|head)\b/i.test(t) || /\bsr\.?\s*principal\b/i.test(t);
  const intern = /\b(intern|internship|co-op|coop|new grad|entry[- ]level|graduate program)\b/i.test(t);
  return { excludedLevel, intern };
}

export function textFlags(title = '', description = '') {
  const text = stripHtml(description);
  const lower = `${title} ${text}`.toLowerCase();
  const javaCentric = /\b(java|spring boot|spring)\b/i.test(String(title || '')) || ((lower.match(/\bjava\b/g) || []).length >= 3 && /\bspring\b/.test(lower));
  const sponsorshipRisk = /(no (visa )?sponsorship|not (provide|offer|able to provide)[^.]{0,60}sponsorship|cannot sponsor|can not sponsor|unable to sponsor|without (visa )?sponsorship|sponsorship is not available|not eligible for (visa )?sponsorship|must be authorized to work[^.]{0,80}without sponsorship)/i.test(text);
  const restricted = /(security clearance|ts\/sci|public trust|secret clearance|u\.s\. citizenship is required|us citizenship is required|must be (a )?u\.s\. citizen|must be (a )?us citizen|department of defense|federal government|government clearance)/i.test(lower);
  const years = [...lower.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(\d{1,2})?\s*years?/g)]
    .map(m => Number(m[2] || m[1]))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 30);
  const experienceMaxYears = years.length ? Math.max(...years) : null;
  const nonUsText = /(\bir35\b|right to work in the (uk|united kingdom)|must be (based|located|residing|living) in (the )?(uk|united kingdom|england|canada|india)|uk[- ]based (only|role)|uk only role|canada[- ]based only|india[- ]based only|must (live|reside) in (the )?(uk|canada|india))/i.test(text);
  return { javaCentric, sponsorshipRisk, restricted, experienceMaxYears, nonUsText };
}

const US_STATES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia';
const NON_US = /canada|ontario|toronto|vancouver|montreal|calgary|waterloo|united kingdom|london|england|scotland|wales|ireland|dublin|germany|berlin|munich|france|paris|india|bangalore|bengaluru|hyderabad|pune|mumbai|delhi|jaipur|kolkata|ahmedabad|chennai|kochi|indore|lucknow|nagpur|surat|coimbatore|thiruvananthapuram|australia|sydney|melbourne|singapore|tokyo|japan|brazil|sao paulo|mexico|mexico city|poland|warsaw|krakow|spain|madrid|barcelona|netherlands|amsterdam|israel|tel aviv|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|czech|prague|portugal|lisbon|italy|milan|rome|new zealand|auckland|hong kong|china|beijing|shanghai|shenzhen|south korea|seoul|philippines|manila|vietnam|hanoi|indonesia|jakarta|malaysia|kuala lumpur|argentina|buenos aires|chile|santiago|colombia|bogota|peru|lima|uruguay|montevideo|south africa|cape town|johannesburg|nigeria|lagos|kenya|nairobi|egypt|cairo|uae|dubai|abu dhabi|saudi|riyadh|qatar|doha|pakistan|islamabad|lahore|karachi|bangladesh|dhaka|sri lanka|colombo|nepal|kathmandu|\bapac\b|\bemea\b/i;

export function remoteAssessment({ location = '', workplace = null, isRemote = null, description = '' } = {}) {
  const loc = String(location || '').trim();
  const lower = loc.toLowerCase();
  const text = stripHtml(description).toLowerCase();
  const wp = String(workplace || '').toLowerCase();
  const remoteSignal = /\bremote\b/.test(lower) || wp === 'remote' || isRemote === true;
  const hybridSignal = /hybrid/.test(lower) || wp === 'hybrid';
  const onsiteSignal = /on[- ]site|in[- ]office/.test(lower) || wp === 'onsite' || wp === 'on-site';
  const hasNonUs = NON_US.test(loc);
  const hasUs = /\b(united states|usa|u\.s\.a\.|u\.s\.)\b/i.test(loc) || new RegExp(`\\b(${US_STATES})\\b`, 'i').test(loc) || /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(loc);
  const textUsRemote = /(remote[^.]{0,80}(united states|usa|u\.s\.)|(united states|usa|u\.s\.)[^.]{0,80}remote|based in the united states|u\.s\.-based|us-based)/i.test(text);
  if (hasNonUs) return { usRemote: false, remoteType: 'non-us', remoteReason: 'Primary location is outside the US' };
  if (hybridSignal || onsiteSignal) return { usRemote: false, remoteType: hybridSignal ? 'hybrid' : 'onsite', remoteReason: 'Hybrid or onsite location' };
  if (remoteSignal && (hasUs || textUsRemote || /^remote$/i.test(loc))) return { usRemote: true, remoteType: 'us-remote', remoteReason: 'US remote signal verified from ATS fields' };
  if (remoteSignal) return { usRemote: null, remoteType: 'remote-unknown', remoteReason: 'Remote is stated, but US eligibility is not explicit' };
  return { usRemote: false, remoteType: 'not-remote', remoteReason: 'No remote signal in ATS fields' };
}

export function freshness(published, now = Date.now()) {
  if (!published) return { ageDays: null, within24h: false, within7d: false };
  const ts = Date.parse(published);
  if (Number.isNaN(ts)) return { ageDays: null, within24h: false, within7d: false };
  const ageMs = now - ts;
  return {
    ageDays: Math.round((ageMs / 86400000) * 10) / 10,
    within24h: ageMs >= 0 && ageMs <= 86400000,
    within7d: ageMs >= 0 && ageMs <= FRESH_WINDOW_DAYS * 86400000,
  };
}

export function normalizeCompany(value = '') {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// USA-only snapshot rule: a job stays only when nothing marks it non-US.
// US-onsite and US-unknown locations remain visible for manual review;
// fit still requires verified US remote.
export function isUsJob(job) {
  return job && job.remoteType !== 'non-us' && !(job.flags && job.flags.nonUsText);
}

export function assessJob(job, now = Date.now()) {
  const flags = { ...(job.flags || {}) };
  const fresh = freshness(job.published, now);
  const blocks = [];
  const notes = [];
  if (!job.role) blocks.push('No target role lane');
  if (!fresh.within7d) blocks.push(job.published ? 'Outside 7-day window' : 'Posting date unknown');
  if (job.usRemote !== true) blocks.push(job.remoteReason || 'US remote not verified');
  if (flags.excludedLevel) blocks.push('Excluded seniority/title level');
  if (flags.intern) blocks.push('Intern or entry-level');
  if (flags.javaCentric) blocks.push('Java/Spring-centric');
  if (flags.sponsorshipRisk) blocks.push('JD states sponsorship restriction');
  if (flags.restricted) blocks.push('Government, clearance, or citizenship restriction');
  if (flags.nonUsText) blocks.push('JD indicates location outside the US');
  if (flags.experienceMaxYears && flags.experienceMaxYears >= 7) blocks.push(`Experience ask may be ${flags.experienceMaxYears}+ years`);
  if (job.salaryMax && job.salaryMax < SALARY_FLOOR) blocks.push('Listed salary is below $125k');
  if (job.alreadyApplied) notes.push('Company already applied');
  if (job.salaryMin && job.salaryMin >= SALARY_FLOOR) notes.push('Listed salary meets $125k floor');
  else if (job.salaryMax && job.salaryMax >= SALARY_FLOOR) notes.push('Listed salary range reaches $125k');
  else if (!job.salaryMax) notes.push('Salary not listed');
  return { ...job, ...fresh, flags, fit: blocks.length === 0, fitBlocks: blocks, fitNotes: notes };
}

export function enrichJob(base, { description = '', structuredSalaryText = '' } = {}, now = Date.now()) {
  const salary = parseSalary(description, structuredSalaryText || base.salary || '');
  const tf = titleFlags(base.title);
  const xf = textFlags(base.title, description);
  const remote = remoteAssessment({ location: base.location, workplace: base.workplace, isRemote: base.isRemote, description });
  const job = {
    ...base,
    salary: salary.salary || base.salary || null,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    usRemote: remote.usRemote,
    remoteType: remote.remoteType,
    remoteReason: remote.remoteReason,
    flags: { ...tf, ...xf },
  };
  delete job.isRemote;
  return assessJob(job, now);
}
