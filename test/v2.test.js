'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, chiefTok } = require('./helpers');
const E = require('../public/engine.js');
const Fx = require('../lib/fixtures.js');

test('fixture generators', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rr = Fx.roundRobin(ids);
  assert.equal(rr.length, 5);
  const seen = new Set(rr.flat().map(([x, y]) => Fx.pairKey(x, y)));
  assert.equal(seen.size, 15, 'every pair exactly once');
  assert.equal(rr.flat().length, 15);
  rr.forEach((r) => { const flat = r.flat(); assert.equal(new Set(flat).size, flat.length, 'nobody twice in a round'); });
  assert.equal(Fx.roundRobin(['a', 'b', 'c']).flat().length, 3, 'odd count handled with byes');
  // doubles: 12 players -> 3 matches per round, no repeated partners across 3 rounds when avoidable
  const p12 = Array.from({ length: 12 }, (_, i) => 'p' + i);
  const rounds = Fx.doublesRounds(p12, Fx.buildHistory([]), 3);
  assert.equal(rounds.length, 3); rounds.forEach((r) => assert.equal(r.length, 3));
  const partners = rounds.flat().flatMap((m) => [Fx.pairKey(...m.sideA), Fx.pairKey(...m.sideB)]);
  assert.equal(new Set(partners).size, partners.length, 'no repeated partners');
  rounds.forEach((r) => { const all = r.flatMap((m) => [...m.sideA, ...m.sideB]); assert.equal(new Set(all).size, 12); });
  // 10 players: 8 play, 2 rest, rest rotates
  const p10 = Array.from({ length: 10 }, (_, i) => 'q' + i);
  const r10 = Fx.doublesRounds(p10, Fx.buildHistory([]), 5);
  r10.forEach((r) => assert.equal(r.length, 2));
  assert.ok(new Set(r10.flatMap((r) => r.flatMap((m) => [...m.sideA, ...m.sideB]))).size === 10, 'everyone gets to play');
  assert.equal(Fx.addMinutes('2026-11-29T09:50', 25), '2026-11-29T10:15');
  const slots = Fx.assignSlots([[1, 2, 3], [4]], ['C1', 'C2'], '2026-11-29T09:00', 20);
  assert.deepEqual(slots[0].map((s) => s.startsAt.slice(11)), ['09:00', '09:00', '09:20']);
  assert.equal(slots[1][0].startsAt.slice(11), '09:40');
  assert.deepEqual(slots[0].map((s) => s.court), ['C1', 'C2', 'C1']);
});

