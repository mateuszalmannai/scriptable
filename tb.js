// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: clock;

// tb — Timebutler time tracking and absences for Scriptable (iPhone), over
// the Timebutler REST API v2 (https://app.timebutler.com/api/v2/docs).
//
// Three ways to run it:
//   * In the Scriptable app: a menu with pickers and confirmations.
//   * As a widget: clock state, a live timer while running, today's hours.
//   * From Shortcuts / Siri / a URL with parameters, like the CLI:
//       scriptable:///run/tb?cmd=start
//       Shortcuts "Run Script", parameter = dictionary
//         {cmd: "stop", project: "Internal", message: "release", yes: true}
//     or just the text "status". Writes need yes=true when no UI can be
//     shown (Shortcuts running the script outside the app). json=true makes
//     the shortcut output the raw API data instead of text.
//
// Commands (parameter names match the CLI flags):
//   status | start | pause | resume | cancel
//   stop      project, category, message, break (apply|ignore)
//   log       date, time (09:00-17:30), pause, project, category, message,
//             or entries: [{date, time, pause, project, category, remarks}]
//             with top-level project/category/pause as defaults; dryRun
//   entries   month (YYYY-MM or YYYY)
//   balance | whoami
//   off       start, end, type (VAC), half (morning|afternoon), sub, message, hours
//   absences  editing, upcoming
//   absence-cancel  id, reason
//   ics       pending
//   projects | categories | absence-types | subs   (refresh)
//
// The token (tb_…) is stored in the iOS Keychain on first run in the app.

'use strict';

const BASE_URL = 'https://app.timebutler.com/api/v2';
const TZ = 'Europe/Berlin';
const KEYCHAIN_KEY = 'timebutler_token';
const CACHE_TTL_MS = 60 * 60 * 1000;
const IS_SCRIPTABLE = typeof Script !== 'undefined' && typeof Request !== 'undefined';

// --- time --------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function formatMinutes(m) {
  m = Math.trunc(m || 0);
  let sign = '';
  if (m < 0) { sign = '-'; m = -m; }
  return `${sign}${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

function formatSeconds(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// berlinParts is the Europe/Berlin wall clock at an instant.
function berlinParts(date) {
  const p = {};
  for (const x of partsFmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
}

// berlinTime is the instant of a Europe/Berlin wall-clock time, whatever the
// phone's own time zone is. It corrects a UTC guess by the zone offset.
function berlinTime(y, m, d, h = 0, mi = 0) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = berlinParts(new Date(t));
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    if (got === want) break;
    t += want - got;
  }
  return new Date(t);
}

const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const hhmm = (date) => { const p = berlinParts(date); return `${pad2(p.h)}:${pad2(p.mi)}`; };
const todayBerlin = (now) => { const p = berlinParts(now); return ymd(p.y, p.m, p.d); };

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function weekday(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return date || '-';
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] + ' ' + date;
}

// parseDate accepts YYYY-MM-DD, today, yesterday and tomorrow (Berlin days).
function parseDate(s, now) {
  const v = String(s ?? '').trim().toLowerCase();
  const today = todayBerlin(now);
  if (v === '' || v === 'today') return today;
  if (v === 'yesterday') return addDays(today, -1);
  if (v === 'tomorrow') return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v) return v;
  throw new Error(`date "${s}": want YYYY-MM-DD, today, yesterday or tomorrow`);
}

// parseHHMM: "9:00", "09:00" and "0900" are fine, "09:00:00" and "9:60" are not.
function parseHHMM(s) {
  s = String(s).trim();
  let h, m;
  const i = s.indexOf(':');
  if (i >= 0) { h = s.slice(0, i); m = s.slice(i + 1); }
  else if (s.length === 4) { h = s.slice(0, 2); m = s.slice(2); }
  const bad = () => new Error(`time "${s}": want HH:MM`);
  if (h === undefined || !/^\d{1,2}$/.test(h) || !/^\d{2}$/.test(m)) throw bad();
  const hh = +h, mm = +m;
  if (hh > 23 || mm > 59) throw bad();
  return [hh, mm];
}

// parseSpan turns a date and "09:00-17:30" into Berlin start and end instants
// on the same day.
function parseSpan(date, span, now) {
  const day = parseDate(date, now);
  const s = String(span ?? '');
  const i = s.indexOf('-');
  if (i < 0) throw new Error(`time range "${s}": want HH:MM-HH:MM`);
  const [sh, sm] = parseHHMM(s.slice(0, i));
  const [eh, em] = parseHHMM(s.slice(i + 1));
  const [y, m, d] = day.split('-').map(Number);
  const start = berlinTime(y, m, d, sh, sm);
  const end = berlinTime(y, m, d, eh, em);
  if (end <= start) throw new Error(`time range "${s}": end must be after start on the same day`);
  return { day, start, end };
}

// parsePause reads "30m", "1h", "1h15m", "0" or a bare number, in minutes.
function parsePause(s) {
  s = String(s ?? '').trim();
  if (s === '') return 0;
  if (/^\d+$/.test(s)) return +s;
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/.exec(s);
  const min = m && (m[1] || m[2]) ? (+(m[1] || 0)) * 60 + (+(m[2] || 0)) : NaN;
  if (!Number.isInteger(min)) throw new Error(`pause "${s}": want minutes like 30, 30m, 1h or 1h15m`);
  return min;
}

// --- name matching -------------------------------------------------------------

function isSubsequence(q, s) {
  let i = 0;
  for (const c of q) {
    while (i < s.length && s[i] !== c) i++;
    if (i === s.length) return false;
    i++;
  }
  return true;
}

// resolve picks the item meant by query: exact ID, exact name, unique prefix,
// unique substring, then unique subsequence ("cprt" -> "CustomerPortal").
// Ambiguity is an error listing the candidates, never a guess.
function resolve(kind, items, query) {
  const raw = String(query ?? '').trim();
  const q = raw.toLowerCase();
  if (!q) throw new Error(`empty ${kind}`);
  const byId = items.find((it) => String(it.id) === raw);
  if (byId) return byId;
  const tiers = [
    (n) => n === q,
    (n) => n.startsWith(q),
    (n) => n.includes(q),
    (n) => isSubsequence(q, n),
  ];
  for (const match of tiers) {
    const hits = items.filter((it) => match(String(it.name).toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(`${kind} "${query}" is ambiguous: ${hits.map((h) => `${h.name} (${h.id})`).join(', ')}`);
    }
  }
  throw new Error(`no ${kind} matches "${query}"`);
}

const NONE = { id: 0, name: '-' };
const choiceLabel = (c) => (c.id === 0 ? '-' : c.name);

function toChoice(kind, hit) {
  const id = parseInt(hit.id, 10);
  if (!Number.isInteger(id) || String(id) !== String(hit.id)) {
    throw new Error(`${kind} "${hit.name}" has non-numeric id "${hit.id}"`);
  }
  return { id, name: hit.name };
}

// pick: an explicit query wins, then the company default; a mandatory field
// without either is an error. "none" or "0" asks for no assignment.
function pick(kind, listCmd, query, items, defaultId, mandatory) {
  const q = String(query ?? '').trim();
  if (q === 'none' || q === '0') {
    if (mandatory) throw new Error(`a ${kind} is mandatory in this company`);
    return NONE;
  }
  if (q) return toChoice(kind, resolve(kind, items, q));
  if (defaultId) {
    const hit = items.find((it) => String(it.id) === String(defaultId)) || { id: defaultId, name: 'default' };
    return toChoice(kind, hit);
  }
  if (mandatory) throw new Error(`a ${kind} is mandatory: pass one (see the ${listCmd} list)`);
  return NONE;
}

// --- .ics ------------------------------------------------------------------------

const escapeText = (s) => String(s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

// fold wraps content lines at 75 octets (RFC 5545 §3.1) without splitting UTF-8.
function fold(s) {
  const enc = (c) => unescape(encodeURIComponent(c)).length;
  let out = '', n = 0;
  for (const c of s) {
    const size = enc(c);
    if (n + size > 75) { out += '\r\n '; n = 1; }
    out += c; n += size;
  }
  return out;
}

function ics(absences, typeNames, now) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//util tb//Timebutler absences//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Timebutler absences'];
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  for (const a of absences) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(a.endDate)) continue;
    let summary = typeNames[a.type] || a.type;
    if (a.halfDay) summary += ` (½ ${a.halfDay})`;
    if (a.status !== 'approved') summary += ` [${a.status}]`;
    lines.push('BEGIN:VEVENT',
      `UID:timebutler-absence-${a.id}@util-tb`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${a.startDate.replace(/-/g, '')}`,
      // DTEND of an all-day event is exclusive.
      `DTEND;VALUE=DATE:${addDays(a.endDate, 1).replace(/-/g, '')}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(a.type)}\\, ${a.days} day(s)\\, status ${escapeText(a.status)}`,
      'TRANSP:TRANSPARENT',
      a.status !== 'approved' ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// --- API client --------------------------------------------------------------------

