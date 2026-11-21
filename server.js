'use strict';
/* Tournament server v2: static files + JSON API + live updates (SSE) + web push.
   Zero build step. Data lives in ./data (db.json + uploads). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const webpush = require('web-push');
const QRCode = require('qrcode');
const Engine = require('./public/engine.js');
const Fx = require('./lib/fixtures.js');
const SheetImport = require('./lib/sheet-import.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BK_PASS = process.env.BACKUP_PASSPHRASE || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MIRROR_DIR = process.env.BACKUP_COPY_DIR || '';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
[DATA_DIR, UPLOAD_DIR, BACKUP_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

/* ---- optional encryption for backup copies (set BACKUP_PASSPHRASE) ---- */
function encBuf(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('TBK1'), salt, iv, c.getAuthTag(), ct]);
}
function decBuf(buf, pass) {
  if (buf.slice(0, 4).toString() !== 'TBK1') throw new Error('Not an encrypted backup');
  const salt = buf.slice(4, 20), iv = buf.slice(20, 32), tag = buf.slice(32, 48);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.slice(48)), d.final()]);
}
const writeSecure = (file, buf) => fs.writeFileSync(BK_PASS ? file + '.enc' : file, BK_PASS ? encBuf(buf, BK_PASS) : buf);
const di = process.argv.indexOf('--decrypt');
if (di !== -1) {   /* node server.js --decrypt <file.enc>  (needs BACKUP_PASSPHRASE) */
  const f = process.argv[di + 1];
  try { const out = f.replace(/\.enc$/, '') + '.decrypted'; fs.writeFileSync(out, decBuf(fs.readFileSync(f), BK_PASS)); console.log('Decrypted to ' + out); process.exit(0); }
  catch (e) { console.log('Could not decrypt: ' + e.message + ' (is BACKUP_PASSPHRASE the same one used for the backup?)'); process.exit(1); }
}

class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const uid = () => crypto.randomBytes(5).toString('hex');
const pinN = (n) => String(crypto.randomInt(10 ** (n - 1), 10 ** n));
const SECTIONS = ['adults', 'kids'];
const SPORTS = ['badminton', 'tt', 'carrom', 'chess', 'other'];
const LEVELS = ['', 'Beginner', 'Intermediate', 'Advanced', 'Pro'];
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/* ------------------------------------------------------------ PIN hashing */
/* A keyed fingerprint of each PIN lets sign-in find the person directly (PIN-only sign-in) without testing every stored PIN. */
const pinIdx = (pin) => crypto.createHmac('sha256', String(db.pinSecret || '')).update(String(pin)).digest('hex').slice(0, 32);
function hashPin(pin) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const a = Buffer.from(crypto.scryptSync(String(pin), salt, 32).toString('hex'));
  const b = Buffer.from(hex);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- database */
const DEFAULT_CFG = {
  bestOf: 3, target: 15, winBy: 1, cap: 0, increments: [1],
  pointsWin: 2, pointsDraw: 1, pointsLoss: 0, rankBy: 'matchPoints', finalists: 4,
};

/* International rule presets (organizers can change every value per event). */
const BWF = { bestOf: 3, target: 21, winBy: 2, cap: 30 };      /* BWF 3x21 */
const BWF15 = { bestOf: 3, target: 15, winBy: 2, cap: 21 };    /* BWF 3x15 */
const ICF = { maxBoards: 8, coinWeight: 1, queenWeight: 3, queenCutoff: 22 };   /* ICF carrom */

function seedEvents() {
  const mk = (name, sport, o) => ({
    id: uid(), name, sport, section: 'adults', scoring: 'points', sideType: 'player', sideSize: 1,
    participantIds: [], note: '', ...o, config: { ...DEFAULT_CFG, ...(o.config || {}) },
  });
  return [
    mk("Badminton – Women's Doubles", 'badminton', { sideSize: 2, config: { rankBy: 'tally', finalists: 4, ...BWF } }),
    mk('Badminton – Team Event', 'badminton', { sideType: 'team', config: { finalists: 2, ...BWF } }),
    mk('Table Tennis', 'tt', { config: { bestOf: 3, target: 11, winBy: 2, cap: 0, finalists: 4, smallBelow: 8, finalistsSmall: 2 }, note: 'ITTF defaults: best of 3 games, 11 points, win by 2. Points per game and best-of are settings.' }),
    mk('Carrom', 'carrom', { config: { bestOf: 3, target: 25, winBy: 1, increments: [1, 2, 3], finalists: 4, smallBelow: 8, finalistsSmall: 2, ...ICF }, note: 'ICF defaults: best of 3 games; a game is 25 points or 8 boards. Coin weight, queen weight and queen cutoff are settings.' }),
    mk('Chess', 'chess', { scoring: 'result', config: { pointsWin: 1, pointsDraw: 0.5, pointsLoss: 0, finalists: 4, smallBelow: 8, finalistsSmall: 2 }, note: 'Placeholder rules – update once chess format is final.' }),
    ...seedKidsEvents(),
  ];
}
function seedKidsEvents() {
  const mk = (name, sport, o) => ({
    id: uid(), name, sport, section: 'kids', scoring: 'points', sideType: 'player', sideSize: 1,
    participantIds: [], note: 'Placeholder rules for kids – update once the kids format is final.', ...o, config: { ...DEFAULT_CFG, ...(o.config || {}) },
  });
  return [
    mk('Kids – Badminton', 'badminton', { config: { finalists: 4, ...BWF15 } }),
    mk('Kids – Table Tennis', 'tt', { config: { bestOf: 3, target: 11, winBy: 2, finalists: 4, smallBelow: 8, finalistsSmall: 2 } }),
    mk('Kids – Carrom', 'carrom', { config: { bestOf: 3, target: 15, winBy: 1, increments: [1, 2, 3], finalists: 4, smallBelow: 8, finalistsSmall: 2, ...ICF } }),
    mk('Kids – Chess', 'chess', { scoring: 'result', config: { pointsWin: 1, pointsDraw: 0.5, pointsLoss: 0, finalists: 4, smallBelow: 8, finalistsSmall: 2 } }),
  ];
}

let initialPin = null;
function freshDb() {
  initialPin = pinN(6);
  return {
    version: 2,
    tournament: { tz: 'Asia/Kolkata', sponsorSeconds: 8, name: 'Tournament Name', tagline: 'Badminton • Carrom • Chess • Table Tennis', dates: '', venue: '', logo: '', primary: '#0f766e', showKidsPhotos: false, signers: [], seasonName: 'CSSL - Season 3', seasonStartedAt: Date.now() },
    admins: [{ id: uid(), name: 'Admin', pinHash: hashPin(initialPin) }], sessions: {}, vapid: webpush.generateVAPIDKeys(),
    players: [], teams: [], referees: [], events: seedEvents(), matches: [], sponsors: [], gallery: [], subs: [], audit: [], seasons: [], kidsSeeded: true,
  };
}

/* Bring older data (v1) up to date. Safe to run repeatedly. */
function migrate(d) {
  d.version = 3;
  d.tournament = d.tournament || {};
  const t = d.tournament;
  if (t.showKidsPhotos === undefined) t.showKidsPhotos = false;
  if (!Array.isArray(t.signers) || !t.signers.length) t.signers = [{ name: '', title: 'Organizer', image: '' }, { name: '', title: 'Chief Referee', image: '' }];
  ['players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'subs', 'audit', 'disputes', 'trash', 'seasons'].forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
  if (!t.seasonName) t.seasonName = 'CSSL - Season 3';
  if (!t.seasonStartedAt) t.seasonStartedAt = Date.now();
  d.sessions = d.sessions || {};
  if (!t.tz) t.tz = 'Asia/Kolkata';
  if (!t.sponsorSeconds) t.sponsorSeconds = 8;
  d.registration = Object.assign({ enabled: false, deadline: '', joinCode: '', notice: 'Your details are used only to run this tournament. Contact details are visible to organisers only. Your name, age group and match results are shown publicly.', kidsNotice: 'I am the parent/guardian of this child and I consent to their participation and to their name, age group and match results being shown publicly. Their photo is not shown publicly unless the organisers enable it.' }, d.registration || {});
  d.gallery.forEach((g) => { if (typeof g.minors !== 'boolean') g.minors = false; });
  d.events.forEach((e) => {
    if (!e.format) e.format = { type: 'roundrobin', groups: 2, qualifiers: 2, thirdPlace: false, swissRounds: 0, autoAdvance: false, doubleRR: false };
    if (!Array.isArray(e.rubbers)) e.rubbers = []; if (!e.rubberRules) e.rubberRules = { clinch: true, maxPerPlayer: 2 };
    if (!Array.isArray(e.byes)) e.byes = []; e.ageMin = e.ageMin || 0; e.ageMax = e.ageMax || 0;
    /* house rule for carrom, table tennis and chess: fewer than 8 players -> top 2 play the final; 8 or more -> top 4 play semi-finals */
    if (e.config && e.config.smallBelow === undefined && e.sideType === 'player' && e.sideSize === 1 && ['tt', 'carrom', 'chess'].includes(e.sport)) { e.config.finalists = 4; e.config.smallBelow = 8; e.config.finalistsSmall = 2; }
  });
  d.events.forEach((e) => { if (!Array.isArray(e.withdrawn)) e.withdrawn = []; if (!Array.isArray(e.interestedIds)) e.interestedIds = []; if (e.maxParticipants == null) e.maxParticipants = 0; if (e.selfRegister == null) e.selfRegister = true; });
  d.players.forEach((p) => { if (!SECTIONS.includes(p.section)) p.section = 'adults'; p.ageGroup = p.ageGroup || ''; });
  d.nextPlayerNo = d.nextPlayerNo || 1;
  d.players.forEach((p) => {
    if (!p.playerNo) p.playerNo = 'P' + String(d.nextPlayerNo++).padStart(3, '0');
    if (!p.sports || typeof p.sports !== 'object') p.sports = {};
    if (!Array.isArray(p.achievements)) p.achievements = [];
    if (!Array.isArray(p.career)) p.career = [];
    ['affiliation', 'bio', 'emergency', 'tshirt', 'hand'].forEach((k) => { if (typeof p[k] !== 'string') p[k] = ''; });
    if (typeof p.profilePublic !== 'boolean') p.profilePublic = p.section !== 'kids';
    if (!p.status) p.status = 'approved';
    ['guardianName', 'guardianPhone', 'editTokenHash'].forEach((k) => { if (typeof p[k] !== 'string') p[k] = ''; });
    if (!Array.isArray(p.requestedEventIds)) p.requestedEventIds = [];
  });
  d.teams.forEach((x) => { if (!SECTIONS.includes(x.section)) x.section = 'adults'; });
  d.events.forEach((e) => { if (!SECTIONS.includes(e.section)) e.section = 'adults'; });
  if (d.adminPin) { d.adminPinHash = hashPin(d.adminPin); delete d.adminPin; }
  d.referees.forEach((r) => { if (r.pin) { r.pinHash = hashPin(r.pin); delete r.pin; } if (!['referee', 'chief', 'volunteer'].includes(r.kind)) r.kind = 'referee'; if (!Array.isArray(r.sports)) r.sports = []; if (!Array.isArray(r.eventIds)) r.eventIds = []; if (!r.status) r.status = 'active'; });
  if (!d.kidsSeeded) { if (!d.events.some((e) => e.section === 'kids')) d.events.push(...seedKidsEvents()); d.kidsSeeded = true; }
  if (!d.vapid) d.vapid = webpush.generateVAPIDKeys();
  if (!Array.isArray(d.cards)) d.cards = [];
  if (!d.suspend || typeof d.suspend !== 'object') d.suspend = {};
  if (!Array.isArray(d.admins)) d.admins = [];
  if (d.adminPinHash) { d.admins.push({ id: uid(), name: 'Admin', pinHash: d.adminPinHash }); delete d.adminPinHash; }
  if (!d.admins.length) { initialPin = pinN(6); d.admins.push({ id: uid(), name: 'Admin', pinHash: hashPin(initialPin) }); }
  d.admins.forEach((a) => { if (!Array.isArray(a.sports)) a.sports = []; });
  ensureTours(d);
  d.matches.forEach((m) => { if (!Array.isArray(m.refereeIds)) { m.refereeIds = m.refereeId ? [m.refereeId] : []; } delete m.refereeId; });
  if (!d.pinSecret) d.pinSecret = crypto.randomBytes(32).toString('hex');
  /* link existing admin / referee accounts to the player with the same (unique) name */
  const byNm = (n) => { const hits = (d.players || []).filter((p) => p.status !== 'rejected' && String(p.name).trim().toLowerCase() === String(n).trim().toLowerCase()); return hits.length === 1 ? hits[0].id : ''; };
  d.admins.forEach((a) => { if (a.playerId === undefined) a.playerId = byNm(a.name); });
  (d.referees || []).forEach((r) => { if (r.playerId === undefined) r.playerId = byNm(r.name); });
  if (d.matches.some((m) => !m.no)) { const keep = db; db = d; try { numberMatches(); } finally { db = keep; } }
  return d;
}
/* Events (e.g. "CSSL - Season 3", "Diwali Kids Cup") run side by side. Each has its own games, organizers, referees,
   roster (players who registered, were uploaded or enrolled), registration settings, teams and fixtures.
   Player profiles are shared by all events and are permanent. */
const newTour = (o) => ({ id: uid(), name: 'Event', dates: '', venue: '', status: 'open', createdAt: Date.now(), createdBy: '', organizerIds: [], refereeIds: [], playerIds: [],
  reg: { enabled: false, deadline: '', joinCode: '', notice: '', kidsNotice: '' }, ...o });
function ensureTours(d) {
  if (!Array.isArray(d.tournaments)) d.tournaments = [];
  const t0 = d.tournament || {}, r0 = d.registration || {};
  if (!d.tournaments.length) {
    const roster = new Set();
    (d.events || []).forEach((e) => { (e.participantIds || []).forEach((id) => roster.add(id)); (e.interestedIds || []).forEach((id) => roster.add(id)); });
    (d.teams || []).forEach((t) => (t.memberIds || []).forEach((id) => roster.add(id)));
    (d.players || []).forEach((p) => { if ((p.requestedEventIds || []).length) roster.add(p.id); });
    d.tournaments.push(newTour({ name: t0.seasonName || 'CSSL - Season 3', dates: t0.dates || '', venue: t0.venue || '', createdAt: t0.seasonStartedAt || Date.now(),
      reg: { enabled: !!r0.enabled, deadline: r0.deadline || '', joinCode: r0.joinCode || '', notice: r0.notice || '', kidsNotice: r0.kidsNotice || '' },
      playerIds: [...roster].filter((id) => (d.players || []).some((p) => p.id === id)) }));
  }
  d.tournaments.forEach((t) => { ['organizerIds', 'refereeIds', 'playerIds'].forEach((k) => { if (!Array.isArray(t[k])) t[k] = []; }); t.reg = { enabled: false, deadline: '', joinCode: '', notice: '', kidsNotice: '', ...(t.reg || {}) }; if (!t.status) t.status = 'open'; });
  if (!d.tournaments.some((t) => t.kind === 'friendly')) d.tournaments.push(newTour({ id: 'friendly', kind: 'friendly', name: 'Friendly matches' }));
  const def = (d.tournaments.find((t) => t.status !== 'closed' && t.kind !== 'friendly') || d.tournaments[0]).id, has = (id) => d.tournaments.some((t) => t.id === id);
  (d.events || []).forEach((e) => { if (!has(e.tid)) e.tid = def; });
  (d.teams || []).forEach((t) => { if (!has(t.tid)) t.tid = ((d.events || []).find((e) => e.sideType === 'team' && (e.participantIds || []).includes(t.id)) || {}).tid || def; });
}
const tour = (id) => (db.tournaments || []).find((t) => t.id === id);
const defTid = () => ((db.tournaments || []).find((t) => t.status !== 'closed' && t.kind !== 'friendly') || (db.tournaments || []).find((t) => t.kind !== 'friendly') || {}).id;
const tidOf = (x) => (x && tour(String(x)) ? String(x) : defTid());
const inRoster = (tid, pid) => { const t = tour(tid); return !!t && (t.kind === 'friendly' || t.playerIds.includes(pid)); };
const addRoster = (tid, ids) => { const t = tour(tid); if (!t) return; ids.forEach((id) => { if (!t.playerIds.includes(id)) t.playerIds.push(id); }); };
const tourOrg = (u, tid) => { const t = tour(tid); return !!(u && t && u.role === 'admin' && t.organizerIds.includes(u.adminId)); };

let db;
let stateV = 1;
const bootId = crypto.randomBytes(3).toString('hex');
function readBackupFile(f) {
  let buf = fs.readFileSync(f);
  if (f.endsWith('.enc')) buf = decBuf(buf, BK_PASS);
  return JSON.parse(buf.toString('utf8'));
}
(function load() {
  if (!fs.existsSync(DB_FILE)) { db = migrate(freshDb()); return; }
  try { db = migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); return; } catch (e) { console.log('  !! data/db.json could not be read (' + e.message + '). Trying to recover…'); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'db.corrupt-' + stamp + '.json')); } catch (e) { /* ignore */ }
  const cands = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-/.test(f)).sort().reverse();
  for (const f of cands) {
    try { db = migrate(readBackupFile(path.join(BACKUP_DIR, f))); console.log('  Recovered from backup ' + f + ' (the broken file was kept as db.corrupt-' + stamp + '.json).'); return; } catch (e) { /* try older */ }
  }
  console.log('  !! No usable backup found. The damaged file was kept as db.corrupt-' + stamp + '.json. Starting with an empty tournament.');
  db = migrate(freshDb());
})();

let dirty = true, savePending = false, saveTimer = null;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  savePending = false;
  const tmp = DB_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(db)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DB_FILE);
  dirty = true;
}
/* Saves are coalesced (max one write per 150 ms) so many scorers do not hammer the disk. */
/* Finals format depends on how many players there are. Once the event's first match has been played the count is frozen, so late changes do not alter the format. */
function freezeCounts() {
  db.events.forEach((ev) => {
    const played = db.matches.some((m) => m.eventId === ev.id && ((m.log || []).length || m.result || m.walkover || m.retired || (m.rubbers || []).some((r) => (r.log || []).length || r.result || r.walkover)));
    if (played && ev.frozenCount == null) ev.frozenCount = (ev.participantIds || []).filter((x) => !(ev.withdrawn || []).includes(x)).length;
    else if (!played && ev.frozenCount != null) delete ev.frozenCount;
  });
}
/* Every match has a number within its game: Women's Doubles #1, #2, #3…; team ties likewise. */
function numberMatches() {
  const next = {};
  db.matches.forEach((m) => { if (m.no) next[m.eventId] = Math.max(next[m.eventId] || 0, m.no); });
  db.matches.filter((m) => !m.no).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach((m) => { m.no = (next[m.eventId] = (next[m.eventId] || 0) + 1); });
}
function save() {
  try { numberMatches(); } catch (e) { console.error('numbering failed', e); }
  try { applySuspensions(); freezeCounts(); } catch (e) { console.error('suspension check failed', e); }
  stateV++; savePending = true;
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { saveNow(); } catch (e) { console.error('save failed', e); } }, 150);
}
const flush = () => { if (savePending) { try { saveNow(); } catch (e) { /* ignore */ } } };
['SIGINT', 'SIGTERM'].forEach((sg) => process.on(sg, () => { flush(); try { backup(); mirror(); } catch (e) { /* ignore */ } process.exit(0); }));
saveNow();

/* Command line: node server.js --reset-pin [newpin]  (recover the first admin's PIN) */
const ri = process.argv.indexOf('--reset-pin');
if (ri !== -1) {
  const given = process.argv[ri + 1];
  const pin = /^\d{6,10}$/.test(given || '') ? given : pinN(6);
  db.admins[0].pinHash = hashPin(pin); db.sessions = {}; saveNow();
  console.log('\n  New admin PIN: ' + pin + '\n');
  process.exit(0);
}

function backup() {
  try {
    flush();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeSecure(path.join(BACKUP_DIR, 'db-' + stamp + '.json'), fs.readFileSync(DB_FILE));
    const all = fs.readdirSync(BACKUP_DIR).sort();
    all.slice(0, Math.max(0, all.length - 80)).forEach((x) => fs.unlinkSync(path.join(BACKUP_DIR, x)));
  } catch (e) { /* best effort */ }
}
let mirrorWarned = false;
function mirror() {
  if (!MIRROR_DIR) return;
  try {
    flush();
    fs.mkdirSync(path.join(MIRROR_DIR, 'uploads'), { recursive: true });
    const raw = fs.readFileSync(DB_FILE);
    const hour = new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-');
    writeSecure(path.join(MIRROR_DIR, 'db-latest.json'), raw);
    writeSecure(path.join(MIRROR_DIR, 'db-' + hour + '.json'), raw);
    const hist = fs.readdirSync(MIRROR_DIR).filter((f) => /^db-\d{4}/.test(f)).sort();
    hist.slice(0, Math.max(0, hist.length - 48)).forEach((f) => fs.unlinkSync(path.join(MIRROR_DIR, f)));
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const dst = path.join(MIRROR_DIR, 'uploads', f + (BK_PASS ? '.enc' : ''));
      if (!fs.existsSync(dst)) fs.writeFileSync(dst, BK_PASS ? encBuf(fs.readFileSync(path.join(UPLOAD_DIR, f)), BK_PASS) : fs.readFileSync(path.join(UPLOAD_DIR, f)));
    }
  } catch (e) { if (!mirrorWarned) { mirrorWarned = true; console.log('  (cloud/extra backup folder not writable: ' + e.message + ')'); } }
}
backup(); mirror();
setInterval(() => { if (dirty) { backup(); dirty = false; } mirror(); }, 2 * 60 * 1000).unref();
if (!BK_PASS) console.log('  Note: backups are not encrypted (set BACKUP_PASSPHRASE to encrypt them).');

webpush.setVapidDetails('mailto:organizer@example.com', db.vapid.publicKey, db.vapid.privateKey);

/* ----------------------------------------------------------------- audit */
function audit(who, action, detail, matchId) {
  db.audit.push({ t: Date.now(), who: who || '-', action, detail: detail || '', matchId: matchId || '' });
  if (db.audit.length > 3000) db.audit.splice(0, db.audit.length - 3000);
}

/* ---------------------------------------------------- discipline: cards and suspensions */
function cardInfo(pid) {
  const mine = db.cards.filter((c) => c.playerId === pid && !c.revoked), left = db.suspend[pid] || 0;
  const yellow = mine.filter((c) => c.color === 'yellow').length, red = mine.filter((c) => c.color === 'red').length;
  return { bubble: left > 0 ? 'red' : (yellow || red) ? 'yellow' : 'green', yellow, red, left };
}
/* A red card costs the player their next two scheduled games: each is recorded as a walkover to the opponent. */
let suspending = false;
function applySuspensions() {
  if (suspending || !db.suspend || !Object.values(db.suspend).some((n) => n > 0)) return;
  suspending = true;
  try {
    const order = (a, b) => String(a.startsAt || 'zzzz').localeCompare(String(b.startsAt || 'zzzz')) || db.matches.indexOf(a) - db.matches.indexOf(b);
    const touched = new Set();
    for (const pid of Object.keys(db.suspend)) {
      let left = db.suspend[pid]; if (!(left > 0)) continue;
      const mine = db.matches.filter((m) => { const ev = find('events', m.eventId); return ev && ev.sideType === 'player' && !m.walkover && !m.retired && !m.result && !(m.log || []).length && [...m.sideA, ...m.sideB].includes(pid); }).sort(order);
      for (const m of mine) {
        if (left <= 0) break;
        m.walkover = m.sideA.includes(pid) ? 'B' : 'A'; m.outcome = 'suspended'; left--; touched.add(m.eventId);
        audit('system', 'suspension: walkover to side ' + m.walkover, ((find('players', pid) || {}).name || 'player') + ' is suspended', m.id);
      }
      db.suspend[pid] = left;
    }
    touched.forEach((eid) => autoAdvance(find('events', eid), 'system'));
  } finally { suspending = false; }
}

/* A bug in one request must never take the whole app down on match day: log it and keep serving. */
function logCrash(kind, e) {
  const line = new Date().toISOString() + ' ' + kind + ': ' + ((e && e.stack) || e) + '\n';
  console.error('\n!!! ' + line);
  try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), line); } catch (x) { /* ignore */ }
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

/* ------------------------------------------------------------ live updates */
const clients = new Set();
let bt = null;
function broadcast() {
  if (bt) return;
  bt = setTimeout(() => {
    bt = null;
    const msg = 'data: ' + JSON.stringify({ t: Date.now() }) + '\n\n';
    clients.forEach((res) => { try { res.write(msg); } catch (e) { clients.delete(res); } });
  }, 250);
}
setInterval(() => clients.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } }), 25000).unref();

/* ----------------------------------------------------------------- helpers */
const find = (col, id) => db[col].find((x) => x.id === id);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
const str = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);
const nameOf = (ev, id) => { const x = ev.sideType === 'team' ? find('teams', id) : find('players', id); return x ? x.name : '?'; };
const sideName = (ev, ids) => ids.map((i) => nameOf(ev, i)).join(' & ');
const sideNamePub = (ev, ids) => ids.map((i) => (ev.sideType === 'player' ? pubName(i) : nameOf(ev, i))).join(' & ');
const normSports = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => str(x, 20)).filter(Boolean))].slice(0, 6);

/* Privacy: the public sees first names only. Staff see full names (no contact details). Only the organizer sees everything. */
const firstOf = (n) => String(n || '').trim().split(/\s+/)[0] || 'Player';
function publicNames() {
  const key = (p) => firstOf(p.name).toLowerCase(), cnt = new Map();
  db.players.forEach((p) => cnt.set(key(p), (cnt.get(key(p)) || 0) + 1));
  const out = new Map();
  db.players.forEach((p) => {
    const parts = String(p.name || '').trim().split(/\s+/), f = firstOf(p.name);
    out.set(p.id, cnt.get(key(p)) > 1 && parts.length > 1 ? f + ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : f);
  });
  const seen = new Map(); out.forEach((v) => seen.set(v, (seen.get(v) || 0) + 1));
  db.players.forEach((p) => { if (seen.get(out.get(p.id)) > 1 && p.playerNo) out.set(p.id, out.get(p.id) + ' (' + p.playerNo + ')'); });
  return out;
}
let pubNames = { v: -1, map: new Map() };
const pubName = (id) => { if (pubNames.v !== stateV) pubNames = { v: stateV, map: publicNames() }; return pubNames.map.get(id) || 'Player'; };
function publicPlayer(p, mode, names) {
  if (mode === 'public') return { id: p.id, name: names.get(p.id) || firstOf(p.name), photo: '', section: p.section, playerNo: p.playerNo, joined: p.createdAt, extHidden: true };
  const showKids = db.tournament.showKidsPhotos;
  if (mode === 'staff') return { id: p.id, name: p.name, gender: p.gender, section: p.section, playerNo: p.playerNo, joined: p.createdAt, extHidden: true, card: cardInfo(p.id) };
  const base = { id: p.id, name: p.name, gender: p.gender, section: p.section, ageGroup: p.ageGroup, playerNo: p.playerNo, photo: p.section === 'kids' && !showKids ? '' : p.photo, joined: p.createdAt };
  base.status = p.status; base.requestedEventIds = p.requestedEventIds; base.registeredAt = p.registeredAt; base.card = cardInfo(p.id); base.dupOf = (p.dupOf || []).filter((i) => find('players', i)); base.pushStatus = p.pushStatus || '';
  return { ...base, hand: p.hand, bio: p.bio, affiliation: p.affiliation, sports: p.sports, achievements: p.achievements, career: p.career, profilePublic: p.profilePublic };
}

