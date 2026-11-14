// Job Finder: daily collector. Node 20+, no dependencies.
// Pipeline: fetch -> normalize -> filter (remote, location, language, date) -> score -> dedupe -> link check -> data/jobs.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { detectNiche } from './niches.mjs';

const DAY = 864e5, KEEP_DAYS = 30, MIN_SCORE = 70, DATA = 'data/jobs.json';
const UA = 'JobFinderPersonal/1.0 (personal job search tool)';
const log = (...a) => console.log(...a);

// Add company boards here. The token is the name in the company's job-board address,
// e.g. boards.greenhouse.io/examplecompany -> 'examplecompany'
export const CONFIG = {
  greenhouse: [],
  lever: ['supportninja'],            // jobs.lever.co/supportninja
  names: { supportninja: 'SupportNinja' }, // display names for the boards above
};

// ---------- helpers ----------
const dec = s => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const strip = h => String(h||'').replace(/<(br|\/p|\/li|\/h\d|\/div|\/ul)[^>]*>/gi,'\n').replace(/<li[^>]*>/gi,'• ')
  .replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
  .replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
const textOf = h => strip(/&lt;\/?\w+/.test(h||'') ? dec(h) : h);
const toIso = s => { if (s==null||s==='') return null; let d = typeof s==='number' ? s : String(s);
  if (typeof d==='string' && /^\d{4}-\d\d-\d\d[T ][\d:.]+$/.test(d)) d = d.replace(' ','T')+'Z';
  const t = new Date(d); return isNaN(t) ? null : t.toISOString(); };
async function get(url, type='json') {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 20000);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return type === 'json' ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

// ---------- source connectors (each returns raw jobs) ----------
export const connectors = {
  async remotive() { // public API; link back to Remotive is required, so the job URL stays on remotive.com
    const out = [];
    for (const q of ['category=customer-support','search=virtual%20assistant','search=coordinator','search=administrative']) {
      const d = await get('https://remotive.com/api/remote-jobs?limit=100&' + q);
      for (const j of d.jobs || []) out.push({ source:'Remotive', title:j.title, company:j.company_name, published_at:toIso(j.publication_date),
        date_type:'published', location:j.candidate_required_location||'', salary:j.salary||'',
        type:{full_time:'Full-time',part_time:'Part-time',contract:'Contract',freelance:'Freelance'}[j.job_type]||null,
        html:j.description, url:j.url, remoteOnly:true, priority:2 });
    }
    return out;
  },
  async wwr() { // We Work Remotely RSS
    const x = await get('https://weworkremotely.com/remote-jobs.rss', 'text');
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => { const b = m[1];
      const tag = n => { const r = b.match(new RegExp('<'+n+'[^>]*>([\\s\\S]*?)</'+n+'>')); return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : ''; };
      const full = tag('title'), i = full.indexOf(': ');
      return { source:'We Work Remotely', title:i>0?full.slice(i+2):full, company:i>0?full.slice(0,i):'', published_at:toIso(tag('pubDate')),
        date_type:'published', location:tag('region'), html:tag('description'), url:tag('link')||tag('guid'), remoteOnly:true, type:tag('type')||null, priority:2 }; });
  },
  async remoteok() { // public API; link back required
    const d = await get('https://remoteok.com/api');
    return d.filter(j => j && j.id && j.position).map(j => ({ source:'Remote OK', title:j.position, company:j.company, published_at:toIso(j.date),
      date_type:'published', location:j.location||'', salary:j.salary_min ? `$${j.salary_min.toLocaleString()}-${(j.salary_max||j.salary_min).toLocaleString()}/yr` : '',
      salary_max:j.salary_max||0, html:j.description, url:j.url||j.apply_url, remoteOnly:true, priority:2 }));
  },
  async greenhouse() { // company career pages built on Greenhouse
    const out = [];
    for (const b of CONFIG.greenhouse) { try {
      const d = await get(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`);
      for (const j of d.jobs || []) out.push({ source:'Company career page', title:j.title, company:j.company_name||b,
        published_at:toIso(j.first_published||j.updated_at), date_type:j.first_published?'published':'updated',
        location:j.location?.name||'', html:j.content||'', url:j.absolute_url, remoteOnly:false, priority:1 });
    } catch (e) { log(`greenhouse ${b}: ${e.message}`); } }
    return out;
  },
  async lever() { // company career pages built on Lever
    const out = [];
    for (const b of CONFIG.lever) { try {
      const d = await get(`https://api.lever.co/v0/postings/${b}?mode=json`);
      for (const j of d) out.push({ source:'Company career page', title:j.text, company:(CONFIG.names||{})[b]||b, published_at:toIso(j.createdAt), date_type:'published',
        location:`${j.categories?.location||''} ${j.workplaceType||''}`.trim(), html:[j.descriptionPlain||j.description||'', ...(j.lists||[]).map(l => `${l.text}\n${l.content}`), j.additionalPlain||''].join('\n'), url:j.hostedUrl, remoteOnly:j.workplaceType==='remote', priority:1 });
    } catch (e) { log(`lever ${b}: ${e.message}`); } }
    return out;
  },
};