const STATUS_TEXT = { 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

class ApiError extends Error {
  constructor(status, message, ignorable) {
    const suffix = message ? ': ' + message : '';
    let text;
    switch (status) {
      case 401: text = '401 unauthorized: token missing, invalid or revoked (create a new one via the docs page)' + suffix; break;
      case 403: text = '403 forbidden: no permission for this action, or blocked by an IP restriction' + suffix; break;
      case 409: text = '409 conflict' + suffix; break;
      case 422: if (message) { text = message; break; } // falls through
      case 429: if (!text && status === 429) { text = '429 rate limited, still after one retry' + suffix; break; } // falls through
      default: text = `${status} ${STATUS_TEXT[status] || 'error'}${suffix}`;
    }
    super(text);
    this.status = status;
    this.apiMessage = message;
    this.ignorable = !!ignorable;
  }
}

function decodeError(status, text) {
  try {
    const b = JSON.parse(text);
    const msg = [b.error, b.message, b.detail].find((m) => typeof m === 'string' && m) || '';
    return new ApiError(status, msg, b.ignorable);
  } catch (_) {
    const t = String(text || '').trim();
    return new ApiError(status, t && t.length < 500 && !t.startsWith('<') ? t : '', false);
  }
}

function retryAfterMs(h) {
  const s = parseInt(String(h ?? '').trim(), 10);
  return Number.isInteger(s) && s >= 0 && s <= 120 ? s * 1000 : 5000;
}

function header(headers, name) {
  const k = Object.keys(headers || {}).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}

// Client mirrors internal/timebutler: transport({method,url,headers,body})
// resolves to {status, headers, text}; sleep(ms) waits before the one 429 retry.
class Client {
  constructor(token, transport, sleep, baseURL = BASE_URL) {
    Object.assign(this, { token, transport, sleep, baseURL: baseURL.replace(/\/+$/, '') });
  }

  async call(method, path, { query, body } = {}) {
    let url = this.baseURL + path;
    const qs = Object.entries(query || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    if (qs) url += '?' + qs;
    const headers = { Authorization: 'Bearer ' + this.token, Accept: 'application/json' };
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    for (let attempt = 0; ; attempt++) {
      const res = await this.transport({ method, url, headers, body: payload });
      if (res.status === 429 && attempt === 0) { await this.sleep(retryAfterMs(header(res.headers, 'Retry-After'))); continue; }
      if (res.status < 200 || res.status > 299) throw decodeError(res.status, res.text);
      const text = String(res.text || '').trim();
      let data = null;
      if (res.status !== 204 && text) {
        try { data = JSON.parse(text); } catch (e) { throw new Error(`decode ${method} ${path}: ${e.message}`); }
      }
      return { status: res.status, data };
    }
  }

  async get(path, query) { return (await this.call('GET', path, { query })).data; }
  clockStatus() { return this.get('/time-clock/status'); }
  // action: start | pause | resume | cancel | business-trip-start | business-trip-end
  async clockAction(action) { return (await this.call('POST', '/time-clock/' + action)).data || {}; }
  async clockStop(req) {
    const r = await this.call('POST', '/time-clock/stop', { body: req });
    return r.status === 204 ? { outcome: 'discarded' } : r.data;
  }
  async clockEntry(req) { return (await this.call('POST', '/time-tracking/clock-entry', { body: req })).data; }
  workSummary() { return this.get('/time-tracking/work-summary'); }
  timeOffSummary() { return this.get('/time-tracking/time-off-summary'); }
  myTimeEntries(year, month) {
    const q = {};
    if (year > 0) { q.year = year; if (month > 0) q.month = month; }
    return this.get('/time-entries/my', q);
  }
  projects() { return this.get('/projects'); }
  categories() { return this.get('/categories'); }
  absenceTypes() { return this.get('/absence-types'); }
  substitutes() { return this.get('/substitute-employees'); }
  profile() { return this.get('/user/profile'); }
  myAbsences(includeEditing) { return this.get('/absence-requests/my', { includeEditing: String(!!includeEditing) }); }
  async createAbsence(req) { return (await this.call('POST', '/absence-requests', { body: req })).data; }
  async deleteAbsence(id, reason) {
    return (await this.call('DELETE', '/absence-requests/' + id, { body: reason ? { reason } : undefined })).data;
  }
}

// --- environment ------------------------------------------------------------------

const aborted = () => new Error('Aborted, nothing changed.');

// env: { client, cache: {load(name), save(name, v)}, now(), ui, interactive, yes }
async function confirm(env, title, message) {
  if (env.yes) return true;
  if (!env.interactive) throw new Error(`Confirmation needed for: ${title}\n${message}\nPass yes=true to run it without asking.`);
  return env.ui.confirm(title, message);
}

async function cached(env, name, refresh, fetch) {
  if (!refresh) { const v = env.cache.load(name); if (v !== undefined) return v; }
  const v = await fetch();
  env.cache.save(name, v);
  return v;
}
const lookups = {
  projects: (env, r) => cached(env, 'projects', r, () => env.client.projects()),
  categories: (env, r) => cached(env, 'categories', r, () => env.client.categories()),
  absenceTypes: (env, r) => cached(env, 'absence-types', r, () => env.client.absenceTypes()),
  substitutes: (env, r) => cached(env, 'substitutes', r, () => env.client.substitutes()),
};

// chooseInteractive offers the default first, the others, then "None" when allowed.
async function chooseInteractive(env, kind, items, defaultId, mandatory) {
  if (items.length === 0) return NONE;
  const def = items.find((it) => String(it.id) === String(defaultId));
  const ordered = def ? [def, ...items.filter((it) => it !== def)] : items;
  const labels = ordered.map((it) => (it === def ? `★ ${it.name} (default)` : it.name));
  if (!mandatory) labels.push('None');
  const i = await env.ui.choose(kind[0].toUpperCase() + kind.slice(1), labels, mandatory ? `A ${kind} is mandatory.` : '');
  if (i < 0) throw aborted();
  return i >= ordered.length ? NONE : toChoice(kind, ordered[i]);
}

// resolveAssignment turns project/category queries into IDs; in the app an
// unset one is asked with a picker, elsewhere the company default applies.
async function resolveAssignment(env, project, category) {
  const ps = await lookups.projects(env);
  const pn = (ps.projects || []).map((p) => ({ id: p.id, name: p.name }));
  const pMand = !!ps.isProjectMandatory && pn.length > 0;
  const p = env.interactive && project === undefined
    ? await chooseInteractive(env, 'project', pn, ps.defaultProjectId, pMand)
    : pick('project', 'projects', project, pn, ps.defaultProjectId, pMand);
  const cs = await lookups.categories(env);
  const cn = cs.categories || [];
  const cMand = !!cs.isCategoryMandatory && cn.length > 0;
  const c = env.interactive && category === undefined
    ? await chooseInteractive(env, 'category', cn, cs.defaultCategoryId, cMand)
    : pick('category', 'categories', category, cn, cs.defaultCategoryId, cMand);
  return { project: p, category: c };
}

// --- commands -------------------------------------------------------------------------
// Each returns { data, text } (data = what --json prints), optionally rows
// [{title, subtitle}] for a table in the app.

function clockLine(s) {
  let line = s.status;
  if (s.startTimestamp != null && s.status !== 'idle') {
    line += ' since ' + hhmm(new Date(s.startTimestamp));
    line += `, ${formatMinutes(Math.trunc(s.workTimeElapsedSeconds / 60))} worked`;
    if (s.accumulatedBreakSeconds > 0) line += `, ${formatMinutes(Math.trunc(s.accumulatedBreakSeconds / 60))} break`;
  }
  if (s.status === 'paused' && s.pauseTimestamp != null) line += ` (paused at ${hhmm(new Date(s.pauseTimestamp))})`;
  if (s.status === 'waiting' && s.waitSeconds != null) line += ` (${formatSeconds(s.waitSeconds)} until you may stop)`;
  if (s.isBusinessTripActive) line += ' [business trip]';
  return line;
}

function todayLine(w) {
  let line = `${formatMinutes(w.workedMinutes)} of ${formatMinutes(w.commitmentMinutes)} (${w.percentDone}%), break ${formatMinutes(w.breakMinutes)}`;
  if (w.remainingMinutes > 0) line += `, ${formatMinutes(w.remainingMinutes)} to go`;
  else if (w.remainingMinutes < 0) line += `, ${formatMinutes(-w.remainingMinutes)} over`;
  return line;
}

const commands = {};

commands.status = async (env) => {
  const s = await env.client.clockStatus();
  const w = await env.client.workSummary();
  return { data: { clock: s, today: w }, text: `Clock:  ${clockLine(s)}\nToday:  ${todayLine(w)}` };
};

for (const action of ['start', 'pause', 'resume']) {
  commands[action] = async (env) => {
    const s = await env.client.clockAction(action);
    return { data: s, text: 'Clock: ' + clockLine(s) };
  };
}

commands.cancel = async (env) => {
  const s = await env.client.clockStatus();
  if (s.status === 'idle') throw new Error('The clock is not running.');
  const ok = await confirm(env, 'Discard session?',
    `Discard the ${s.status} session (${formatMinutes(Math.trunc(s.workTimeElapsedSeconds / 60))} worked)? It will not be saved.`);
  if (!ok) throw aborted();
  const r = await env.client.clockAction('cancel');
  return { data: r, text: 'Clock: ' + clockLine(r) };
};

// breakDecision asks how to handle a break-rule violation; backing out
// leaves the clock running.
async function breakDecision(env, info, brk) {
  info = info || {};
  let msg = 'Break rule violated: ' + (info.detailText || '-');
  if (!info.hasNoRemedy) msg += `\napply → ${formatMinutes(info.resultingWorkMinutes)} worked, ${formatMinutes(info.resultingBreakMinutes)} break`;
  if (info.hasNoRemedy && info.obligatory) throw new Error(msg + '\nThis session cannot be saved as it is and has no automatic fix; the clock is still running, fix it in the web app.');
  if (brk === 'ignore' && info.obligatory) throw new Error(msg + '\nThe break rule is obligatory here, so break=ignore is not allowed; the clock is still running.');
  if (brk) return brk;
  if (!env.interactive || env.yes) throw new Error(msg + '\nThe break rule needs a decision: rerun with break=apply or break=ignore; the clock is still running.');
  const opts = [];
  if (!info.hasNoRemedy) opts.push(['Apply the correction', 'apply']);
  if (!info.obligatory) opts.push([info.hasNoRemedy ? 'Ignore and save unchanged' : 'Ignore it', 'ignore']);
  const i = await env.ui.choose('Break rule', opts.map((o) => o[0]), msg + (info.obligatory ? '\nThe rule is obligatory.' : ''));
  if (i < 0) throw new Error('Aborted, the clock is still running.');
  return opts[i][1];
}

commands.stop = async (env, o = {}) => {
  const brk = o.break || '';
  if (brk && brk !== 'apply' && brk !== 'ignore') throw new Error('break must be apply or ignore');
  const s = await env.client.clockStatus();
  if (s.status === 'idle') throw new Error('The clock is not running.');
  const { project, category } = await resolveAssignment(env, o.project, o.category);
  let remarks = o.message;
  if (remarks === undefined && env.interactive) {
    const r = await env.ui.form('Remarks', 'Optional remarks for the entry.', [{ placeholder: 'Remarks' }]);
    if (!r) throw aborted();
    remarks = r[0].trim();
  }
  remarks = remarks || '';
  const summary = `${clockLine(s)}\nProject: ${choiceLabel(project)}\nCategory: ${choiceLabel(category)}\nRemarks: ${remarks || '-'}`;
  if (!(await confirm(env, 'Stop and save?', summary))) throw aborted();

  const req = { projectId: project.id, categoryId: category.id };
  if (remarks) req.remarks = remarks;
  if (brk) req.breakRegulation = brk;
  let res = await env.client.clockStop(req);
  if (res.outcome === 'confirmationRequired') {
    req.breakRegulation = await breakDecision(env, res.breakRegulation, brk);
    res = await env.client.clockStop(req);
  }
  switch (res.outcome) {
    case 'discarded':
      return { data: res, text: 'The clock was still waiting for its delayed start; discarded, nothing saved.' };
    case 'saved': {
      let text = `Saved entry ${res.id}: ${formatMinutes(res.workedMinutes)} worked, ${formatMinutes(res.breakMinutes)} break`;
      if (res.breakRegulationApplied) text += ' (break rule correction applied)';
      if (res.breakRegulationIgnored) text += ' (break rule ignored)';
      return { data: res, text };
    }
    default:
      throw new Error(`Unexpected stop outcome "${res.outcome}"; check the status.`);
  }
};

const firstNonEmpty = (...v) => v.find((x) => x !== undefined && x !== null && String(x).trim() !== '');

async function planEntry(env, r) {
  const { start, end } = parseSpan(r.date, r.time, env.now());
  const pause = parsePause(r.pause);
  if (pause * 60000 >= end - start) throw new Error(`pause ${formatMinutes(pause)} is not shorter than the span`);
  const { project, category } = await resolveAssignment(env, r.project, r.category);
  return { start, end, pause, project, category, remarks: r.remarks || '' };
}

function planLine(p) {
  const net = Math.round((p.end - p.start) / 60000) - p.pause;
  return {
    net,
    title: `${weekday(todayBerlin(p.start))} ${hhmm(p.start)}-${hhmm(p.end)}`,
    subtitle: `${formatMinutes(net)} net, pause ${formatMinutes(p.pause)} · ${choiceLabel(p.project)} · ${choiceLabel(p.category)} · ${p.remarks || '-'}`,
  };
}

commands.log = async (env, o = {}) => {
  let raw;
  if (Array.isArray(o.entries)) {
    if (o.entries.length === 0) throw new Error('no entries');
    raw = o.entries.map((en) => ({
      date: en.date, time: en.time,
      project: firstNonEmpty(en.project, o.project),
      category: firstNonEmpty(en.category, o.category),
      pause: firstNonEmpty(en.pause, o.pause),
      remarks: firstNonEmpty(en.remarks, o.message),
    }));
  } else if (o.time) {
    raw = [{ date: o.date || 'today', time: o.time, pause: o.pause, project: o.project, category: o.category, remarks: o.message }];
  } else {
    throw new Error('need time like 09:00-17:30 (and optionally date), or entries');
  }
  const planned = [];
  for (const [i, r] of raw.entries()) {
    try { planned.push(await planEntry(env, r)); }
    catch (e) { throw new Error(`entry ${i + 1} (${r.date} ${r.time}): ${e.message}`); }
  }
  const lines = planned.map(planLine);
  let summary = lines.map((l) => `${l.title}: ${l.subtitle}`).join('\n');
  if (planned.length > 1) summary += `\nTotal: ${formatMinutes(lines.reduce((a, l) => a + l.net, 0))}`;
  if (o.dryRun) return { data: planned, text: summary + '\nDry run: nothing sent.' };
  if (!(await confirm(env, planned.length === 1 ? 'Submit this entry?' : `Submit ${planned.length} entries?`, summary))) throw aborted();

  const results = [], out = [];
  for (const [i, p] of planned.entries()) {
    let res;
    try {
      res = await env.client.clockEntry({
        startTimestamp: p.start.getTime(), endTimestamp: p.end.getTime(), pauseSeconds: p.pause * 60,
        projectId: p.project.id, categoryId: p.category.id, ...(p.remarks ? { remarks: p.remarks } : {}),
      });
    } catch (e) {
      if (i > 0) throw new Error(`entry ${i + 1} (${todayBerlin(p.start)} ${hhmm(p.start)}) failed after ${i} were saved: ${e.message}`);
      throw e;
    }
    results.push(res);
    out.push(`Saved ${lines[i].title} as entry ${res.id}: ${formatMinutes(res.workedMinutes)} worked`);
  }
  return { data: results, text: out.join('\n') };
};

commands.entries = async (env, o = {}) => {
  let year = 0, month = 0;
  if (o.month) {
    const m = /^(\d{4})(?:-(\d{1,2}))?$/.exec(String(o.month).trim());
    if (!m || +m[1] < 2000 || (m[2] && (+m[2] < 1 || +m[2] > 12))) throw new Error(`month "${o.month}": want YYYY-MM or YYYY`);
    year = +m[1]; month = m[2] ? +m[2] : 0;
  }
  const entries = (await env.client.myTimeEntries(year, month)) || [];
  if (entries.length === 0) return { data: entries, text: 'No entries.', rows: [] };
  // The API sends newest first; a timesheet reads top to bottom.
  const list = [...entries].reverse();
  let total = 0;
  const rows = list.map((en) => {
    total += en.workedMinutes;
    const span = en.startTime && en.endTime ? `${en.startTime}-${en.endTime}` : '-';
    const status = en.status + (en.autoStopped ? ' (auto-stop)' : '');
    return {
      title: `${weekday(en.date)}  ${span}  ${formatMinutes(en.workedMinutes)}`,
      subtitle: `break ${formatMinutes(en.breakMinutes)} · ${en.project || '-'} · ${en.category || '-'} · ${status} · ${en.remarks || '-'} · #${en.id}`,
    };
  });
  const summary = `Total: ${formatMinutes(total)} in ${list.length} entries`;
  return { data: entries, rows, summary, text: rows.map((r) => `${r.title} — ${r.subtitle}`).join('\n') + '\n' + summary };
};

commands.balance = async (env) => {
  const s = await env.client.timeOffSummary();
  return {
    data: s,
    text: `Vacation: ${s.vacationDaysRemaining} of ${s.vacationDaysTotal} days left (${s.vacationDaysApproved} approved, ${s.vacationDaysPending} pending)\nSick: ${s.illnessDaysTaken} days this year`,
  };
};

commands.whoami = async (env) => {
  const p = await env.client.profile();
  return { data: p, text: `${p.name} (${p.email}), role ${p.role}, department ${p.department || '-'}` };
};

// resolveAbsenceType matches a type code case-insensitively, then fuzzy names.
function resolveAbsenceType(types, query) {
  const byCode = types.find((t) => String(t.id).toLowerCase() === String(query).toLowerCase());
  if (byCode) return byCode;
  const hit = resolve('absence type', types, query);
  return types.find((t) => t.id === hit.id);
}

commands.off = async (env, o = {}) => {
  const now = env.now();
  const start = parseDate(o.start, now);
  const end = o.end ? parseDate(o.end, now) : start;
  if (end < start) throw new Error(`end ${end} is before start ${start}`);
  const at = o.absenceType || resolveAbsenceType(await lookups.absenceTypes(env), o.type || 'VAC');

  const req = { absenceTypeId: at.id, startDate: start, endDate: end };
  if (o.message) req.comments = o.message;
  if (o.half) {
    if (o.half !== 'morning' && o.half !== 'afternoon') throw new Error('half must be morning or afternoon');
    if (start !== end) throw new Error('a half day needs a single day (start = end)');
    if (!at.halfDaysAllowed) throw new Error(`${at.name} (${at.id}) does not allow half days`);
    req.halfDay = o.half;
  }
  const overtime = at.id === 'UEB' || at.id === 'AUA';
  if (o.hours) {
    if (!overtime) throw new Error('hours is only for the overtime types UEB and AUA');
    if (start !== end) throw new Error('hours needs a single day');
    const h = String(o.hours).replace(',', '.');
    if (!Number.isFinite(parseFloat(h))) throw new Error(`hours "${o.hours}" is not a number`);
    req.hours = h;
  } else if (overtime) {
    throw new Error(`${at.id} needs hours`);
  }
  let subName = '-';
  if (o.substitute) { req.substituteEmployeeId = o.substitute.id; subName = o.substitute.name; }
  else if (o.sub) {
    const sub = resolve('substitute', await lookups.substitutes(env), o.sub);
    req.substituteEmployeeId = sub.id; subName = sub.name;
  }

  let when = req.startDate + (req.endDate !== req.startDate ? ' to ' + req.endDate : '');
  if (req.halfDay) when += ` (${req.halfDay})`;
  let summary = `Absence: ${at.name} (${at.id})\nWhen: ${when}\nSubstitute: ${subName}\nComment: ${o.message || '-'}`;
  if (req.hours) summary += `\nHours: ${req.hours}`;
  if (!(await confirm(env, 'Send this request?', summary))) throw aborted();
  const res = await env.client.createAbsence(req);
  return { data: res, text: `Request ${res.id}: ${res.type}, ${res.days} day(s), status ${res.status}` };
};

function absenceRow(a) {
  const note = [];
  if (a.halfDay) note.push('½ ' + a.halfDay);
  if (a.hours != null) note.push(`${a.hours}h`);
  if (a.substitutePending) note.push('substitute pending');
  const to = a.endDate !== a.startDate ? ` → ${weekday(a.endDate)}` : '';
  return { title: `${a.type}  ${weekday(a.startDate)}${to}`, subtitle: `${a.days} day(s) · ${a.status} · ${note.join(', ') || '-'} · #${a.id}` };
}

commands.absences = async (env, o = {}) => {
  let list = (await env.client.myAbsences(!!o.editing)) || [];
  if (o.upcoming) { const today = todayBerlin(env.now()); list = list.filter((a) => a.endDate >= today); }
  list.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  if (list.length === 0) return { data: list, text: 'No absence requests.', rows: [] };
  const rows = list.map(absenceRow);
  return { data: list, rows, text: rows.map((r) => `${r.title} — ${r.subtitle}`).join('\n') };
};

commands['absence-cancel'] = async (env, o = {}) => {
  const id = parseInt(o.id, 10);
  if (!Number.isInteger(id) || String(id) !== String(o.id).trim()) throw new Error(`ID "${o.id}" is not a number`);
  // Show what is about to go; an approved one becomes a cancellation request.
  const target = ((await env.client.myAbsences(true)) || []).find((a) => String(a.id) === String(id));
  if (!target) throw new Error(`No absence request ${id} among yours.`);
  const action = target.status === 'approved' ? 'Ask your approver to cancel' : 'Delete';
  if (!(await confirm(env, action + '?', `${action} ${target.type} ${target.startDate} to ${target.endDate} (${target.status})?`))) throw aborted();
  let res;
  try { res = await env.client.deleteAbsence(id, o.reason); }
  catch (e) {
    if (e.status === 400 && !o.reason) throw new Error(`${e.message} (your company may require a reason)`);
    throw e;
  }
  const text = res.result === 'deleted' ? `Request ${res.id} deleted.`
    : res.result === 'cancellation_requested' ? `Request ${res.id} was approved: a cancellation request has been sent.`
      : `Request ${res.id}: ${res.result}`;
  return { data: res, text };
};

commands.ics = async (env, o = {}) => {
  const list = ((await env.client.myAbsences(false)) || [])
    .filter((a) => a.status === 'approved' || (o.pending && a.status === 'pending'));
  const names = {};
  try { for (const t of await lookups.absenceTypes(env)) names[t.id] = t.name; } catch (_) { /* codes only */ }
  const cal = ics(list, names, env.now());
  return { data: cal, text: cal, count: list.length };
};

commands.projects = async (env, o = {}) => {
  const ps = await lookups.projects(env, !!o.refresh);
  const rows = (ps.projects || []).map((p) => ({
    title: p.name + (ps.defaultProjectId === p.id ? '  ★' : '') + (p.isFavorite ? '  ♥' : ''),
    subtitle: 'ID ' + p.id,
  }));
  const summary = ps.isProjectMandatory ? 'A project is mandatory.' : '★ = default';
  return { data: ps, rows, summary, text: rows.map((r) => `${r.subtitle}  ${r.title}`).join('\n') + '\n' + summary };
};

commands.categories = async (env, o = {}) => {
  const cs = await lookups.categories(env, !!o.refresh);
  const rows = (cs.categories || []).map((c) => ({
    title: c.name + (cs.defaultCategoryId === c.id ? '  ★' : ''), subtitle: 'ID ' + c.id,
  }));
  const summary = cs.isCategoryMandatory ? 'A category is mandatory.' : '★ = default';
  return { data: cs, rows, summary, text: rows.map((r) => `${r.subtitle}  ${r.title}`).join('\n') + '\n' + summary };
};

const yesNo = (b) => (b ? 'yes' : 'no');
commands['absence-types'] = async (env, o = {}) => {
  const ts = await lookups.absenceTypes(env, !!o.refresh);
  const rows = ts.map((t) => ({
    title: `${t.id}  ${t.name}`,
    subtitle: `approval ${yesNo(t.needsApproval)} · half days ${yesNo(t.halfDaysAllowed)} · certificate ${yesNo(t.requiresMedicalCertificate)}`,
  }));
  return { data: ts, rows, text: rows.map((r) => `${r.title} — ${r.subtitle}`).join('\n') };
};

commands.subs = async (env, o = {}) => {
  const ss = await lookups.substitutes(env, !!o.refresh);
  const rows = ss.map((s) => ({ title: s.name, subtitle: `${s.department || '-'} · ID ${s.id}` }));
  return { data: ss, rows, text: rows.map((r) => `${r.title} — ${r.subtitle}`).join('\n') };
};

// --- Scriptable glue ---------------------------------------------------------------------

function scriptableUI() {
  return {
    async alert(title, message) {
      const a = new Alert(); a.title = title; a.message = message || ''; a.addAction('OK');
      await a.presentAlert();
    },
    async confirm(title, message) {
      const a = new Alert(); a.title = title; a.message = message || '';
      a.addAction('OK'); a.addCancelAction('Cancel');
      return (await a.presentAlert()) === 0;
    },
    async choose(title, options, message) {
      const a = new Alert(); a.title = title; if (message) a.message = message;
      for (const o of options) a.addAction(o);
      a.addCancelAction('Cancel');
      return a.presentSheet();
    },
    // fields: [{placeholder, value, secure}] -> values, or null on cancel
    async form(title, message, fields) {
      const a = new Alert(); a.title = title; a.message = message || '';
      for (const f of fields) {
        if (f.secure) a.addSecureTextField(f.placeholder, f.value || '');
        else a.addTextField(f.placeholder, f.value || '');
      }
      a.addAction('OK'); a.addCancelAction('Cancel');
      if ((await a.presentAlert()) === -1) return null;
      // textFieldValue returns null for an empty field; callers expect strings.
      return fields.map((_, i) => a.textFieldValue(i) ?? '');
    },
    // table shows rows; with selectable it returns the tapped row index, else -1.
    async table(title, summary, rows, selectable) {
      const t = new UITable(); t.showSeparators = true;
      let picked = -1;
      const h = new UITableRow(); h.isHeader = true; h.height = 60;
      h.addText(title, summary || '');
      t.addRow(h);
      rows.forEach((r, i) => {
        const row = new UITableRow(); row.height = r.subtitle ? 64 : 44;
        const c = row.addText(r.title, r.subtitle || '');
        c.subtitleColor = Color.gray(); c.subtitleFont = Font.footnote();
        if (selectable) { row.dismissOnSelect = true; row.onSelect = () => { picked = i; }; }
        t.addRow(row);
      });
      await t.present();
      return picked;
    },
  };
}

function scriptableCache() {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), 'tb');
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const file = (name) => fm.joinPath(dir, name + '.json');
  return {
    load(name) {
      const f = file(name);
      if (!fm.fileExists(f) || Date.now() - fm.modificationDate(f).getTime() > CACHE_TTL_MS) return undefined;
      try { return JSON.parse(fm.readString(f)); } catch (_) { return undefined; }
    },
    save(name, v) { try { fm.writeString(file(name), JSON.stringify(v)); } catch (_) { /* cache is optional */ } },
  };
}