/* Local "now" at the venue, as YYYY-MM-DDTHH:mm */
function nowLocal() {
  try {
    const o = {}; new Intl.DateTimeFormat('en-GB', { timeZone: db.tournament.tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach((x) => { o[x.type] = x.value; });
    return o.year + '-' + o.month + '-' + o.day + 'T' + o.hour + ':' + o.minute;
  } catch (e) { return new Date().toISOString().slice(0, 16); }
}
function regOpen(tid) {
  const T = tour(tidOf(tid)); if (!T || T.status === 'closed') return false;
  const r = T.reg;
  if (!r.enabled) return false;
  if (r.deadline && nowLocal().slice(0, 10) > r.deadline) return false;
  return true;
}
/* Set which games a player takes part in. Individual events use participantIds; team events keep an interested list.
   Organizers may override limits; players are held to event limits, age ranges and self-registration settings. */
function setGames(pl, eventIds, asOrganizer) {
  const want = new Set((Array.isArray(eventIds) ? eventIds : []).map(String));
  const added = [], removed = [], skipped = [];
  if (pl.status === 'pending') {
    const ids = [...want].filter((id) => { const ev = find('events', id); return ev && (ev.section || 'adults') === pl.section && (asOrganizer || ev.selfRegister !== false); });
    pl.requestedEventIds = ids; return { added: ids.length, removed: 0, skipped };
  }
  for (const ev of db.events) {
    if ((ev.section || 'adults') !== pl.section) continue;
    const team = ev.sideType === 'team'; const pool = team ? (ev.interestedIds = ev.interestedIds || []) : ev.participantIds;
    const inNow = pool.includes(pl.id), wants = want.has(ev.id);
    if (wants && !inNow) {
      if (!inRoster(ev.tid, pl.id)) { skipped.push(ev.name + ' (not registered for ' + ((tour(ev.tid) || {}).name || 'that event') + ')'); continue; }
      if (!asOrganizer && ev.selfRegister === false) { skipped.push(ev.name + ' (registration is by the organizers)'); continue; }
      if (!ageOk(ev, pl)) { skipped.push(ev.name + ' (age range ' + ageText(ev) + ')'); continue; }
      if (!asOrganizer && ev.maxParticipants > 0 && pool.length >= ev.maxParticipants) { skipped.push(ev.name + ' (full)'); continue; }
      pool.push(pl.id); added.push(ev.name);
    } else if (!wants && inNow) {
      if (!team && db.matches.some((x) => x.eventId === ev.id && (x.sideA.includes(pl.id) || x.sideB.includes(pl.id)))) { skipped.push(ev.name + ' (already has fixtures – use Withdraw / replace)'); continue; }
      if (!team && (ev.groups || ev.bracket)) { skipped.push(ev.name + ' (draw already made – use Withdraw / replace)'); continue; }
      const i = pool.indexOf(pl.id); pool.splice(i, 1); removed.push(ev.name);
    }
  }
  return { added: added.length, removed: removed.length, addedNames: added, skipped };
}
function requestedCount(ev) { return (ev.sideType === 'team' ? ev.interestedIds : ev.participantIds).length + db.players.filter((p) => p.status === 'pending' && (p.requestedEventIds || []).includes(ev.id)).length; }
function regPublic(isAdmin) {
  const per = db.tournaments.filter((T) => T.status !== 'closed' && T.kind !== 'friendly').map((T) => regOne(T, isAdmin));
  const d = per.find((x) => x.tid === defTid()) || per[0] || {};
  return { ...d, publicUrl: db.registration.publicUrl || '', tours: per };
}
function regOne(T, isAdmin) {
  const r = T.reg;
  return {
    tid: T.id, name: T.name, open: regOpen(T.id), deadline: r.deadline, codeRequired: !!r.joinCode, notice: r.notice, kidsNotice: r.kidsNotice,
    events: db.events.filter((e) => e.tid === T.id && e.selfRegister !== false).map((e) => ({ id: e.id, team: e.sideType === 'team', name: e.name, section: e.section, ageMin: e.ageMin || 0, ageMax: e.ageMax || 0, full: e.maxParticipants > 0 && requestedCount(e) >= e.maxParticipants })),
    ...(isAdmin ? { enabled: r.enabled, joinCode: r.joinCode, pending: db.players.filter((p) => p.status === 'pending' && tidOf(p.requestTid) === T.id).length } : {}),
  };
}

/* Staff appear by first name on public screens; a last initial is added only when two share a first name. */
function refDisplay(r) {
  const f = firstOf(r.name), same = db.referees.filter((x) => firstOf(x.name).toLowerCase() === f.toLowerCase());
  const parts = String(r.name).trim().split(/\s+/);
  return same.length > 1 && parts.length > 1 ? f + ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : f;
}
/* May this referee score this match? Organizer-set limits (sports / games) and, when switched on, match assignment. Chiefs may score everything. */
function refScope(r) {
  if (!r || (!r.sports.length && !r.eventIds.length)) return '';
  return [...r.sports.map((x) => SPORT_NAMES[x] || x), ...r.eventIds.map((id) => (find('events', id) || {}).name).filter(Boolean)].join(', ');
}
function checkRef(user, match) {
  if (!user.refId) return;
  if (user.personId && inMatch(user.personId, match)) throw new HttpError(403, 'You (or your team) play in this match, so you cannot referee it.');
  if (user.kind === 'chief') return;
  if (db.tournament.enforceReferee && (match.refereeIds || []).length && !match.refereeIds.includes(user.refId)) throw new HttpError(403, 'This match is assigned to another referee.');
  const r = find('referees', user.refId), ev = find('events', match.eventId);
  if (r && ev && (r.sports.length || r.eventIds.length) && !r.eventIds.includes(ev.id) && !r.sports.includes(ev.sport) && !(ev.refereeIds || []).includes(r.id)) throw new HttpError(403, 'You are set up to referee ' + refScope(r) + ' only. Ask the organizer to change this.');
}
const SPORT_NAMES = { badminton: 'Badminton', tt: 'Table tennis', carrom: 'Carrom', chess: 'Chess', other: 'Other' };
/* Per-season records for all-time rankings (past seasons are frozen when the next season starts). */
const seasonPublic = (x, mode) => ({ id: x.id, name: x.name, startedAt: x.startedAt, endedAt: x.endedAt, champions: x.champions || [], matches: x.matches || 0,
  records: mode === 'public' ? Object.fromEntries(Object.entries(x.records || {}).filter(([pid]) => find('players', pid))) : x.records || {} });

function publicState(mode) {
  const isAdmin = mode === 'admin', names = mode === 'public' ? publicNames() : null;
  const { signers, ...tour } = db.tournament;
  const flaggedSet = new Set(db.disputes.filter((d) => !d.resolved).map((d) => d.matchId));
  return {
    tournament: { ...tour, signers },
    players: db.players.filter((p) => isAdmin || p.status !== 'pending').map((p) => publicPlayer(p, mode, names)),
    teams: db.teams.map(({ captainHash, ...t }) => ({ ...t, hasCode: !!captainHash })), referees: db.referees.filter((r) => isAdmin || r.status !== 'pending').map((r) => ({ id: r.id, name: mode === 'public' ? refDisplay(r) : r.name, kind: r.kind, sports: r.sports, eventIds: r.eventIds, status: r.status, playerId: r.playerId || '', ...(isAdmin ? { phone: r.phone, note: r.note, signedUpAt: r.signedUpAt } : {}) })),
    seasons: db.seasons.map((x) => seasonPublic(x, mode)),
    tournaments: db.tournaments.map((T) => ({ id: T.id, kind: T.kind || '', name: T.name, dates: T.dates, venue: T.venue, status: T.status, createdAt: T.createdAt, createdBy: isAdmin ? T.createdBy : '', organizerIds: T.organizerIds, refereeIds: T.refereeIds, playerIds: T.playerIds })),
    organizers: db.admins.map((a) => (isAdmin ? { id: a.id, name: a.name, sports: a.sports || [], limited: !!a.limited } : { id: a.id, name: mode === 'public' ? firstOf(a.name) : a.name })), events: db.events,
    matches: db.matches.map(({ cids, lock, ...m00 }) => { const m0 = mode === 'public' ? (panic().hideScoreboard ? blankScores(m00) : paperPublic(m00)) : m00; const m = mode === 'public' && !tieRevealed(m0) ? hideLineups(m0) : m0; const o = flaggedSet.has(m.id) ? { ...m, flagged: true } : m; return m.rubbers ? { ...o, rubbers: m.rubbers.map(({ cids: c2, ...r }) => r) } : o; }),
    sponsors: db.sponsors, gallery: (mode === 'public' ? db.gallery.filter((g) => g.consent !== false && (!g.minors || db.tournament.showKidsPhotos)) : db.gallery.filter((g) => isAdmin || !g.minors || db.tournament.showKidsPhotos)).map(({ delHash, ...g }) => g),
    feed: (db.feed || []).slice(-60).reverse(),
    panic: { freezeScoring: !!panic().freezeScoring, lockedEvents: panic().lockedEvents, hideScoreboard: !!panic().hideScoreboard },
    registration: regPublic(isAdmin), vapidPublicKey: db.vapid.publicKey, serverTime: Date.now(),
    ...(isAdmin ? { openDisputes: db.disputes.filter((d) => !d.resolved).length } : {}),
  };
}
/* The public view is identical for everyone, so it is built, compressed and ETagged once per change. */
let pubCache = { v: 0 };
function publicCache() {
  if (pubCache.v !== stateV) {
    const body = Buffer.from(JSON.stringify(publicState('public')));
    pubCache = { v: stateV, body, gz: zlib.gzipSync(body), etag: 'W/"' + bootId + '-' + stateV + '"' };
  }
  return pubCache;
}

/* ---------------------------------------------------------- rate limiting */
const buckets = new Map();
function hit(key, n, win) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + win }; buckets.set(key, b); }
  return ++b.n <= n;
}
const limit = (key, n, win, msg) => { if (!hit(key, n, win)) throw new HttpError(429, msg || 'Too many requests. Please wait a minute and try again.'); };
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();
const sseByIp = new Map();
const dlTokens = new Map();   /* one-time, 2-minute download links (keeps the admin token out of URLs) */

/* ---------------------------------------------------------- login throttling */
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function lockedFor(key) { const f = fails.get(key); return f && f.until > Date.now() ? f.until - Date.now() : 0; }
function recordFail(key, limit) {
  const now = Date.now();
  let f = fails.get(key);
  if (!f || now - f.first > WINDOW) f = { n: 0, first: now, until: 0 };
  f.n++;
  if (f.n >= limit) { f.until = now + WINDOW; f.n = 0; f.first = now; }
  fails.set(key, f);
}
const isLoop = (a) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(a || ''));
/* Real visitor address. Proxy headers are believed only when the request came through a local tunnel/reverse proxy. */
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  if (process.env.TRUST_PROXY === '1' || isLoop(sock)) {
    const h = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0];
    if (h && String(h).trim()) return String(h).trim().slice(0, 64);
  }
  return sock;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/* ------------------------------------------------------------ push */
function interestedIds(ev, m) {
  const ids = new Set([...m.sideA, ...m.sideB]);
  if (ev.sideType === 'team') [...ids].forEach((t) => (find('teams', t) || { memberIds: [] }).memberIds.forEach((p) => ids.add(p)));
  return ids;
}
async function pushTo(filter, title, body, url) {
  const payload = JSON.stringify({ title, body, url: url || '/' });
  const dead = []; let sent = 0;
  await Promise.all(db.subs.map(async (s) => {
    if (!filter(s)) return;
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); }
  }));
  if (dead.length) { db.subs = db.subs.filter((s) => !dead.includes(s.endpoint)); save(); }
  return sent;
}
function addFeed(title, body, o) {
  db.feed = db.feed || [];
  db.feed.push({ id: uid(), at: Date.now(), title: str(title, 100), body: str(body, 300), kind: (o && o.kind) || 'match', matchId: (o && o.matchId) || '', sport: (o && o.sport) || '' });
  if (db.feed.length > 300) db.feed.splice(0, db.feed.length - 300);
  save();
}
async function notify(m, title, body) {
  const ev = find('events', m.eventId);
  if (ev) addFeed(title, body, { kind: /^Full time/.test(title) ? 'result' : /^Up next|^Starting soon/.test(title) ? 'upcoming' : 'match', matchId: m.id, sport: ev.sport });
  if (!ev || !db.subs.length) return;
  const ids = interestedIds(ev, m);
  await pushTo((s) => !s.approvalOnly && (!(s.follow && s.follow.length) || s.follow.some((f) => ids.has(f))), title, body, '/#/match/' + m.id);
}

/* Possible duplicates for the organizer to review: same phone, same email, or the same / very similar name. */
function dupCandidates(pl) {
  const dg = (x) => String(x || '').replace(/\D/g, ''), norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
  return db.players.filter((x) => x.id !== pl.id && x.status !== 'rejected' && x.section === pl.section && (
    (pl.phone && x.phone && dg(x.phone) === dg(pl.phone) && norm(x.name) === norm(pl.name)) ||
    (pl.email && x.email && x.email.toLowerCase() === pl.email.toLowerCase() && norm(x.name) === norm(pl.name)) ||
    (norm(x.name) === norm(pl.name) && (!pl.dob || !x.dob || x.dob === pl.dob)) ||
    (pl.dob && x.dob === pl.dob && norm(x.name).slice(0, 4) === norm(pl.name).slice(0, 4)))).map((x) => x.id).slice(0, 5);
}
function mergePlayers(fromId, intoId, who) {
  const a = find('players', fromId), b = find('players', intoId);
  if (!a || !b || a === b) throw new HttpError(400, 'Choose two different players');
  if (db.matches.some((m) => { const ids = [...m.sideA, ...m.sideB]; return ids.includes(a.id) && ids.includes(b.id); })) throw new HttpError(409, 'These two players are in the same match; delete that match first.');
  const swap = (arr) => [...new Set((arr || []).map((x) => (x === a.id ? b.id : x)))];
  db.tournaments.forEach((t) => { t.playerIds = swap(t.playerIds); });
  db.events.forEach((e) => { e.participantIds = swap(e.participantIds); if (e.interestedIds) e.interestedIds = [...new Set(swap(e.interestedIds))]; if (e.withdrawn) e.withdrawn = swap(e.withdrawn); });
  db.teams.forEach((t) => { t.memberIds = swap(t.memberIds); if (t.captainId === a.id) t.captainId = b.id; });
  db.matches.forEach((m) => {
    m.sideA = m.sideA.map((x) => (x === a.id ? b.id : x)); m.sideB = m.sideB.map((x) => (x === a.id ? b.id : x));
    m.lineupA = swap(m.lineupA); m.lineupB = swap(m.lineupB);
    (m.rubbers || []).forEach((r) => { r.sideA = swap(r.sideA); r.sideB = swap(r.sideB); });
  });
  db.cards.forEach((c) => { if (c.playerId === a.id) c.playerId = b.id; });
  if (db.suspend[a.id]) { db.suspend[b.id] = (db.suspend[b.id] || 0) + db.suspend[a.id]; delete db.suspend[a.id]; }
  db.subs.forEach((s) => { if (s.playerId === a.id) s.playerId = b.id; if (s.follow) s.follow = swap(s.follow); });
  ['phone', 'email', 'dob', 'photo', 'bio', 'affiliation', 'ageGroup', 'gender'].forEach((k) => { if (!b[k] && a[k]) b[k] = a[k]; });
  b.requestedEventIds = [...new Set([...(b.requestedEventIds || []), ...(a.requestedEventIds || [])])];
  db.players = db.players.filter((x) => x !== a);
  db.players.forEach((x) => { if (x.dupOf) x.dupOf = x.dupOf.filter((i) => i !== a.id); });
  audit(who, 'merged players', a.name + ' → ' + b.name);
}

function approvedPush(pl) {
  if (!db.subs.some((x) => x.playerId === pl.id)) return;
  pushTo((x) => x.playerId === pl.id, 'Registration approved', 'You are in, ' + pl.name + '. See your events and fixtures in the app.', '/').catch(() => {});
  db.subs.forEach((x) => { if (x.playerId === pl.id && x.approvalOnly) { delete x.approvalOnly; x.follow = [pl.id]; } });   /* from now on this phone gets the player's own match alerts */
}

/* ------------------------------------------------------------- validation */
function checkSection(ids, col, section) {
  for (const id of ids) {
    const x = find(col, id);
    if (!x) throw new HttpError(400, 'Unknown ' + (col === 'teams' ? 'team' : 'player'));
    if ((x.section || 'adults') !== section) throw new HttpError(400, x.name + ' is in the ' + (x.section === 'kids' ? 'Kids' : 'Adults') + ' section and cannot be used in a ' + (section === 'kids' ? 'Kids' : 'Adults') + ' event');
  }
}

/* Age bands: a player's age is read from the "age / age group" text (e.g. "9", "Under-10" counts as 9). Unreadable ages are never blocked. */
function ageOf(p) {
  const t = String((p && p.ageGroup) || '');
  let m = t.match(/\b(?:under|u)[-\s]?(\d{1,2})\b/i); if (m) return Number(m[1]) - 1;
  m = t.match(/\d{1,2}/); return m ? Number(m[0]) : null;
}
const ageOk = (ev, p) => { const a = ageOf(p); if (a == null) return true; if (ev.ageMin && a < ev.ageMin) return false; if (ev.ageMax && a > ev.ageMax) return false; return true; };
const ageText = (ev) => (ev.ageMin && ev.ageMax ? 'ages ' + ev.ageMin + '–' + ev.ageMax : ev.ageMax ? 'age ' + ev.ageMax + ' and under' : 'age ' + ev.ageMin + ' and over');

const STAGES = ['League', 'Play-off', 'Third place', 'Final', 'Semi-final', 'Quarter-final'];
const okStage = (x) => STAGES.includes(x) || /^Round of (4|8|16|32|64)$/.test(x || '');
const clampN = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));

/* Rubbers = the sub-matches a team tie is made of (e.g. men's singles, women's singles, mixed doubles). */
function makeRubbers(ev) {
  const out = [];
  (ev.rubbers || []).forEach((t) => {
    const cfg = {}; ['bestOf', 'target', 'winBy'].forEach((k) => { if (t[k]) cfg[k] = t[k]; });
    for (let k = 0; k < (t.count || 1); k++) out.push({ id: uid(), name: t.name + ((t.count || 1) > 1 ? ' ' + (k + 1) : ''), size: t.size === 2 ? 2 : 1, gender: t.gender || '', config: cfg, sideA: [], sideB: [], log: [], cids: [], result: null });
  });
  return out;
}
/* After the rubber template changes: ties not yet started get the new structure; ties in progress keep theirs. */
function syncRubbers(ev) {
  db.matches.forEach((m) => {
    if (m.eventId !== ev.id) return;
    const started = (m.log && m.log.length) || m.result || m.walkover || m.retired || (m.rubbers || []).some((r) => r.log.length || r.result || r.walkover);
    if (started) return;
    if (ev.sideType === 'team' && ev.rubbers.length) m.rubbers = makeRubbers(ev); else delete m.rubbers;
  });
}

function normEvent(b, prev) {
  prev = prev || {};
  const pc = prev.config || {}, bc = b.config || {};
  const inc = (Array.isArray(bc.increments) ? bc.increments : String(bc.increments || (pc.increments || [1]).join(',')).split(','))
    .map((x) => Math.round(Number(x))).filter((x) => x > 0 && x < 100);
  let bestOf = Math.min(9, Math.max(1, Math.round(num(bc.bestOf, pc.bestOf || 3)))); if (bestOf % 2 === 0) bestOf += 1;
  const config = {
    bestOf, target: Math.max(1, Math.round(num(bc.target, pc.target || 15))), winBy: Math.max(1, Math.round(num(bc.winBy, pc.winBy || 1))),
    cap: Math.max(0, Math.round(num(bc.cap, pc.cap || 0))), increments: inc.length ? inc : [1],
    pointsWin: num(bc.pointsWin, pc.pointsWin != null ? pc.pointsWin : 2), pointsDraw: num(bc.pointsDraw, pc.pointsDraw != null ? pc.pointsDraw : 1), pointsLoss: num(bc.pointsLoss, pc.pointsLoss != null ? pc.pointsLoss : 0),
    rankBy: (bc.rankBy || pc.rankBy) === 'tally' ? 'tally' : 'matchPoints', finalists: Math.max(0, Math.round(num(bc.finalists, pc.finalists != null ? pc.finalists : 4))),
    maxBoards: clampN(bc.maxBoards, 0, 50, pc.maxBoards || 0), coinWeight: clampN(bc.coinWeight, 0, 20, pc.coinWeight != null ? pc.coinWeight : 1), queenWeight: clampN(bc.queenWeight, 0, 50, pc.queenWeight != null ? pc.queenWeight : 3), queenCutoff: clampN(bc.queenCutoff, 0, 500, pc.queenCutoff != null ? pc.queenCutoff : 22),
    smallBelow: clampN(bc.smallBelow, 0, 500, pc.smallBelow || 0), finalistsSmall: clampN(bc.finalistsSmall, 0, 64, pc.finalistsSmall != null ? pc.finalistsSmall : 2),
    h2hFirst: bc.h2hFirst != null ? !!bc.h2hFirst : !!pc.h2hFirst,
    walkoverPoints: 'walkoverPoints' in bc ? (bc.walkoverPoints === '' || bc.walkoverPoints == null ? null : Math.max(0, Math.round(num(bc.walkoverPoints, 0)))) : pc.walkoverPoints == null ? null : pc.walkoverPoints,
  };
  const section = SECTIONS.includes(b.section) ? b.section : prev.section || 'adults';
  const sideType = (b.sideType || prev.sideType) === 'team' ? 'team' : 'player';
  const participantIds = Array.isArray(b.participantIds) ? [...new Set(b.participantIds.map(String))] : prev.participantIds || [];
  checkSection(participantIds, sideType === 'team' ? 'teams' : 'players', section);
  const tid = b.tid && tour(String(b.tid)) ? String(b.tid) : prev.tid && tour(prev.tid) ? prev.tid : defTid();
  if (Array.isArray(b.participantIds)) {
    const before = new Set(prev.tid === tid ? prev.participantIds || [] : []);
    const bad = participantIds.filter((id) => !before.has(id) && (sideType === 'team' ? (find('teams', id) || {}).tid !== tid : !inRoster(tid, id)));
    if (bad.length) throw new HttpError(400, bad.map((id) => (find(sideType === 'team' ? 'teams' : 'players', id) || {}).name).join(', ') + (sideType === 'team' ? ' – team is not part of ' : ' – not registered for ') + ((tour(tid) || {}).name || 'this event') + '. Players join an event by registering, by an uploaded player list, or by being enrolled.');
  }
  const sideSize = Number(b.sideSize || prev.sideSize) === 2 ? 2 : 1;
  const ageMin = clampN(b.ageMin != null ? b.ageMin : prev.ageMin, 0, 99, 0);
  let ageMax = clampN(b.ageMax != null ? b.ageMax : prev.ageMax, 0, 99, 0); if (ageMax && ageMax < ageMin) ageMax = ageMin;
  if (sideType === 'player' && (ageMin || ageMax)) {
    const before = new Set(prev.participantIds || []);
    participantIds.filter((id) => !before.has(id)).forEach((id) => { const pl = find('players', id); if (pl && !ageOk({ ageMin, ageMax }, pl)) throw new HttpError(400, pl.name + ' (' + pl.ageGroup + ') does not fit the age range of this event (' + ageText({ ageMin, ageMax }) + ')'); });
  }
  const FT = ['roundrobin', 'groups', 'knockout', 'swiss'], pf = prev.format || {}, bf = b.format || {};
  const format = {
    type: FT.includes(bf.type) ? bf.type : FT.includes(pf.type) ? pf.type : 'roundrobin',
    groups: clampN(bf.groups, 2, 8, pf.groups || 2), qualifiers: clampN(bf.qualifiers, 1, 8, pf.qualifiers || 2),
    thirdPlace: bf.thirdPlace != null ? !!bf.thirdPlace : !!pf.thirdPlace, swissRounds: clampN(bf.swissRounds, 0, 15, pf.swissRounds || 0),
    autoAdvance: bf.autoAdvance != null ? !!bf.autoAdvance : !!pf.autoAdvance, doubleRR: bf.doubleRR != null ? !!bf.doubleRR : !!pf.doubleRR,
  };
  if (sideSize === 2) format.type = 'roundrobin';
  if (format.type === 'groups') config.finalists = format.groups * format.qualifiers;
  if (format.type === 'knockout') config.finalists = 0;
  const rbIn = Array.isArray(b.rubbers) ? b.rubbers : prev.rubbers || [];
  const rubbers = sideType !== 'team' ? [] : rbIn.slice(0, 12).map((t) => {
    const o = { name: str(t.name, 40) || 'Rubber', size: Number(t.size) === 2 ? 2 : 1, gender: ['M', 'F'].includes(t.gender) ? t.gender : '', count: clampN(t.count, 1, 5, 1) };
    ['bestOf', 'target', 'winBy'].forEach((k) => { const v = Math.round(num(t[k], 0)); if (v > 0 && v < 100) o[k] = v; });
    if (o.bestOf && o.bestOf % 2 === 0) o.bestOf += 1;
    return o;
  });
  if (rubbers.reduce((n, t) => n + t.count, 0) > 15) throw new HttpError(400, 'A tie can have at most 15 rubbers');
  const rr = b.rubberRules || {}, pr = prev.rubberRules || {};
  const rubberRules = { clinch: rr.clinch != null ? !!rr.clinch : pr.clinch !== false, maxPerPlayer: clampN(rr.maxPerPlayer, 1, 6, pr.maxPerPlayer || 2) };
  return {
    groups: prev.groups, bracket: prev.bracket, byes: prev.byes || [], format, rubbers, rubberRules, ageMin, ageMax,
    id: prev.id || uid(), name: str(b.name || prev.name || 'Event', 80), sport: str(b.sport || prev.sport || 'other', 20), section,
    scoring: (b.scoring || prev.scoring) === 'result' ? 'result' : 'points', sideType, sideSize,
    note: str(b.note != null ? b.note : prev.note || '', 300), participantIds, config,
    maxParticipants: Math.max(0, Math.min(500, Math.round(num(b.maxParticipants, prev.maxParticipants || 0)))),
    selfRegister: b.selfRegister != null ? !!b.selfRegister : prev.selfRegister !== false,
    withdrawn: (prev.withdrawn || []).filter((x) => participantIds.includes(x)), interestedIds: prev.interestedIds || [], tid,
    organizerIds: Array.isArray(b.organizerIds) ? [...new Set(b.organizerIds.map(String))].filter((id) => db.admins.some((a) => a.id === id)) : prev.organizerIds || [],
    refereeIds: Array.isArray(b.refereeIds) ? [...new Set(b.refereeIds.map(String))].filter((id) => find('referees', id)) : prev.refereeIds || [],
    ...(prev.frozenCount != null ? { frozenCount: prev.frozenCount } : {}),
  };
}

function normMatch(b, prev) {
  prev = prev || {};
  const ev = find('events', b.eventId || prev.eventId);
  if (!ev) throw new HttpError(400, 'Choose an event');
  const sideA = (b.sideA || prev.sideA || []).map(String), sideB = (b.sideB || prev.sideB || []).map(String);
  if (sideA.length !== ev.sideSize || sideB.length !== ev.sideSize) throw new HttpError(400, 'Each side needs ' + ev.sideSize + ' ' + (ev.sideType === 'team' ? 'team' : 'player') + (ev.sideSize > 1 ? 's' : ''));
  const all = [...sideA, ...sideB];
  if (new Set(all).size !== all.length) throw new HttpError(400, 'The same player/team is selected twice');
  const col = ev.sideType === 'team' ? 'teams' : 'players';
  checkSection(all, col, ev.section || 'adults');
  const T = tour(ev.tid);
  if (T && T.status === 'closed') throw new HttpError(409, T.name + ' is closed.');
  if (!prev.id) { const bad = all.filter((id) => (ev.sideType === 'team' ? (find('teams', id) || {}).tid !== ev.tid : !inRoster(ev.tid, id)));
    if (bad.length) throw new HttpError(400, bad.map((id) => (find(col, id) || {}).name).join(', ') + ' – not registered for ' + (T ? T.name : 'this event') + '.'); }
  const lineup = (key, ids) => {
    if (ev.sideType !== 'team') return [];
    const src = b[key] !== undefined ? b[key] : prev[key] || [];
    const members = new Set(ids.flatMap((t) => (find('teams', t) || { memberIds: [] }).memberIds));
    return (Array.isArray(src) ? src : []).map(String).filter((x) => members.has(x));
  };
  const startsAt = b.startsAt !== undefined ? (SLOT_RE.test(b.startsAt) ? b.startsAt : '') : prev.startsAt || '';
  return {
    id: prev.id || uid(), eventId: ev.id, stage: okStage(b.stage) ? b.stage : prev.stage || 'League', ...(b.group || prev.group ? { group: str(b.group != null ? b.group : prev.group, 4) } : {}),
    ...(prev.rubbers ? { rubbers: prev.rubbers } : ev.sideType === 'team' && (ev.rubbers || []).length ? { rubbers: makeRubbers(ev) } : {}),
    sideA, sideB, lineupA: lineup('lineupA', sideA), lineupB: lineup('lineupB', sideB),
    court: str(b.court != null ? b.court : prev.court || '', 30), time: str(b.time != null ? b.time : prev.time || '', 30), startsAt,
    round: Math.max(0, Math.round(num(b.round, prev.round || 0))), totalRounds: Math.max(0, Math.min(99, Math.round(num(b.totalRounds, prev.totalRounds || 0)))), ...matchCfg(b, prev), refereeIds: (() => {
      const ids = Array.isArray(b.refereeIds) ? b.refereeIds.map(String) : b.refereeId !== undefined ? (b.refereeId ? [str(b.refereeId, 20)] : []) : prev.refereeIds || (prev.refereeId ? [prev.refereeId] : []);
      const ok = [...new Set(ids)].filter((id) => find('referees', id)).slice(0, ev.sideType === 'team' ? 6 : 2);
      const clash = ok.map((id) => find('referees', id)).filter((r) => r.playerId && inMatch(r.playerId, { sideA, sideB }));
      if (clash.length && (Array.isArray(b.refereeIds) || b.refereeId !== undefined)) throw new HttpError(400, clash.map((r) => r.name).join(', ') + ' play' + (clash.length > 1 ? '' : 's') + ' in this match and cannot referee it.');
      return ok.filter((id) => !clash.some((r) => r.id === id));
    })(),
    log: prev.log || [], cids: prev.cids || [], result: prev.result || null, createdAt: prev.createdAt || Date.now(), ...(prev.startedAt ? { startedAt: prev.startedAt } : {}),
    ...(prev.walkover ? { walkover: prev.walkover } : {}), ...(prev.retired ? { retired: prev.retired } : {}), ...(prev.outcome ? { outcome: prev.outcome } : {}), ...(prev.lock ? { lock: prev.lock } : {}),
    ...(prev.notified15 && startsAt === prev.startsAt ? { notified15: true } : {}),
  };
}