// ---------- rules ----------
const CATS = [
  ['Customer Service and Support', /customer (service|support|success|care|experience)|support (representative|specialist|agent|associate)|billing (specialist|support|associate)|help ?desk|chat (support|agent)|email support/i],
  ['Administrative Support', /administrative|admin(istrator)? assistant|virtual assistant|executive assistant|data entry|documentation specialist|office assistant|personal assistant/i],
  ['Scheduling and Coordination', /schedul|dispatch|service coordinator|on-call coordinator|maintenance coordinator|work order/i],
  ['Vendor and Account Support', /vendor|account support|client operations|onboarding (assistant|specialist|coordinator)/i],
  ['Operations Support', /operations? (assistant|coordinator|support|specialist|associate)|back[- ]office|process coordinator|business operations/i],
];
const TITLE_EXCLUDE = /\b(director|vp|vice president|head of|engineer|developer|designer|devops|scientist|architect|attorney|counsel|nurse|sales)\b/i;
const BAD_REMOTE = /hybrid|on-?site|in[- ]office|office[- ]based|(days?|times?)\s+(a|per)\s+(week|month)\s+(in|at)\s+(the\s+)?office|come (in)?to the office/i;
const COUNTRIES = 'us|u\\.s\\.|usa|united states|uk|canada|europe|eu|australia|latam|india|brazil|mexico|germany';
const LOC_FAIL = new RegExp(`(\\b(${COUNTRIES})\\b\\s*[-–]?\\s*(only|residents?|citizens?))|(must\\s+(currently\\s+)?(reside|live|be\\s+(located|based|residing))\\s+in\\s+(the\\s+)?(${COUNTRIES}))|((authorized|eligible|legally\\s+entitled)\\s+to\\s+work\\s+in\\s+(the\\s+)?(us|u\\.s\\.|united states|uk|canada|eu|europe|australia))`, 'i');
const LANGS = 'spanish|mandarin|chinese|cantonese|japanese|korean|german|french|portuguese|arabic|hindi|italian|dutch|russian|polish|turkish|vietnamese|thai|indonesian|bahasa';
const LANG_RE = new RegExp('\\b(' + LANGS + ')\\b', 'i');
export function langRequired(t) {
  for (const s of t.split(/[.\n•;]/)) {
    if (!LANG_RE.test(s)) continue;
    if (/\b(plus|bonus|preferred|nice to have|advantage|asset|desirable|optional)\b/i.test(s)) continue;
    if (/\b(fluen\w*|proficien\w*|native|bilingual|required|must|speaker|speaking|written|verbal)\b/i.test(s)) return true;
  }
  return false;
}
function locationState(field, text) { // 'pass' | 'fail' | 'unknown'
  const f = (field || '').toLowerCase();
  if (LOC_FAIL.test(text) || LOC_FAIL.test(field || '')) return 'fail';
  if (/philippines|\bph\b/.test(f)) return 'pass';
  if (/worldwide|anywhere|global|any location|apac|asia/.test(f) && !/(except|excluding|excl\.)/.test(f)) return 'pass';
  if (f && new RegExp(`\\b(${COUNTRIES})\\b|only|americas|emea|timezone|time zone`, 'i').test(f)) return 'fail';
  if (/philippines/i.test(text)) return 'pass';
  return 'unknown';
}
const SKILLS = ['customer','email','chat','phone','ticket','crm','helpdesk','billing','refund','subscription','escalat','vendor','work order','scheduling','calendar','dispatch','data entry','documentation','back office','invoice','onboarding','inbox','coordinat','reporting','records'];
export function score(title, text, loc) {
  const t = title.toLowerCase(), x = text.toLowerCase(); let s = 55;
  if (/assistant|coordinator|specialist|representative|associate|agent/.test(t)) s += 10;
  s += Math.min(20, SKILLS.filter(k => x.includes(k)).length * 3);
  if (loc === 'pass') s += 8;
  if (x.includes('philippines')) s += 7;
  for (const m of x.matchAll(/(\d+)\+?\s*(?:years|yrs)[^.\n]{0,40}experience/g)) if (+m[1] >= 5) { s -= 10; break; }
  if (/senior|sr\./.test(t)) s -= 8;
  if (/manager|lead|supervisor/.test(t)) s -= 8;
  return Math.max(0, Math.min(100, Math.round(s)));
}
function sections(text) {
  const lines = text.split('\n').map(l => l.replace(/^[•\-*\s]+/, '').trim()).filter(Boolean);
  let mode = null; const resp = [], qual = [];
  for (const l of lines) {
    if (l.length < 60 && /(responsibilit|what you.?ll do|duties|your role)/i.test(l)) mode = 'r';
    else if (l.length < 60 && /(qualification|requirement|what you.?ll need|about you|who you are)/i.test(l)) mode = 'q';
    else if (mode === 'r' && resp.length < 4 && l.length > 8) resp.push(l.slice(0, 160));
    else if (mode === 'q' && qual.length < 4 && l.length > 8) qual.push(l.slice(0, 160));
  }
  return { resp, qual };
}
const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = j => createHash('sha1').update(norm(j.company) + '|' + norm(j.title)).digest('hex').slice(0, 10);