async function scriptableTransport({ method, url, headers, body }) {
  const r = new Request(url);
  r.method = method; r.headers = headers; r.timeoutInterval = 30;
  if (body !== undefined) r.body = body;
  const text = await r.loadString();
  return { status: r.response.statusCode, headers: r.response.headers || {}, text };
}

const sleepMs = (ms) => new Promise((done) => Timer.schedule(ms, false, done));

async function askToken(ui, why) {
  const intro = (why ? why + '\n\n' : '') + 'Copy your personal access token (tb_…) to the clipboard first. Create it on app.timebutler.com/api/v2/docs → "Create or revoke a personal token". It is stored in the iOS Keychain.';
  // Read the token from the clipboard: Alert text fields are not reliable on every iOS/Scriptable version.
  const clip = String(Pasteboard.pasteString() ?? '').trim();
  let t = '';
  if (/^tb_\S+$/.test(clip)) {
    if (!(await ui.confirm('Timebutler token', `${intro}\n\nUse the token on the clipboard (${clip.slice(0, 6)}…${clip.slice(-4)})?`))) throw aborted();
    t = clip;
  } else {
    const v = await ui.form('Timebutler token', intro + '\n\nNo tb_… token found on the clipboard; paste it here instead.', [{ placeholder: 'tb_…' }]);
    if (!v) throw aborted();
    t = v[0].trim();
  }
  if (!t) throw new Error('No token entered. Copy the token (tb_…) to the clipboard and run tb again.');
  Keychain.set(KEYCHAIN_KEY, t);
  return t;
}