test('v2 server: security, privacy, sections, clashes, generators, finals, corrections, backup', async () => {
  const s = await start();
  try {
    const { call, pin } = s;
    assert.match(pin, /^\d{6}$/, 'fresh install gets a 6-digit PIN');
    // headers
    const h = await fetch(s.base + '/');
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);

    // lockout after repeated wrong PINs
    for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/login', { role: 'admin', pin: '000000' })).status, 401);
    const locked = await call('POST', '/api/login', { role: 'admin', pin });
    assert.equal(locked.status, 429, 'even the right PIN is refused while locked');
  } finally { await s.stop(); }

  const s2 = await start();
  try {
    const { call, pin } = s2;
    const admin = (await call('POST', '/api/login', { role: 'admin', pin })).body.token; const chiefT = await chiefTok({ call }, admin);
    await s2.settle();
    const db = JSON.parse(fs.readFileSync(path.join(s2.DIR, 'db.json'), 'utf8'));
    assert.ok(db.admins && db.admins[0].pinHash && !db.adminPin && !db.adminPinHash, 'admin PIN stored hashed');

    // players in both sections, with private details
    const mkp = async (name, section, extra) => (await call('POST', '/api/admin/players', { name, section, ...(extra || {}) }, admin)).body.id;
    const A = []; for (const n of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12']) A.push(await mkp(n, 'adults', { gender: 'F', phone: '9999999999', email: 'x@y.z', notes: 'secret' }));
    const K = []; for (const n of ['K1', 'K2', 'K3', 'K4']) K.push(await mkp(n, 'kids', { ageGroup: 'U10', phone: '8888888888' }));
    let st = (await call('GET', '/api/state')).body;
    assert.ok(st.players.every((p) => p.phone === undefined && p.email === undefined && p.notes === undefined), 'no private fields in public state');
    assert.equal((await call('GET', '/api/admin/players/' + A[0], null, admin)).body.phone, '9999999999', 'admin can read private details');
    assert.equal((await call('GET', '/api/admin/players/' + A[0])).status, 401);
    const kidsPhoto = (await call('PUT', '/api/admin/players/' + K[0], { photo: '/uploads/x.jpg' }, admin)).body;
    st = (await call('GET', '/api/state')).body;
    assert.equal(st.players.find((p) => p.id === K[0]).photo, '', 'kids photos hidden by default');
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === K[0]).photo, '', 'organizer view also hides kids photos until enabled');
    await call('POST', '/api/admin/tournament', { showKidsPhotos: true }, admin);
    assert.equal((await call('GET', '/api/state')).body.players.find((p) => p.id === K[0]).photo, '', 'player photos are never public');
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === K[0]).photo, '/uploads/x.jpg');

    // sections are enforced
    const wd = st.events.find((e) => /Women/.test(e.name));
    await call('PUT', '/api/admin/events/' + wd.id, { config: { target: 15, winBy: 1, cap: 0 } }, admin);   // this test plays 15-point games
    const kb = st.events.find((e) => e.name === 'Kids – Badminton');
    assert.equal(kb.section, 'kids');
    assert.equal((await call('PUT', '/api/admin/events/' + wd.id, { participantIds: [A[0], K[0]] }, admin)).status, 400, 'kid cannot be enrolled in adult event');
    assert.equal((await call('PUT', '/api/admin/events/' + kb.id, { participantIds: K }, admin)).status, 200);
    await call('PUT', '/api/admin/events/' + wd.id, { participantIds: A }, admin);

    // fixtures generator: kids round-robin = 6 matches, with courts & times
    const g = await call('POST', '/api/admin/events/' + kb.id + '/generate', { mode: 'roundrobin', courts: 'Table 1, Table 2', start: '2026-11-29T09:00', slotMinutes: 20 }, admin);
    assert.equal(g.body.created, 6);
    assert.equal((await call('POST', '/api/admin/events/' + kb.id + '/generate', { mode: 'roundrobin' }, admin)).status, 400, 'nothing new on second run');
    // doubles rounds for women's doubles
    const gd = await call('POST', '/api/admin/events/' + wd.id + '/generate', { mode: 'doubles', rounds: 2, courts: 'Court 1,Court 2,Court 3', start: '2026-11-29T10:00', slotMinutes: 25 }, admin);
    assert.equal(gd.body.created, 6);
    st = (await call('GET', '/api/state')).body;
    const wdm = st.matches.filter((m) => m.eventId === wd.id);
    assert.equal(wdm.length, 6);
    assert.ok(wdm.every((m) => m.sideA.length === 2 && m.sideB.length === 2 && m.round >= 1));

    // clash detection: same player same time in another event -> 409 unless forced
    const a1 = wdm[0].sideA[0];
    const tt = st.events.find((e) => e.name === 'Table Tennis');
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: A.slice(0, 4) }, admin);
    const clash = await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [a1], sideB: [a1 === A[3] ? A[2] : A[3]], startsAt: wdm[0].startsAt, court: 'Zed' }, admin);
    assert.equal(clash.status, 409); assert.ok(clash.body.clash && /scheduled/.test(clash.body.clashes[0]));
    const forced = await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [a1], sideB: [a1 === A[3] ? A[2] : A[3]], startsAt: wdm[0].startsAt, court: 'Zed', force: true }, admin);
    assert.equal(forced.status, 200);
    const courtClash = await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [A[0]], sideB: [A[1]], startsAt: wdm[0].startsAt, court: wdm[0].court }, admin);
    assert.equal(courtClash.status, 409);

    // score correction (admin) with validation
    const m0 = wdm[0];
    assert.equal((await call('POST', '/api/admin/matches/' + m0.id + '/scores', { games: [{ a: 16, b: 5 }] }, chiefT)).status, 400, 'invalid score rejected');
    const ok = await call('POST', '/api/admin/matches/' + m0.id + '/scores', { games: [{ a: 15, b: 10 }, { a: 12, b: 15 }, { a: 15, b: 7 }] }, chiefT);
    assert.equal(ok.status, 200);
    st = (await call('GET', '/api/state')).body;
    const evw = st.events.find((e) => e.id === wd.id);
    const d = E.derive(st.matches.find((m) => m.id === m0.id), evw);
    assert.equal(E.scoreText(d), '15-10, 12-15, 15-7'); assert.equal(d.status, 'completed');
    const audit = (await call('GET', '/api/admin/audit?matchId=' + m0.id, null, admin)).body;
    assert.ok(audit.some((a) => a.action === 'corrected scores'));

    // finals: doubles with 4 finalists => 1 final (1&4 v 2&3); needs force while league open
    const need = await call('POST', '/api/admin/events/' + wd.id + '/finals', {}, admin);
    assert.equal(need.status, 409); assert.ok(need.body.needForce);
    const nf = await call('POST', '/api/admin/events/' + wd.id + '/finals', { force: true }, admin);
    assert.equal(nf.status, 200, JSON.stringify(nf.body));
    st = (await call('GET', '/api/state')).body;
    const fin = st.matches.find((m) => m.eventId === wd.id && m.stage === 'Final');
    assert.ok(fin && fin.sideA.length === 2);
    assert.equal(st.matches.filter((m) => m.eventId === wd.id && m.stage === 'League').length, 6, 'finals not counted as league');

    // referee PIN returned once, hashed at rest, lockout per account
    const ref = (await call('POST', '/api/admin/referees', { name: 'R1' }, admin)).body;
    assert.match(ref.pin, /^\d{4}$/);
    assert.equal((await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: ref.pin })).status, 200);
    await s2.settle();
    const sec = JSON.stringify(JSON.parse(fs.readFileSync(path.join(s2.DIR, 'db.json'), 'utf8')).referees);
    assert.ok(!sec.includes('"pin"') && sec.includes('pinHash'));
    assert.equal(JSON.stringify((await call('GET', '/api/state')).body.referees).includes('pin'), false);

    // QR
    const qr = await fetch(s2.base + '/api/qr.svg?text=' + encodeURIComponent('https://example.com'));
    assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);

    // upload + full backup (with images) + restore
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await (await fetch(s2.base + '/api/upload', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'image/png' }, body: png })).json();
    const svgTry = await fetch(s2.base + '/api/upload', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
    assert.equal(svgTry.status, 400, 'svg uploads refused');
    const backup = await (await fetch(s2.base + '/api/admin/backup', { headers: { 'x-token': admin } })).json();
    assert.ok(backup.uploads[path.basename(up.url)], 'backup contains uploaded image');
    assert.equal(backup.adminPinHash, undefined, 'backup excludes admin PIN hash'); assert.equal(backup.admins, undefined, 'backup excludes admins');
    fs.unlinkSync(path.join(s2.DIR, 'uploads', path.basename(up.url)));
    const rs = await call('POST', '/api/admin/restore', backup, admin);
    assert.equal(rs.status, 200);
    assert.ok(fs.existsSync(path.join(s2.DIR, 'uploads', path.basename(up.url))), 'image restored from backup');
    assert.ok((await call('GET', '/api/state')).body.matches.length >= 6);

    // new tournament: keeps players, wipes matches, archives
    const nt = await call('POST', '/api/admin/new-tournament', { keepPlayers: true, name: 'Next Year' }, admin);
    assert.equal(nt.status, 200); assert.ok(fs.existsSync(path.join(s2.DIR, nt.body.archive)));
    st = (await call('GET', '/api/state')).body;
    assert.equal(st.matches.length, 0); assert.equal(st.players.length, 16); assert.equal(st.tournament.name, 'Next Year'); assert.equal(st.events.length, 9);

    // public excel hides contact details; admin excel shows them
    const ExcelJS = require('exceljs');
    const read = async (url, hdr) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await (await fetch(s2.base + url, hdr)).arrayBuffer())); return wb.getWorksheet('Players').getRow(1).values.filter(Boolean); };
    assert.deepEqual(await read('/api/export.xlsx'), ['ID', 'Name', 'Section', 'Age group', 'Gender']);
    assert.ok(!(await read('/api/export.xlsx?t=' + admin)).includes('Phone'), 'admin token in the URL no longer unlocks anything');
    const link = (await call('POST', '/api/admin/export-link', {}, admin)).body.url;
    assert.ok((await read(link)).includes('Phone'), 'one-time link gives the admin export');
    assert.equal((await fetch(s2.base + link)).status, 403, 'link works only once');
  } finally { await s2.stop(); }
});