// Returns a job object, or null if it fails a mandatory filter.
export function evaluate(raw, now = Date.now()) {
  const title = (raw.title || '').trim(); if (!title || !raw.url || TITLE_EXCLUDE.test(title)) return null;
  const category = (CATS.find(([, re]) => re.test(title)) || [])[0]; if (!category) return null;
  const text = textOf(raw.html);
  const cleaned = text.replace(/\b(no|not|never|without)\b[^.\n]{0,25}?(on-?site|in[- ]office|hybrid)/gi, '');
  // 'hybrid' or office attendance in the title/location, or clear office days in the text -> drop.
  // A bare mention of the word 'hybrid' in the text only -> keep, but send to Needs verification.
  const hybridMention = /hybrid/i.test(cleaned) && !BAD_REMOTE.test(cleaned.replace(/hybrid/gi, ''));
  if (BAD_REMOTE.test(`${title} ${raw.location}`) || (BAD_REMOTE.test(cleaned) && !hybridMention)) return null;
  if (langRequired(text)) return null;                                                          // other language required
  const loc = locationState(raw.location, text); if (loc === 'fail') return null;               // restricted to another country
  const published = raw.published_at ? new Date(raw.published_at).getTime() : null;
  if (published && (now - published) / DAY > KEEP_DAYS) return null;
  const sc = score(title, `${raw.location} ${text}`, loc); if (sc < MIN_SCORE) return null;
  const remoteOk = !hybridMention && (raw.remoteOnly || (/\bremote\b|work from home|\bwfh\b|home[- ]?based/i.test(raw.location || '') && !/[\/;|]/.test(raw.location || '')));
  const confirmed = remoteOk && loc === 'pass' && published != null;
  const { resp, qual } = sections(text);
  const sal = raw.salary || '';
  const nums = [...sal.matchAll(/(\d[\d,.]*)\s*(k)?/gi)].map(m => parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)).filter(Boolean);
  const mentioned = (text.match(LANG_RE) || [])[0];
  return {
    id: keyOf(raw), title, company: raw.company || 'Not stated', category, niche: detectNiche(title, text), source: raw.source,
    published_at: published ? new Date(Math.min(published, now)).toISOString() : null, date_type: raw.date_type,
    remote: remoteOk ? 'confirmed' : 'needs',
    eligible_location: loc === 'pass' ? (/philippines/i.test(`${raw.location} ${text}`) ? 'Philippines' : (raw.location || 'Worldwide')) : 'Not stated',
    languages: mentioned ? 'English (other languages mentioned, not required)' : 'English',
    salary: sal || null, salary_max: raw.salary_max || (nums.length ? Math.max(...nums) : 0), type: raw.type || null,
    score: sc, verification: confirmed ? 'confirmed' : 'needs',
    summary: text.replace(/\s+/g, ' ').slice(0, 300) + (text.length > 300 ? '…' : ''),
    responsibilities: resp, qualifications: qual, url: raw.url, _priority: raw.priority || 3,
  };
}
export function dedupe(list) {
  const best = new Map();
  for (const j of list) { const o = best.get(j.id);
    if (!o || j._priority < o._priority || (j._priority === o._priority && (j.published_at || 'z') < (o.published_at || 'z'))) best.set(j.id, j); }
  return [...best.values()];
}
async function linkAlive(url) {
  for (const method of ['HEAD', 'GET']) {
    try { const c = new AbortController(), t = setTimeout(() => c.abort(), 10000);
      const r = await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: c.signal }); clearTimeout(t);
      if (r.status === 404 || r.status === 410) return false;
      if (r.ok) return true;
    } catch { /* network problems do not prove the job is gone */ }
  }
  return true;
}
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }

export async function main() {
  const now = Date.now(); let prev = [];
  try { const p = JSON.parse(await readFile(DATA, 'utf8')); if (!p.sample) prev = p.jobs || []; } catch {}
  const raw = [], sources = {};
  for (const [name, fn] of Object.entries(connectors)) {
    try { const r = await fn(); raw.push(...r); sources[name] = { ok: true, fetched: r.length }; log(`${name}: ${r.length} fetched`); }
    catch (e) { sources[name] = { ok: false, error: e.message }; log(`${name}: FAILED ${e.message}`); }
  }
  if (!raw.length) { console.error('No source returned any jobs. Keeping the existing data.'); process.exit(1); }
  const jobs = dedupe(raw.map(r => evaluate(r, now)).filter(Boolean));
  await pool(jobs.filter(j => j.verification === 'confirmed'), 6, async j => { j._dead = !(await linkAlive(j.url)); });
  const fresh = jobs.filter(j => !j._dead).map(({ _priority, _dead, ...j }) => j);
  const prevIds = new Set(prev.map(j => j.id)), freshIds = new Set(fresh.map(j => j.id));
  for (const j of fresh) j.first_seen = (prev.find(p => p.id === j.id) || {}).first_seen || new Date(now).toISOString();
  const kept = prev.filter(j => !freshIds.has(j.id) && j.published_at && (now - new Date(j.published_at)) / DAY <= KEEP_DAYS);
  const all = [...fresh, ...kept].sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  const newIds = fresh.filter(j => !prevIds.has(j.id)).map(j => j.id);
  await mkdir('data', { recursive: true });
  await writeFile(DATA, JSON.stringify({ sample: false, generated_at: new Date(now).toISOString(), new_ids: newIds, sources, jobs: all }, null, 1));
  log(`Done: ${fresh.length} matching, ${newIds.length} new, ${all.length} total saved.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