async function makeEnv(interactive, params) {
  const ui = scriptableUI();
  let token = Keychain.contains(KEYCHAIN_KEY) ? Keychain.get(KEYCHAIN_KEY).trim() : '';
  if (!token) {
    if (!interactive) throw new Error('No Timebutler token: run the tb script in the Scriptable app once to store it.');
    token = await askToken(ui);
  }
  return {
    client: new Client(token, scriptableTransport, sleepMs),
    cache: scriptableCache(),
    now: () => new Date(),
    ui, interactive,
    yes: truthy(params.yes),
  };
}

const truthy = (v) => v === true || ['1', 'true', 'yes', 'y'].includes(String(v ?? '').toLowerCase());

// --- in-app flows: gather input with dialogs, show results ---

async function inputLog(env) {
  const v = await env.ui.form('Log time entry',
    'Date (YYYY-MM-DD, today, yesterday), time range (09:00-17:30), pause (30m, 1h15m), remarks. Times are Berlin time.',
    [{ placeholder: 'Date', value: 'today' }, { placeholder: '09:00-17:30' }, { placeholder: 'Pause, e.g. 30m' }, { placeholder: 'Remarks (optional)' }]);
  if (!v) throw aborted();
  return { date: v[0], time: v[1], pause: v[2], message: v[3].trim() };
}