test('upgrade from v1 data keeps PINs working and adds kids section', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 1, tournament: { name: 'Old', tagline: '', dates: '', venue: '', logo: '', primary: '#0f766e' }, adminPin: '4455', sessions: {}, vapid: { publicKey: 'x', privateKey: 'y' },
    players: [{ id: 'p1', name: 'Old Player', gender: 'F', phone: '1', email: '', photo: '', notes: '' }], teams: [], referees: [{ id: 'r1', name: 'Ref', pin: '1234' }],
    events: [{ id: 'e1', name: 'Chess', sport: 'chess', scoring: 'result', sideType: 'player', sideSize: 1, participantIds: ['p1'], note: '', config: { bestOf: 1, target: 1, winBy: 1, cap: 0, increments: [1], pointsWin: 1, pointsDraw: 0.5, pointsLoss: 0, rankBy: 'matchPoints', finalists: 2 } }],
    matches: [], sponsors: [], gallery: [], subs: [],
  }));
  const webpush = require('web-push'); // real keys needed for setVapidDetails
  const k = webpush.generateVAPIDKeys();
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))); j.vapid = k; fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(j));
  const s = await start({ dir });
  try {
    assert.equal((await s.call('POST', '/api/login', { role: 'admin', pin: '4455' })).status, 200, 'old admin PIN still works');
    assert.equal((await s.call('POST', '/api/login', { role: 'referee', refereeId: 'r1', pin: '1234' })).status, 200, 'old referee PIN still works');
    const st = (await s.call('GET', '/api/state')).body;
    assert.equal(st.players[0].section, 'adults');
    assert.equal(st.events.filter((e) => e.section === 'kids').length, 4);
    assert.equal(st.events.find((e) => e.id === 'e1').section, 'adults');
    const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
    assert.ok(!raw.includes('"adminPin"') && !raw.includes('"pin":"1234"'));
  } finally { await s.stop(); }
});

test('--reset-pin recovers admin access', async () => {
  const s = await start();
  const dir = s.DIR; s.proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('node', [path.join(__dirname, '..', 'server.js'), '--reset-pin', '246810'], { env: { ...process.env, DATA_DIR: dir } }).toString();
  assert.match(out, /246810/);
  const s2 = await start({ dir });
  try { assert.equal((await s2.call('POST', '/api/login', { role: 'admin', pin: '246810' })).status, 200); } finally { await s2.stop(); }
});