const paperPublic = (m) => (m.paper ? { ...m, paper: { signed: !!m.paper.signed } } : m);
function blankScores(m) { const o = { ...m, log: [], result: null, walkover: null, retired: null, outcome: '' }; delete o.paper; if (m.rubbers) o.rubbers = m.rubbers.map((r) => ({ ...r, log: [], result: null, walkover: null })); return o; }

/* Team ties: neither line-up is shown until both captains have set theirs or the tie has started. */
function tieStarted(m) { return !!((m.log || []).length || m.result || m.walkover || (m.rubbers || []).some((r) => (r.log || []).length || r.result || r.walkover)); }
function sideComplete(m, key) { return (m.rubbers || []).length > 0 && m.rubbers.every((r) => (r[key] || []).length === (r.size === 2 ? 2 : 1)); }
function tieRevealed(m) { return !(m.rubbers || []).length || tieStarted(m) || (sideComplete(m, 'sideA') && sideComplete(m, 'sideB')); }
function hideLineups(m) { return { ...m, lineupA: [], lineupB: [], rubbers: m.rubbers.map((r) => ({ ...r, sideA: [], sideB: [] })), lineupHidden: true }; }

/* Per-fixture points settings (optional). Empty object = use the event's settings. */
function matchCfg(b, prev) {
  const src = b.cfg !== undefined ? b.cfg : prev.cfg; if (!src || typeof src !== 'object') return {};
  const o = {};
  ['bestOf', 'target', 'winBy', 'cap', 'maxBoards', 'queenCutoff'].forEach((k) => { if (src[k] !== '' && src[k] != null) { const v = Math.round(Number(src[k])); if (v >= 0 && v < 100) o[k] = v; } });
  ['coinWeight', 'queenWeight'].forEach((k) => { if (src[k] !== '' && src[k] != null) { const v = Number(src[k]); if (v >= 0 && v < 20) o[k] = v; } });
  if (o.bestOf) { if (o.bestOf % 2 === 0) o.bestOf += 1; if (o.bestOf > 9) o.bestOf = 9; }
  if (o.target === 0) delete o.target; if (o.winBy === 0) delete o.winBy; if (o.bestOf === 0) delete o.bestOf;
  return Object.keys(o).length ? { cfg: o } : {};
}

/* Schedule clash detection: same court or same player/team member at the same time. */
const slotOf = (m) => m.startsAt || String(m.time || '').trim().toLowerCase();
function playersOf(m) {
  const ev = find('events', m.eventId); const ids = new Set();
  [...m.sideA, ...m.sideB].forEach((id) => {
    if (ev && ev.sideType === 'team') ((find('teams', id) || { memberIds: [] }).memberIds).forEach((x) => ids.add(x)); else ids.add(id);
  });
  return ids;
}
function findClashes(m) {
  const slot = slotOf(m); if (!slot) return [];
  const mine = playersOf(m), out = [];
  for (const o of db.matches) {
    if (o.id === m.id || slotOf(o) !== slot) continue;
    const oev = find('events', o.eventId);
    if (!oev || Engine.derive(o, oev).status === 'completed') continue;
    if (m.court && o.court && m.court.toLowerCase() === o.court.toLowerCase()) out.push(m.court + ' is already used then by ' + oev.name + ': ' + sideName(oev, o.sideA) + ' vs ' + sideName(oev, o.sideB));
    const theirs = playersOf(o);
    for (const id of mine) if (theirs.has(id)) out.push(((find('players', id) || {}).name || '?') + ' is also scheduled at that time (' + oev.name + ')');
  }
  return [...new Set(out)];
}

const needName = (b, p) => str(b.name != null ? b.name : p && p.name, 60) || (() => { throw new HttpError(400, 'Name is required'); })();
const COLS = {
  players: (b, p) => {
    const sec = SECTIONS.includes(b.section) ? b.section : (p && p.section) || 'adults';
    const sportsIn = b.sports && typeof b.sports === 'object' ? b.sports : (p && p.sports) || {};
    const sports = {};
    SPORTS.forEach((k) => {
      const x = sportsIn[k]; if (!x) return;
      const level = LEVELS.includes(x.level) ? x.level : '', style = str(x.style, 60), rating = x.rating === '' || x.rating == null ? '' : Math.max(0, Math.min(3500, Math.round(num(x.rating, 0)))) || '';
      if (level || style || rating) sports[k] = { level, style, rating };
    });
    const ach = Array.isArray(b.achievements) ? b.achievements : (p && p.achievements) || [];
    const own = (k, max) => str(b[k] != null ? b[k] : (p && p[k]) || '', max);
    let playerNo = p && p.playerNo;
    if (!playerNo) playerNo = 'P' + String(db.nextPlayerNo++).padStart(3, '0');
    return {
      id: (p && p.id) || uid(), playerNo, name: needName(b, p), gender: ['F', 'M', ''].includes(b.gender) ? b.gender : (p && p.gender) || '', section: sec,
      ageGroup: own('ageGroup', 20), phone: own('phone', 30), email: own('email', 80), photo: own('photo', 200), notes: own('notes', 500),
      affiliation: own('affiliation', 60), bio: own('bio', 300), hand: ['R', 'L', 'B', ''].includes(b.hand) ? b.hand : (p && p.hand) || '',
      dob: /^\d{4}-\d{2}-\d{2}$/.test(own('dob', 10)) ? own('dob', 10) : '', pushStatus: (p && p.pushStatus) || '', emergency: own('emergency', 120), tshirt: own('tshirt', 6), sports, achievements: ach.map((x) => str(x, 100)).filter(Boolean).slice(0, 20),
      profilePublic: typeof b.profilePublic === 'boolean' ? b.profilePublic : p ? p.profilePublic : sec !== 'kids',
      career: (p && p.career) || [], createdAt: (p && p.createdAt) || Date.now(),
      guardianName: own('guardianName', 60), guardianPhone: own('guardianPhone', 30),
      pinHash: (p && p.pinHash) || '', pinIdx: (p && p.pinIdx) || '',
      status: (p && p.status) || 'approved', requestedEventIds: (p && p.requestedEventIds) || [], registeredAt: (p && p.registeredAt) || 0, consentAt: (p && p.consentAt) || 0, editTokenHash: (p && p.editTokenHash) || '',
    };
  },
  teams: (b, p) => {
    const section = SECTIONS.includes(b.section) ? b.section : (p && p.section) || 'adults';
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds.map(String) : (p && p.memberIds) || [];
    checkSection(memberIds, 'players', section);
    const tid = b.tid && tour(String(b.tid)) ? String(b.tid) : (p && p.tid && tour(p.tid)) ? p.tid : defTid();
    if (Array.isArray(b.memberIds)) { const bad = memberIds.filter((id) => !inRoster(tid, id) && !((p && p.memberIds) || []).includes(id)); if (bad.length) throw new HttpError(400, bad.map((id) => (find('players', id) || {}).name).join(', ') + ' – not registered for ' + ((tour(tid) || {}).name || 'this event')); }
    const cap = b.captainId !== undefined ? String(b.captainId || '') : (p && p.captainId) || '';
    return { id: (p && p.id) || uid(), name: needName(b, p), section, memberIds, tid, color: str(b.color != null ? b.color : (p && p.color) || '', 20), captainId: memberIds.includes(cap) ? cap : '', ...(p && p.captainHash ? { captainHash: p.captainHash } : {}) };
  },
  referees: (b, p) => {
    let plain = null;
    if (/^\d{4,8}$/.test(String(b.pin || ''))) plain = String(b.pin); else if (!p || b.resetPin) plain = pinN(4);
    const kind = ['referee', 'chief', 'volunteer'].includes(b.kind) ? b.kind : (p && p.kind) || 'referee';
    const sports = Array.isArray(b.sports) ? [...new Set(b.sports.filter((x) => SPORTS.includes(x)))] : (p && p.sports) || [];
    const eventIds = Array.isArray(b.eventIds) ? [...new Set(b.eventIds.map(String).filter((x) => find('events', x)))] : (p && p.eventIds) || [];
    const status = p && p.status === 'pending' && !plain ? 'pending' : 'active';
    return { id: (p && p.id) || uid(), name: needName(b, p), kind, sports, eventIds, status, phone: str(b.phone != null ? b.phone : (p && p.phone) || '', 30), note: str(b.note != null ? b.note : (p && p.note) || '', 200),
      signedUpAt: (p && p.signedUpAt) || 0, pinHash: plain ? hashPin(plain) : p.pinHash, _plain: plain };
  },
  events: normEvent,
  matches: normMatch,
  sponsors: (b, p) => ({ id: (p && p.id) || uid(), name: str(b.name != null ? b.name : (p && p.name) || '', 80), image: str(b.image != null ? b.image : (p && p.image) || '', 200), url: str(b.url != null ? b.url : (p && p.url) || '', 200) }),
};

function cascadeDelete(col, id) {
  const used = (type) => db.matches.some((m) => [...m.sideA, ...m.sideB].includes(id) && (find('events', m.eventId) || {}).sideType === type);
  if (col === 'players') {
    if (used('player')) throw new HttpError(409, 'Player has matches. Delete those matches first.');
    db.teams.forEach((t) => (t.memberIds = t.memberIds.filter((x) => x !== id)));
    db.tournaments.forEach((t) => { t.playerIds = t.playerIds.filter((x) => x !== id); });
    db.events.forEach((e) => { e.participantIds = e.participantIds.filter((x) => x !== id); e.interestedIds = (e.interestedIds || []).filter((x) => x !== id); });
  } else if (col === 'teams') {
    if (used('team')) throw new HttpError(409, 'Team has matches. Delete those matches first.');
    db.events.forEach((e) => { e.participantIds = e.participantIds.filter((x) => x !== id); e.interestedIds = (e.interestedIds || []).filter((x) => x !== id); });
  } else if (col === 'events') db.matches = db.matches.filter((m) => m.eventId !== id);
  else if (col === 'referees') {
    db.matches.forEach((m) => { m.refereeIds = (m.refereeIds || []).filter((x) => x !== id); });
    db.events.forEach((e) => { e.refereeIds = (e.refereeIds || []).filter((x) => x !== id); });
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].refId === id) delete db.sessions[t]; });
  }
  db[col] = db[col].filter((x) => x.id !== id);
}

/* Deleted items go to a 30-day trash so a mis-tap can be undone. */
const clone = (x) => JSON.parse(JSON.stringify(x));
function snapshot(col, id) {
  const item = clone(find(col, id));
  const s = { id: uid(), col, item, at: Date.now(), links: { teams: [], events: [], matches: [] }, matches: [], name: item.name || '' };
  if (col === 'players') { db.teams.forEach((t) => t.memberIds.includes(id) && s.links.teams.push(t.id)); db.events.forEach((e) => e.participantIds.includes(id) && s.links.events.push(e.id)); }
  if (col === 'teams') db.events.forEach((e) => e.participantIds.includes(id) && s.links.events.push(e.id));
  if (col === 'events') s.matches = db.matches.filter((m) => m.eventId === id).map(clone);
  if (col === 'referees') db.matches.forEach((m) => (m.refereeIds || []).includes(id) && s.links.matches.push(m.id));
  if (col === 'matches') { const ev = find('events', item.eventId); s.name = ev ? sideName(ev, item.sideA) + ' vs ' + sideName(ev, item.sideB) : 'Match'; }
  return s;
}
function pushTrash(sn) {
  db.trash.push(sn);
  const cut = Date.now() - 30 * 86400e3;
  db.trash = db.trash.filter((x) => x.at > cut).slice(-200);
}
function restoreTrash(sn) {
  const col = sn.col, it = sn.item;
  if (db[col].some((x) => x.id === it.id)) throw new HttpError(409, 'This item already exists again.');
  if (col === 'matches' && !find('events', it.eventId)) throw new HttpError(409, 'Its event no longer exists. Restore the event first.');
  if (col === 'players' && it.status === 'pending') { /* stays pending */ }
  if (col === 'teams') it.memberIds = it.memberIds.filter((x) => find('players', x));
  db[col].push(it);
  (sn.links.teams || []).forEach((t) => { const x = find('teams', t); if (x && !x.memberIds.includes(it.id)) x.memberIds.push(it.id); });
  (sn.links.events || []).forEach((e) => { const x = find('events', e); if (x && !x.participantIds.includes(it.id)) x.participantIds.push(it.id); });
  (sn.links.matches || []).forEach((m) => { const x = find('matches', m); if (x && col === 'referees' && !(x.refereeIds || []).includes(it.id)) x.refereeIds = (x.refereeIds || []).concat(it.id); });
  if (col === 'events') (sn.matches || []).forEach((m) => { if (!find('matches', m.id)) db.matches.push(m); });
}

/* "Starting soon" push, 15 minutes before a scheduled match. */
setInterval(() => {
  try {
    const nowMs = Date.parse(nowLocal() + ':00Z'); let ch = false;
    for (const m of db.matches) {
      if (!m.startsAt || m.notified15) continue;
      const ev = find('events', m.eventId); if (!ev) continue;
      const diff = (Date.parse(m.startsAt + ':00Z') - nowMs) / 60000;
      if (diff > 15 || diff < -30) continue;
      m.notified15 = true; ch = true;
      if (Engine.derive(m, ev).status !== 'scheduled') continue;
      notify(m, 'Starting soon: ' + ev.name, sideNamePub(ev, m.sideA) + ' vs ' + sideNamePub(ev, m.sideB) + ' in about ' + Math.max(1, Math.round(diff)) + ' min' + (m.court ? ' • ' + m.court : '')).catch(() => {});
    }
    if (ch) save();
  } catch (e) { /* ignore */ }
}, 30000).unref();

/* ------------------------------------------------------------------- http */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
/* ISO media (mp4 / mov: "ftyp" at byte 4) or Matroska/WebM (EBML header). */
const looksLikeVideo = (buf, ext) => (ext === '.webm' ? buf.readUInt32BE(0) === 0x1a45dfa3 : buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp');
/* Streams a request body straight to disk (videos can be large); refuses beyond the limit. */
function readBodyToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file); let n = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.unlink(file, () => {}); reject(e); };
    req.on('data', (c) => { n += c.length; if (n > limit) { fail(new HttpError(413, 'That file is too large (max ' + Math.round(limit / 1e6) + ' MB).')); req.destroy(); } });
    req.on('error', fail); out.on('error', fail);
    req.pipe(out); out.on('finish', () => { if (!failed) resolve(n); });
  });
}
const maskPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length < 5 ? (d ? '•••' : '') : d.slice(0, 2) + '•'.repeat(Math.max(3, d.length - 5)) + d.slice(-3); };
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
/* The file must really be the image type it claims to be (checks the first bytes, not just the header). */
const looksLike = (buf, ext) => (ext === '.jpg' ? buf[0] === 0xff && buf[1] === 0xd8 : ext === '.png' ? buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' : buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP');

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async (req, limit) => { const b = await readBody(req, limit); if (!b.length) return {}; try { return JSON.parse(b.toString()); } catch (e) { throw new HttpError(400, 'Bad JSON'); } };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function auth(req, url) {
  const t = req.headers['x-token'];
  const s = t && db.sessions[t];
  if (!s) return null;
  if (s.exp && s.exp < Date.now()) { delete db.sessions[t]; return null; }
  return { token: t, ...s };
}
/* Writes whole games (from a correction or a paper score sheet) into the match as a point log. */
function writeGames(match, b, who, tag) {
  const ev0 = find('events', match.eventId);
  if (ev0.scoring !== 'points') throw new HttpError(400, 'This event records results only');
  if (!ev0.config.increments.includes(1)) throw new HttpError(400, 'Score correction needs a +1 button on this event');
    const tgt = match.rubbers && match.rubbers.length ? (match.rubbers.find((r) => r.id === b.rid) || (() => { throw new HttpError(400, 'Choose which rubber to correct'); })()) : match;
  const ev = tgt === match ? ev0 : Engine.rubberEvent(ev0, tgt);
  const games = (Array.isArray(b.games) ? b.games : []).filter((g) => g && g.a !== '' && g.b !== '' && g.a != null && g.b != null);
  const log = [];
  games.forEach((g, i) => {
    const a = Math.round(Number(g.a)), c = Math.round(Number(g.b));
    if (!(a >= 0 && c >= 0) || a === c || a > 200 || c > 200) throw new HttpError(400, 'Game ' + (i + 1) + ': enter two different scores');
    const w = a > c ? 'A' : 'B', l = w === 'A' ? 'B' : 'A', ws = Math.max(a, c), ls = Math.min(a, c);
    for (let k = 0; k < ws; k++) { log.push({ s: w, inc: 1, t: Date.now(), by: tag }); if (k < ls) log.push({ s: l, inc: 1, t: Date.now(), by: tag }); }
  });
  const trial = { ...tgt, log, result: null };
  const d = Engine.derive(trial, ev);
  const same = d.games.length === games.length && d.games.every((g, i) => g.a === Math.round(Number(games[i].a)) && g.b === Math.round(Number(games[i].b)));
  if (!same) throw new HttpError(400, 'Those scores are not valid for this event (' + ev.config.target + ' points' + (ev.config.winBy > 1 ? ', win by ' + ev.config.winBy : '') + (ev.config.cap ? ', cap ' + ev.config.cap : '') + ', best of ' + ev.config.bestOf + ')');
  tgt.log = log; tgt.result = null; tgt.cids = []; tgt.retired = null; tgt.walkover = null; tgt.outcome = '';
  if (log.length && !match.startedAt) match.startedAt = Date.now();
  if (Engine.derive(match, ev0).status === 'completed') autoAdvance(ev0, who);
  return games;
}

/* ---------------------------------------------------- panic controls */
const panic = () => (db.tournament.panic = db.tournament.panic || { freezeScoring: false, lockedEvents: [], hideScoreboard: false });
function assertOpen(match) {
  const T = match && tour((find('events', match.eventId) || {}).tid);
  if (T && T.status === 'closed') throw new HttpError(423, T.name + ' is closed – scores can no longer change.');
  const pc = panic();
  if (pc.freezeScoring) throw new HttpError(423, 'Scoring is paused by the organizer. Please wait for the announcement.');
  if (match && pc.lockedEvents.includes(match.eventId)) throw new HttpError(423, 'This event is locked by the organizer.');
}
/* A whole result from a paper score sheet. The referee enters it, the chief referee signs it off; it stays labelled "from paper". */
function applyPaper(match, b, user) {
  const ev = find('events', match.eventId);
  if (!ev) throw new HttpError(404, 'Event not found');
  const live = (match.log || []).length || match.result || (match.rubbers || []).some((r) => (r.log || []).length || r.result);
  if (live && !(user.refId && user.kind === 'chief')) throw new HttpError(409, 'This match already has live scores. Ask the chief referee to correct it.');
  if (ev.scoring === 'points') writeGames(match, b, user.name, 'paper');
  else {
    const r = b.result === 'draw' ? 'draw' : b.result === 'A' || b.result === 'B' ? b.result : '';
    if (!r) throw new HttpError(400, 'Choose the winner or draw');
    match.log = []; match.cids = []; match.retired = null; match.walkover = null; match.outcome = '';
    match.result = r;
  }
  match.paper = { by: user.name, at: Date.now(), signed: false, note: str(b.note, 120) };
  audit(user.name, 'score from paper sheet', str(b.note, 120), match.id);
}
const isStaffU = (u) => !!u && !!(u.adminId || u.refId || u.role === 'admin' || u.role === 'referee');
const needStaff = (u) => { if (!u) throw new HttpError(401, 'Please sign in'); if (!isStaffU(u)) throw new HttpError(403, 'Staff only.'); return u; };
const needScorer = (u) => { needStaff(u); if (!u.refId || u.kind === 'volunteer') throw new HttpError(403, 'Only referees can change scores. The organizer assigns referees.'); return u; };
/* Does this person play in the game – themselves, on its interested list, or as a member of a team entered in it? */
/* Is this person on either side of the match – as a player, or as a member of a team that is playing it? */
const inMatch = (pid, m) => !!pid && [...(m.sideA || []), ...(m.sideB || [])].some((id) => id === pid || ((find('teams', id) || {}).memberIds || []).includes(pid));
const playsIn = (pid, ev) => !!(pid && ev) && ((ev.participantIds || []).includes(pid) || (ev.interestedIds || []).includes(pid) || (ev.participantIds || []).some((tid) => ((find('teams', tid) || {}).memberIds || []).includes(pid)));
const needLineup = (u) => { if (u && u.role === 'captain') return u; needStaff(u); if (u.refId && !u.adminId && u.kind === 'volunteer') throw new HttpError(403, 'Volunteers cannot change line-ups.'); return u; };
/* Full organizers manage everything. A sport lead manages their sports; a game organizer ("limited") manages only the games they organize. */
const isLead = (u) => !!(u && ((u.sports && u.sports.length) || u.limited));
const sportOk = (u, ev) => !isLead(u) || (!!ev && ((u.sports || []).includes(ev.sport) || (ev.organizerIds || []).includes(u.adminId) || tourOrg(u, ev.tid)));
const canTour = (u, tid) => !!u && u.role === 'admin' && (!isLead(u) || tourOrg(u, tid));
function newOrganizer(name, o) {
  let pin; do { pin = pinN(8); } while (db.admins.some((a) => checkPin(pin, a.pinHash)));
  const a = { id: uid(), name: str(name, 40), pinHash: hashPin(pin), sports: o.sports || [], limited: !!o.limited }; db.admins.push(a);
  return Object.defineProperty(a, '_pin', { value: pin, enumerable: false, configurable: true, writable: true });
}
/* Who does this PIN belong to? Players (people), plus older admin / referee / captain PINs that are not yet a person's PIN. */
function findByPin(pin) {
  const idx = pinIdx(pin), lists = [['player', db.players], ['admin', db.admins], ['referee', db.referees], ['captain', db.teams]];
  for (const [kind, list] of lists) for (const rec of list) { const h = kind === 'captain' ? rec.captainHash : rec.pinHash; if (h && rec.pinIdx === idx && checkPin(pin, h)) return { kind, rec }; }
  for (const [kind, list] of lists) for (const rec of list) {   // older PINs without a fingerprint: check, then remember the fingerprint
    const h = kind === 'captain' ? rec.captainHash : rec.pinHash;
    if (kind !== 'player' && h && !rec.pinIdx && checkPin(pin, h)) { rec.pinIdx = idx; return { kind, rec }; }
  }
  return null;
}
/* One session carries every role the person has: admin / organizer, referee, team captain, player. */
function sessionFor(who) {
  const r0 = who.rec;
  const personId = who.kind === 'player' ? r0.id : who.kind === 'captain' ? r0.captainId || '' : r0.playerId || '';
  const pl = personId ? find('players', personId) : null;
  const a = who.kind === 'admin' ? r0 : personId ? db.admins.find((x) => x.playerId === personId) : null;
  const rf = who.kind === 'referee' ? r0 : personId ? db.referees.find((x) => x.playerId === personId && x.status !== 'pending') : null;
  if (who.kind === 'referee' && r0.status === 'pending') return null;
  const cap = who.kind === 'captain' ? r0 : personId ? db.teams.find((t) => t.captainId === personId) : null;
  const role = a ? 'admin' : rf ? 'referee' : cap ? 'captain' : 'player';
  return { role, name: (pl && pl.name) || (a && a.name) || (rf && rf.name) || (cap && cap.name) || 'Player', personId,
    ...(a ? { adminId: a.id, sports: a.sports || [], limited: !!a.limited } : {}), ...(rf ? { refId: rf.id, kind: rf.kind || 'referee' } : {}), ...(cap ? { teamId: cap.id } : {}),
    exp: Date.now() + (a ? 12 : 36) * 3600e3 };
}
const sessOut = (token, s0) => ({ token, role: s0.role, name: s0.name, kind: s0.kind || '', sports: s0.sports || [], limited: !!s0.limited, adminId: s0.adminId || '', refId: s0.refId || '', personId: s0.personId || '', teamId: s0.teamId || '' });
/* A fresh, unique 6-digit PIN that is not trivial. */
function newPersonPin() {
  for (;;) { const pin = String(crypto.randomInt(100000, 1000000)); if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) continue; if (!findByPin(pin)) return pin; }
}
function givePin(pl) { const pin = newPersonPin(); pl.pinHash = hashPin(pin); pl.pinIdx = pinIdx(pin); return pin; }
const needAdmin = (u) => { needStaff(u); if (u.role !== 'admin') throw new HttpError(403, 'Admin only'); return u; };

const fileCache = new Map();   /* app files are read once, compressed once, and revalidated with an ETag */
function serveFile(req, res, file, cache, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = 'W/"' + st.size + '-' + Math.round(st.mtimeMs) + '"';
    const headers = { 'Content-Type': type, 'Cache-Control': cache || 'no-cache', ETag: etag, ...(extra || {}) };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    if (st.size > 2e6 || /^video\//.test(type)) {   // big files and videos: stream, with byte ranges (iPhones need them to play video)
      headers['Accept-Ranges'] = 'bytes';
      const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (r && (r[1] || r[2])) {
        let start = r[1] ? Number(r[1]) : Math.max(0, st.size - Number(r[2])), end = r[1] && r[2] ? Math.min(Number(r[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
    }
    const zip = /^(text\/|application\/(json|manifest))/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    let hit = fileCache.get(file);
    const send = () => { if (zip) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); res.end(hit.gz); } else { res.writeHead(200, headers); res.end(hit.buf); } };
    if (hit && hit.etag === etag) return send();
    fs.readFile(file, (e2, buf) => {
      if (e2) { res.writeHead(404); return res.end('Not found'); }
      hit = { etag, buf, gz: /^(text\/|application\/(json|manifest))/.test(type) ? zlib.gzipSync(buf) : null };
      if (buf.length < 2e6) fileCache.set(file, hit);
      send();
    });
  });
}

/* CSV / TSV text (e.g. a Google Forms export) -> rows. Handles quotes, commas or tabs, Windows line ends. */
function parseDelimited(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0], sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"' && cur === '') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.slice(0, 5000);
}
async function loadWorkbook(buf) {
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
  if (buf.length > 1 && !(buf[0] === 0x50 && buf[1] === 0x4b)) {   // not a zip (xlsx) -> try CSV / TSV text
    const text = buf.toString('utf8');
    if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000))) throw new HttpError(400, 'Please upload an Excel (.xlsx) or CSV file. Old .xls files: open in Excel and "Save as" .xlsx.');
    const ws = wb.addWorksheet('Sheet1'); parseDelimited(text).forEach((r) => ws.addRow(r));
    if (!ws.rowCount) throw new HttpError(400, 'The file is empty.');
    return wb;
  }
  try { await wb.xlsx.load(buf); } catch (e) { throw new HttpError(400, 'That does not look like an Excel (.xlsx) or CSV file.'); }
  if (!wb.worksheets.length) throw new HttpError(400, 'The workbook is empty.');
  return wb;
}
/* Which sheets to import and how. Header x-import-options =
   {"sheets":[{index, kind: players|games|teams|fixtures, headerRow, map:{field:col}, eventId, section, sportMap}]}.
   Without it: every sheet whose kind is recognised, with the automatic column mapping. */