async function inputEntries(env) {
  const now = env.now(), p = berlinParts(now);
  const prev = p.m === 1 ? ymd(p.y - 1, 12, 1).slice(0, 7) : ymd(p.y, p.m - 1, 1).slice(0, 7);
  const i = await env.ui.choose('Entries', ['This month', `Last month (${prev})`, `This year (${p.y})`, 'Other…']);
  if (i < 0) throw aborted();
  if (i === 0) return {};
  if (i === 1) return { month: prev };
  if (i === 2) return { month: String(p.y) };
  const v = await env.ui.form('Entries', 'YYYY-MM, or YYYY for a whole year', [{ placeholder: 'YYYY-MM' }]);
  if (!v) throw aborted();
  return { month: v[0] };
}

async function inputOff(env) {
  const types = await lookups.absenceTypes(env);
  const vacFirst = [...types].sort((a, b) => (a.id === 'VAC' ? -1 : b.id === 'VAC' ? 1 : 0));
  const ti = await env.ui.choose('Absence type', vacFirst.map((t) => `${t.name} (${t.id})`));
  if (ti < 0) throw aborted();
  const at = vacFirst[ti];
  const overtime = at.id === 'UEB' || at.id === 'AUA';
  const fields = [{ placeholder: 'Start (YYYY-MM-DD)' }, { placeholder: 'End (empty = same day)' }];
  if (overtime) fields.push({ placeholder: 'Hours, e.g. 4' });
  else if (at.halfDaysAllowed) fields.push({ placeholder: 'Half day: morning/afternoon (optional)' });
  fields.push({ placeholder: 'Comment for the approver (optional)' });
  const v = await env.ui.form(at.name, 'Dates are YYYY-MM-DD, today or tomorrow; the end is inclusive.', fields);
  if (!v) throw aborted();
  const o = { absenceType: at, start: v[0], end: v[1].trim() || undefined, message: v[v.length - 1].trim() };
  if (overtime) o.hours = v[2].trim();
  else if (at.halfDaysAllowed) o.half = v[2].trim().toLowerCase() || undefined;

  const subs = await lookups.substitutes(env);
  if (subs.length > 0) {
    const si = await env.ui.choose('Substitute', ['No substitute', ...subs.map((s) => s.name + (s.department ? ` (${s.department})` : ''))]);
    if (si < 0) throw aborted();
    if (si > 0) o.substitute = subs[si - 1];
  }
  return o;
}

