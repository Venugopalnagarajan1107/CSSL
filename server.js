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
    tournament: { tz: 'Asia/Kolkata', sponsorSeconds: 8, name: 'Tournament Name', tagline: 'Badminton • Carrom • Chess • Table Tennis', dates: '', venue: '', logo: '', primary: '#0f766e', showKidsPhotos: false, signers: [] },
    admins: [{ id: uid(), name: 'Admin', pinHash: hashPin(initialPin) }], sessions: {}, vapid: webpush.generateVAPIDKeys(),
    players: [], teams: [], referees: [], events: seedEvents(), matches: [], sponsors: [], gallery: [], subs: [], audit: [], kidsSeeded: true,
  };
}

/* Bring older data (v1) up to date. Safe to run repeatedly. */
function migrate(d) {
  d.version = 3;
  d.tournament = d.tournament || {};
  const t = d.tournament;
  if (t.showKidsPhotos === undefined) t.showKidsPhotos = false;
  if (!Array.isArray(t.signers) || !t.signers.length) t.signers = [{ name: '', title: 'Organizer', image: '' }, { name: '', title: 'Chief Referee', image: '' }];
  ['players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'subs', 'audit', 'disputes', 'trash'].forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
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
  d.referees.forEach((r) => { if (r.pin) { r.pinHash = hashPin(r.pin); delete r.pin; } if (!['referee', 'chief', 'volunteer'].includes(r.kind)) r.kind = 'referee'; });
  if (!d.kidsSeeded) { if (!d.events.some((e) => e.section === 'kids')) d.events.push(...seedKidsEvents()); d.kidsSeeded = true; }
  if (!d.vapid) d.vapid = webpush.generateVAPIDKeys();
  if (!Array.isArray(d.cards)) d.cards = [];
  if (!d.suspend || typeof d.suspend !== 'object') d.suspend = {};
  if (!Array.isArray(d.admins)) d.admins = [];
  if (d.adminPinHash) { d.admins.push({ id: uid(), name: 'Admin', pinHash: d.adminPinHash }); delete d.adminPinHash; }
  if (!d.admins.length) { initialPin = pinN(6); d.admins.push({ id: uid(), name: 'Admin', pinHash: hashPin(initialPin) }); }
  d.admins.forEach((a) => { if (!Array.isArray(a.sports)) a.sports = []; });
  return d;
}

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
function save() {
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
function regOpen() {
  const r = db.registration;
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
  const r = db.registration;
  return {
    open: regOpen(), publicUrl: r.publicUrl || '', deadline: r.deadline, codeRequired: !!r.joinCode, notice: r.notice, kidsNotice: r.kidsNotice,
    events: db.events.filter((e) => e.selfRegister !== false).map((e) => ({ id: e.id, team: e.sideType === 'team', name: e.name, section: e.section, ageMin: e.ageMin || 0, ageMax: e.ageMax || 0, full: e.maxParticipants > 0 && requestedCount(e) >= e.maxParticipants })),
    ...(isAdmin ? { enabled: r.enabled, joinCode: r.joinCode, pending: db.players.filter((p) => p.status === 'pending').length } : {}),
  };
}

/* Staff appear by first name on public screens; a last initial is added only when two share a first name. */
function refDisplay(r) {
  const f = firstOf(r.name), same = db.referees.filter((x) => firstOf(x.name).toLowerCase() === f.toLowerCase());
  const parts = String(r.name).trim().split(/\s+/);
  return same.length > 1 && parts.length > 1 ? f + ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : f;
}
function publicState(mode) {
  const isAdmin = mode === 'admin', names = mode === 'public' ? publicNames() : null;
  const { signers, ...tour } = db.tournament;
  const flaggedSet = new Set(db.disputes.filter((d) => !d.resolved).map((d) => d.matchId));
  return {
    tournament: { ...tour, signers },
    players: db.players.filter((p) => isAdmin || p.status !== 'pending').map((p) => publicPlayer(p, mode, names)),
    teams: db.teams.map(({ captainHash, ...t }) => ({ ...t, hasCode: !!captainHash })), referees: db.referees.map((r) => ({ id: r.id, name: mode === 'public' ? refDisplay(r) : r.name, kind: r.kind })), events: db.events,
    matches: db.matches.map(({ cids, lock, ...m00 }) => { const m0 = mode === 'public' ? (panic().hideScoreboard ? blankScores(m00) : paperPublic(m00)) : m00; const m = mode === 'public' && !tieRevealed(m0) ? hideLineups(m0) : m0; const o = flaggedSet.has(m.id) ? { ...m, flagged: true } : m; return m.rubbers ? { ...o, rubbers: m.rubbers.map(({ cids: c2, ...r }) => r) } : o; }),
    sponsors: db.sponsors, gallery: mode === 'public' ? db.gallery.filter((g) => g.consent !== false && (!g.minors || db.tournament.showKidsPhotos)).map((g) => ({ ...g, caption: '' })) : db.gallery.filter((g) => isAdmin || !g.minors || db.tournament.showKidsPhotos),
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
    withdrawn: (prev.withdrawn || []).filter((x) => participantIds.includes(x)), interestedIds: prev.interestedIds || [],
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
    round: Math.max(0, Math.round(num(b.round, prev.round || 0))), totalRounds: Math.max(0, Math.min(99, Math.round(num(b.totalRounds, prev.totalRounds || 0)))), ...matchCfg(b, prev), refereeId: b.refereeId !== undefined ? str(b.refereeId, 20) : prev.refereeId || '',
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
      status: (p && p.status) || 'approved', requestedEventIds: (p && p.requestedEventIds) || [], registeredAt: (p && p.registeredAt) || 0, consentAt: (p && p.consentAt) || 0, editTokenHash: (p && p.editTokenHash) || '',
    };
  },
  teams: (b, p) => {
    const section = SECTIONS.includes(b.section) ? b.section : (p && p.section) || 'adults';
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds.map(String) : (p && p.memberIds) || [];
    checkSection(memberIds, 'players', section);
    const cap = b.captainId !== undefined ? String(b.captainId || '') : (p && p.captainId) || '';
    return { id: (p && p.id) || uid(), name: needName(b, p), section, memberIds, color: str(b.color != null ? b.color : (p && p.color) || '', 20), captainId: memberIds.includes(cap) ? cap : '', ...(p && p.captainHash ? { captainHash: p.captainHash } : {}) };
  },
  referees: (b, p) => {
    let plain = null;
    if (/^\d{4,8}$/.test(String(b.pin || ''))) plain = String(b.pin); else if (!p || b.resetPin) plain = pinN(4);
    const kind = ['referee', 'chief', 'volunteer'].includes(b.kind) ? b.kind : (p && p.kind) || 'referee';
    return { id: (p && p.id) || uid(), name: needName(b, p), kind, pinHash: plain ? hashPin(plain) : p.pinHash, _plain: plain };
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
    db.events.forEach((e) => { e.participantIds = e.participantIds.filter((x) => x !== id); e.interestedIds = (e.interestedIds || []).filter((x) => x !== id); });
  } else if (col === 'teams') {
    if (used('team')) throw new HttpError(409, 'Team has matches. Delete those matches first.');
    db.events.forEach((e) => { e.participantIds = e.participantIds.filter((x) => x !== id); e.interestedIds = (e.interestedIds || []).filter((x) => x !== id); });
  } else if (col === 'events') db.matches = db.matches.filter((m) => m.eventId !== id);
  else if (col === 'referees') {
    db.matches.forEach((m) => { if (m.refereeId === id) m.refereeId = ''; });
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
  if (col === 'referees') db.matches.forEach((m) => m.refereeId === id && s.links.matches.push(m.id));
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
  (sn.links.matches || []).forEach((m) => { const x = find('matches', m); if (x && col === 'referees') x.refereeId = it.id; });
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
};
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
  const pc = panic();
  if (pc.freezeScoring) throw new HttpError(423, 'Scoring is paused by the organizer. Please wait for the announcement.');
  if (match && pc.lockedEvents.includes(match.eventId)) throw new HttpError(423, 'This event is locked by the organizer.');
}
/* A whole result from a paper score sheet. The referee enters it, the chief referee signs it off; it stays labelled "from paper". */
function applyPaper(match, b, user) {
  const ev = find('events', match.eventId);
  if (!ev) throw new HttpError(404, 'Event not found');
  const live = (match.log || []).length || match.result || (match.rubbers || []).some((r) => (r.log || []).length || r.result);
  if (live && !(user.role === 'referee' && user.kind === 'chief')) throw new HttpError(409, 'This match already has live scores. Ask the chief referee to correct it.');
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
const needStaff = (u) => { if (!u) throw new HttpError(401, 'Please sign in'); if (u.role === 'captain') throw new HttpError(403, 'Staff only.'); return u; };
const needScorer = (u) => { needStaff(u); if (u.role !== 'referee' || u.kind === 'volunteer') throw new HttpError(403, 'Only referees can change scores. The organizer assigns referees.'); return u; };
const needLineup = (u) => { if (u && u.role === 'captain') return u; needStaff(u); if (u.role === 'referee' && u.kind === 'volunteer') throw new HttpError(403, 'Volunteers cannot change line-ups.'); return u; };
const sportOk = (u, ev) => !(u.sports && u.sports.length) || (ev && u.sports.includes(ev.sport));
const needAdmin = (u) => { needStaff(u); if (u.role !== 'admin') throw new HttpError(403, 'Admin only'); return u; };

const fileCache = new Map();   /* app files are read once, compressed once, and revalidated with an ETag */
function serveFile(req, res, file, cache, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = 'W/"' + st.size + '-' + Math.round(st.mtimeMs) + '"';
    const headers = { 'Content-Type': type, 'Cache-Control': cache || 'no-cache', ETag: etag, ...(extra || {}) };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
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

async function exportXlsx(admin) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = db.tournament.name;
  for (const ev of db.events) {
    const ws = wb.addWorksheet(((ev.section === 'kids' && !/^Kids/i.test(ev.name) ? 'Kids ' : '') + ev.name).replace(/[\\/*?:[\]]/g, '').slice(0, 31));
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
    if (user && user.role === 'referee') return json(res, 200, publicState('staff'));
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
    const bad = () => { recordFail(ipK, 8); recordFail('glob:' + (b.role === 'admin' ? 'admin' : str(b.refereeId || b.teamId, 20)), b.role === 'admin' ? 25 : 5); throw new HttpError(401, 'Wrong PIN'); };
    if (b.role === 'captain') {
      const t = find('teams', b.teamId);
      if (!t || !t.captainHash || !checkPin(String(b.pin || ''), t.captainHash)) bad();
      sess = { role: 'captain', name: t.name, teamId: t.id, exp: Date.now() + 24 * 3600e3 };
    } else if (b.role === 'admin') {
      const a = db.admins.find((x) => checkPin(String(b.pin || ''), x.pinHash));
      if (!a) bad();
      sess = { role: 'admin', name: a.name, adminId: a.id, sports: a.sports || [], exp: Date.now() + 12 * 3600e3 };
    } else {
      const r = find('referees', b.refereeId);
      if (!r || !checkPin(String(b.pin || ''), r.pinHash)) bad();
      sess = { role: 'referee', name: r.name, refId: r.id, kind: r.kind || 'referee', exp: Date.now() + 36 * 3600e3 };
    }
    fails.delete(ipK);
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].exp && db.sessions[t].exp < Date.now()) delete db.sessions[t]; });
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = sess;
    audit(sess.name, 'login', sess.role);
    save();
    return json(res, 200, { token, role: sess.role, name: sess.name, kind: sess.kind || '', sports: sess.sports || [], teamId: sess.teamId || '' });
  }
  if (p === '/api/me' && m === 'GET') return json(res, 200, user ? { role: user.role, name: user.name, kind: user.kind || '', sports: user.sports || [] } : { role: null });
  if (p === '/api/logout' && m === 'POST') { if (user) { delete db.sessions[user.token]; save(); } return json(res, 200, { ok: true }); }

  /* ---- staff: scoring (batch of ops, idempotent) ---- */
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/ops$/)) && m === 'POST') {
    needScorer(user);
    const match = find('matches', mt[1]);
    if (!match) throw new HttpError(404, 'Match not found');
    assertOpen(match);
    const ev = find('events', match.eventId);
    if (user.role === 'referee' && user.kind !== 'chief' && db.tournament.enforceReferee && match.refereeId && match.refereeId !== user.refId) throw new HttpError(403, 'This match is assigned to another referee.');
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
    if (user.kind !== 'chief' && db.tournament.enforceReferee && match.refereeId && match.refereeId !== user.refId) throw new HttpError(403, 'This match is assigned to another referee.');
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
    needStaff(user); if (!(user.role === 'referee' && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee can revoke a card.');
    const c = db.cards.find((x) => x.id === mt[1]); if (!c) throw new HttpError(404, 'Card not found');
    if (!c.revoked) { c.revoked = true; if (c.color === 'red') db.suspend[c.playerId] = Math.max(0, (db.suspend[c.playerId] || 0) - 2); audit(user.name, 'card revoked', ((find('players', c.playerId) || {}).name || '') + ' (' + c.color + ')', c.matchId); save(); broadcast(); }
    return json(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/paper$/)) && m === 'POST') {
    needScorer(user);
    const match = find('matches', mt[1]); if (!match) throw new HttpError(404, 'Match not found');
    assertOpen(match);
    if (user.kind !== 'chief' && db.tournament.enforceReferee && match.refereeId && match.refereeId !== user.refId) throw new HttpError(403, 'This match is assigned to another referee.');
    applyPaper(match, await readJson(req, 4000), user);
    if (Engine.derive(match, find('events', match.eventId)).status === 'completed') autoAdvance(find('events', match.eventId), user.name);
    save(); broadcast(); return json(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/matches\/([\w-]+)\/paper\/sign$/)) && m === 'POST') {
    needStaff(user); if (!(user.role === 'referee' && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee signs off paper scores.');
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
    if (user.role === 'referee' && user.kind !== 'chief' && db.tournament.enforceReferee && match.refereeId && match.refereeId !== user.refId) throw new HttpError(403, 'This match is assigned to another referee.');
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
  if (p === '/api/register' && m === 'POST') {
    limit('reg:' + ip, 150, 3600e3, 'Too many registrations from this network. Please try again later.');
    const b = await readJson(req, 20000);
    if (b.website) return json(res, 200, { ok: true });          /* honeypot: bots fill hidden fields */
    if (!regOpen()) throw new HttpError(403, 'Registration is closed.');
    const r = db.registration;
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
      if (!ev || ev.selfRegister === false) throw new HttpError(400, 'One of the chosen events is not open for registration.');
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
    Object.assign(pl, { status: 'pending', requestedEventIds: ids, registeredAt: Date.now(), consentAt: Date.now(), editTokenHash: sha(tok) });
    db.players.push(pl);
    audit('Registration', 'registered', name + ' (' + section + ')');
    save(); broadcast();
    return json(res, 200, { ok: true, id: pl.id, playerNo: pl.playerNo, editToken: tok, status: 'pending' });
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
    if (dl) {
      const e = dlTokens.get(dl); dlTokens.delete(dl);
      if (!e || e.exp < Date.now()) throw new HttpError(403, 'That download link has expired. Create a new one.');
      adminXl = true;
    }
    const buf = await exportXlsx(adminXl);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="tournament-results.xlsx"' });
    return res.end(Buffer.from(buf));
  }

  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    const chiefPath = /^\/api\/admin\/matches\/[\w-]+\/(scores|reset)$/.test(p);
    if (chiefPath) { needStaff(user); if (!(user.role === 'referee' && user.kind === 'chief')) throw new HttpError(403, 'Only the chief referee corrects or resets scores.'); } else needAdmin(user);
    let mm;
    if (user.sports && user.sports.length) {
      if (/^\/api\/admin\/(admins|pin|tournament|revoke-sessions|purge|backup|restore|new-tournament|trash|registration|export-link|secrets|shift|panic|snapshots|rollback|import-|reachability)/.test(p)) throw new HttpError(403, 'This is for the organizer only. Sport leads manage their own sport.');
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
    if (p === '/api/admin/admins' && m === 'GET') return json(res, 200, db.admins.map((a) => ({ id: a.id, name: a.name, sports: a.sports || [], me: a.id === me().id })));
    if (p === '/api/admin/admins' && m === 'POST') {
      const b = await readJson(req, 2000); const name = str(b.name, 40);
      if (!name) throw new HttpError(400, 'Enter a name for the new admin');
      if (db.admins.length >= 8) throw new HttpError(400, 'Maximum 8 admins');
      let pin; do { pin = pinN(8); } while (db.admins.some((a) => checkPin(pin, a.pinHash)));
      const a = { id: uid(), name, pinHash: hashPin(pin), sports: normSports(b.sports) }; db.admins.push(a);
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
      const b = await readJson(req, 8000); const r = db.registration;
      if (b.enabled != null) r.enabled = !!b.enabled;
      if (b.deadline != null) { if (b.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(b.deadline)) throw new HttpError(400, 'Deadline must be a date'); r.deadline = b.deadline; }
      if (b.joinCode != null) { if (!/^[A-Za-z0-9-]{0,24}$/.test(b.joinCode)) throw new HttpError(400, 'Join code: letters, numbers and dashes only (max 24)'); r.joinCode = b.joinCode; }
      if (b.publicUrl != null) {
        let u = String(b.publicUrl).trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/i.test(u)) throw new HttpError(400, 'Web address must look like https://your-name.ts.net (no path)');
        r.publicUrl = u;
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
      if (sport && user.sports && user.sports.length && !user.sports.includes(sport)) throw new HttpError(403, 'You can only announce for your sport.');
      if (!sport && user.sports && user.sports.length) throw new HttpError(403, 'Sport leads announce for their own sport only.');
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
      ['tournament', 'players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'registration'].forEach((k) => { if (b[k] !== undefined) db[k] = b[k]; });
      migrate(db); audit(user.name, 'restore backup'); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/new-tournament' && m === 'POST') {
      const b = await readJson(req);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      flush(); const archName = 'archive-' + stamp + '.json' + (BK_PASS ? '.enc' : '');
      writeSecure(path.join(DATA_DIR, 'archive-' + stamp + '.json'), fs.readFileSync(DB_FILE));
      if (b.keepPlayers) {
        const data = { players: db.players, teams: db.teams, events: db.events, matches: db.matches };
        db.players.forEach((pl) => {
          const st = Engine.playerStats(pl.id, data);
          const entered = db.events.some((e) => (e.participantIds || []).includes(pl.id) || (e.sideType === 'team' && e.participantIds.some((t) => (find('teams', t) || { memberIds: [] }).memberIds.includes(pl.id))));
          if (!st.totals.played && !entered) return;
          pl.career = (pl.career || []).concat([{ tournament: db.tournament.name, dates: db.tournament.dates, played: st.totals.played, won: st.totals.won, lost: st.totals.lost, drawn: st.totals.drawn, tally: Engine.r2(st.totals.pf), honours: st.honours.map((h) => h.event + ' – ' + h.place), at: Date.now() }]);
        });
      }
      db.matches = []; db.teams = []; db.gallery = []; db.disputes = []; db.trash = []; db.events = seedEvents();
      if (!b.keepPlayers) { db.cards = []; db.suspend = {}; }
      db.players = db.players.filter((x) => x.status !== 'pending' || b.keepPlayers);
      if (!b.keepPlayers) db.players = [];
      if (!b.keepReferees) db.referees = [];
      if (!b.keepSponsors) db.sponsors = [];
      if (b.name) db.tournament.name = str(b.name, 80);
      audit(user.name, 'new tournament', 'archived as ' + archName); save(); broadcast();
      return json(res, 200, { ok: true, archive: archName });
    }
    const enrol = (pl) => {
      const enrolled = [], skipped = [];
      (pl.requestedEventIds || []).forEach((id) => {
        const ev = find('events', id); if (!ev) return;
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
      ['tournament', 'players', 'teams', 'referees', 'events', 'matches', 'sponsors', 'gallery', 'registration', 'cards', 'suspend', 'feed', 'nextPlayerNo'].forEach((k) => { if (snap[k] !== undefined) db[k] = snap[k]; });
      migrate(db); audit(user.name, 'rolled back to snapshot', b.file); save(); broadcast();
      return json(res, 200, { ok: true });
    }
    /* ---- clone an event (settings, format, rubbers; no players or matches) ---- */
    if ((mm = p.match(/^\/api\/admin\/events\/([\w-]+)\/clone$/)) && m === 'POST') {
      const src = find('events', mm[1]); if (!src) throw new HttpError(404, 'Event not found');
      if (user.sports && user.sports.length && !user.sports.includes(src.sport)) throw new HttpError(403, 'That event belongs to another sport.');
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
      const ev = wb.addWorksheet('Event names'); ev.addRow(['Event name (copy exactly)', 'Section', 'Type']).font = { bold: true };
      db.events.forEach((e) => ev.addRow([e.name, (e.section || 'adults') === 'kids' ? 'kids' : 'adults', e.sideType === 'team' ? 'Team event' : 'Individual / doubles'])); ev.columns.forEach((c) => { c.width = 34; });
      const h = wb.addWorksheet('How it works'); [['How the import maps players'],
        ['• One row per player. Name is the only required column.'],
        ['• Games: list event names from the "Event names" sheet, separated by commas. The player is entered in each one.'],
        ['• Team: give a team name. If the team does not exist it is created in the same section, and the player is added to it.'],
        ['• Team events: if a player lists a team event AND has a Team, that team is entered in the event. With no Team, the player goes on the event\'s interested list so you can place them later.'],
        ['• Players already in a draw or with fixtures are not changed. Possible duplicates are flagged for you to check.'],
        ['• You see a preview before anything is saved.']].forEach((r, k) => { const x = h.addRow(r); if (!k) x.font = { bold: true }; }); h.getColumn(1).width = 110;
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="players-import-template.xlsx"' });
      return res.end(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    if (p === '/api/admin/import-players' && m === 'POST') {
      const buf = await readBody(req, 5e6);
      const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
      try { await wb.xlsx.load(buf); } catch (e) { throw new HttpError(400, 'That does not look like an Excel (.xlsx) file.'); }
      const ws = wb.worksheets[0]; if (!ws) throw new HttpError(400, 'The workbook is empty.');
      const cell = (r, c) => { let v = r.getCell(c).value; if (v && typeof v === 'object') { if ('result' in v) v = v.result; else if ('text' in v) v = v.text; else if (v instanceof Date) v = v.toISOString().slice(0, 10); } return v == null ? '' : String(v).trim(); };
      let created = 0, flagged = 0; const errors = [], made = [], totals = { games: 0, interested: 0, teamEntries: 0, teamsMade: 0 };
      const dry = url.searchParams.get('dry') === '1';
      for (let i = 2; i <= Math.min(ws.rowCount, 1000); i++) {
        const row = ws.getRow(i), name = cell(row, 1); if (!name) continue;
        try {
          if (db.players.length >= 5000) throw new Error('Player limit reached');
          const section = /kid|child/i.test(cell(row, 2)) ? 'kids' : 'adults';
          const dob = /^\d{4}-\d{2}-\d{2}/.test(cell(row, 6)) ? cell(row, 6).slice(0, 10) : '';
          const evNames = cell(row, 9).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
          const evs = evNames.map((n) => { const e = db.events.find((x) => x.name.toLowerCase() === n && (x.section || 'adults') === section) || db.events.find((x) => x.name.toLowerCase() === n); if (!e) throw new Error('Unknown event "' + n + '"'); return e; });
          const pl = COLS.players({ name, section, gender: cell(row, 3).toUpperCase().slice(0, 1), phone: cell(row, 4), email: cell(row, 5), dob, ageGroup: cell(row, 7), affiliation: cell(row, 8) }, null);
          if (db.players.some((x) => x.status !== 'rejected' && x.dob && dob && x.dob === dob && x.name.toLowerCase() === name.toLowerCase() && evs.some((e) => e.participantIds.includes(x.id)))) throw new Error('Already registered for that event');
          pl.status = 'approved'; pl.profilePublic = false; pl.dupOf = dupCandidates(pl); if (pl.dupOf.length) flagged++;
          const tn = cell(row, 10);
          const stat = { games: 0, interested: 0, teamEntries: 0, teamsMade: 0 };
          if (!dry) {
            db.players.push(pl);
            let t = null;
            if (tn) { t = db.teams.find((x) => x.name.toLowerCase() === tn.toLowerCase() && x.section === section); if (!t) { t = COLS.teams({ name: tn, section, memberIds: [] }, null); db.teams.push(t); stat.teamsMade++; } if (!t.memberIds.includes(pl.id)) t.memberIds.push(pl.id); }
            evs.forEach((e) => {
              if (e.sideType !== 'team') { if (!e.participantIds.includes(pl.id)) { e.participantIds.push(pl.id); stat.games++; } return; }
              if (t) { if (!e.participantIds.includes(t.id)) { e.participantIds.push(t.id); stat.teamEntries++; } stat.games++; }
              else { e.interestedIds = e.interestedIds || []; if (!e.interestedIds.includes(pl.id)) { e.interestedIds.push(pl.id); stat.interested++; stat.games++; } }
            });
          } else { db.players.push(pl); evs.forEach(() => { stat.games++; }); }
          totals.games += stat.games; totals.interested += stat.interested; totals.teamEntries += stat.teamEntries; totals.teamsMade += stat.teamsMade;
          created++; made.push(pl.id);
        } catch (e) { errors.push({ row: i, name, error: e.message }); }
      }
      if (dry) { db.players = db.players.filter((x) => !made.includes(x.id)); db.nextPlayerNo -= made.length; }
      else { audit(user.name, 'imported players from Excel', created + ' added, ' + errors.length + ' skipped'); save(); broadcast(); }
      return json(res, 200, { created, flagged, errors, dryRun: dry, ...totals });
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
      return json(res, 200, x);
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
        return json(res, code || 200, col === 'referees' ? { id: item.id, name: item.name, pin: plain } : item);
      };
      if (m === 'POST' && !id) {
        const b = await readJson(req);
        if (col === 'matches' && !sportOk(user, find('events', b.eventId))) throw new HttpError(403, 'That event belongs to another sport.');
        if (col === 'events' && user.sports && user.sports.length && !user.sports.includes(b.sport)) throw new HttpError(403, 'You can only add events for your sport.');
        const item = COLS[col](b, null);
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