const IMPORT_KINDS = ['players', 'games', 'teams', 'fixtures'];
function importPlan(wb, header, evs) {
  let opt = null;
  if (header) { try { opt = JSON.parse(header); } catch (e) { throw new HttpError(400, 'Bad import options'); } }
  const one = (ws, o) => {
    const auto = SheetImport.inspectSheet(ws, evs);
    const kind = IMPORT_KINDS.includes(o.kind) ? o.kind : auto.kind;
    if (kind !== 'players') {
      if (!IMPORT_KINDS.includes(kind)) return null;
      const k = SheetImport.sheetKind(ws);
      const kc = k.kind === kind ? k.cols : {};
      return { ws, kind, headerRow: k.kind === kind ? k.headerRow : auto.headerRow, cols: kc };
    }
    const map = {}, src = o.map && typeof o.map === 'object' ? o.map : auto.map;
    SheetImport.FIELD_KEYS.forEach((k) => { const c = Math.floor(Number(src[k])); if (c >= 1 && c <= 60) map[k] = c; });
    if (!map.name && !map.firstName) throw new HttpError(400, 'Sheet "' + ws.name + '": choose which column holds the player name.');
    const headerRow = Math.max(1, Math.min(50, Math.floor(Number(o.headerRow)) || auto.headerRow));
    const used = new Set(Object.values(map));
    const sportMap = {};
    if (o.sportMap && typeof o.sportMap === 'object') Object.entries(o.sportMap).slice(0, 20).forEach(([k, v]) => { if (/^[a-z]+\|(adults|kids)$/.test(k) && (v === 'skip' || evs.some((e) => e.id === v))) sportMap[k] = v; });
    return { ws, kind, headerRow, map, eventCols: auto.eventCols.filter((x) => !used.has(x.col)), sportCols: auto.sportCols.filter((x) => !used.has(x.col)), sportMap, eventId: evs.some((e) => e.id === o.eventId) ? o.eventId : '', section: ['adults', 'kids'].includes(o.section) ? o.section : '' };
  };
  const plan = (opt && Array.isArray(opt.sheets)
    ? opt.sheets.slice(0, 50).map((o) => { const ws = wb.worksheets[Number(o.index)]; if (!ws) throw new HttpError(400, 'Sheet not found'); return one(ws, o); })
    : wb.worksheets.map((ws) => one(ws, {}))).filter(Boolean);
  if (!plan.length) throw new HttpError(400, opt ? 'Choose at least one sheet to import.' : 'No sheet with players, games, teams or fixtures was found (a players sheet needs a "Name" column).');
  return plan;
}
/* Games, teams and fixtures sheets (players have their own, richer path in the import endpoint). Latest sheet wins. */
function importOthers(sheets, kind, errors, warnings, tid, evs) {
  const out = { rowsBySheet: {} }, nm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const playerByName = (name, section) => { const hits = db.players.filter((p) => p.status !== 'rejected' && (p.section || 'adults') === section && nm(p.name) === nm(name) && inRoster(tid, p.id)); return hits.length === 1 ? hits[0] : hits.length ? 'many' : null; };
  for (const sh of sheets) {
    const W = (row, name, error) => warnings.push({ sheet: sh.ws.name, row, name, error });
    const E = (row, name, error) => errors.push({ sheet: sh.ws.name, row, name, error });
    if (kind === 'games') {
      const rows = SheetImport.readGames(sh.ws, sh.headerRow, sh.cols); out.rowsBySheet[sh.ws.name] = rows.length;
      rows.forEach((g) => {
        if (evs.some((e) => nm(e.name) === nm(g.name) && (e.section || 'adults') === g.section)) { out.gamesExisting = (out.gamesExisting || 0) + 1; return; }
        const like = evs.find((e) => e.sport === g.sport && (e.section || 'adults') === g.section && e.sideType === g.sideType) || evs.find((e) => e.sport === g.sport);
        try {
          const ev = normEvent({ name: g.name, section: g.section, sport: g.sport, sideType: g.sideType, sideSize: g.sideType === 'team' ? 1 : g.sideSize, scoring: like ? like.scoring : g.sport === 'chess' ? 'result' : 'points',
            config: { ...(like ? like.config : {}), ...(g.bestOf ? { bestOf: g.bestOf } : {}), ...(g.target ? { target: g.target } : {}) }, participantIds: [], tid }, null);
          db.events.push(ev); evs.push(ev); out.gamesMade = (out.gamesMade || 0) + 1;
        } catch (e) { E(g.row, g.name, e.message); }
      });
    }
    if (kind === 'teams') {
      const rows = SheetImport.readTeams(sh.ws, sh.headerRow, sh.cols); out.rowsBySheet[sh.ws.name] = rows.length;
      rows.forEach((r) => {
        const teamEvs = r.games.map((g) => SheetImport.eventByName(g, evs, r.section || undefined)).filter(Boolean);
        r.games.filter((g) => !SheetImport.eventByName(g, evs)).forEach((g) => W(r.row, r.name, 'unknown game "' + g + '"'));
        const section = r.section || (teamEvs[0] && teamEvs[0].section) || 'adults';
        const ids = [];
        r.members.forEach((mn) => { const p = playerByName(mn, section); if (p === 'many') W(r.row, r.name, 'two players are called "' + mn + '" – add them in the app'); else if (!p) W(r.row, r.name, 'player "' + mn + '" is not registered for this event – put them in a Players sheet of the same file'); else if (!ids.includes(p.id)) ids.push(p.id); });
        let t = db.teams.find((x) => nm(x.name) === nm(r.name) && (x.section || 'adults') === section && x.tid === tid);
        if (t) { if (r.members.length) t.memberIds = ids; out.teamsUpdated = (out.teamsUpdated || 0) + 1; }
        else { t = COLS.teams({ name: r.name, section, memberIds: ids, tid }, null); db.teams.push(t); out.teamsCreated = (out.teamsCreated || 0) + 1; }
        teamEvs.forEach((e) => {
          if (e.sideType !== 'team') { W(r.row, r.name, e.name + ' is not a team game'); return; }
          if ((e.section || 'adults') !== section) { W(r.row, r.name, e.name + ' is in the other section'); return; }
          if (!e.participantIds.includes(t.id)) { e.participantIds.push(t.id); out.teamEntries = (out.teamEntries || 0) + 1; }
          e.interestedIds = (e.interestedIds || []).filter((id) => !ids.includes(id));   // placed in a team now
        });
      });
    }
    if (kind === 'fixtures') {
      const rows = SheetImport.readFixtures(sh.ws, sh.headerRow, sh.cols); out.rowsBySheet[sh.ws.name] = rows.length;
      rows.forEach((f) => {
        const label = f.sideA.join(' & ') + ' vs ' + f.sideB.join(' & ');
        const ev = SheetImport.eventByName(f.game, evs); if (!ev) { E(f.row, label, f.game ? 'unknown game "' + f.game + '"' : 'no game given'); return; }
        const sec = ev.section || 'adults', team = ev.sideType === 'team';
        const resolve = (names) => names.map((n) => {
          if (team) { const t = db.teams.filter((x) => (x.section || 'adults') === sec && x.tid === tid && nm(x.name) === nm(n)); if (t.length !== 1) throw new Error('team "' + n + '" not found'); return t[0].id; }
          const p = playerByName(n, sec); if (p === 'many') throw new Error('two players are called "' + n + '"'); if (!p) throw new Error('player "' + n + '" is not registered for this event'); return p.id;
        });
        try {
          const A = resolve(f.sideA), B = resolve(f.sideB);
          const key = (x) => [...x].sort().join(',');
          if (db.matches.some((m) => m.eventId === ev.id && m.stage === f.stage && (m.round || 0) === f.round && ((key(m.sideA) === key(A) && key(m.sideB) === key(B)) || (key(m.sideA) === key(B) && key(m.sideB) === key(A))))) { out.fixturesExisting = (out.fixturesExisting || 0) + 1; return; }
          [...A, ...B].forEach((id) => { if (!ev.participantIds.includes(id)) ev.participantIds.push(id); });
          const ref = f.referee ? db.referees.find((r) => nm(r.name) === nm(f.referee) && r.status !== 'pending') : null;
          if (f.referee && !ref) W(f.row, label, 'referee "' + f.referee + '" not found');
          const m = normMatch({ eventId: ev.id, sideA: A, sideB: B, stage: f.stage, round: f.round, group: f.group, startsAt: f.startsAt, time: f.time, court: f.court, refereeId: ref ? ref.id : '' }, null);
          const c = findClashes(m); if (c.length) W(f.row, label, 'time clash: ' + c[0]);
          db.matches.push(m); out.fixturesMade = (out.fixturesMade || 0) + 1;
        } catch (e) { E(f.row, label, e.message); }
      });
    }
  }
  return out;
}
/* New organizers / referees: typed names ("Ravi, Asha") or people picked from the player list ({ playerId }). */
function staffNames(x) {
  const list = Array.isArray(x) ? x : String(x || '').split(',');
  return list.map((v) => { if (v && typeof v === 'object') { const pl = v.playerId && find('players', String(v.playerId)); return { name: str(pl ? pl.name : v.name, 60).trim(), playerId: pl ? pl.id : '' }; } return { name: str(v, 60).trim(), playerId: '' }; })
    .filter((v) => v.name).slice(0, 10);
}
/* An event's organizers and referees: existing ones and/or new ones (created with a PIN, shown once). At least one of each. */
function tourStaff(b, pins, creator) {
  const orgIds = (Array.isArray(b.organizerIds) ? b.organizerIds : []).map(String).filter((id) => db.admins.some((a) => a.id === id));
  if (creator && creator.role === 'admin' && !orgIds.includes(creator.adminId)) orgIds.push(creator.adminId);
  const refIds = (Array.isArray(b.refereeIds) ? b.refereeIds : []).map(String).filter((id) => { const r = find('referees', id); return r && r.status !== 'pending'; });
  staffNames(b.newOrganizers).forEach((x) => { const a = newOrganizer(x.name, { sports: [], limited: true }); if (x.playerId) a.playerId = x.playerId; pins.push({ role: 'Organizer', name: a.name, pin: a._pin }); delete a._pin; orgIds.push(a.id); });
  staffNames(b.newReferees).forEach((x) => { const r = COLS.referees({ name: x.name, kind: 'referee' }, null); if (x.playerId) r.playerId = x.playerId; pins.push({ role: 'Referee', name: r.name, pin: r._plain }); delete r._plain; db.referees.push(r); refIds.push(r.id); });
  if (!orgIds.length) throw new HttpError(400, 'An event needs at least one organizer – choose one or add a new one.');
  if (!refIds.length) throw new HttpError(400, 'An event needs at least one referee – choose one or add a new one.');
  return { organizerIds: [...new Set(orgIds)], refereeIds: [...new Set(refIds)] };
}
/* One game (sub-event) of an event, with the usual rules for its sport. */
function makeGame(tid, g, staff) {
  const sport = SPORTS.includes(g.sport) ? g.sport : 'other', section = g.section === 'kids' ? 'kids' : 'adults', kind = ['singles', 'doubles', 'team'].includes(g.kind) ? g.kind : 'singles';
  const name = str(g.name, 80).trim() || ({ badminton: 'Badminton', tt: 'Table Tennis', carrom: 'Carrom', chess: 'Chess' }[sport] || 'Game') + (kind === 'doubles' ? ' – Doubles' : kind === 'team' ? ' – Team Event' : '') + (section === 'kids' ? ' (Kids)' : '');
  if (db.events.some((e) => e.tid === tid && e.name.toLowerCase() === name.toLowerCase() && (e.section || 'adults') === section)) throw new HttpError(409, 'Duplicate game');
  const like = db.events.find((e) => e.sport === sport && (e.section || 'adults') === section && (e.sideType === 'team') === (kind === 'team')) || [...seedEvents(), ...seedKidsEvents()].find((e) => e.sport === sport && e.section === section) || seedEvents().find((e) => e.sport === sport);
  const ev = normEvent({ name, sport, section, sideType: kind === 'team' ? 'team' : 'player', sideSize: kind === 'doubles' ? 2 : 1, scoring: like ? like.scoring : 'points', config: like ? like.config : {}, participantIds: [], tid, ...staff }, null);
  db.events.push(ev); return ev;
}
async function exportXlsx(admin, tid) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = db.tournament.name;
  const used = new Set(['matches', 'players']);
  const sheetName = (t) => { let base = t.replace(/[\\/*?:[\]]/g, '').slice(0, 28) || 'Game', n = base, i = 2; while (used.has(n.toLowerCase())) n = base.slice(0, 26) + ' ' + i++; used.add(n.toLowerCase()); return n; };
  for (const ev of db.events.filter((e) => !tid || e.tid === tid)) {
    const ws = wb.addWorksheet(sheetName((ev.section === 'kids' && !/^Kids/i.test(ev.name) ? 'Kids ' : '') + ev.name));
    ws.addRow([db.tournament.name + ' – ' + ev.name + (ev.section === 'kids' ? ' (Kids)' : '')]).font = { bold: true, size: 14 };
    ws.addRow([]);
    const hdr = ['Rank', ev.sideType === 'team' ? 'Team' : 'Player', 'Played', 'Won', 'Drawn', 'Lost', 'Points', 'Tally (scored)', 'Conceded', 'Point diff', 'Qualified'];
    const table = (rows) => { ws.addRow(hdr).font = { bold: true }; rows.forEach((r) => ws.addRow([r.rank, nameOf(ev, r.id), r.played, r.won, r.drawn, r.lost, r.mp, r.pf, r.pa, r.pd, r.qualified ? 'Yes' : ''])); };
    if (ev.format && ev.format.type === 'groups' && ev.groups) Engine.groupTables(ev, db.matches).forEach((t) => { ws.addRow(['Group ' + t.group]).font = { bold: true }; table(t.rows); ws.addRow([]); });
    else if (!(ev.format && ev.format.type === 'knockout')) table(Engine.standings(ev, db.matches));
    const pod = Engine.podium(ev, db.matches);
    if (pod) { ws.addRow([]); ws.addRow(['Champion', sideName(ev, pod.first)]).font = { bold: true }; ws.addRow(['Runner-up', sideName(ev, pod.second)]); if (pod.third.length) ws.addRow(['Third place', sideName(ev, pod.third)]); }
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 28 : 13; });
  }
  const wm = wb.addWorksheet('Matches');
  wm.addRow(['Event', 'Section', 'Stage', 'Group', 'Round', 'Court', 'Start', 'Side A', 'Side B', 'Status', 'Games', 'Winner']).font = { bold: true };
  db.matches.forEach((m) => {
    const ev = find('events', m.eventId); if (!ev) return;
    const d = Engine.derive(m, ev);
    wm.addRow([ev.name, ev.section, m.stage, m.group || '', m.round || '', m.court, m.startsAt ? m.startsAt.replace('T', ' ') : m.time, sideName(ev, m.sideA), sideName(ev, m.sideB), d.status, Engine.scoreText(d) + (d.rubbers ? ' [' + d.rubbers.filter((x) => x.status !== 'scheduled').map((x) => x.name + ': ' + Engine.scoreText(x)).join('; ') + ']' : ''), d.draw ? 'Draw' : d.winner ? sideName(ev, d.winner === 'A' ? m.sideA : m.sideB) : '']);
  });
  wm.columns.forEach((c) => { c.width = 22; });
  const wp = wb.addWorksheet('Players');
  wp.addRow(admin ? ['ID', 'Name', 'Section', 'Age group', 'Gender', 'Affiliation', 'Phone', 'Email', 'Emergency contact', 'T-shirt', 'Notes'] : ['ID', 'Name', 'Section', 'Age group', 'Gender']).font = { bold: true };
  db.players.forEach((p) => wp.addRow(admin ? [p.playerNo, p.name, p.section, p.ageGroup, p.gender, p.affiliation, p.phone, p.email, p.emergency, p.tshirt, p.notes] : [p.playerNo, p.name, p.section, p.ageGroup, p.gender]));
  wp.columns.forEach((c) => { c.width = 22; });
  return wb.xlsx.writeBuffer();
}

function buildUploads() {
  const out = {};
  for (const f of fs.readdirSync(UPLOAD_DIR)) if (/^[\w.-]+$/.test(f)) out[f] = fs.readFileSync(path.join(UPLOAD_DIR, f)).toString('base64');
  return out;
}

/* ------------------------------------------------------------ tournament formats */
const leagueOf = (ev) => db.matches.filter((x) => x.eventId === ev.id && (x.stage || 'League') === 'League');
const allDone = (ev, list) => list.length > 0 && list.every((x) => Engine.derive(x, ev).status === 'completed');
const activeIds = (ev) => ev.participantIds.filter((x) => !(ev.withdrawn || []).includes(x));
const rndUnit = () => crypto.randomInt(1e6) / 1e6;
const makeMatches = (ev, plan, extra) => plan.forEach((x, i) => db.matches.push(normMatch({ eventId: ev.id, ...x, ...(extra ? extra(i) : {}) }, null)));

/* Who goes into the knockout, best seed first. Groups: all group winners, then all runners-up, ... */
function finalistSeeds(ev) {
  if (ev.format.type === 'groups') {
    const tabs = Engine.groupTables(ev, db.matches), seeds = [];
    for (let k = 0; k < ev.format.qualifiers; k++) tabs.forEach((t) => { const r = t.rows[k]; if (r && r.played > 0) seeds.push(r.id); });
    return seeds;
  }
  return Engine.standings(ev, db.matches).filter((r) => r.played > 0).slice(0, Engine.finalistsFor(ev)).map((r) => r.id);
}

/* Finals / next knockout round. Doubles keep the original rule (1&4 v 2&3). */
function advanceEvent(ev, who, force) {
  if (ev.sideSize === 2) {
    const open = leagueOf(ev).filter((x) => Engine.derive(x, ev).status !== 'completed').length;
    if (open && !force) throw new HttpError(409, open + ' league match(es) are not finished yet.', { needForce: true });
    let plan; try { plan = Fx.finalsPlan(ev, Engine.standings(ev, db.matches), db.matches, Engine.derive); } catch (e) { throw new HttpError(400, e.message); }
    makeMatches(ev, plan); audit(who, 'created finals', ev.name + ': ' + plan.map((x) => x.stage).join(', '));
    return plan;
  }
  let fresh = false;
  if (!ev.bracket) {
    const league = leagueOf(ev), open = league.filter((x) => Engine.derive(x, ev).status !== 'completed').length;
    if (open && !force) throw new HttpError(409, open + ' league match(es) are not finished yet.', { needForce: true });
    const n = ev.format.type === 'groups' ? ev.format.groups * ev.format.qualifiers : Engine.finalistsFor(ev);
    const seeds = finalistSeeds(ev);
    if (n < 2) throw new HttpError(400, 'This event has no finals. Set the number of finalists in Edit event.');
    if (seeds.length < n) throw new HttpError(400, 'Not enough players have played to pick ' + n + ' finalists');
    ev.bracket = { order: Engine.bracketOrder(seeds) }; fresh = true;
  }
  let plan;
  try { plan = Fx.koPlan(ev, db.matches, Engine.bracket); } catch (e) { if (fresh) delete ev.bracket; throw new HttpError(400, e.message); }
  makeMatches(ev, plan);
  audit(who, 'created ' + plan.map((x) => x.stage).join(' + '), ev.name);
  return plan;
}

/* Next Swiss round: pairs players on similar scores who have not met; the lowest-ranked player without a bye sits out when odd. */
function swissNext(ev, o) {
  o = o || {};
  const ids = activeIds(ev);
  if (ev.sideSize !== 1) throw new HttpError(400, 'Swiss is for singles events');
  if (ids.length < 2) throw new HttpError(400, 'Enrol at least 2 players first');
  const league = leagueOf(ev);
  if (league.length && !allDone(ev, league)) throw new HttpError(409, 'Finish every match of the current round first.');
  const total = ev.format.swissRounds || Math.max(1, Math.ceil(Math.log2(ids.length)));
  const round = Math.max(0, ...league.map((m) => m.round || 0)) + 1;
  if (round > total) throw new HttpError(400, 'All ' + total + ' Swiss rounds have been played.');
  const played = new Set(league.map((m) => Fx.pairKey(m.sideA[0], m.sideB[0])));
  const r = Fx.swissPairs(ids, Engine.standings(ev, db.matches), played, new Set((ev.byes || []).map((x) => x.id)), rndUnit);
  if (r.bye) { ev.byes = ev.byes || []; ev.byes.push({ id: r.bye, round }); }
  const slots = Fx.assignSlots([r.pairs], o.courts || [], o.start || '', o.slot || 25)[0];
  r.pairs.forEach(([a, c], i) => db.matches.push(normMatch({ eventId: ev.id, stage: 'League', sideA: [a], sideB: [c], round, court: slots[i].court, startsAt: slots[i].startsAt }, null)));
  return { created: r.pairs.length, round, total, bye: r.bye, rematch: r.rematch };
}

/* Optional hands-free progress: when a round / league is finished, create what comes next. Never throws. */
function autoAdvance(ev, who) {
  if (!ev || !ev.format || !ev.format.autoAdvance) return;
  try {
    const t = ev.format.type, league = leagueOf(ev);
    if (ev.bracket) { const plan = Fx.koPlan(ev, db.matches, Engine.bracket); makeMatches(ev, plan); audit(who, 'auto-created', ev.name + ': ' + plan.map((x) => x.stage).join(' + ')); return; }
    if (t === 'knockout' || ev.sideSize === 2 || !allDone(ev, league)) return;
    if (t === 'swiss') {
      const total = ev.format.swissRounds || Math.max(1, Math.ceil(Math.log2(activeIds(ev).length)));
      if (Math.max(0, ...league.map((m) => m.round || 0)) < total) { const r = swissNext(ev); audit(who, 'auto-created', ev.name + ': Swiss round ' + r.round); return; }
      if (Engine.finalistsFor(ev) >= 2) advanceEvent(ev, who, false);
      return;
    }
    if (Engine.finalistsFor(ev) >= 2 || t === 'groups') advanceEvent(ev, who, false);
  } catch (e) { /* not ready (or nothing to do): the organizer can use the buttons */ }
}

async function route(req, res, url) {
  const p = url.pathname, m = req.method;
  const user = auth(req, url);
  let mt;

  if (p === '/healthz') return json(res, 200, { ok: true });
  const ip = clientIp(req);
  if (p.startsWith('/api/') && p !== '/api/stream') {
    if (user) limit('u:' + user.token, 1500, 60e3);
    else { limit('g:' + ip, 3000, 60e3); if (m !== 'GET') limit('w:' + ip, 90, 60e3, 'Too many requests from this network. Please wait a minute and try again.'); }
  }

  if (p === '/api/state' && m === 'GET') {
    if (user && user.role === 'admin') return json(res, 200, publicState('admin'));
    if (user && user.refId) return json(res, 200, publicState('staff'));
    const c = publicCache();
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ETag: c.etag, 'Cache-Control': 'no-cache' }); return res.end(); }
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    return res.end(gz ? c.gz : c.body);
  }

  if (p === '/api/stream' && m === 'GET') {
    const n = sseByIp.get(ip) || 0;
    if (n >= 250 || clients.size >= 4000) throw new HttpError(503, 'Too many live connections. Pull to refresh instead.');
    sseByIp.set(ip, n + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); const k = (sseByIp.get(ip) || 1) - 1; if (k > 0) sseByIp.set(ip, k); else sseByIp.delete(ip); });
    return;
  }

  if (p === '/api/qr.svg' && m === 'GET') {
    limit('q:' + ip, 120, 60e3);
    const text = str(url.searchParams.get('text'), 300);
    if (!text) throw new HttpError(400, 'Missing text');
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
    return res.end(svg);
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req, 5000);
    const ipK = 'ip:' + ip;
    const wait = lockedFor(ipK);
    if (wait) throw new HttpError(429, 'Too many wrong PINs from this network. Try again in ' + Math.ceil(wait / 60000) + ' min.');
    if (lockedFor('glob:' + (b.role === 'admin' ? 'admin' : str(b.refereeId || b.teamId, 20)))) throw new HttpError(429, 'Sign-in is temporarily paused after many failed attempts. Try again in a few minutes.');
    let sess;
    if (!b.role && !b.refereeId && !b.teamId) {   // one PIN per person
      const pin = String(b.pin || '');
      const fail = () => { recordFail(ipK, 8); recordFail('glob:pin', 60); throw new HttpError(401, 'Wrong PIN'); };
      if (lockedFor('glob:pin')) throw new HttpError(429, 'Sign-in is temporarily paused after many failed attempts. Try again in a few minutes.');
      if (!/^\d{4,10}$/.test(pin)) fail();
      const who = findByPin(pin); if (!who) fail();
      sess = sessionFor(who);
      if (!sess) throw new HttpError(403, 'Your referee sign-up is waiting for the organizer to approve it.');
    } else {
    const bad = () => { recordFail(ipK, 8); recordFail('glob:' + (b.role === 'admin' ? 'admin' : str(b.refereeId || b.teamId, 20)), b.role === 'admin' ? 25 : 5); throw new HttpError(401, 'Wrong PIN'); };
    if (b.role === 'captain') {
      const t = find('teams', b.teamId);
      if (!t || !t.captainHash || !checkPin(String(b.pin || ''), t.captainHash)) bad();
      sess = { role: 'captain', name: t.name, teamId: t.id, exp: Date.now() + 24 * 3600e3 };
    } else if (b.role === 'admin') {
      const a = db.admins.find((x) => checkPin(String(b.pin || ''), x.pinHash));
      if (!a) bad();
      sess = { role: 'admin', name: a.name, adminId: a.id, sports: a.sports || [], limited: !!a.limited, exp: Date.now() + 12 * 3600e3 };
    } else {
      const r = find('referees', b.refereeId);
      if (r && r.status === 'pending') throw new HttpError(403, 'Your referee sign-up is waiting for the organizer to approve it.');
      if (!r || !checkPin(String(b.pin || ''), r.pinHash)) bad();
      sess = { role: 'referee', name: r.name, refId: r.id, kind: r.kind || 'referee', personId: r.playerId || '', exp: Date.now() + 36 * 3600e3 };
    }
    }
    fails.delete(ipK);
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].exp && db.sessions[t].exp < Date.now()) delete db.sessions[t]; });
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = sess;
    audit(sess.name, 'login', sess.role);
    save();
    return json(res, 200, sessOut(token, sess));
  }
  if (p === '/api/me' && m === 'GET') {
    if (!user) return json(res, 200, { role: null });
    const pl = user.personId && find('players', user.personId);
    const mine = pl ? (({ pinHash, pinIdx: _i, editTokenHash, ...x }) => x)(pl) : null;
    return json(res, 200, { ...sessOut(user.token, user), token: undefined, profile: mine, hasPin: !!(pl && pl.pinHash) });
  }
  /* My profile: change my PIN, add my photo. */
  if (p === '/api/me/pin' && m === 'POST') {
    if (!user || !user.personId) throw new HttpError(401, 'Sign in first.');
    const pl = find('players', user.personId); if (!pl) throw new HttpError(404, 'Profile not found');
    if (lockedFor('ip:' + ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const pin = String((await readJson(req, 500)).pin || '');
    if (!/^\d{6,10}$/.test(pin)) throw new HttpError(400, 'Use 6 to 10 digits.');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new HttpError(400, 'That PIN is too easy to guess – choose another.');
    const other = findByPin(pin);
    if (other && !(other.kind === 'player' && other.rec === pl)) { recordFail('ip:' + ip, 8); throw new HttpError(400, 'Choose a different PIN.'); }   // counts like a wrong sign-in, so it cannot be used to guess PINs
    pl.pinHash = hashPin(pin); pl.pinIdx = pinIdx(pin);
    db.admins.forEach((a) => { if (a.playerId === pl.id) { a.pinHash = ''; a.pinIdx = ''; } });   // one PIN for everything
    db.referees.forEach((r) => { if (r.playerId === pl.id) { r.pinHash = ''; r.pinIdx = ''; } });
    audit(pl.name, 'changed own PIN'); save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me/photo' && m === 'POST') {
    if (!user || !user.personId) throw new HttpError(401, 'Sign in first.');
    const pl = find('players', user.personId); if (!pl) throw new HttpError(404, 'Profile not found');
    limit('ph:' + ip, 30, 3600e3);
    const buf = await readBody(req, 6e6), ext = EXT_BY_TYPE[String(req.headers['content-type'] || '')];
    if (!ext || !buf.length || !looksLike(buf, ext)) throw new HttpError(400, 'Upload a JPG, PNG or WEBP photo');
    const file = uid() + uid() + ext; fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    pl.photo = '/uploads/' + file; audit(pl.name, 'changed own photo'); save(); broadcast();
    return json(res, 200, { ok: true, photo: pl.photo });
  }
  if (p === '/api/logout' && m === 'POST') { if (user) { delete db.sessions[user.token]; save(); } return json(res, 200, { ok: true }); }

  /* ---- staff: scoring (batch of ops, idempotent) ---- */
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/ops$/)) && m === 'POST') {
    needScorer(user);
    const match = find('matches', mt[1]);
    if (!match) throw new HttpError(404, 'Match not found');
    assertOpen(match);
    const ev = find('events', match.eventId);
    checkRef(user, match);
    const b = await readJson(req);
    const myKey = user.role === 'admin' ? 'admin:' + (user.adminId || '') : 'ref:' + (user.refId || '');
    if (match.lock && match.lock.until > Date.now() && match.lock.key !== myKey && !b.force && Array.isArray(b.ops) && b.ops.length)
      throw new HttpError(409, match.lock.name + ' is scoring this match right now.', { locked: true, by: match.lock.name });
    const before = Engine.derive(match, ev);
    let changed = false, logged = 0;
    for (const op of (Array.isArray(b.ops) ? b.ops : []).slice(0, 500)) {
      if (Engine.applyOp(match, ev, op, user.name)) {
        changed = true;
        if (op.type !== 'point') logged++;
        if (op.type !== 'point') audit(user.name, op.type === 'undo' ? 'undo' : op.type === 'retire' ? 'retired: ' + (op.s === 'A' ? 'side A' : 'side B') + ' – opponent awarded the match' : op.type === 'board' ? 'carrom board to side ' + op.s : op.type === 'walkover' ? 'walkover to ' + op.s + (op.reason === 'dq' ? ' (disqualification)' : '') : 'result ' + op.result + (op.reason ? ' (' + op.reason + ')' : ''), '', match.id);
      }
    }
    const after = Engine.derive(match, ev);
    if (logged) { const d = Engine.scoreText(before) + ' → ' + Engine.scoreText(after); for (let i = 1; i <= logged; i++) { const e = db.audit[db.audit.length - i]; if (e && e.matchId === match.id) e.detail = d; } }
    if (!match.startedAt && after.points > 0) match.startedAt = Date.now();
    if (changed) { if (after.status === 'completed') delete match.lock; else match.lock = { key: myKey, name: user.name, until: Date.now() + 30e3 }; }
    if (changed && after.status === 'completed') autoAdvance(ev, user.name);
    save(); broadcast();
    if (changed) {
      const A = sideNamePub(ev, match.sideA), B = sideNamePub(ev, match.sideB);
      if (before.status === 'scheduled' && after.status !== 'scheduled') notify(match, 'Match started', A + ' vs ' + B + (match.court ? ' • ' + match.court : '')).catch(() => {});
      if (before.status !== 'completed' && after.status === 'completed') {
        const r2 = after.draw ? 'Draw' : sideNamePub(ev, after.winner === 'A' ? match.sideA : match.sideB) + ' won';
        notify(match, 'Full time: ' + A + ' vs ' + B, r2 + (after.games.length || after.tie ? ' (' + Engine.scoreText(after) + ')' : '')).catch(() => {});
      }
    }
    return json(res, 200, { ok: true, changed });
  }

  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/card$/)) && m === 'POST') {
    needScorer(user);
    const match = find('matches', mt[1]); if (!match) throw new HttpError(404, 'Match not found');
    assertOpen(match);
    const ev = find('events', match.eventId);
    checkRef(user, match);
    const b = await readJson(req, 2000), pid = String(b.playerId || ''), color = b.color === 'red' ? 'red' : b.color === 'yellow' ? 'yellow' : '';
    if (!color) throw new HttpError(400, 'Choose yellow or red');
    const inMatch = new Set([...match.sideA, ...match.sideB]);
    if (ev.sideType === 'team') [...match.sideA, ...match.sideB].forEach((tid) => ((find('teams', tid) || {}).memberIds || []).forEach((x) => inMatch.add(x)));
    if (!inMatch.has(pid)) throw new HttpError(400, 'That player is not in this match.');
    const pl = find('players', pid); if (!pl) throw new HttpError(404, 'Player not found');
    const card = { id: uid(), playerId: pid, color, matchId: match.id, by: user.name, reason: str(b.reason, 120), at: Date.now() };
    db.cards.push(card); if (db.cards.length > 5000) db.cards.shift();
    if (color === 'red') db.suspend[pid] = (db.suspend[pid] || 0) + 2;
    audit(user.name, color + ' card', pl.name + (card.reason ? ': ' + card.reason : ''), match.id);
    save(); broadcast();
    return json(res, 200, { ok: true, card: cardInfo(pid) });
  }
  if ((mt = p.match(/^\/api\/cards\/([\w-]+)\/revoke$/)) && m === 'POST') {
    needStaff(user); if (!(user.refId && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee can revoke a card.');
    const c = db.cards.find((x) => x.id === mt[1]); if (!c) throw new HttpError(404, 'Card not found');
    if (!c.revoked) { c.revoked = true; if (c.color === 'red') db.suspend[c.playerId] = Math.max(0, (db.suspend[c.playerId] || 0) - 2); audit(user.name, 'card revoked', ((find('players', c.playerId) || {}).name || '') + ' (' + c.color + ')', c.matchId); save(); broadcast(); }
    return json(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/paper$/)) && m === 'POST') {
    needScorer(user);
    const match = find('matches', mt[1]); if (!match) throw new HttpError(404, 'Match not found');
    assertOpen(match);
    checkRef(user, match);
    applyPaper(match, await readJson(req, 4000), user);
    if (Engine.derive(match, find('events', match.eventId)).status === 'completed') autoAdvance(find('events', match.eventId), user.name);
    save(); broadcast(); return json(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/paper\/sign$/)) && m === 'POST') {
    needStaff(user); if (!(user.refId && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee signs off paper scores.');
    const match = find('matches', mt[1]); if (!match || !match.paper) throw new HttpError(404, 'No paper score on this match');
    match.paper.signed = true; match.paper.signedBy = user.name; match.paper.signedAt = Date.now();
    audit(user.name, 'signed off paper score', '', match.id); save(); broadcast(); return json(res, 200, { ok: true });
  }
  if (p === '/api/staff/paper-template.xlsx' && m === 'GET') {
    needScorer(user);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Paper scores');
    ws.addRow(['Match ID (do not change)', 'Event', 'Side A', 'Side B', 'G1 A', 'G1 B', 'G2 A', 'G2 B', 'G3 A', 'G3 B', 'G4 A', 'G4 B', 'G5 A', 'G5 B', 'Result (A / B / draw – chess only)', 'Note']).font = { bold: true };
    db.matches.filter((x) => !x.rubbers && Engine.derive(x, find('events', x.eventId)).status !== 'completed').forEach((x) => { const ev = find('events', x.eventId); ws.addRow([x.id, ev.name, sideName(ev, x.sideA), sideName(ev, x.sideB)]); });
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 26 : i < 4 ? 24 : 8; });
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="paper-scores-template.xlsx"' });
    return res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  if (p === '/api/staff/paper-upload' && m === 'POST') {
    needScorer(user); limit('paper:' + ip, 30, 3600e3);
    const buf = await readBody(req, 3e6);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) { throw new HttpError(400, 'That does not look like an Excel (.xlsx) file.'); }
    const ws = wb.worksheets[0]; if (!ws) throw new HttpError(400, 'The workbook is empty.');
    const cell = (r, c) => { const v = r.getCell(c).value; return v && typeof v === 'object' && 'result' in v ? v.result : v; };
    let applied = 0; const errors = [];
    for (let i = 2; i <= Math.min(ws.rowCount, 500); i++) {
      const row = ws.getRow(i), id = String(cell(row, 1) || '').trim(); if (!id) continue;
      const match = find('matches', id);
      try {
        if (!match) throw new HttpError(404, 'Unknown match ID');
        assertOpen(match);
        const games = []; for (let g = 0; g < 5; g++) { const a = cell(row, 5 + g * 2), c = cell(row, 6 + g * 2); if (a !== null && a !== '' && c !== null && c !== '') games.push({ a, b: c }); }
        const res0 = String(cell(row, 15) || '').trim().toUpperCase();
        if (!games.length && !res0) continue;
        applyPaper(match, { games, result: res0 === 'DRAW' ? 'draw' : res0, note: str(cell(row, 16) || 'Excel upload', 120) }, user);
        if (Engine.derive(match, find('events', match.eventId)).status === 'completed') autoAdvance(find('events', match.eventId), user.name);
        applied++;
      } catch (e) { errors.push({ row: i, error: e.message }); }
    }
    if (applied) { save(); broadcast(); }
    return json(res, 200, { applied, errors });
  }
  if (p === '/api/staff/cards' && m === 'GET') {
    needStaff(user);
    const pid = url.searchParams.get('playerId');
    return json(res, 200, db.cards.filter((c) => !pid || c.playerId === pid).slice(-200).reverse().map((c) => ({ ...c, player: (find('players', c.playerId) || {}).name || '' })));
  }
  if (p === '/api/staff/flags' && m === 'GET') {
    needStaff(user); if (!(user.role === 'admin' || user.kind === 'chief')) throw new HttpError(403, 'Chief referee only.');
    return json(res, 200, db.disputes.slice().reverse().slice(0, 100).map((d) => (user.role === 'admin' ? d : { ...d, contact: '' })));
  }
  if ((mt = p.match(/^\/api\/staff\/flags\/([\w-]+)\/resolve$/)) && m === 'POST') {
    needStaff(user); if (!(user.role === 'admin' || user.kind === 'chief')) throw new HttpError(403, 'Chief referee only.');
    const d = db.disputes.find((x) => x.id === mt[1]); if (!d) throw new HttpError(404, 'Report not found');
    const b = await readJson(req, 2000);
    d.resolved = true; d.by = user.name; d.note = str(b.note, 140); d.resolvedAt = Date.now();
    audit(user.name, 'score report resolved', d.note, d.matchId); save(); broadcast();
    return json(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/lineup$/)) && m === 'POST') {
    needLineup(user);
    const match = find('matches', mt[1]); if (!match || !(match.rubbers || []).length) throw new HttpError(404, 'This match has no rubbers');
    const ev = find('events', match.eventId);
    checkRef(user, match);
    const b = await readJson(req, 20000);
    let capSide = '';
    if (user.role === 'captain') {
      capSide = match.sideA[0] === user.teamId ? 'A' : match.sideB[0] === user.teamId ? 'B' : '';
      if (!capSide) throw new HttpError(403, 'This is not your team’s tie.');
      if (tieStarted(match)) throw new HttpError(409, 'The tie has started; the line-up is locked. Ask the referee.');
    }
    const teamA = find('teams', match.sideA[0]) || { memberIds: [] }, teamB = find('teams', match.sideB[0]) || { memberIds: [] };
    const max = (ev.rubberRules && ev.rubberRules.maxPerPlayer) || 2;
    const next = new Map();
    for (const it of Array.isArray(b.rubbers) ? b.rubbers : []) {
      const r = match.rubbers.find((x) => x.id === it.id); if (!r) continue;
      const started = r.log.length || r.result || r.walkover;
      if (capSide) { it.sideA = capSide === 'A' ? it.sideA : undefined; it.sideB = capSide === 'B' ? it.sideB : undefined; }
      if (started && user.role !== 'admin') throw new HttpError(409, r.name + ' has already started; ask an admin to change its players.');
      const size = r.size === 2 ? 2 : 1;
      const A = [...new Set((it.sideA === undefined && capSide ? r.sideA : (it.sideA || [])).map(String))], B = [...new Set((it.sideB === undefined && capSide ? r.sideB : (it.sideB || [])).map(String))];
      if ((A.length && A.length !== size) || (B.length && B.length !== size)) throw new HttpError(400, r.name + ' needs ' + size + ' player' + (size > 1 ? 's' : '') + ' per side');
      const chk = (ids, team) => ids.forEach((id) => {
        if (!team.memberIds.includes(id)) throw new HttpError(400, ((find('players', id) || {}).name || 'That player') + ' is not in ' + (team.name || 'the team'));
        const pl = find('players', id);
        if ((db.suspend[id] || 0) > 0) throw new HttpError(400, ((pl || {}).name || 'That player') + ' is suspended for ' + db.suspend[id] + ' more game(s) and cannot be in a line-up');
        if (r.gender && pl && pl.gender && pl.gender !== r.gender) throw new HttpError(400, pl.name + ' cannot play ' + r.name + ' (' + (r.gender === 'F' ? 'women' : 'men') + ' only)');
      });
      chk(A, teamA); chk(B, teamB);
      next.set(r.id, { A: capSide === 'B' ? r.sideA : A, B: capSide === 'A' ? r.sideB : B });
    }
    const cnt = new Map();
    match.rubbers.forEach((r) => { const n = next.get(r.id) || { A: r.sideA, B: r.sideB }; [...n.A, ...n.B].forEach((id) => cnt.set(id, (cnt.get(id) || 0) + 1)); });
    for (const [id, c] of cnt) if (c > max) throw new HttpError(400, ((find('players', id) || {}).name || 'A player') + ' is in ' + c + ' rubbers; the limit is ' + max + ' per tie');
    match.rubbers.forEach((r) => { const n = next.get(r.id); if (n) { r.sideA = n.A; r.sideB = n.B; } });
    match.lineupA = [...new Set(match.rubbers.flatMap((r) => r.sideA))]; match.lineupB = [...new Set(match.rubbers.flatMap((r) => r.sideB))];
    audit(user.name, 'set line-up', '', match.id); save(); broadcast();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/captain/ties' && m === 'GET') {
    if (!user) throw new HttpError(401, 'Please sign in'); if (user.role !== 'captain') throw new HttpError(403, 'Captains only');
    const t = find('teams', user.teamId); if (!t) throw new HttpError(404, 'Team not found');
    const ties = db.matches.filter((x) => x.rubbers && x.rubbers.length && (x.sideA[0] === t.id || x.sideB[0] === t.id)).map(({ cids, lock, ...x }) => {
      const mine = x.sideA[0] === t.id ? 'A' : 'B', ev = find('events', x.eventId) || {};
      const out = !tieRevealed(x) ? { ...hideLineups(x), rubbers: x.rubbers.map((r) => ({ ...r, sideA: mine === 'A' ? r.sideA : [], sideB: mine === 'B' ? r.sideB : [] })) } : x;
      return { ...out, mine, eventName: ev.name, maxPerPlayer: (ev.rubberRules && ev.rubberRules.maxPerPlayer) || 2, locked: tieStarted(x) };
    });
    return json(res, 200, { team: { id: t.id, name: t.name, memberIds: t.memberIds, captainId: t.captainId }, members: t.memberIds.map((id) => { const p = find('players', id) || {}; return { id, name: p.name, gender: p.gender, suspended: (db.suspend[id] || 0) > 0 }; }), ties });
  }
  if ((mt = p.match(/^\/api\/admin\/teams\/([\w-]+)\/captain-code$/)) && m === 'POST') {
    needAdmin(user);
    const t = find('teams', mt[1]); if (!t) throw new HttpError(404, 'Team not found');
    const b = await readJson(req, 1000);
    if (b.playerId !== undefined) { if (b.playerId && !t.memberIds.includes(String(b.playerId))) throw new HttpError(400, 'The captain must be a member of the team'); t.captainId = String(b.playerId || ''); }
    let code; do { code = pinN(6); } while (db.teams.some((x) => x.captainHash && checkPin(code, x.captainHash)));
    t.captainHash = hashPin(code);
    Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].teamId === t.id) delete db.sessions[k]; });
    audit(user.name, 'captain code issued', t.name); save(); broadcast();
    return json(res, 200, { code, team: t.name });
  }
  if (p === '/api/upload' && m === 'POST') {
    needStaff(user);
    const buf = await readBody(req, 6e6);
    const ext = EXT_BY_TYPE[String(req.headers['content-type'] || '')];
    if (!ext || !buf.length || !looksLike(buf, ext)) throw new HttpError(400, 'Upload a JPG, PNG or WEBP image');
    const file = uid() + uid() + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    return json(res, 200, { url: '/uploads/' + file });
  }
  /* Anyone with the link can add photos or videos to the gallery. Organizers can remove anything; the uploader can remove their own. */
  if (p === '/api/gallery/media' && m === 'POST') {
    limit('gal:' + ip, 80, 3600e3, 'Too many uploads from this network – please try again in an hour.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const img = EXT_BY_TYPE[type], vid = VIDEO_EXT[type];
    if (!img && !vid) throw new HttpError(400, 'Upload a photo (JPG, PNG, WEBP) or a video (MP4, MOV, WEBM).');
    if (db.gallery.length >= 1500) throw new HttpError(400, 'The gallery is full. Ask the organizers to make room.');
    const ext = img || vid, name = uid() + uid() + ext, file = path.join(UPLOAD_DIR, name), tmp = file + '.part';
    const size = await readBodyToFile(req, tmp, vid ? 200e6 : 12e6);
    const head = Buffer.alloc(16); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (!size || !(img ? looksLike(head, ext) : looksLikeVideo(head, ext))) { fs.unlink(tmp, () => {}); throw new HttpError(400, 'That file is not a real ' + (img ? 'photo' : 'video') + '.'); }
    fs.renameSync(tmp, file);
    const key = crypto.randomBytes(12).toString('hex');
    const by = user ? user.name : str(url.searchParams.get('by'), 40).trim() || 'Guest';
    const item = { id: uid(), url: '/uploads/' + name, type: vid ? 'video' : 'image', size, caption: str(url.searchParams.get('caption'), 120), by, ts: Date.now(), minors: url.searchParams.get('minors') === '1', delHash: sha(key) };
    db.gallery.unshift(item); save(); broadcast();
    return json(res, 200, { ok: true, id: item.id, deleteKey: key });
  }
  if ((mt = p.match(/^\/api\/gallery\/([\w-]+)$/)) && m === 'DELETE') {
    const g = db.gallery.find((x) => x.id === mt[1]); if (!g) throw new HttpError(404, 'Not found');
    const key = String(req.headers['x-delete-key'] || '');
    if (!(user && user.role === 'admin') && !(g.delHash && key && safeEq(sha(key), g.delHash))) throw new HttpError(403, 'Only the person who added it, or an organizer, can remove it.');
    db.gallery = db.gallery.filter((x) => x !== g); save(); broadcast();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/gallery' && m === 'POST') {
    needStaff(user);
    const b = await readJson(req);
    if (!/^\/uploads\/[\w.-]+$/.test(b.url || '')) throw new HttpError(400, 'Bad image');
    if (db.gallery.length >= 400) throw new HttpError(400, 'Gallery is full (400 photos)');
    db.gallery.unshift({ id: uid(), url: b.url, caption: str(b.caption, 120), by: user.name, ts: Date.now(), minors: !!b.minors });
    save(); broadcast();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/push/subscribe' && m === 'POST') {
    limit('ps:' + ip, 400, 3600e3);
    const b = await readJson(req, 8000); const s = b.subscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 600 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') throw new HttpError(400, 'Bad subscription');
    if (db.subs.length >= 5000 && !db.subs.some((x) => x.endpoint === s.endpoint)) throw new HttpError(503, 'Notification list is full');
    db.subs = db.subs.filter((x) => x.endpoint !== s.endpoint);
    db.subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) }, follow: Array.isArray(b.follow) ? b.follow.map(String).slice(0, 20) : [] });
    save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const b = await readJson(req);
    db.subs = db.subs.filter((x) => x.endpoint !== b.endpoint); save();
    return json(res, 200, { ok: true });
  }

  /* ---- public: registration (needs admin approval), self-service edit link, score disputes ---- */
  if (p === '/api/referee-signup' && m === 'POST') {
    limit('refsign:' + ip, 10, 3600e3, 'Too many sign-ups from this network. Please try again later.');
    const b = await readJson(req, 4000);
    if (b.website) return json(res, 200, { ok: true });          /* honeypot */
    if (!db.tournament.refSignupOpen) throw new HttpError(403, 'Referee sign-up is closed. Please contact the organizers.');
    if (db.referees.filter((x) => x.status === 'pending').length >= 100) throw new HttpError(503, 'Too many sign-ups are waiting. Please contact the organizers.');
    const name = str(b.name, 60).trim(); if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
    const phone = str(b.phone, 30).trim(); if (!/\d{6,}/.test(phone.replace(/\D/g, ''))) throw new HttpError(400, 'Please enter a phone number so the organizers can reach you.');
    if (db.referees.some((x) => x.name.toLowerCase() === name.toLowerCase() && String(x.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''))) throw new HttpError(409, 'You have already signed up.');
    const r = { id: uid(), name, kind: 'referee', sports: (Array.isArray(b.sports) ? b.sports : []).filter((x) => SPORTS.includes(x)).slice(0, 5), eventIds: [], status: 'pending', phone, note: str(b.note, 200), signedUpAt: Date.now(), pinHash: '' };
    db.referees.push(r); audit(name, 'referee sign-up', r.sports.join(', ')); save(); broadcast();
    return json(res, 200, { ok: true });
  }
  /* ---- events: anyone signed in (organizer or referee) may create one and set its organizers and referees ---- */
  if (p === '/api/staff/friendly' && m === 'POST') {
    if (!isStaffU(user)) throw new HttpError(401, 'Sign in to start a match.');
    const b = await readJson(req, 4000);
    const sport = SPORTS.includes(b.sport) ? b.sport : 'other', kind = b.kind === 'doubles' ? 'doubles' : 'singles', n = kind === 'doubles' ? 2 : 1;
    const A = (b.sideA || []).map(String), B = (b.sideB || []).map(String);
    const people = [...A, ...B].map((id) => find('players', id));
    if (A.length !== n || B.length !== n || people.some((x) => !x)) throw new HttpError(400, 'Choose ' + n + ' player' + (n > 1 ? 's' : '') + ' for each side.');
    const section = people.every((x) => x.section === 'kids') ? 'kids' : 'adults';
    if (people.some((x) => (x.section || 'adults') !== section)) throw new HttpError(400, 'Adults and kids cannot play in the same friendly match.');
    const name = ({ badminton: 'Badminton', tt: 'Table Tennis', carrom: 'Carrom', chess: 'Chess' }[sport] || 'Game') + (kind === 'doubles' ? ' – Doubles' : '') + (section === 'kids' ? ' (Kids)' : '') + ' – Friendly';
    let ev = db.events.find((e) => e.tid === 'friendly' && e.name === name);
    if (!ev) {
      const like = [...seedEvents(), ...seedKidsEvents()].find((e) => e.sport === sport && e.section === section) || seedEvents().find((e) => e.sport === sport);
      ev = normEvent({ name, sport, section, sideType: 'player', sideSize: n, scoring: like ? like.scoring : 'points', config: { ...(like ? like.config : {}), finalists: 0 }, participantIds: [], tid: 'friendly', selfRegister: false }, null);
      db.events.push(ev);
    }
    [...A, ...B].forEach((id) => { if (!ev.participantIds.includes(id)) ev.participantIds.push(id); });
    const mt0 = normMatch({ eventId: ev.id, stage: 'Play-off', sideA: A, sideB: B, court: str(b.court, 30), refereeId: user.refId && !(user.personId && [...A, ...B].includes(user.personId)) ? user.refId : '' }, null);
    db.matches.push(mt0); audit(user.name, 'friendly match', ev.name); save(); broadcast();
    return json(res, 200, mt0);
  }
  if (p === '/api/staff/tournaments' && m === 'POST') {
    if (!isStaffU(user)) throw new HttpError(401, 'Sign in with your PIN (organizer or referee) to create an event.');
    const b = await readJson(req, 60000);
    const name = str(b.name, 80).trim(); if (name.length < 3) throw new HttpError(400, 'Give the event a name.');
    if (db.tournaments.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'An event called "' + name + '" already exists.');
    if (db.tournaments.length >= 100) throw new HttpError(400, 'Too many events – close or archive old ones first.');
    const pins = [], staff = tourStaff(b, pins, user);
    const T = newTour({ name, dates: str(b.dates, 60), venue: str(b.venue, 120), createdBy: user.name, ...staff });
    db.tournaments.push(T);
    const src = b.copyFrom && tour(String(b.copyFrom));
    const games = src ? db.events.filter((e) => e.tid === src.id).map((e) => ({ copy: e })) : (Array.isArray(b.games) ? b.games : []).slice(0, 40);
    const made = [];
    games.forEach((g) => {
      try {
        if (g.copy) { const c = JSON.parse(JSON.stringify(g.copy)); Object.assign(c, { id: uid(), tid: T.id, participantIds: [], withdrawn: [], interestedIds: [], organizerIds: staff.organizerIds, refereeIds: staff.refereeIds }); delete c.frozenCount; delete c.groups; delete c.bracket; delete c.byes; db.events.push(c); made.push(c); return; }
        made.push(makeGame(T.id, g, staff));
      } catch (e) { /* skip a bad row, the rest is created */ }
    });
    audit(user.name, 'created event', name + ' (' + made.length + ' games)'); save(); broadcast();
    return json(res, 200, { tournament: T, games: made.length, pins });
  }
  if ((mt = p.match(/^\/api\/staff\/tournaments\/([\w-]+)$/)) && m === 'PUT') {
    const T = tour(mt[1]); if (!T) throw new HttpError(404, 'Event not found');
    if (!canTour(user, T.id)) throw new HttpError(403, 'Only this event’s organizers can change it.');
    const b = await readJson(req, 60000), pins = [];
    if (b.name != null) { const n = str(b.name, 80).trim(); if (n.length < 3) throw new HttpError(400, 'Give the event a name.'); if (db.tournaments.some((x) => x !== T && x.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'Another event has that name.'); T.name = n; }
    if (b.dates != null) T.dates = str(b.dates, 60);
    if (b.venue != null) T.venue = str(b.venue, 120);
    if (b.status === 'closed' || b.status === 'open') T.status = b.status;
    if (b.organizerIds || b.refereeIds || b.newOrganizers || b.newReferees) Object.assign(T, tourStaff({ organizerIds: b.organizerIds || T.organizerIds, refereeIds: b.refereeIds || T.refereeIds, newOrganizers: b.newOrganizers, newReferees: b.newReferees }, pins, null));
    if (T.kind === 'friendly') T.status = 'open';
    if (!db.tournaments.some((x) => x.status !== 'closed' && x.kind !== 'friendly')) { T.status = 'open'; throw new HttpError(400, 'At least one event must stay open.'); }
    audit(user.name, 'edited event', T.name); save(); broadcast();
    return json(res, 200, { tournament: T, pins });
  }
  if (p === '/api/register' && m === 'POST') {
    limit('reg:' + ip, 150, 3600e3, 'Too many registrations from this network. Please try again later.');
    const b = await readJson(req, 20000);
    if (b.website) return json(res, 200, { ok: true });          /* honeypot: bots fill hidden fields */
    const regTid = tidOf(b.tid);
    if (!regOpen(regTid)) throw new HttpError(403, 'Registration is closed.');
    const r = tour(regTid).reg;
    if (lockedFor('code:' + ip)) throw new HttpError(429, 'Too many wrong join codes. Try again later.');
    if (r.joinCode && !safeEq(String(b.code || '').trim().toLowerCase(), r.joinCode.toLowerCase())) { recordFail('code:' + ip, 10); throw new HttpError(403, 'That join code is not correct.'); }
    if (db.players.filter((x) => x.status === 'pending').length >= 500) throw new HttpError(503, 'The registration queue is full. Please contact the organisers.');
    const section = b.section === 'kids' ? 'kids' : 'adults';
    const name = str(b.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Please enter the full name.');
    if (!b.consent) throw new HttpError(400, 'Please tick the consent box to continue.');
    const phone = str(b.phone, 30), email = str(b.email, 80);
    if (!phone && !email) throw new HttpError(400, 'Please give a phone number or an email so the organisers can reach you.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address does not look right.');
    let guardianName = '', guardianPhone = '';
    if (section === 'kids') {
      guardianName = str(b.guardianName, 60); guardianPhone = str(b.guardianPhone, 30);
      if (!guardianName || !guardianPhone) throw new HttpError(400, 'A parent/guardian name and phone number are required for children.');
      if (!str(b.ageGroup, 20)) throw new HttpError(400, 'Please enter the child’s age or age group.');
    }
    const ids = [...new Set((Array.isArray(b.eventIds) ? b.eventIds : []).map(String))].slice(0, 10);
    if (!ids.length) throw new HttpError(400, 'Choose at least one event.');
    for (const id of ids) {
      const ev = find('events', id);
      if (!ev || ev.selfRegister === false || ev.tid !== regTid) throw new HttpError(400, 'One of the chosen games is not open for registration in ' + tour(regTid).name + '.');
      if ((ev.section || 'adults') !== section) throw new HttpError(400, ev.name + ' is not in the ' + (section === 'kids' ? 'Kids' : 'Adults') + ' section.');
      if (ev.maxParticipants > 0 && requestedCount(ev) >= ev.maxParticipants) throw new HttpError(409, ev.name + ' is full.');
      if (section === 'kids' && !ageOk(ev, { ageGroup: b.ageGroup })) throw new HttpError(400, ev.name + ' is for ' + ageText(ev) + '. Please pick the event for your age.');
    }
    const digits = (x) => String(x || '').replace(/\D/g, '');
    const dobIn = /^\d{4}-\d{2}-\d{2}$/.test(str(b.dob, 10)) ? str(b.dob, 10) : '';
    /* Only an identical name + date of birth in the same event is refused outright. Everything else is flagged for the organizer (siblings share phones). */
    const sameEvent = (x) => ids.some((i) => (x.requestedEventIds || []).includes(i) || ((find('events', i) || { participantIds: [] }).participantIds.includes(x.id) || ((find('events', i) || {}).interestedIds || []).includes(x.id)));
    if (dobIn && db.players.some((x) => x.status !== 'rejected' && x.dob === dobIn && x.name.toLowerCase() === name.toLowerCase() && sameEvent(x)))
      throw new HttpError(409, 'This person is already registered for that event. If that is you, use your edit link or contact the organisers.');
    const sportsIn = {}; (b.sports && typeof b.sports === 'object' ? Object.keys(b.sports) : []).forEach((k) => { if (SPORTS.includes(k)) sportsIn[k] = b.sports[k]; });
    const pl = COLS.players({ name, section, ageGroup: str(b.ageGroup, 20), gender: b.gender, phone, email, affiliation: b.affiliation, hand: b.hand, emergency: b.emergency, tshirt: b.tshirt, sports: sportsIn, guardianName, guardianPhone, profilePublic: section !== 'kids' }, null);
    const tok = crypto.randomBytes(18).toString('hex');
    pl.dob = dobIn; pl.dupOf = dupCandidates(pl);
    Object.assign(pl, { status: 'pending', requestTid: regTid, requestedEventIds: ids, registeredAt: Date.now(), consentAt: Date.now(), editTokenHash: sha(tok) });
    db.players.push(pl);
    audit('Registration', 'registered', name + ' (' + section + ')');
    save(); broadcast();
    const firstPin = givePin(pl); save();
    return json(res, 200, { ok: true, id: pl.id, playerNo: pl.playerNo, editToken: tok, status: 'pending', pin: firstPin });
  }

  let sm;
  if ((sm = p.match(/^\/api\/self\/([\w-]+)(\/photo|\/push|\/games)?$/))) {
    if (lockedFor('self:' + ip)) throw new HttpError(429, 'Too many wrong attempts. Try again later.');
    const pl = find('players', sm[1]); const tok = String(req.headers['x-edit-token'] || '');
    if (!pl || !pl.editTokenHash || !safeEq(sha(tok), pl.editTokenHash)) { recordFail('self:' + ip, 20); throw new HttpError(403, 'This edit link is not valid.'); }
    const mine = () => { const { editTokenHash, notes, ...rest } = pl; return { ...rest, gameIds: [...new Set([...(pl.requestedEventIds || []), ...db.events.filter((e) => e.participantIds.includes(pl.id) || (e.interestedIds || []).includes(pl.id)).map((e) => e.id)])], requestedEvents: (pl.requestedEventIds || []).map((i) => (find('events', i) || {}).name).filter(Boolean), enrolled: db.events.filter((e) => e.participantIds.includes(pl.id)).map((e) => e.name) }; };
    if (sm[2] === '/push' && m === 'POST' && (req.headers['x-push-status'] || '')) {
      const v = String(req.headers['x-push-status']); pl.pushStatus = ['off', 'unsupported', 'later'].includes(v) ? v : 'unknown'; save(); return json(res, 200, { ok: true });
    }
    if (sm[2] === '/push' && m === 'POST') {
      limit('selfpush:' + ip, 60, 3600e3);
      const b = await readJson(req, 8000); const sb = b.subscription;
      if (!sb || typeof sb.endpoint !== 'string' || !/^https:\/\//.test(sb.endpoint) || sb.endpoint.length > 600 || !sb.keys || typeof sb.keys.p256dh !== 'string' || typeof sb.keys.auth !== 'string') throw new HttpError(400, 'Bad subscription');
      if (db.subs.length >= 5000 && !db.subs.some((x) => x.endpoint === sb.endpoint)) throw new HttpError(503, 'Notification list is full');
      const old = db.subs.find((x) => x.endpoint === sb.endpoint);
      db.subs = db.subs.filter((x) => x.endpoint !== sb.endpoint);
      db.subs.push({ endpoint: sb.endpoint, keys: { p256dh: sb.keys.p256dh.slice(0, 200), auth: sb.keys.auth.slice(0, 100) }, follow: old ? old.follow : [], playerId: pl.id, ...(old ? {} : { approvalOnly: true }) });
      pl.pushStatus = 'on'; save(); return json(res, 200, { ok: true });
    }
    if (sm[2] === '/games' && m === 'PUT') {
      limit('selfgames:' + ip, 120, 3600e3);
      if (!regOpen() && pl.status !== 'pending') throw new HttpError(403, 'Registration is closed. Ask the organizers to change your games.');
      const b = await readJson(req, 3000);
      const r = setGames(pl, b.eventIds, false); audit('Player ' + pl.playerNo, 'changed own games', pl.name);
      save(); broadcast(); return json(res, 200, { ok: true, ...r, ...mine() });
    }
    if (sm[2] === '/photo' && m === 'POST') {
      limit('selfup:' + ip, 80, 3600e3, 'Too many uploads. Try again later.');
      const buf = await readBody(req, 3e6); const ext = EXT_BY_TYPE[String(req.headers['content-type'] || '')];
      if (!ext || !buf.length || !looksLike(buf, ext)) throw new HttpError(400, 'Upload a JPG, PNG or WEBP image');
      const file = uid() + uid() + ext; fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
      return json(res, 200, { url: '/uploads/' + file });
    }
    if (m === 'GET') return json(res, 200, mine());
    if (m === 'PUT') {
      limit('selfput:' + ip, 300, 3600e3);
      const b = await readJson(req, 20000);
      const allowed = ['bio', 'hand', 'affiliation', 'sports', 'achievements', 'phone', 'email', 'emergency', 'tshirt', 'photo', 'profilePublic', 'guardianName', 'guardianPhone', 'ageGroup'];
      const body = {}; allowed.forEach((k) => { if (b[k] !== undefined) body[k] = b[k]; });
      if (pl.status === 'pending' && b.name) body.name = b.name;
      if (body.photo && !/^\/uploads\/[\w.-]+$/.test(body.photo)) throw new HttpError(400, 'Bad photo');
      if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) throw new HttpError(400, 'That email address does not look right.');
      const item = COLS.players({ ...body, section: pl.section }, pl);
      db.players[db.players.indexOf(pl)] = item;
      audit('Player ' + item.playerNo, 'edited own profile', item.name);
      save(); broadcast(); return json(res, 200, (() => { const { editTokenHash, notes, ...rest } = item; return rest; })());
    }
  }

  if (p === '/api/disputes' && m === 'POST') {
    limit('disp:' + ip, 40, 3600e3, 'Too many reports from this network. Please try again later.');
    const b = await readJson(req, 5000);
    const match = find('matches', b.matchId); if (!match) throw new HttpError(404, 'Match not found');
    const text = str(b.text, 300); if (text.length < 5) throw new HttpError(400, 'Please describe the problem (a few words).');
    if (db.disputes.length >= 300) throw new HttpError(503, 'Too many open reports.');
    db.disputes.push({ id: uid(), matchId: match.id, text, name: str(b.name, 40), contact: str(b.contact, 60), at: Date.now(), resolved: false });
    save(); broadcast();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/export.xlsx' && m === 'GET') {
    limit('x:' + ip, 20, 60e3);
    let adminXl = !!(user && user.role === 'admin');
    const dl = url.searchParams.get('dl');
    if (!dl && !isStaffU(user)) throw new HttpError(403, 'Reports can be downloaded by organizers and referees only.');
    if (dl) {
      const e = dlTokens.get(dl); dlTokens.delete(dl);
      if (!e || e.exp < Date.now()) throw new HttpError(403, 'That download link has expired. Create a new one.');
      adminXl = true;
    }
    const buf = await exportXlsx(adminXl, tour(url.searchParams.get('tid')) ? url.searchParams.get('tid') : '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="tournament-results.xlsx"' });
    return res.end(Buffer.from(buf));
  }

  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    const chiefPath = /^\/api\/admin\/matches\/[\w-]+\/(scores|reset)$/.test(p);
    if (chiefPath) { needStaff(user); if (!(user.refId && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee corrects or resets scores.'); } else needAdmin(user);
    let mm;
    if (isLead(user)) {
      if (/^\/api\/admin\/(admins|pin|tournament(?!s)|revoke-sessions|purge|backup|restore|new-tournament|trash|registration|export-link|secrets|shift|panic|snapshots|rollback|import-|reachability)/.test(p)
        && !(/^\/api\/admin\/(registration|import-)/.test(p) && tourOrg(user, url.searchParams.get('tid')))) throw new HttpError(403, 'This is for the organizer only. Sport leads manage their own sport.');
      let ge = null; const em = p.match(/^\/api\/admin\/events\/([\w-]+)/), mtc = p.match(/^\/api\/admin\/matches\/([\w-]+)/);
      if (em) ge = find('events', em[1]); else if (mtc) { const x = find('matches', mtc[1]); ge = x && find('events', x.eventId); }
      if ((em || mtc) && !sportOk(user, ge)) throw new HttpError(403, 'That event belongs to another sport.');
      if (/^\/api\/admin\/(referees|sponsors)/.test(p) && m !== 'GET') throw new HttpError(403, 'Only the organizer manages referees and sponsors.');
    }
    if (p === '/api/admin/secrets' && m === 'GET') return json(res, 200, { subscribers: db.subs.length });
    if (p === '/api/admin/audit' && m === 'GET') {
      const id = url.searchParams.get('matchId');
      return json(res, 200, db.audit.filter((a) => !id || a.matchId === id).slice(-100).reverse());
    }
    if (p === '/api/admin/tournament' && m === 'POST') {
      const b = await readJson(req); const t = db.tournament;
      ['name', 'tagline', 'dates', 'venue'].forEach((k) => { if (b[k] != null) t[k] = str(b[k], 120); });
      if (b.logo != null) t.logo = str(b.logo, 200);
      if (/^#[0-9a-fA-F]{6}$/.test(b.primary || '')) t.primary = b.primary;
      if (b.showKidsPhotos != null) t.showKidsPhotos = !!b.showKidsPhotos;
      if (b.enforceReferee != null) t.enforceReferee = !!b.enforceReferee;
      if (b.refSignupOpen != null) t.refSignupOpen = !!b.refSignupOpen;
      if (b.seasonName != null && str(b.seasonName, 80).trim()) t.seasonName = str(b.seasonName, 80).trim();
      if (b.rankPts && typeof b.rankPts === 'object') { t.rankPts = {}; Object.keys(Engine.RANK_POINTS).forEach((k) => { t.rankPts[k] = Math.max(0, Math.min(100, Math.round(num(b.rankPts[k], Engine.RANK_POINTS[k])))); }); }
      if (b.tz != null) { try { new Intl.DateTimeFormat('en-GB', { timeZone: String(b.tz) }); t.tz = String(b.tz); } catch (e) { throw new HttpError(400, 'Unknown time zone (use a name like Asia/Kolkata)'); } }
      if (b.sponsorSeconds != null) t.sponsorSeconds = Math.max(3, Math.min(60, Math.round(num(b.sponsorSeconds, 8))));
      if (Array.isArray(b.signers)) t.signers = b.signers.slice(0, 3).map((s) => ({ name: str(s.name, 60), title: str(s.title, 60), image: /^\/uploads\/[\w.-]+$/.test(s.image || '') ? s.image : '' }));
      audit(user.name, 'settings', 'tournament details'); save(); broadcast(); return json(res, 200, { ok: true });
    }
    const me = () => db.admins.find((a) => a.id === user.adminId) || db.admins[0];
    if (p === '/api/admin/pin' && m === 'POST') {
      const b = await readJson(req, 2000);
      if (!/^\d{6,10}$/.test(String(b.pin || ''))) throw new HttpError(400, 'Admin PIN must be 6–10 digits');
      if (db.admins.some((a) => a !== me() && checkPin(b.pin, a.pinHash))) throw new HttpError(400, 'Choose a different PIN.');
      me().pinHash = hashPin(b.pin);
      Object.keys(db.sessions).forEach((t) => { const x = db.sessions[t]; if (x.role === 'admin' && (x.adminId || me().id) === me().id && t !== user.token) delete db.sessions[t]; });
      audit(user.name, 'pin changed'); save(); return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/admins' && m === 'GET') return json(res, 200, db.admins.map((a) => ({ id: a.id, name: a.name, sports: a.sports || [], limited: !!a.limited, games: db.events.filter((e) => (e.organizerIds || []).includes(a.id)).map((e) => e.name), me: a.id === me().id })));
    if (p === '/api/admin/admins' && m === 'POST') {
      const b = await readJson(req, 2000); const name = str(b.name, 40);
      if (!name) throw new HttpError(400, 'Enter a name for the new admin');
      if (db.admins.length >= 40) throw new HttpError(400, 'Maximum 40 organizer accounts');
      const a = newOrganizer(name, { sports: normSports(b.sports), limited: !!b.limited }); const pin = a._pin; delete a._pin;
      audit(user.name, 'added admin', name); save();
      return json(res, 200, { id: a.id, name, pin });
    }
    if ((mm = p.match(/^\/api\/admin\/admins\/([\w-]+)$/))) {
      const a = db.admins.find((x) => x.id === mm[1]); if (!a) throw new HttpError(404, 'Not found');
      if (m === 'PUT') {
        const b = await readJson(req, 2000); let pin = null;
        if (b.name) a.name = str(b.name, 40);
        if (Array.isArray(b.sports)) { a.sports = normSports(b.sports); Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].adminId === a.id) db.sessions[t].sports = a.sports; }); }
        if (b.resetPin) { do { pin = pinN(8); } while (db.admins.some((x) => checkPin(pin, x.pinHash))); a.pinHash = hashPin(pin); Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].adminId === a.id && t !== user.token) delete db.sessions[t]; }); }
        audit(user.name, b.resetPin ? 'reset admin PIN' : 'renamed admin', a.name); save();
        return json(res, 200, { id: a.id, name: a.name, pin });
      }
      if (m === 'DELETE') {
        if (db.admins.length <= 1) throw new HttpError(400, 'You cannot remove the only admin.');
        if (a.id === me().id) throw new HttpError(400, 'You cannot remove yourself. Ask another admin.');
        db.admins = db.admins.filter((x) => x !== a); Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].adminId === a.id) delete db.sessions[t]; });
        db.events.forEach((e) => { e.organizerIds = (e.organizerIds || []).filter((x) => x !== a.id); });
        audit(user.name, 'removed admin', a.name); save(); return json(res, 200, { ok: true });
      }
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)\/cards-reset$/)) && m === 'POST') {
      const pl = find('players', mm[1]); if (!pl) throw new HttpError(404, 'Player not found');
      db.cards = db.cards.filter((c) => c.playerId !== pl.id); delete db.suspend[pl.id];
      audit(user.name, 'card record reset', pl.name); save(); broadcast(); return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/revoke-sessions' && m === 'POST') {
      let n = 0; Object.keys(db.sessions).forEach((t) => { if (t !== user.token) { delete db.sessions[t]; n++; } });
      audit(user.name, 'signed out everyone else', n + ' sessions'); save(); return json(res, 200, { ok: true, signedOut: n });
    }
    if (p === '/api/admin/export-link' && m === 'POST') {
      const t = crypto.randomBytes(16).toString('hex'); dlTokens.set(t, { exp: Date.now() + 120e3 });
      for (const [k, v] of dlTokens) if (v.exp < Date.now()) dlTokens.delete(k);
      return json(res, 200, { url: '/api/export.xlsx?dl=' + t });
    }
    if (p === '/api/admin/registration' && m === 'POST') {
      const b = await readJson(req, 8000); const regT = tour(tidOf(url.searchParams.get('tid') || b.tid)), r = regT.reg;
      if (!canTour(user, regT.id)) throw new HttpError(403, 'Only this event’s organizers can change its registration.');
      if (b.enabled != null) r.enabled = !!b.enabled;
      if (b.deadline != null) { if (b.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(b.deadline)) throw new HttpError(400, 'Deadline must be a date'); r.deadline = b.deadline; }
      if (b.joinCode != null) { if (!/^[A-Za-z0-9-]{0,24}$/.test(b.joinCode)) throw new HttpError(400, 'Join code: letters, numbers and dashes only (max 24)'); r.joinCode = b.joinCode; }
      if (b.publicUrl != null) {
        let u = String(b.publicUrl).trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/i.test(u)) throw new HttpError(400, 'Web address must look like https://your-name.ts.net (no path)');
        db.registration.publicUrl = u;
      }
      if (b.rotateCode) { const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; r.joinCode = Array.from({ length: 6 }, () => al[crypto.randomInt(al.length)]).join(''); }
      if (b.notice != null) r.notice = str(b.notice, 600);
      if (b.kidsNotice != null) r.kidsNotice = str(b.kidsNotice, 600);
      audit(user.name, 'registration settings', (r.enabled ? 'open' : 'closed') + (r.joinCode ? ', code set' : ', no code')); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/disputes' && m === 'GET') return json(res, 200, db.disputes.slice().reverse());
    if ((mm = p.match(/^\/api\/admin\/disputes\/([\w-]+)$/))) {
      const d = db.disputes.find((x) => x.id === mm[1]); if (!d) throw new HttpError(404, 'Not found');
      if (m === 'POST') { d.resolved = true; d.by = user.name; save(); broadcast(); return json(res, 200, { ok: true }); }
      if (m === 'DELETE') { db.disputes = db.disputes.filter((x) => x !== d); save(); broadcast(); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/admin/trash' && m === 'GET') return json(res, 200, db.trash.slice().reverse().map((x) => ({ id: x.id, col: x.col, name: x.name, at: x.at, matches: (x.matches || []).length })));
    if ((mm = p.match(/^\/api\/admin\/trash\/([\w-]+)\/restore$/)) && m === 'POST') {
      const sn = db.trash.find((x) => x.id === mm[1]); if (!sn) throw new HttpError(404, 'Not found');
      restoreTrash(sn); db.trash = db.trash.filter((x) => x !== sn); audit(user.name, 'restored from trash', sn.col + ': ' + sn.name); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/trash' && m === 'DELETE') { db.trash = []; save(); return json(res, 200, { ok: true }); }
    if (p === '/api/admin/purge' && m === 'POST') {
      const b = await readJson(req, 2000); const out = [];
      const used = () => { const u = new Set(); const add = (x) => { const k = String(x || '').match(/^\/uploads\/([\w.-]+)$/); if (k) u.add(k[1]); };
        add(db.tournament.logo); (db.tournament.signers || []).forEach((x) => add(x.image)); db.players.forEach((x) => add(x.photo)); db.sponsors.forEach((x) => add(x.image)); db.gallery.forEach((x) => add(x.url)); return u; };
      if (b.contacts) { db.players.forEach((x) => { x.phone = ''; x.email = ''; x.emergency = ''; x.tshirt = ''; x.notes = ''; x.guardianName = ''; x.guardianPhone = ''; x.editTokenHash = ''; }); db.disputes.forEach((d) => { d.contact = ''; d.name = ''; }); out.push('contact details'); }
      if (b.kidsPhotos) { db.players.forEach((x) => { if (x.section === 'kids') x.photo = ''; }); db.gallery = db.gallery.filter((g) => !g.minors); out.push('children’s photos'); }
      if (b.trash) { db.trash = []; out.push('trash'); }
      if (b.audit) { db.audit = []; out.push('activity log'); }
      if (b.subs) { db.subs = []; out.push('notification subscriptions'); }
      save(); flush();
      const u = used(); let files = 0;
      fs.readdirSync(UPLOAD_DIR).forEach((f) => { if (!u.has(f)) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); files++; } catch (e) { /* ignore */ } } });
      if (b.backups) {
        let n = 0;
        [BACKUP_DIR].concat(MIRROR_DIR ? [MIRROR_DIR] : []).forEach((d) => { try { fs.readdirSync(d).filter((f) => /^(db-|archive-)/.test(f)).forEach((f) => { fs.unlinkSync(path.join(d, f)); n++; }); } catch (e) { /* ignore */ } });
        fs.readdirSync(DATA_DIR).filter((f) => /^(archive-|db\.corrupt-)/.test(f)).forEach((f) => { try { fs.unlinkSync(path.join(DATA_DIR, f)); n++; } catch (e) { /* ignore */ } });
        out.push(n + ' old backup/archive file(s)');
      }
      audit(user.name, 'privacy clean-up', out.join(', ')); save(); broadcast();
      return json(res, 200, { ok: true, cleared: out, unusedFilesDeleted: files });
    }
    if (p === '/api/admin/broadcast' && m === 'POST') {
      const b = await readJson(req, 3000); const text = str(b.text, 240), title = str(b.title, 60) || 'Announcement';
      if (text.length < 3) throw new HttpError(400, 'Write the announcement first');
      const sport = SPORTS.includes(b.sport) ? b.sport : '';
      if (sport && isLead(user) && !user.sports.includes(sport)) throw new HttpError(403, 'You can only announce for your sport.');
      if (!sport && isLead(user)) throw new HttpError(403, 'Sport leads announce for their own sport only.');
      addFeed(title, text, { kind: 'announcement', sport });
      audit(user.name, 'announcement', title + ': ' + text);
      const ids = sport ? new Set(db.events.filter((e) => e.sport === sport).flatMap((e) => e.participantIds)) : null;
      const sent = await pushTo((s) => !s.approvalOnly && (!ids || !(s.follow && s.follow.length) || s.follow.some((f) => ids.has(f) || db.teams.some((t) => t.id === f && t.memberIds.some((x) => ids.has(x))))), title, text, '/#/feed');
      broadcast(); return json(res, 200, { ok: true, sent });
    }
    if (p === '/api/admin/announce' && m === 'POST') {
      const b = await readJson(req); const match = find('matches', b.matchId);
      if (!match) throw new HttpError(404, 'Match not found');
      const ev = find('events', match.eventId);
      await notify(match, 'Up next: ' + ev.name, sideNamePub(ev, match.sideA) + ' vs ' + sideNamePub(ev, match.sideB) + (match.court ? ' • ' + match.court : ''));
      audit(user.name, 'call to court', '', match.id);
      return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)\/merge$/)) && m === 'POST') {
      const b = await readJson(req, 1000); mergePlayers(mm[1], String(b.intoId || ''), user.name); save(); broadcast(); return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)\/test-push$/)) && m === 'POST') {
      const pl = find('players', mm[1]); if (!pl) throw new HttpError(404, 'Player not found');
      const sent = await pushTo((s) => s.playerId === pl.id || (s.follow || []).includes(pl.id), 'Test notification', 'Hi ' + pl.name.split(' ')[0] + ', notifications are working on your phone.', '/');
      pl.pushStatus = sent ? 'on' : (pl.pushStatus === 'on' ? 'unknown' : pl.pushStatus || 'unknown'); save();
      return json(res, 200, { sent });
    }
    if (p === '/api/admin/reachability' && m === 'GET') {
      const rows = db.players.filter((x) => x.status !== 'rejected' && x.status !== 'pending').map((x) => {
        const has = db.subs.some((s) => s.playerId === x.id || (s.follow || []).includes(x.id));
        return { id: x.id, name: x.name, section: x.section, phone: x.phone || '', status: has ? 'on' : (x.pushStatus && x.pushStatus !== 'on' ? x.pushStatus : 'unknown') };
      });
      const link = str(url.searchParams.get('link'), 200);
      return json(res, 200, { rows, counts: rows.reduce((o, r) => ((o[r.status] = (o[r.status] || 0) + 1), o), {}), message: 'Hi! Please open ' + (link || 'the tournament app') + ' and turn on notifications so you get your match times and scores. On iPhone: Share → Add to Home Screen, then open it from there.' });
    }
    if (p === '/api/admin/test-push' && m === 'POST') {
      const sent = await pushTo(() => true, 'Test notification', 'Notifications are working on this device 🎉', '/');
      return json(res, 200, { sent, subscribers: db.subs.length });
    }
    if (p === '/api/admin/backup' && m === 'GET') {
      const { sessions, subs, vapid, admins, audit: au, trash, disputes, ...rest } = db;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="tournament-backup.json"' });
      return res.end(JSON.stringify({ ...rest, uploads: buildUploads() }));
    }
    if (p === '/api/admin/restore' && m === 'POST') {
      const b = JSON.parse((await readBody(req, 4e8)).toString() || '{}');
      if (!Array.isArray(b.players) || !Array.isArray(b.events) || !Array.isArray(b.matches)) throw new HttpError(400, 'Not a valid backup file');
      backup();
      for (const [f, data] of Object.entries(b.uploads || {})) {
        if (/^[\w.-]+$/.test(f) && ['.jpg', '.png', '.webp'].includes(path.extname(f).toLowerCase())) fs.writeFileSync(path.join(UPLOAD_DIR, f), Buffer.from(data, 'base64'));
      }
      ['tournament', 'tournaments', 'seasons', 'players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'registration'].forEach((k) => { if (b[k] !== undefined) db[k] = b[k]; });
      migrate(db); audit(user.name, 'restore backup'); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/new-tournament' && m === 'POST') {
      const b = await readJson(req);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      flush(); const archName = 'archive-' + stamp + '.json' + (BK_PASS ? '.enc' : '');
      writeSecure(path.join(DATA_DIR, 'archive-' + stamp + '.json'), fs.readFileSync(DB_FILE));
      { /* freeze this season: results per player per sport (for all-time rankings) and each game's podium */
        const data = { players: db.players, teams: db.teams, events: db.events, matches: db.matches };
        const nameIds = (ev, ids) => ids.map((id) => (find(ev.sideType === 'team' ? 'teams' : 'players', id) || {}).name || '?').join(' & ');
        const champions = db.events.map((ev) => { const pod = Engine.podium(ev, db.matches); return pod ? { event: ev.name, section: ev.section || 'adults', sport: ev.sport, first: nameIds(ev, pod.first), second: nameIds(ev, pod.second), third: pod.third.length ? nameIds(ev, pod.third) : '' } : null; }).filter(Boolean);
        const done = db.matches.filter((x) => { const ev = find('events', x.eventId); return ev && Engine.derive(x, ev).status === 'completed'; }).length;
        if (db.matches.length || champions.length) db.seasons.push({ id: uid(), name: db.tournament.seasonName || db.tournament.name, startedAt: db.tournament.seasonStartedAt || 0, endedAt: Date.now(), champions, matches: done, records: b.keepPlayers ? Engine.seasonRecords(data, db.matches) : {} });
      }
      if (b.keepPlayers) {
        const data = { players: db.players, teams: db.teams, events: db.events, matches: db.matches };
        db.players.forEach((pl) => {
          const st = Engine.playerStats(pl.id, data);
          const entered = db.events.some((e) => (e.participantIds || []).includes(pl.id) || (e.sideType === 'team' && e.participantIds.some((t) => (find('teams', t) || { memberIds: [] }).memberIds.includes(pl.id))));
          if (!st.totals.played && !entered) return;
          pl.career = (pl.career || []).concat([{ tournament: db.tournament.name, season: db.tournament.seasonName || '', dates: db.tournament.dates, played: st.totals.played, won: st.totals.won, lost: st.totals.lost, drawn: st.totals.drawn, tally: Engine.r2(st.totals.pf), honours: st.honours.map((h) => h.event + ' – ' + h.place), at: Date.now() }]);
        });
      }
      const games = b.keepGames ? db.events.map((ev) => { const c = JSON.parse(JSON.stringify(ev)); c.id = uid(); c.participantIds = []; c.withdrawn = []; c.interestedIds = []; delete c.frozenCount; delete c.groups; delete c.bracket; delete c.byes; return c; }) : null;
      db.matches = []; db.teams = []; db.gallery = []; db.disputes = []; db.trash = []; db.events = games || seedEvents();
      if (!b.keepPlayers) db.seasons = db.seasons.map((x) => ({ ...x, records: {} }));
      if (!b.keepPlayers) { db.cards = []; db.suspend = {}; }
      db.players = db.players.filter((x) => x.status !== 'pending' || b.keepPlayers);
      if (!b.keepPlayers) db.players = [];
      if (!b.keepReferees) db.referees = [];
      if (!b.keepSponsors) db.sponsors = [];
      if (b.name) db.tournament.name = str(b.name, 80);
      /* next season's name: as typed, otherwise "… Season 3" becomes "… Season 4" */
      const prevSeason = db.tournament.seasonName || '';
      db.tournament.seasonName = str(b.season, 80).trim() || (/\d+\s*$/.test(prevSeason) ? prevSeason.replace(/(\d+)\s*$/, (x) => String(Number(x) + 1)) : (prevSeason ? prevSeason + ' (next)' : 'Season 1'));
      db.tournament.seasonStartedAt = Date.now();
      db.tournaments = [newTour({ name: db.tournament.seasonName })]; ensureTours(db);
      db.referees.forEach((r) => { r.eventIds = []; });   // game-specific referee limits pointed at last season's games
      audit(user.name, 'new season', db.tournament.seasonName + ' (previous archived as ' + archName + ')'); save(); broadcast();
      return json(res, 200, { ok: true, archive: archName, season: db.tournament.seasonName });
    }
    const enrol = (pl) => {
      const enrolled = [], skipped = [];
      if (pl.requestTid) addRoster(pl.requestTid, [pl.id]);
      (pl.requestedEventIds || []).forEach((id) => {
        const ev = find('events', id); if (!ev) return;
        addRoster(ev.tid, [pl.id]);
        const team = ev.sideType === 'team', pool = team ? (ev.interestedIds = ev.interestedIds || []) : ev.participantIds;
        if (pool.includes(pl.id)) return;
        if ((ev.section || 'adults') !== pl.section) { skipped.push(ev.name + ' (not allowed)'); return; }
        if (ev.maxParticipants > 0 && pool.length >= ev.maxParticipants) { skipped.push(ev.name + ' (full)'); return; }
        if (!ageOk(ev, pl)) { skipped.push(ev.name + ' (age range ' + ageText(ev) + ')'); return; }
        pool.push(pl.id); enrolled.push(team ? ev.name + ' (interested list – add to a team)' : ev.name);
      });
      pl.requestedEventIds = [];
      return { enrolled, skipped };
    };
    /* ---- panic controls: every action needs the organizer to type the action word ---- */
    if (p === '/api/admin/panic' && m === 'POST') {
      const b = await readJson(req, 1000); const pc = panic();
      const ACT = { freeze: 'FREEZE', unfreeze: 'RESUME', lock: 'LOCK', unlock: 'UNLOCK', hide: 'HIDE', show: 'SHOW' };
      if (!ACT[b.action]) throw new HttpError(400, 'Unknown action');
      if (String(b.confirm || '').trim().toUpperCase() !== ACT[b.action]) throw new HttpError(400, 'Type ' + ACT[b.action] + ' to confirm.');
      if (b.action === 'freeze') pc.freezeScoring = true; else if (b.action === 'unfreeze') pc.freezeScoring = false;
      else if (b.action === 'hide') pc.hideScoreboard = true; else if (b.action === 'show') pc.hideScoreboard = false;
      else { const ev = find('events', b.eventId); if (!ev) throw new HttpError(404, 'Event not found'); pc.lockedEvents = b.action === 'lock' ? [...new Set([...pc.lockedEvents, ev.id])] : pc.lockedEvents.filter((x) => x !== ev.id); }
      audit(user.name, 'panic control: ' + b.action, b.eventId ? (find('events', b.eventId) || {}).name || '' : ''); save(); broadcast();
      return json(res, 200, { ok: true, panic: pc });
    }
    if (p === '/api/admin/snapshots' && m === 'GET') {
      flush();
      const list = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-[\w.-]+\.json$/.test(f)).sort().reverse().slice(0, 40).map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, at: st.mtimeMs, size: st.size }; });
      return json(res, 200, list);
    }
    if (p === '/api/admin/rollback' && m === 'POST') {
      const b = await readJson(req, 1000);
      if (String(b.confirm || '').trim().toUpperCase() !== 'ROLLBACK') throw new HttpError(400, 'Type ROLLBACK to confirm.');
      if (!/^db-[\w.-]+\.json$/.test(String(b.file || ''))) throw new HttpError(400, 'Choose a snapshot');
      const fp = path.join(BACKUP_DIR, b.file); if (!fs.existsSync(fp)) throw new HttpError(404, 'That snapshot no longer exists');
      let snap; try { snap = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { throw new HttpError(400, 'That snapshot cannot be read'); }
      if (!Array.isArray(snap.players) || !Array.isArray(snap.matches)) throw new HttpError(400, 'That snapshot is not valid');
      backup();   /* keep what we have now so the rollback itself can be undone */
      ['tournament', 'tournaments', 'seasons', 'players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'registration', 'cards', 'suspend', 'feed', 'nextPlayerNo'].forEach((k) => { if (snap[k] !== undefined) db[k] = snap[k]; });
      migrate(db); audit(user.name, 'rolled back to snapshot', b.file); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    /* ---- clone an event (settings, format, rubbers; no players or matches) ---- */
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/clone$/)) && m === 'POST') {
      const src = find('events', mm[1]); if (!src) throw new HttpError(404, 'Event not found');
      if (!sportOk(user, src)) throw new HttpError(403, 'That event belongs to another sport.');
      const b = await readJson(req, 1000);
      const copy = JSON.parse(JSON.stringify(src));
      Object.assign(copy, { id: uid(), name: str(b.name, 80) || src.name + ' (copy)', participantIds: [], withdrawn: [], groups: undefined, bracket: undefined, byes: undefined });
      delete copy.frozenCount; delete copy.groups; delete copy.bracket; delete copy.byes;
      if (b.section === 'kids' || b.section === 'adults') copy.section = b.section;
      db.events.push(copy); audit(user.name, 'cloned event', src.name + ' → ' + copy.name); save(); broadcast();
      return json(res, 200, copy);
    }
    /* ---- bulk import of players from Excel ---- */
    if (p === '/api/admin/import-template.xlsx' && m === 'GET') {
      const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Players');
      ws.addRow(['Name', 'Section (adults/kids)', 'Gender (M/F)', 'Phone', 'Email', 'Date of birth (YYYY-MM-DD)', 'Age group (kids)', 'Department / company', 'Games (comma separated event names)', 'Team (optional)']).font = { bold: true };
      const ind = db.events.find((e) => e.sideType !== 'team' && (e.section || 'adults') === 'adults'), tm = db.events.find((e) => e.sideType === 'team' && (e.section || 'adults') === 'adults');
      ws.addRow(['Asha Verma', 'adults', 'F', '9800000000', '', '1991-04-12', '', 'Engineering', ind ? ind.name : 'Table Tennis', '']);
      ws.addRow(['Ravi Kumar', 'adults', 'M', '9800000001', '', '1989-09-30', '', 'Finance', [ind && ind.name, tm && tm.name].filter(Boolean).join(', '), 'Red Hawks']);
      ws.addRow(['Meena Iyer', 'adults', 'F', '9800000002', '', '1993-01-15', '', 'HR', tm ? tm.name : '', 'Red Hawks']);
      ws.columns.forEach((c, i) => { c.width = i === 8 ? 44 : 22; });
      const bold = (ws2) => { ws2.getRow(1).font = { bold: true }; ws2.columns.forEach((c) => { c.width = 26; }); };
      const gs = wb.addWorksheet('Games'); gs.addRow(['Game', 'Sport', 'Category', 'Type']);
      db.events.forEach((e) => gs.addRow([e.name, { badminton: 'Badminton', tt: 'Table Tennis', carrom: 'Carrom', chess: 'Chess' }[e.sport] || 'Other', (e.section || 'adults') === 'kids' ? 'Under-16' : 'Seniors', e.sideType === 'team' ? 'Team' : e.sideSize === 2 ? 'Doubles' : 'Singles']));
      gs.addRow(['Badminton – Men Doubles', 'Badminton', 'Seniors', 'Doubles']); bold(gs);
      const teamEv = db.events.find((e) => e.sideType === 'team' && (e.section || 'adults') === 'adults');
      const tsh = wb.addWorksheet('Teams'); tsh.addRow(['Team', 'Game', 'Player 1', 'Player 2', 'Player 3', 'Player 4']);
      tsh.addRow(['Red Hawks', teamEv ? teamEv.name : 'Badminton – Team Event', 'Ravi Kumar', 'Asha Verma', '', '']); bold(tsh);
      const fx = wb.addWorksheet('Fixtures'); fx.addRow(['Game', 'Side A', 'Side B', 'Round', 'Date', 'Time', 'Court', 'Referee']);
      fx.addRow([ind ? ind.name : 'Table Tennis', 'Asha Verma', 'Ravi Kumar', 'League', '29/11/2026', '10:30 AM', 'Court 1', '']); bold(fx);
      const h = wb.addWorksheet('How it works'); [['How the upload works – fill only the sheets you need, delete the rest'],
        ['• Players: one row per player. Name is the only required column. Your own layout also works (e.g. "Participant Name", "Select Games to Participate [Badminton]" = Yes, Category Seniors / Under-16, Villa Number, Age).'],
        ['• Games: new games to create (existing names are skipped). Type = Singles, Doubles or Team. Category = Seniors or Under-16.'],
        ['• Teams: team name, its game, and its players (Player 1, Player 2… or one "Members" column, comma separated). Players must exist – put them in the Players sheet of the same file. The team is entered in the game.'],
        ['• Fixtures: Game, Side A, Side B (player or team names; doubles: "Asha & Meena"), optional Round (League, Group A, Quarter final, Semi final, Final), Date, Time, Court, Referee.'],
        ['• Order: games are created first, then players, then teams, then fixtures – so one file can set up everything.'],
        ['• Players already in the app are updated with the latest details; nothing is duplicated. Existing fixtures are not duplicated either.'],
        ['• You choose which sheets to import and see a preview before anything is saved.']].forEach((r, k) => { const x = h.addRow(r); if (!k) x.font = { bold: true }; }); h.getColumn(1).width = 120;
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="players-import-template.xlsx"' });
      return res.end(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    /* Look at every sheet of an uploaded workbook: which ones hold players, and how their columns map. */
    if (p === '/api/admin/import-inspect' && m === 'POST') {
      const wb = await loadWorkbook(await readBody(req, 5e6));
      const evs = db.events.filter((e) => e.tid === tidOf(url.searchParams.get('tid')));
      return json(res, 200, {
        fields: SheetImport.FIELDS.map((f) => ({ key: f.key, label: f.label })),
        sheets: wb.worksheets.map((ws, i) => ({ index: i, ...SheetImport.inspectSheet(ws, evs) })),
      });
    }
    if (p === '/api/admin/import-players' && m === 'POST') {
      const wb = await loadWorkbook(await readBody(req, 5e6));
      const impTid = tidOf(url.searchParams.get('tid')), impT = tour(impTid);
      if (impT.status === 'closed') throw new HttpError(409, impT.name + ' is closed.');
      const evs = db.events.filter((e) => e.tid === impTid);
      const fullPlan = importPlan(wb, req.headers['x-import-options'], evs);
      const preview = url.searchParams.get('dry') === '1';
      /* A preview runs the real import on the live data and then puts the data back exactly as it was. */
      const snap = preview ? JSON.stringify({ players: db.players, teams: db.teams, events: db.events, matches: db.matches, tournaments: db.tournaments, nextPlayerNo: db.nextPlayerNo }) : null;
      try {
      const dry = false;
      let created = 0, flagged = 0, merged = 0, updated = 0; const errors = [], warnings = [], made = [], totals = { games: 0, interested: 0, teamEntries: 0, teamsMade: 0 }, perSheet = [];
      const extra = importOthers(fullPlan.filter((x) => x.kind === 'games'), 'games', errors, warnings, impTid, evs);
      const plan = fullPlan.filter((x) => x.kind === 'players');
      /* Same person = same name + phone (else email, else date of birth), in any section, so a child who moves up to
         Seniors keeps their profile. The latest sheet wins: a player already in the app gets the sheet's details and
         game choices; what the sheet does not hold (photo, bio, results, history) is kept, and replaced values are noted. */
      const nm = (x) => String(x.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const keyOf = (x) => nm(x) + '|' + (String(x.phone || '').replace(/\D/g, '').slice(-10) || String(x.email || '').toLowerCase() || x.dob || x.section || 'adults');
      const existing = new Map(); db.players.forEach((q) => { if (q.status !== 'rejected') existing.set(keyOf(q), q); });
      /* Fallback for players entered earlier without a phone (or with a placeholder one): the only player with
         that name in the section is the same person, unless the sheet itself lists two different people by that name. */
      const nameKey = (x) => (x.section || 'adults') + '|' + nm(x);
      const byName = new Map(); db.players.forEach((q) => { if (q.status === 'rejected') return; const k = nameKey(q); byName.set(k, byName.has(k) ? null : q); });
      const allRows = plan.map((sh) => SheetImport.readRows(sh.ws, sh, evs));
      const sheetKeys = new Map(); allRows.flat().forEach((x) => { const k = nameKey(x); if (!sheetKeys.has(k)) sheetKeys.set(k, new Set()); sheetKeys.get(k).add(keyOf(x)); });
      const findExisting = (x) => existing.get(keyOf(x)) || (sheetKeys.get(nameKey(x)).size === 1 ? byName.get(nameKey(x)) || null : null);
      const seen = new Map(), plans = new Map();
      const nextNo = db.nextPlayerNo;
      const SPN = { badminton: 'Badminton', tt: 'Table Tennis', carrom: 'Carrom', chess: 'Chess' };
      const FIELDS = ['phone', 'email', 'dob', 'ageGroup', 'affiliation', 'gender'];
      const LBL = { phone: 'phone', email: 'email', dob: 'date of birth', ageGroup: 'age', affiliation: 'villa / dept', gender: 'gender', section: 'section' };
      const same = (k, t) => (k === 'phone' ? String(t).replace(/\D/g, '').slice(-10) : String(t).toLowerCase());
      const inFixtures = (ev, id) => db.matches.some((x) => x.eventId === ev.id && (x.sideA.includes(id) || x.sideB.includes(id)));
      for (const [si, sh] of plan.entries()) {
        const rows = allRows[si]; let n = 0, u = 0;
        for (const x of rows.slice(0, 2000)) {
          try {
            const rowEvs = x.games.map((g) => { const e = SheetImport.eventByName(g, evs, x.section); if (!e) throw new Error('Unknown event "' + g + '"'); return e; });
            (x.sports || []).forEach((sp) => {
              const e = SheetImport.eventForSport(sp, x, evs, (sh.sportMap || {})[sp + '|' + x.section]);
              if (e) { if (!rowEvs.includes(e)) rowEvs.push(e); }
              else if ((sh.sportMap || {})[sp + '|' + x.section] !== 'skip') warnings.push({ sheet: sh.ws.name, row: x.row, name: x.name, error: 'no ' + (SPN[sp] || sp) + ' game for ' + (x.section === 'kids' ? 'kids' : 'adults') + ' fits (' + [x.gender === 'F' ? 'female' : x.gender === 'M' ? 'male' : '', x.ageGroup].filter(Boolean).join(', ') + ')' });
            });
            const key = keyOf(x); let pl = seen.get(key), isNew = false;
            if (pl) merged++;
            else if ((pl = findExisting(x)) && !made.includes(pl.id)) { seen.set(key, pl); updated++; u++; }
            else {
              if (db.players.length >= 5000) throw new Error('Player limit reached');
              pl = COLS.players({ name: x.name, section: x.section, gender: x.gender, phone: x.phone, email: x.email, dob: x.dob, ageGroup: x.ageGroup, affiliation: x.affiliation }, null);
              pl.status = 'approved'; pl.profilePublic = false; pl.dupOf = dupCandidates(pl); if (pl.dupOf.length) flagged++;
              db.players.push(pl); seen.set(key, pl); made.push(pl.id); isNew = true; created++;
            }
            addRoster(impTid, [pl.id]);
            let pp = plans.get(pl.id);
            if (!pp) plans.set(pl.id, (pp = { pl, existed: !made.includes(pl.id), sheet: sh.ws.name, want: new Set(), covered: new Set(), set: {}, old: {} }));
            rowEvs.forEach((e) => pp.want.add(e.id));
            (sh.sportCols || []).forEach((c) => pp.covered.add(c.sport));
            (sh.eventCols || []).forEach((c) => { const e = find('events', c.eventId); if (e) pp.covered.add(e.sport); });
            if (sh.map && sh.map.games) pp.covered.add('*');
            if (pp.existed) {   // latest sheet wins for every detail it provides
              FIELDS.forEach((k) => { const v = String(x[k] || '').slice(0, k === 'email' ? 80 : 60).trim(); if (v) pp.set[k] = v; });
              if (x.section !== pl.section) pp.set.section = x.section;
            }
            const stat = { games: 0, interested: 0, teamEntries: 0, teamsMade: 0 };
            const sec = pp.set.section || pl.section;
            const mine = rowEvs.filter((e) => (e.section || 'adults') === sec);
            if (!dry) {
              let t = null;
              if (x.team) { t = db.teams.find((q) => q.name.toLowerCase() === x.team.toLowerCase() && q.section === sec && q.tid === impTid); if (!t) { t = COLS.teams({ name: x.team, section: sec, memberIds: [], tid: impTid }, null); db.teams.push(t); stat.teamsMade++; } if (!t.memberIds.includes(pl.id)) t.memberIds.push(pl.id); }
              mine.forEach((e) => {
                if (e.sideType !== 'team') { if (!e.participantIds.includes(pl.id)) { e.participantIds.push(pl.id); stat.games++; } return; }
                if (t) { if (!e.participantIds.includes(t.id)) { e.participantIds.push(t.id); stat.teamEntries++; } stat.games++; }
                else { e.interestedIds = e.interestedIds || []; if (!e.interestedIds.includes(pl.id)) { e.interestedIds.push(pl.id); stat.interested++; stat.games++; } }
              });
            } else mine.forEach((e) => { if (!e.participantIds.includes(pl.id) && !(e.interestedIds || []).includes(pl.id)) { stat.games++; if (e.sideType === 'team' && !x.team) stat.interested++; } });
            Object.keys(totals).forEach((k) => { totals[k] += stat[k]; });
            if (isNew) n++;
          } catch (e) { errors.push({ sheet: sh.ws.name, row: x.row, name: x.name, error: e.message }); }
        }
        perSheet.push({ sheet: sh.ws.name, rows: rows.length, added: n, updated: u });
      }
      /* Apply the latest details and game choices to players who were already in the app. */
      let changed = 0, removedGames = 0;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: db.tournament.tz || 'Asia/Kolkata' });
      for (const pp of plans.values()) {
        if (!pp.existed) continue;
        const pl = pp.pl, id = pl.id, was = [], left = [];
        // section move (e.g. a child now in Seniors): only when no fixtures hold them in the old section
        if (pp.set.section) {
          const oldEvs = evs.filter((e) => (e.section || 'adults') === pl.section);
          const stuck = oldEvs.filter((e) => e.sideType !== 'team' && inFixtures(e, id));
          if (stuck.length) { warnings.push({ sheet: pp.sheet, row: '', name: pl.name, error: 'stays in ' + pl.section + ' – already has fixtures in ' + stuck.map((e) => e.name).join(', ') }); delete pp.set.section; }
          else {
            was.push('section was ' + pl.section);
            oldEvs.forEach((e) => { const pool = e.sideType === 'team' ? (e.interestedIds || []) : e.participantIds; if (pool.includes(id)) { left.push(e.name); removedGames++; if (!dry) pool.splice(pool.indexOf(id), 1); } });
            if (!dry) { pl.section = pp.set.section; db.teams.forEach((t) => { if (t.section !== pl.section && t.memberIds.includes(id)) t.memberIds = t.memberIds.filter((m) => m !== id); }); }
          }
        }
        FIELDS.forEach((k) => {
          const v = pp.set[k]; if (!v) return;
          const cur = String(pl[k] || '').trim(); if (same(k, cur) === same(k, v)) return;
          if (cur) was.push(LBL[k] + ' was ' + (k === 'phone' ? maskPhone(cur) : k === 'email' ? cur.replace(/^(.).*(@.*)$/, '$1•••$2') : cur));
          if (!dry) pl[k] = k === 'gender' ? (['M', 'F'].includes(v) ? v : cur) : v;
        });
        // game choices: in the sports this sheet asks about, the player plays exactly what they ticked now
        const sec = pp.set.section || pl.section;
        if (pp.covered.size) evs.forEach((ev) => {
          if ((ev.section || 'adults') !== sec || pp.want.has(ev.id) || (!pp.covered.has('*') && !pp.covered.has(ev.sport))) return;
          const team = ev.sideType === 'team', pool = team ? (ev.interestedIds || []) : ev.participantIds;
          if (!pool.includes(id)) return;
          if (!team && (inFixtures(ev, id) || ev.groups || ev.bracket)) { warnings.push({ sheet: pp.sheet, row: '', name: pl.name, error: 'kept in ' + ev.name + ' although not ticked – the draw/fixtures are already made (use Withdraw)' }); return; }
          left.push(ev.name); removedGames++; if (!dry) pool.splice(pool.indexOf(id), 1);
        });
        if (was.length || left.length) changed++;
        if (!dry && (was.length || left.length)) {
          const line = 'Updated ' + today + ' from ' + pp.sheet + ': ' + was.concat(left.length ? ['left ' + left.join(', ')] : []).join('; ');
          pl.notes = ((pl.notes ? pl.notes + '\n' : '') + line).slice(-500);
        }
      }
      Object.assign(extra, importOthers(fullPlan.filter((x) => x.kind === 'teams'), 'teams', errors, warnings, impTid, evs));
      Object.assign(extra, importOthers(fullPlan.filter((x) => x.kind === 'fixtures'), 'fixtures', errors, warnings, impTid, evs));
      fullPlan.filter((x) => x.kind !== 'players').forEach((x) => perSheet.push({ sheet: x.ws.name, kind: x.kind, rows: (extra.rowsBySheet || {})[x.ws.name] || 0 }));
      delete extra.rowsBySheet;
      void nextNo;
      if (!preview) { audit(user.name, 'imported from Excel', [created + ' players added', updated + ' updated', extra.gamesMade ? extra.gamesMade + ' games' : '', extra.teamsCreated || extra.teamsUpdated ? (extra.teamsCreated || 0) + ' teams made, ' + (extra.teamsUpdated || 0) + ' updated' : '', extra.fixturesMade ? extra.fixturesMade + ' fixtures' : '', errors.length + ' skipped'].filter(Boolean).join(', ')); save(); broadcast(); }
      return json(res, 200, { created, updated, changed, removedGames, flagged, merged, errors, warnings, dryRun: preview, sheets: perSheet, ...totals, ...extra });
      } finally { if (preview) Object.assign(db, JSON.parse(snap)); }
    }
    /* ---- teams under an event: create one from the event's players and pick the team games it plays ---- */
    const setTeamGames = (t, ids) => {
      const want = new Set((Array.isArray(ids) ? ids : []).map(String)), out = { added: 0, removed: 0, kept: [] };
      db.events.filter((e) => e.tid === t.tid && e.sideType === 'team' && (e.section || 'adults') === t.section).forEach((e) => {
        const inNow = e.participantIds.includes(t.id);
        if (want.has(e.id) && !inNow) { e.participantIds.push(t.id); e.interestedIds = (e.interestedIds || []).filter((id) => !t.memberIds.includes(id)); out.added++; }
        else if (!want.has(e.id) && inNow) {
          if (db.matches.some((x) => x.eventId === e.id && [...x.sideA, ...x.sideB].includes(t.id))) { out.kept.push(e.name); return; }
          e.participantIds = e.participantIds.filter((id) => id !== t.id); out.removed++;
        }
      });
      return out;
    };
    if ((mm = p.match(/^\/api\/admin\/tournaments\/([\w-]+)\/teams$/)) && m === 'POST') {
      const T = tour(mm[1]); if (!T || T.kind === 'friendly') throw new HttpError(404, 'Event not found');
      if (!canTour(user, T.id)) throw new HttpError(403, 'Only this event’s organizers can make its teams.');
      const b = await readJson(req, 20000), section = b.section === 'kids' ? 'kids' : 'adults';
      const t = COLS.teams({ name: b.name, section, memberIds: (Array.isArray(b.memberIds) ? b.memberIds : []).map(String), tid: T.id }, null);
      if (db.teams.some((x) => x.tid === T.id && x.section === section && x.name.toLowerCase() === t.name.toLowerCase())) throw new HttpError(409, 'A team called "' + t.name + '" already exists in ' + T.name + '.');
      db.teams.push(t); const g = setTeamGames(t, b.eventIds);
      audit(user.name, 'made team', t.name + ' in ' + T.name); save(); broadcast();
      return json(res, 200, { team: t, ...g });
    }
    if ((mm = p.match(/^\/api\/admin\/teams\/([\w-]+)\/games$/)) && m === 'PUT') {
      const t = find('teams', mm[1]); if (!t) throw new HttpError(404, 'Team not found');
      if (!canTour(user, t.tid)) throw new HttpError(403, 'Only this event’s organizers can change its teams.');
      const g = setTeamGames(t, (await readJson(req, 8000)).eventIds);
      audit(user.name, 'team games', t.name); save(); broadcast();
      return json(res, 200, g);
    }
    /* ---- people & roles: the main admin gives a person admin / referee roles and PINs; one login does it all ---- */
    if (p === '/api/admin/people' && m === 'GET') {
      if (isLead(user)) throw new HttpError(403, 'Only a main admin manages people and roles.');
      return json(res, 200, {
        people: db.players.filter((x) => x.status !== 'rejected').map((x) => ({ id: x.id, name: x.name, section: x.section, hasPin: !!x.pinHash,
          admin: db.admins.some((a) => a.playerId === x.id && !a.limited && !(a.sports || []).length), organizer: db.admins.some((a) => a.playerId === x.id && (a.limited || (a.sports || []).length)),
          referee: (db.referees.find((r) => r.playerId === x.id && r.status !== 'pending') || {}).kind || '', captain: db.teams.some((t) => t.captainId === x.id) })),
        unlinked: [...db.admins.filter((a) => !a.playerId).map((a) => ({ type: 'admin', id: a.id, name: a.name })), ...db.referees.filter((r) => !r.playerId && r.status !== 'pending').map((r) => ({ type: 'referee', id: r.id, name: r.name }))],
      });
    }
    if ((mm = p.match(/^\/api\/admin\/people\/([\w-]+)\/(roles|pin)$/)) && m === 'POST') {
      if (isLead(user)) throw new HttpError(403, 'Only a main admin manages people and roles.');
      const pl = find('players', mm[1]); if (!pl || pl.status === 'rejected') throw new HttpError(404, 'Person not found');
      if (mm[2] === 'pin') { const pin = givePin(pl); audit(user.name, 'new PIN', pl.name); save(); return json(res, 200, { name: pl.name, pin }); }
      const b = await readJson(req, 2000), out = {};
      if (b.admin != null) {
        const a = db.admins.find((x) => x.playerId === pl.id);
        if (b.admin && !a) { db.admins.push({ id: uid(), name: pl.name, pinHash: '', sports: [], limited: false, playerId: pl.id }); out.admin = 'added'; }
        else if (b.admin && a) { a.limited = false; a.sports = []; out.admin = 'main admin'; }
        else if (!b.admin && a) {
          if (a.id === user.adminId) throw new HttpError(400, 'You cannot remove your own admin role. Ask another admin.');
          if (!a.limited && !(a.sports || []).length && db.admins.filter((x) => !x.limited && !(x.sports || []).length).length <= 1) throw new HttpError(400, 'Keep at least one main admin.');
          db.admins = db.admins.filter((x) => x !== a); db.events.forEach((e) => { e.organizerIds = (e.organizerIds || []).filter((x) => x !== a.id); }); db.tournaments.forEach((t) => { t.organizerIds = t.organizerIds.filter((x) => x !== a.id); });
          Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].adminId === a.id) delete db.sessions[t]; }); out.admin = 'removed';
        }
      }
      if (b.referee != null) {
        const r = db.referees.find((x) => x.playerId === pl.id);
        const kind = ['referee', 'chief', 'volunteer'].includes(b.referee) ? b.referee : '';
        if (kind && !r) { db.referees.push({ id: uid(), name: pl.name, kind, sports: [], eventIds: [], status: 'active', phone: '', note: '', signedUpAt: 0, pinHash: '', playerId: pl.id }); out.referee = 'added'; }
        else if (kind && r) { r.kind = kind; r.status = 'active'; out.referee = kind; }
        else if (!kind && r) { cascadeDelete('referees', r.id); db.referees = db.referees.filter((x) => x !== r); Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].refId === r.id) delete db.sessions[t]; }); out.referee = 'removed'; }
      }
      let pin = null; if (!pl.pinHash && (b.admin || b.referee)) pin = givePin(pl);   // a role needs a way to sign in
      audit(user.name, 'roles', pl.name + ': ' + JSON.stringify(out)); save(); broadcast();
      return json(res, 200, { ok: true, ...out, pin, name: pl.name });
    }
    if (p === '/api/admin/people/pins' && m === 'POST') {
      if (isLead(user)) throw new HttpError(403, 'Only a main admin manages people and roles.');
      const b = await readJson(req, 50000), tid = b.tid && tour(String(b.tid));
      const who = db.players.filter((x) => x.status === 'approved' && !x.pinHash && (!tid || tid.playerIds.includes(x.id)));
      const out = who.slice(0, 2000).map((x) => ({ id: x.id, name: x.name, pin: givePin(x) }));
      audit(user.name, 'generated PINs', out.length + ' people'); save();
      return json(res, 200, { pins: out });
    }
    if (p === '/api/admin/people/link' && m === 'POST') {
      if (isLead(user)) throw new HttpError(403, 'Only a main admin manages people and roles.');
      const b = await readJson(req, 2000), pl = find('players', String(b.playerId || ''));
      const rec = b.type === 'admin' ? db.admins.find((a) => a.id === b.id) : find('referees', String(b.id || ''));
      if (!pl || !rec) throw new HttpError(404, 'Not found');
      if ((b.type === 'admin' ? db.admins : db.referees).some((x) => x !== rec && x.playerId === pl.id)) throw new HttpError(409, pl.name + ' already has that role.');
      rec.playerId = pl.id; audit(user.name, 'linked account', rec.name + ' → ' + pl.name); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    /* ---- events: roster (enrol existing players / remove from the event) ---- */
    if ((mm = p.match(/^\/api\/admin\/tournaments\/([\w-]+)\/roster$/)) && m === 'POST') {
      const T = tour(mm[1]); if (!T) throw new HttpError(404, 'Event not found');
      if (!canTour(user, T.id)) throw new HttpError(403, 'Only this event’s organizers can change its players.');
      const b = await readJson(req, 50000);
      const add = (Array.isArray(b.add) ? b.add : []).map(String).filter((id) => { const pl = find('players', id); return pl && pl.status === 'approved'; });
      addRoster(T.id, add);
      let removed = 0;
      if (b.remove) {
        const id = String(b.remove), pl = find('players', id); if (!pl) throw new HttpError(404, 'Player not found');
        const evs = db.events.filter((e) => e.tid === T.id);
        const teamIds = db.teams.filter((t) => t.tid === T.id && t.memberIds.includes(id)).map((t) => t.id);
        const busy = evs.filter((e) => db.matches.some((x) => x.eventId === e.id && [...x.sideA, ...x.sideB].includes(id)));
        if (busy.length) throw new HttpError(409, pl.name + ' already has fixtures in ' + busy.map((e) => e.name).join(', ') + ' – use Withdraw / replace there first.');
        T.playerIds = T.playerIds.filter((x) => x !== id);
        evs.forEach((e) => { e.participantIds = e.participantIds.filter((x) => x !== id); e.interestedIds = (e.interestedIds || []).filter((x) => x !== id); });
        db.teams.forEach((t) => { if (teamIds.includes(t.id)) t.memberIds = t.memberIds.filter((x) => x !== id); });
        removed = 1;
      }
      audit(user.name, 'event players', T.name + ': +' + add.length + (removed ? ' -1' : '')); save(); broadcast();
      return json(res, 200, { ok: true, added: add.length, removed });
    }
    /* ---- a game (sub-event) always has an organizer and a referee: create both inline if needed ---- */
    const gameStaff = (b, pins) => {
      const orgIds = (Array.isArray(b.organizerIds) ? b.organizerIds : []).map(String).filter((id) => db.admins.some((a) => a.id === id));
      const refIds = (Array.isArray(b.refereeIds) ? b.refereeIds : []).map(String).filter((id) => { const r = find('referees', id); return r && r.status !== 'pending'; });
      staffNames(b.newOrganizers).forEach((x) => { const a = newOrganizer(x.name, { sports: [], limited: true }); if (x.playerId) a.playerId = x.playerId; pins.push({ role: 'Organizer', name: a.name, pin: a._pin }); delete a._pin; orgIds.push(a.id); });
      if (b.newOrganizer && str(b.newOrganizer, 40).trim()) { const a = newOrganizer(str(b.newOrganizer, 40).trim(), { sports: [], limited: true }); pins.push({ role: 'Organizer', name: a.name, pin: a._pin }); delete a._pin; orgIds.push(a.id); }
      staffNames(b.newReferees).forEach((x) => { const r = COLS.referees({ name: x.name, kind: 'referee' }, null); if (x.playerId) r.playerId = x.playerId; pins.push({ role: 'Referee', name: r.name, pin: r._plain }); delete r._plain; db.referees.push(r); refIds.push(r.id); });
      if (!refIds.length) throw new HttpError(400, 'Every game needs at least one referee – choose one or add a new one.');
      return { organizerIds: [...new Set(orgIds)], refereeIds: [...new Set(refIds)] };
    };
    if (p === '/api/admin/games' && m === 'POST') {
      const b = await readJson(req, 20000);
      const tid = tidOf(b.tid);
      const sport = SPORTS.includes(b.sport) ? b.sport : 'other', section = b.section === 'kids' ? 'kids' : 'adults';
      if (isLead(user) && !tourOrg(user, tid) && !(user.sports || []).includes(sport)) throw new HttpError(403, 'You can only add games to events you organize.');
      if (tour(tid).status === 'closed') throw new HttpError(409, tour(tid).name + ' is closed.');
      const kind = ['singles', 'doubles', 'team'].includes(b.kind) ? b.kind : 'singles';
      const name = str(b.name, 80).trim() || ({ badminton: 'Badminton', tt: 'Table Tennis', carrom: 'Carrom', chess: 'Chess' }[sport] || 'Game') + (kind === 'doubles' ? ' – Doubles' : kind === 'team' ? ' – Team Event' : '') + (section === 'kids' ? ' (Kids)' : '');
      if (db.events.some((e) => e.tid === tid && e.name.toLowerCase() === name.toLowerCase() && (e.section || 'adults') === section)) throw new HttpError(409, 'A game called "' + name + '" already exists in ' + tour(tid).name + '.');
      if (!(Array.isArray(b.refereeIds) && b.refereeIds.length) && !(b.newReferees && b.newReferees.length)) b.refereeIds = tour(tid).refereeIds;   // the event's referees by default
      const pins = [], staff = gameStaff(b, pins);
      const like = db.events.find((e) => e.sport === sport && (e.section || 'adults') === section && (e.sideType === 'team') === (kind === 'team')) || db.events.find((e) => e.sport === sport)
        || [...seedEvents(), ...seedKidsEvents()].find((e) => e.sport === sport && e.section === section) || seedEvents().find((e) => e.sport === sport);
      const ev = normEvent({ name, sport, section, sideType: kind === 'team' ? 'team' : 'player', sideSize: kind === 'doubles' ? 2 : 1, scoring: like ? like.scoring : 'points', config: like ? like.config : {}, participantIds: [], tid, ...staff }, null);
      db.events.push(ev); audit(user.name, 'created game', name + ' in ' + tour(tid).name); save(); broadcast();
      return json(res, 200, { event: ev, pins });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/staff$/)) && m === 'PUT') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Game not found');
      const pins = [], staff = gameStaff(await readJson(req, 20000), pins);
      ev.organizerIds = staff.organizerIds; ev.refereeIds = staff.refereeIds;
      audit(user.name, 'set organizer & referees', ev.name); save(); broadcast();
      return json(res, 200, { ok: true, pins });
    }
    /* ---- team builder for a team game: players who chose the game -> teams entered in it ---- */
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/(teams|auto-teams)$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Game not found');
      if (ev.sideType !== 'team') throw new HttpError(400, ev.name + ' is not a team game.');
      const sec = ev.section || 'adults', b = await readJson(req, 20000);
      const placed = new Set(ev.participantIds.flatMap((tid) => (find('teams', tid) || { memberIds: [] }).memberIds));
      const freeName = () => { let n = 1; while (db.teams.some((x) => x.section === sec && x.tid === ev.tid && x.name.toLowerCase() === 'team ' + n)) n++; return 'Team ' + n; };
      const make = (name, ids) => {
        const t = COLS.teams({ name, section: sec, memberIds: ids, tid: ev.tid }, null);
        if (db.teams.some((x) => x.section === sec && x.tid === ev.tid && x.name.toLowerCase() === t.name.toLowerCase())) throw new HttpError(409, 'A team called "' + t.name + '" already exists – choose another name.');
        db.teams.push(t); ev.participantIds.push(t.id);
        ev.interestedIds = (ev.interestedIds || []).filter((id) => !ids.includes(id));
        return t;
      };
      if (mm[2] === 'teams') {
        const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(String))].filter((id) => { const pl = find('players', id); return pl && (pl.section || 'adults') === sec && inRoster(ev.tid, id); });
        const t = make(str(b.name, 60).trim() || freeName(), ids);
        audit(user.name, 'made team for ' + ev.name, t.name + ' (' + ids.length + ' players)'); save(); broadcast();
        return json(res, 200, t);
      }
      const pool = (ev.interestedIds || []).map((id) => find('players', id)).filter((pl) => pl && !placed.has(pl.id) && (pl.section || 'adults') === sec && inRoster(ev.tid, pl.id));
      if (pool.length < 2) throw new HttpError(400, 'At least 2 players must be waiting for a team.');
      const size = clampN(b.size, 2, 20, 4), k = Math.max(1, Math.round(pool.length / size));
      for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const order = { F: 0, M: 1 }; pool.sort((a, c) => (order[a.gender] ?? 2) - (order[c.gender] ?? 2));   // deal women, then men, so teams are mixed evenly
      const groups = Array.from({ length: k }, () => []); pool.forEach((pl, i) => groups[i % k].push(pl.id));
      const made = groups.map((ids) => make(freeName(), ids));
      audit(user.name, 'auto-made teams for ' + ev.name, made.length + ' teams from ' + pool.length + ' players'); save(); broadcast();
      return json(res, 200, { teams: made.length, players: pool.length });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/teams\/([\w-]+)\/remove$/)) && m === 'POST') {
      const ev = find('events', mm[1]), t = find('teams', mm[2]); if (!ev || !t) throw new HttpError(404, 'Not found');
      if (db.matches.some((x) => x.eventId === ev.id && (x.sideA.includes(t.id) || x.sideB.includes(t.id)))) throw new HttpError(409, t.name + ' already has fixtures in ' + ev.name + ' – use Withdraw / replace instead.');
      ev.participantIds = ev.participantIds.filter((id) => id !== t.id);
      ev.interestedIds = [...new Set((ev.interestedIds || []).concat(t.memberIds))];
      audit(user.name, 'removed team from ' + ev.name, t.name); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/referees\/([\w-]+)\/approve$/)) && m === 'POST') {
      const r = find('referees', mm[1]); if (!r) throw new HttpError(404, 'Not found');
      const b = await readJson(req, 3000);
      const pin = pinN(4); r.pinHash = hashPin(pin); r.status = 'active';
      if (['referee', 'chief', 'volunteer'].includes(b.kind)) r.kind = b.kind;
      if (Array.isArray(b.sports)) r.sports = [...new Set(b.sports.filter((x) => SPORTS.includes(x)))];
      if (Array.isArray(b.eventIds)) r.eventIds = [...new Set(b.eventIds.map(String).filter((x) => find('events', x)))];
      audit(user.name, 'approved referee', r.name); save(); broadcast();
      return json(res, 200, { ok: true, name: r.name, pin });
    }
    if (p === '/api/admin/players/approve-all' && m === 'POST') {
      let n = 0; db.players.filter((x) => x.status === 'pending').forEach((x) => { x.status = 'approved'; enrol(x); n++; });
      db.players.filter((x) => x.status === 'approved' && x.editTokenHash).forEach((x) => approvedPush(x));
      audit(user.name, 'approved registrations', n + ' players'); save(); broadcast(); return json(res, 200, { ok: true, approved: n });
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)\/games$/)) && m === 'PUT') {
      const pl = find('players', mm[1]); if (!pl) throw new HttpError(404, 'Not found');
      const b = await readJson(req, 3000); const r = setGames(pl, b.eventIds, true);
      audit(user.name, 'set games', pl.name + ': +' + r.added + ' -' + r.removed); save(); broadcast(); return json(res, 200, { ok: true, ...r });
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)\/approve$/)) && m === 'POST') {
      const pl = find('players', mm[1]); if (!pl) throw new HttpError(404, 'Not found');
      pl.status = 'approved'; const r = enrol(pl);
      approvedPush(pl);
      audit(user.name, 'approved registration', pl.name); save(); broadcast(); return json(res, 200, { ok: true, ...r });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/withdraw$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Event not found');
      const b = await readJson(req, 2000); const id = String(b.participantId || '');
      if (!ev.participantIds.includes(id)) throw new HttpError(400, 'Not in this event');
      let n = 0;
      db.matches.forEach((x) => {
        if (x.eventId !== ev.id || Engine.derive(x, ev).status !== 'scheduled') return;
        const side = x.sideA.includes(id) ? 'B' : x.sideB.includes(id) ? 'A' : null; if (!side) return;
        x.walkover = side; x.outcome = 'walkover'; n++;
      });
      if (!ev.withdrawn.includes(id)) ev.withdrawn.push(id);
      audit(user.name, 'withdrew from ' + ev.name, nameOf(ev, id) + ': ' + n + ' match(es) awarded to opponents'); save(); broadcast();
      return json(res, 200, { ok: true, awarded: n });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/replace$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Event not found');
      const b = await readJson(req, 2000); const oldId = String(b.oldId || ''), newId = String(b.newId || '');
      if (!ev.participantIds.includes(oldId)) throw new HttpError(400, 'The player to replace is not in this event');
      if (ev.participantIds.includes(newId)) throw new HttpError(400, 'The replacement is already in this event');
      checkSection([newId], ev.sideType === 'team' ? 'teams' : 'players', ev.section || 'adults');
      let n = 0;
      db.matches.forEach((x) => {
        if (x.eventId !== ev.id || Engine.derive(x, ev).status !== 'scheduled') return;
        ['sideA', 'sideB'].forEach((k) => { const ix = x[k].indexOf(oldId); if (ix !== -1) { x[k][ix] = newId; n++; } });
      });
      ev.participantIds[ev.participantIds.indexOf(oldId)] = newId;
      ev.withdrawn = ev.withdrawn.filter((x) => x !== oldId);
      audit(user.name, 'replaced in ' + ev.name, nameOf(ev, oldId) + ' → ' + nameOf(ev, newId) + ' in ' + n + ' unplayed match(es)'); save(); broadcast();
      return json(res, 200, { ok: true, updated: n });
    }
    if ((mm = p.match(/^\/api\/admin\/players\/([\w-]+)$/)) && m === 'GET') {
      const x = find('players', mm[1]); if (!x) throw new HttpError(404, 'Not found');
      const { pinHash, pinIdx: _pi, editTokenHash, ...safe } = x;
      return json(res, 200, { ...safe, hasPin: !!pinHash });
    }
    if ((mm = p.match(/^\/api\/admin\/matches\/([\w-]+)\/reset$/)) && m === 'POST') {
      const match = find('matches', mm[1]); if (!match) throw new HttpError(404, 'Match not found');
      match.log = []; match.cids = []; match.result = null; match.walkover = null; match.retired = null; match.outcome = ''; delete match.startedAt; delete match.lock; delete match.notified15;
      (match.rubbers || []).forEach((r) => { r.log = []; r.cids = []; r.result = null; r.walkover = null; r.outcome = ''; });
      audit(user.name, 'reset scores', '', match.id); save(); broadcast(); return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/matches\/([\w-]+)\/scores$/)) && m === 'POST') {
      const match = find('matches', mm[1]); if (!match) throw new HttpError(404, 'Match not found');
      const b = await readJson(req);
      const games = writeGames(match, b, user.name, 'admin-edit');
      delete match.paper;
      audit(user.name, 'corrected scores', games.map((g) => g.a + '-' + g.b).join(', '), match.id); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/generate$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Event not found');
      const b = await readJson(req);
      const courts = str(b.courts, 200).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
      const start = SLOT_RE.test(b.start || '') ? b.start : '';
      const slot = Math.max(5, Math.min(240, Math.round(num(b.slotMinutes, 25))));
      let ids = ev.participantIds.filter((x) => !(ev.withdrawn || []).includes(x));
      if (b.random) { ids = ids.slice(); for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; } }
      if (b.mode === 'groups' || b.mode === 'knockout' || b.mode === 'swiss') {
        if (ev.sideSize !== 1) throw new HttpError(400, 'This format needs a singles or team event');
        const slot2 = (rounds2) => Fx.assignSlots(rounds2, courts, start, slot);
        if (b.mode === 'swiss') {
          const r = swissNext(ev, { courts, start, slot });
          audit(user.name, 'generated Swiss round ' + r.round, ev.name + ': ' + r.created + ' matches' + (r.bye ? ', 1 bye' : '')); save(); broadcast();
          return json(res, 200, r);
        }
        if (b.mode === 'groups') {
          if (ev.groups && Object.keys(ev.groups).length) throw new HttpError(409, 'Groups are already drawn. Use "Reset draw" to start over.');
          let g; try { g = Fx.drawGroups(ids, ev.format.groups, null); } catch (e) { throw new HttpError(400, e.message); }
          const rounds2 = Fx.groupRounds(g, ev.format.doubleRR), sl = slot2(rounds2); let k = 0;
          ev.groups = g;
          rounds2.forEach((r, ri) => r.forEach((x, i) => { db.matches.push(normMatch({ eventId: ev.id, stage: 'League', ...x, round: ri + 1, court: sl[ri][i].court, startsAt: sl[ri][i].startsAt }, null)); k++; }));
          audit(user.name, 'drew groups', ev.name + ': ' + Object.keys(g).length + ' groups, ' + k + ' matches'); save(); broadcast();
          return json(res, 200, { created: k, groups: Object.keys(g).length });
        }
        if (ev.bracket) throw new HttpError(409, 'The bracket is already drawn. Use "Reset draw" to start over.');
        if (ids.length < 2) throw new HttpError(400, 'Enrol at least 2 players/teams first');
        ev.bracket = { order: Engine.bracketOrder(ids) };
        let plan; try { plan = Fx.koPlan(ev, db.matches, Engine.bracket); } catch (e) { delete ev.bracket; throw new HttpError(400, e.message); }
        const sl = slot2([plan])[0];
        makeMatches(ev, plan, (i) => ({ court: sl[i].court, startsAt: sl[i].startsAt, round: 1 }));
        audit(user.name, 'drew knockout bracket', ev.name + ': ' + ids.length + ' entries, ' + plan.length + ' first-round matches'); save(); broadcast();
        return json(res, 200, { created: plan.length, stage: plan[0].stage });
      }
      let rounds;
      try {
        if (b.mode === 'doubles') {
          if (ev.sideSize !== 2) throw new Error('This event is not doubles');
          const league = db.matches.filter((x) => x.eventId === ev.id && x.stage === 'League');
          rounds = Fx.doublesRounds(ids, Fx.buildHistory(league), Math.max(1, Math.min(20, Math.round(num(b.rounds, 1)))));
        } else {
          if (ev.sideSize !== 1) throw new Error('Round-robin is for singles and team events');
          if (ids.length < 2) throw new Error('Enrol at least 2 players/teams first');
          let rr = Fx.roundRobin(ids);
          if (b.double) rr = rr.concat(rr.map((r) => r.map(([x, y]) => [y, x])));
          const exists = new Set(db.matches.filter((x) => x.eventId === ev.id && x.stage === 'League').map((x) => x.sideA[0] + '>' + x.sideB[0]));
          rounds = rr.map((r) => r.filter(([x, y]) => !(exists.has(x + '>' + y) || (!b.double && exists.has(y + '>' + x)))).map(([x, y]) => ({ sideA: [x], sideB: [y] }))).filter((r) => r.length);
        }
      } catch (e) { throw new HttpError(400, e.message); }
      if (!rounds.length) throw new HttpError(400, 'Nothing new to create');
      const slots = Fx.assignSlots(rounds, courts, start, slot);
      const base = Math.max(0, ...db.matches.filter((x) => x.eventId === ev.id).map((x) => x.round || 0));
      let n = 0;
      rounds.forEach((r, ri) => r.forEach((x, k) => {
        db.matches.push(normMatch({ eventId: ev.id, stage: 'League', sideA: x.sideA, sideB: x.sideB, court: slots[ri][k].court, startsAt: slots[ri][k].startsAt, round: base + ri + 1 }, null)); n++;
      }));
      audit(user.name, 'generated fixtures', ev.name + ': ' + n + ' matches'); save(); broadcast();
      return json(res, 200, { created: n, rounds: rounds.length });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/finals$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Event not found');
      const b = await readJson(req);
      const plan = advanceEvent(ev, user.name, !!b.force);
      save(); broadcast();
      return json(res, 200, { created: plan.length, stage: plan[0].stage });
    }
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/reset-draw$/)) && m === 'POST') {
      const ev = find('events', mm[1]); if (!ev) throw new HttpError(404, 'Event not found');
      const b = await readJson(req);
      const mine = db.matches.filter((x) => x.eventId === ev.id);
      const played = mine.filter((x) => Engine.derive(x, ev).status !== 'scheduled').length;
      if (played && !b.force) throw new HttpError(409, played + ' match(es) already have scores. Resetting deletes ALL ' + mine.length + ' fixtures of this event.', { needForce: true });
      db.matches = db.matches.filter((x) => x.eventId !== ev.id);
      delete ev.groups; delete ev.bracket; ev.byes = [];
      audit(user.name, 'reset draw', ev.name + ': ' + mine.length + ' fixtures removed'); save(); broadcast();
      return json(res, 200, { ok: true, removed: mine.length });
    }
    if (p === '/api/admin/shift' && m === 'POST') {
      const b = await readJson(req, 2000);
      const mins = Math.round(num(b.minutes, 0));
      if (!mins || Math.abs(mins) > 600) throw new HttpError(400, 'Enter minutes between 1 and 600 (negative = earlier)');
      const from = SLOT_RE.test(b.from || '') ? b.from : nowLocal();
      let n = 0;
      db.matches.forEach((x) => {
        const ev = find('events', x.eventId);
        if (!ev || !SLOT_RE.test(x.startsAt || '') || x.startsAt < from || Engine.derive(x, ev).status === 'completed') return;
        if (b.eventId && x.eventId !== b.eventId) return;
        if (b.court && String(x.court || '').toLowerCase() !== String(b.court).toLowerCase()) return;
        x.startsAt = Fx.addMinutes(x.startsAt, mins); delete x.notified15; n++;
      });
      audit(user.name, 'shifted schedule', (mins > 0 ? '+' : '') + mins + ' min for ' + n + ' match(es) from ' + from.replace('T', ' ') + (b.court ? ', ' + b.court : '') + (b.eventId ? ', ' + ((find('events', b.eventId) || {}).name || '') : ''));
      save(); broadcast();
      return json(res, 200, { ok: true, moved: n });
    }
    if ((mm = p.match(/^\/api\/admin\/gallery\/([\w-]+)$/)) && m === 'DELETE') {
      db.gallery = db.gallery.filter((g) => g.id !== mm[1]); save(); broadcast(); return json(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/(players|teams|referees|events|matches|sponsors)(?:\/([\w-]+))?$/))) {
      const col = mm[1], id = mm[2];
      const finish = (item, code) => {
        const plain = item._plain; delete item._plain;
        save(); broadcast();
        return json(res, code || 200, col === 'referees' ? { id: item.id, name: item.name, kind: item.kind, sports: item.sports, eventIds: item.eventIds, status: item.status, pin: plain } : item);
      };
      if (m === 'POST' && !id) {
        const b = await readJson(req);
        if (col === 'matches' && !sportOk(user, find('events', b.eventId))) throw new HttpError(403, 'That event belongs to another sport.');
        if (col === 'events' && isLead(user) && !(user.sports || []).includes(b.sport)) throw new HttpError(403, 'You can only add events for your sport.');
        const item = COLS[col](b, null);
        if (col === 'players') { const tid = tidOf(b.tid); if (!canTour(user, tid) && isLead(user)) throw new HttpError(403, 'Only this event’s organizers can add players to it.'); addRoster(tid, [item.id]); }
        if (col === 'matches') { const c = findClashes(item); if (c.length && !b.force) throw new HttpError(409, 'Schedule clash:\n• ' + c.join('\n• '), { clash: true, clashes: c }); }
        db[col].push(item); audit(user.name, 'created ' + col.slice(0, -1), item.name || '', col === 'matches' ? item.id : '');
        return finish(item);
      }
      if (m === 'PUT' && id) {
        const prev = find(col, id); if (!prev) throw new HttpError(404, 'Not found');
        const b = await readJson(req);
        const item = COLS[col](b, prev);
        if (col === 'matches') { const c = findClashes(item); if (c.length && !b.force) throw new HttpError(409, 'Schedule clash:\n• ' + c.join('\n• '), { clash: true, clashes: c }); }
        db[col][db[col].indexOf(prev)] = item; if (col === 'events') syncRubbers(item);
        audit(user.name, 'edited ' + col.slice(0, -1), item.name || '', col === 'matches' ? item.id : '');
        return finish(item);
      }
      if (m === 'DELETE' && id) {
        if (!find(col, id)) throw new HttpError(404, 'Not found');
        if (col === 'players' && find(col, id).status !== 'pending') throw new HttpError(403, 'Player profiles are permanent. Remove the player from an event instead, or merge a duplicate into the right profile.');
        const snap = snapshot(col, id);
        cascadeDelete(col, id); pushTrash(snap); audit(user.name, 'deleted ' + col.slice(0, -1), snap.name || id, col === 'matches' ? id : '');
        save(); broadcast(); return json(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, 'Unknown admin route');
  }

  if (p.startsWith('/api/')) throw new HttpError(404, 'Unknown route');

  /* ---- static ---- */
  if (p.startsWith('/uploads/')) {
    return serveFile(req, res, path.join(UPLOAD_DIR, path.basename(p)), 'public, max-age=31536000, immutable', { 'Content-Security-Policy': "default-src 'none'; sandbox" });
  }
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  return serveFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x');
  try { await route(req, res, url); }
  catch (e) {
    if (e instanceof HttpError) return json(res, e.code, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n==============================================');
  console.log('  Tournament app v4 is running');
  console.log('  On this computer : http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  Same Wi-Fi only  : http://' + ip + ':' + PORT));
  if (initialPin) console.log('  Admin PIN        : ' + initialPin + '   (shown only now – write it down; change it in Admin > Setup)');
  else console.log('  Admin PIN        : unchanged (forgot it? run: ./start.command --reset-pin)');
  console.log('==============================================\n');
});

module.exports = { server };