async function runInApp(env, cmd) {
  let opts = {};
  if (cmd === 'log') opts = await inputLog(env);
  if (cmd === 'entries') opts = await inputEntries(env);
  if (cmd === 'off') opts = await inputOff(env);
  if (cmd === 'ics') {
    const i = await env.ui.choose('Export .ics', ['Approved absences', 'Approved + pending (tentative)']);
    if (i < 0) return;
    opts = { pending: i === 1 };
  }
  if (cmd === 'absences') {
    const i = await env.ui.choose('Absences', ['Upcoming', 'All', 'All, incl. editing']);
    if (i < 0) return;
    opts = { upcoming: i === 0, editing: i === 2 };
  }

  const res = await commands[cmd](env, opts);

  if (cmd === 'ics') {
    await DocumentPicker.exportString(res.text, 'timebutler-absences.ics');
    return;
  }
  if (cmd === 'absences' && res.rows.length > 0) {
    const i = await env.ui.table('Absences', 'Tap a request to delete or cancel it.', res.rows, true);
    if (i < 0) return;
    const a = res.data[i];
    const v = await env.ui.form(`${a.status === 'approved' ? 'Cancel' : 'Delete'} #${a.id}?`,
      `${a.type} ${a.startDate} to ${a.endDate} (${a.status}). Reason (some companies require one):`, [{ placeholder: 'Reason (optional)' }]);
    if (!v) return;
    const r = await commands['absence-cancel']({ ...env, yes: true }, { id: a.id, reason: v[0].trim() });
    await env.ui.alert('Absences', r.text);
    return;
  }
  if (res.rows && res.rows.length > 0) {
    await env.ui.table(cmd[0].toUpperCase() + cmd.slice(1), res.summary || '', res.rows, false);
    return;
  }
  await env.ui.alert('Timebutler', res.text);
}

async function appMenu(env) {
  for (;;) {
    let s = null, header;
    try { s = await env.client.clockStatus(); header = 'Clock: ' + clockLine(s); }
    catch (e) {
      header = '⚠️ ' + e.message;
      if (e.status === 401) {
        try { env.client.token = await askToken(env.ui, e.message); continue; } catch (_) { return; }
      }
    }
    const actions = [];
    if (s) {
      if (s.status === 'idle') actions.push(['▶️ Start', 'start']);
      if (s.status === 'running') actions.push(['⏸ Pause', 'pause'], ['⏹ Stop & save', 'stop']);
      if (s.status === 'paused') actions.push(['⏯ Resume', 'resume'], ['⏹ Stop & save', 'stop']);
      if (s.status === 'waiting') actions.push(['⏹ Stop', 'stop']);
      if (s.status !== 'idle') actions.push(['🗑 Discard session', 'cancel']);
    }
    actions.push(['📊 Today', 'status'], ['📝 Log time entry', 'log'], ['📅 Entries', 'entries'],
      ['🏖 Balance', 'balance'], ['✈️ Request absence', 'off'], ['📋 Absences', 'absences'],
      ['📆 Export absences (.ics)', 'ics'], ['Projects', 'projects'], ['Categories', 'categories'],
      ['Absence types', 'absence-types'], ['Substitutes', 'subs'], ['Who am I', 'whoami'], ['🔑 Change token', 'token']);
    const i = await env.ui.choose('Timebutler', actions.map((a) => a[0]), header);
    if (i < 0) return;
    const cmd = actions[i][1];
    try {
      if (cmd === 'token') env.client.token = await askToken(env.ui);
      else await runInApp(env, cmd);
    } catch (e) {
      await env.ui.alert('Timebutler', e.message);
    }
  }
}

// --- widget ---

async function widget(params) {
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color('#ffffff'), new Color('#1c1c1e'));
  w.url = `scriptable:///run/${encodeURIComponent(Script.name())}`;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const fg = Color.dynamic(Color.black(), Color.white());
  const small = (text, color = Color.gray()) => { const t = w.addText(text); t.font = Font.systemFont(12); t.textColor = color; t.lineLimit = 2; return t; };
  small('TIMEBUTLER');
  w.addSpacer(4);
  try {
    const env = await makeEnv(false, params);
    const [s, sum] = await Promise.all([env.client.clockStatus(), env.client.workSummary()]);
    const colors = { running: Color.green(), paused: Color.orange(), waiting: Color.yellow(), idle: Color.gray() };
    const st = w.addText(s.status[0].toUpperCase() + s.status.slice(1));
    st.font = Font.semiboldSystemFont(15); st.textColor = colors[s.status] || fg;
    if (s.status === 'running') {
      const d = w.addDate(new Date(Date.now() - s.workTimeElapsedSeconds * 1000));
      d.applyTimerStyle(); d.font = Font.boldMonospacedSystemFont(26); d.textColor = fg;
    } else {
      const t = w.addText(formatMinutes(s.status === 'idle' ? sum.workedMinutes : Math.trunc(s.workTimeElapsedSeconds / 60)));
      t.font = Font.boldMonospacedSystemFont(26); t.textColor = fg; t.minimumScaleFactor = 0.6;
    }
    if (s.status !== 'idle' && s.startTimestamp != null) small('since ' + hhmm(new Date(s.startTimestamp)));
    w.addSpacer();
    small(`Today ${formatMinutes(sum.workedMinutes)} / ${formatMinutes(sum.commitmentMinutes)} (${sum.percentDone}%)`, fg);
    if (config.widgetFamily !== 'small') {
      try {
        const b = await env.client.timeOffSummary();
        small(`Vacation ${b.vacationDaysRemaining} of ${b.vacationDaysTotal} days left`, fg);
      } catch (_) { /* optional line */ }
    }
  } catch (e) {
    small(e.message, Color.red());
  }
  Script.setWidget(w);
}

// params come from the URL (?cmd=…), a Shortcuts parameter (dictionary or
// plain text "status"), or the widget parameter.
function readParams() {
  const p = { ...(args.queryParameters || {}) };
  const sp = args.shortcutParameter;
  if (sp && typeof sp === 'object') Object.assign(p, sp);
  else if (typeof sp === 'string' && sp.trim()) {
    const t = sp.trim();
    if (t.startsWith('{')) { try { Object.assign(p, JSON.parse(t)); } catch (_) { p.cmd = t; } } else p.cmd = t;
  }
  if (typeof p.entries === 'string') { try { p.entries = JSON.parse(p.entries); } catch (_) { /* reported by log */ } }
  for (const k of ['dryRun', 'pending', 'upcoming', 'editing', 'refresh']) if (k in p) p[k] = truthy(p[k]);
  return p;
}

async function main() {
  const params = readParams();
  if (config.runsInWidget) return widget(params);

  const interactive = config.runsInApp;
  const cmd = params.cmd ? String(params.cmd).trim().toLowerCase() : '';
  try {
    const env = await makeEnv(interactive, params);
    if (!cmd) {
      if (interactive) await appMenu(env);
      else Script.setShortcutOutput((await commands.status(env)).text);
      return;
    }
    if (!commands[cmd]) throw new Error(`unknown command "${cmd}"; try one of: ${Object.keys(commands).join(', ')}`);
    if (interactive && !params.yes && ['log', 'off', 'entries', 'absences', 'ics'].includes(cmd) && Object.keys(params).length === 1) {
      await runInApp(env, cmd); // bare ?cmd=log in the app: ask with dialogs
      return;
    }
    const res = await commands[cmd](env, params);
    Script.setShortcutOutput(truthy(params.json) ? res.data : res.text);
    if (interactive) await env.ui.alert('Timebutler', res.text);
  } catch (e) {
    if (interactive) await scriptableUI().alert('Timebutler', e.message);
    else Script.setShortcutOutput('Error: ' + e.message);
  }
}

if (IS_SCRIPTABLE) {
  await main();
  Script.complete();
} else if (typeof module !== 'undefined') {
  module.exports = {
    formatMinutes, berlinParts, berlinTime, parseDate, parseHHMM, parseSpan, parsePause, addDays, weekday,
    resolve, pick, ics, fold, ApiError, decodeError, Client, commands, clockLine, todayLine, NONE,
  };
}
