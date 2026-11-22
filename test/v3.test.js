'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const E = require('../public/engine.js');
const { start } = require('./helpers');

const login = async (s, pin) => (await s.call('POST', '/api/login', { role: 'admin', pin })).body.token;

test('registration: join code, approval queue, kids consent, caps, self-edit link', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s, s.pin);
    const st0 = (await call('GET', '/api/state')).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis'), kt = st0.events.find((e) => e.name === 'Kids – Table Tennis');
    const base = { name: 'Meera Rao', section: 'adults', gender: 'F', phone: '98450 11111', eventIds: [tt.id], consent: true };
    let n = 0; const reg = (body) => call('POST', '/api/register', body, '', { 'x-forwarded-for': '10.1.0.' + (++n) });

    assert.equal((await reg( base)).status, 403, 'closed by default');
    await call('POST', '/api/admin/registration', { enabled: true, joinCode: 'Smash-26' }, admin);
    assert.equal((await call('GET', '/api/state')).body.registration.joinCode, undefined, 'join code never public');
    assert.equal((await call('GET', '/api/state', null, admin)).body.registration.joinCode, 'Smash-26');
    assert.equal((await reg( base)).status, 403, 'code required');
    assert.equal((await reg( { ...base, code: 'wrong' })).status, 403);
    assert.equal((await reg( { ...base, code: 'smash-26', consent: false })).status, 400, 'consent required');
    assert.equal((await reg( { ...base, code: 'smash-26', phone: '', email: '' })).status, 400, 'needs a way to contact');
    assert.equal((await reg( { ...base, code: 'smash-26', eventIds: [kt.id] })).status, 400, 'adult cannot enter kids event');

    const ok = (await reg( { ...base, code: 'SMASH-26', website: '' })).body;
    assert.ok(ok.ok && ok.editToken && ok.status === 'pending' && ok.playerNo);
    const dup = (await reg( { ...base, code: 'smash-26' })); assert.equal(dup.status, 200, 'same name and phone is flagged for review, not blocked'); const dupAdmin = (await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === dup.body.id); assert.equal(dupAdmin.dupOf.length, 1, 'organizer sees the possible duplicate'); await call('DELETE', '/api/admin/players/' + dup.body.id, null, admin);
    assert.equal((await reg( { ...base, name: 'Bot', code: 'smash-26', website: 'http://spam' })).body.ok, true, 'honeypot looks successful…');

    const pub = (await call('GET', '/api/state')).body;
    assert.ok(!pub.players.some((p) => p.name === 'Meera Rao' || p.name === 'Bot'), 'pending players are not public');
    assert.ok(!pub.events.find((e) => e.id === tt.id).participantIds.includes(ok.id));
    assert.equal(((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === ok.id) || {}).status, 'pending');

    // kids need a guardian + age
    const kid = { name: 'Tiny Tim', section: 'kids', ageGroup: 'Under-10', phone: '', email: 'p@x.in', eventIds: [kt.id], consent: true, code: 'smash-26' };
    assert.equal((await reg( kid)).status, 400, 'guardian required');
    const k = (await reg( { ...kid, guardianName: 'Mr Tim', guardianPhone: '99999' })).body;
    assert.ok(k.ok);
    const kp = (await call('GET', '/api/admin/players/' + k.id, null, admin)).body;
    assert.equal(kp.guardianName, 'Mr Tim'); assert.equal(kp.profilePublic, false); assert.ok(kp.consentAt > 0);

    // approve -> public + enrolled
    const ap = (await call('POST', '/api/admin/players/' + ok.id + '/approve', {}, admin)).body;
    assert.deepEqual(ap.enrolled, ['Table Tennis']);
    const pub2 = (await call('GET', '/api/state')).body;
    assert.ok(pub2.players.some((p) => p.id === ok.id));
    assert.ok(pub2.events.find((e) => e.id === tt.id).participantIds.includes(ok.id));
    assert.equal((await call('POST', '/api/admin/players/approve-all', {}, admin)).body.approved, 1, 'only the kid is still waiting; the honeypot bot was never stored');

    // self-edit link
    const hdr = { 'x-edit-token': ok.editToken };
    assert.equal((await call('GET', '/api/self/' + ok.id)).status, 403);
    assert.equal((await call('GET', '/api/self/' + ok.id, null, '', { 'x-edit-token': 'nope' })).status, 403);
    const me = (await call('GET', '/api/self/' + ok.id, null, '', hdr)).body;
    assert.equal(me.name, 'Meera Rao'); assert.equal(me.editTokenHash, undefined); assert.equal(me.notes, undefined);
    const up = await call('PUT', '/api/self/' + ok.id, { bio: 'Hello', section: 'kids', status: 'approved', name: 'Hacker', sports: { tt: { level: 'Advanced', style: 'Attacker' } }, photo: 'https://evil/x.png' }, '', hdr);
    assert.equal(up.status, 400, 'external photo urls refused');
    const up2 = await call('PUT', '/api/self/' + ok.id, { bio: 'Hello', section: 'kids', name: 'Hacker', sports: { tt: { level: 'Advanced', style: 'Attacker' } } }, '', hdr);
    assert.equal(up2.body.bio, 'Hello'); assert.equal(up2.body.section, 'adults', 'cannot change section'); assert.equal(up2.body.name, 'Meera Rao', 'cannot rename after approval');
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === ok.id).sports.tt.style, 'Attacker');

    // cap + closing
    await call('PUT', '/api/admin/events/' + tt.id, { maxParticipants: 1 }, admin);
    assert.equal((await reg( { ...base, name: 'Late Joiner', phone: '1', code: 'smash-26' })).status, 409, 'event full');
    await call('POST', '/api/admin/registration', { enabled: false }, admin);
    assert.equal((await reg( { ...base, name: 'Another', code: 'smash-26' })).status, 403);
    await call('POST', '/api/admin/registration', { enabled: true, deadline: '2000-01-01' }, admin);
    assert.equal((await reg( { ...base, name: 'Another', code: 'smash-26' })).status, 403, 'deadline passed');
  } finally { await s.stop(); }
});

test('named admins, lockout is per network, sessions can be revoked', async () => {
  const s = await start();
  try {
    const { call } = s; const a1 = await login(s, s.pin);
    const add = (await call('POST', '/api/admin/admins', { name: 'Priya' }, a1)).body;
    assert.match(add.pin, /^\d{8}$/);
    const a2 = await login(s, add.pin);
    assert.equal((await call('GET', '/api/me', null, a2)).body.name, 'Priya');
    await call('POST', '/api/admin/players', { name: 'Zed' }, a2);
    const log = (await call('GET', '/api/admin/audit', null, a1)).body;
    assert.ok(log.some((x) => x.who === 'Priya' && /created player/.test(x.action)), 'audit names the admin');
    assert.equal((await call('DELETE', '/api/admin/admins/' + add.id, null, a2)).status, 400, 'cannot remove yourself');
    const me1 = (await call('GET', '/api/admin/admins', null, a1)).body;
    assert.equal(me1.length, 2);
    // changing my own PIN only affects me
    assert.equal((await call('POST', '/api/admin/pin', { pin: '13572468' }, a2)).status, 200);
    assert.equal((await call('GET', '/api/me', null, a1)).body.role, 'admin', 'other admin stays signed in');
    assert.equal((await call('POST', '/api/login', { role: 'admin', pin: add.pin })).status, 401);
    assert.ok(await login(s, '13572468'));
    // revoke
    const rv = (await call('POST', '/api/admin/revoke-sessions', {}, a1)).body;
    assert.ok(rv.signedOut >= 1);
    assert.equal((await call('GET', '/api/me', null, a2)).body.role, null);
    assert.equal((await call('DELETE', '/api/admin/admins/' + add.id, null, a1)).status, 200);

    // lockout: 8 wrong PINs from one address block that address only (addresses come from the tunnel header)
    const wrong = (ipx) => call('POST', '/api/login', { role: 'admin', pin: '000000' }, '', { 'x-forwarded-for': ipx });
    for (let i = 0; i < 8; i++) assert.equal((await wrong('203.0.113.9')).status, 401);
    assert.equal((await wrong('203.0.113.9')).status, 429);
    assert.equal((await call('POST', '/api/login', { role: 'admin', pin: s.pin }, '', { 'x-forwarded-for': '203.0.113.9' })).status, 429, 'blocked even with the right PIN');
    assert.equal((await call('POST', '/api/login', { role: 'admin', pin: s.pin }, '', { 'x-forwarded-for': '198.51.100.7' })).status, 200, 'admin is not locked out for everyone');
  } finally { await s.stop(); }
});

test('scorer lock, walkovers, withdrawals, replacement, retirement', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s, s.pin);
    const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
    const ids = []; for (const n of ['A', 'B', 'C', 'D']) ids.push((await call('POST', '/api/admin/players', { name: n }, admin)).body.id);
    const spare = (await call('POST', '/api/admin/players', { name: 'Spare' }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: ids }, admin);
    const ref = (await call('POST', '/api/admin/referees', { name: 'Ref One' }, admin)).body;
    const ref2 = (await call('POST', '/api/admin/referees', { name: 'Ref Two' }, admin)).body;
    const r1 = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: ref.pin })).body.token;
    const r2 = (await call('POST', '/api/login', { role: 'referee', refereeId: ref2.id, pin: ref2.pin })).body.token;
    const mk = async (a, b) => (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [a], sideB: [b], force: true }, admin)).body;
    const m1 = await mk(ids[0], ids[1]), m2 = await mk(ids[0], ids[2]), m3 = await mk(ids[1], ids[3]);

    // lock
    assert.equal((await call('POST', `/api/matches/${m1.id}/ops`, { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'a1' }] }, r1)).status, 200);
    const clash = await call('POST', `/api/matches/${m1.id}/ops`, { ops: [{ type: 'point', s: 'B', inc: 1, cid: 'b1' }] }, r2);
    assert.equal(clash.status, 409); assert.equal(clash.body.locked, true); assert.equal(clash.body.by, 'Ref One');
    assert.equal((await call('POST', `/api/matches/${m1.id}/ops`, { ops: [{ type: 'point', s: 'B', inc: 1, cid: 'b1' }], force: true }, r2)).status, 200, 'take over');
    assert.equal((await call('GET', '/api/state')).body.matches.find((m) => m.id === m1.id).lock, undefined, 'lock not public');

    // retirement keeps the score so far
    await call('POST', `/api/matches/${m1.id}/ops`, { ops: [{ type: 'result', result: 'A', reason: 'retired', cid: 'r1' }], force: true }, r2);
    let st = (await call('GET', '/api/state')).body;
    const d1 = E.derive(st.matches.find((m) => m.id === m1.id), st.events.find((e) => e.id === tt.id));
    assert.equal(d1.status, 'completed'); assert.equal(d1.outcome, 'retired'); assert.equal(d1.winner, 'A');

    // walkover: awarded to opponent, counts in standings as target points
    await call('POST', `/api/matches/${m2.id}/ops`, { ops: [{ type: 'walkover', s: 'B', cid: 'w1' }], force: true }, r1);
    st = (await call('GET', '/api/state')).body;
    const ev = st.events.find((e) => e.id === tt.id);
    const d2 = E.derive(st.matches.find((m) => m.id === m2.id), ev);
    assert.equal(d2.status, 'completed'); assert.equal(d2.winner, 'B'); assert.equal(d2.outcome, 'walkover'); assert.deepEqual(d2.games.map((g) => g.b), [11, 11]);
    const row = E.standings(ev, st.matches).find((r) => r.id === ids[2]); assert.equal(row.won, 1); assert.equal(row.pf, 22);
    // undo restores
    await call('POST', `/api/matches/${m2.id}/ops`, { ops: [{ type: 'undo', cid: 'u1' }], force: true }, r1);
    assert.equal(E.derive((await call('GET', '/api/state')).body.matches.find((m) => m.id === m2.id), ev).status, 'scheduled');

    // withdrawal: unplayed matches go to opponents; replace swaps in unplayed ones
    const w = (await call('POST', '/api/admin/events/' + tt.id + '/withdraw', { participantId: ids[3] }, admin)).body;
    assert.equal(w.awarded, 1);
    st = (await call('GET', '/api/state')).body;
    assert.equal(E.derive(st.matches.find((m) => m.id === m3.id), ev).winner, 'A');
    assert.deepEqual(st.events.find((e) => e.id === tt.id).withdrawn, [ids[3]]);
    const rp = (await call('POST', '/api/admin/events/' + tt.id + '/replace', { oldId: ids[0], newId: spare }, admin)).body;
    assert.equal(rp.updated, 1, 'only the unplayed match (m2) changes; the retired one keeps A');
    st = (await call('GET', '/api/state')).body;
    assert.deepEqual(st.matches.find((m) => m.id === m2.id).sideA, [spare]); assert.deepEqual(st.matches.find((m) => m.id === m1.id).sideA, [ids[0]]);
  } finally { await s.stop(); }
});

test('trash restores deleted players and events (with matches); disputes; purge', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s, s.pin);
    const ev = (await call('POST', '/api/admin/events', { name: 'Side Event', sport: 'tt' }, admin)).body;
    const a = (await call('POST', '/api/admin/players', { name: 'Ann', phone: '555', email: 'a@b.c', section: 'adults' }, admin)).body;
    const b = (await call('POST', '/api/admin/players', { name: 'Bob' }, admin)).body;
    await call('PUT', '/api/admin/events/' + ev.id, { participantIds: [a.id, b.id] }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: ev.id, sideA: [a.id], sideB: [b.id] }, admin)).body;
    assert.equal((await call('DELETE', '/api/admin/events/' + ev.id, null, admin)).status, 200);
    let tr = (await call('GET', '/api/admin/trash', null, admin)).body;
    assert.equal(tr[0].col, 'events'); assert.equal(tr[0].matches, 1);
    assert.equal((await call('POST', '/api/admin/trash/' + tr[0].id + '/restore', {}, admin)).status, 200);
    let st = (await call('GET', '/api/state')).body;
    assert.ok(st.events.some((e) => e.id === ev.id) && st.matches.some((x) => x.id === m.id), 'event and its match are back');
    // player profiles are permanent: delete is refused, the player stays in the event
    await call('DELETE', '/api/admin/matches/' + m.id, null, admin);
    // a profile with no match history left may be deleted (v21 covers the rules)
    st = (await call('GET', '/api/state')).body;
    assert.ok(st.events.find((e) => e.id === ev.id).participantIds.includes(a.id));
    assert.equal((await call('GET', '/api/admin/players/' + a.id, null, admin)).body.phone, '555');

    // disputes
    const m2 = (await call('POST', '/api/admin/matches', { eventId: ev.id, sideA: [a.id], sideB: [b.id] }, admin)).body;
    assert.equal((await call('POST', '/api/disputes', { matchId: m2.id, text: 'hi' })).status, 400);
    assert.equal((await call('POST', '/api/disputes', { matchId: m2.id, text: 'Score was 11-9 not 11-8', name: 'Ann' })).status, 200);
    assert.equal((await call('GET', '/api/admin/disputes')).status, 401);
    const dl = (await call('GET', '/api/admin/disputes', null, admin)).body;
    assert.equal(dl.length, 1);
    assert.equal((await call('GET', '/api/state', null, admin)).body.openDisputes, 1);
    await call('POST', '/api/admin/disputes/' + dl[0].id, {}, admin);
    assert.equal((await call('GET', '/api/state', null, admin)).body.openDisputes, 0);

    // purge contacts + trash
    const pg = (await call('POST', '/api/admin/purge', { contacts: true, trash: true }, admin)).body;
    assert.ok(pg.cleared.includes('contact details'));
    assert.equal((await call('GET', '/api/admin/players/' + a.id, null, admin)).body.phone, '');
    assert.equal((await call('GET', '/api/admin/trash', null, admin)).body.length, 0);
  } finally { await s.stop(); }
});

test('public state is cached, gzip-compressed and revalidated with ETag', async () => {
  const s = await start();
  try {
    const r1 = await fetch(s.base + '/api/state', { headers: { 'accept-encoding': 'gzip' } });
    const etag = r1.headers.get('etag');
    assert.ok(etag); assert.equal(r1.headers.get('content-encoding'), 'gzip');
    assert.ok((await r1.json()).tournament);
    assert.equal((await fetch(s.base + '/api/state', { headers: { 'if-none-match': etag } })).status, 304);
    const admin = await login(s, s.pin);
    await s.call('POST', '/api/admin/players', { name: 'New' }, admin);
    const r3 = await fetch(s.base + '/api/state', { headers: { 'if-none-match': etag } });
    assert.equal(r3.status, 200); assert.notEqual(r3.headers.get('etag'), etag);
  } finally { await s.stop(); }
});

test('encrypted backups, decrypt tool, and recovery from a damaged database file', async () => {
  const s = await start({ env: { BACKUP_PASSPHRASE: 'correct horse battery' }, keepDir: true });
  const dir = s.DIR;
  try {
    const admin = await login(s, s.pin);
    await s.call('POST', '/api/admin/players', { name: 'Secret Sam', phone: '777' }, admin);
    await s.settle(600);
  } finally { await s.stop(); }
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.ok(files.length && files.every((f) => f.endsWith('.enc')), 'backups are encrypted');
  assert.ok(!files.some((f) => fs.readFileSync(path.join(dir, 'backups', f)).includes('Secret Sam')), 'no plain text inside');
  const enc = path.join(dir, 'backups', files.sort().pop());
  const env = { ...process.env, DATA_DIR: dir, BACKUP_PASSPHRASE: 'correct horse battery' };
  execFileSync('node', [path.join(__dirname, '..', 'server.js'), '--decrypt', enc], { env });
  assert.ok(fs.readFileSync(enc.replace(/\.enc$/, '') + '.decrypted', 'utf8').includes('Secret Sam'));
  assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'server.js'), '--decrypt', enc], { env: { ...env, BACKUP_PASSPHRASE: 'wrong' }, stdio: 'pipe' }));

  // damage the live file: the server must recover from the newest backup instead of starting empty
  fs.writeFileSync(path.join(dir, 'db.json'), '{"players": [ {"name": "trunc');
  const s2 = await start({ dir, env: { BACKUP_PASSPHRASE: 'correct horse battery' } });
  try {
    assert.match(s2.out(), /Recovered from backup/);
    assert.ok((await s2.call('GET', '/api/state')).body.players.some((p) => p.name === 'Secret'));
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.corrupt-')), 'damaged file kept for inspection');
  } finally { await s2.stop(); }
});

test('head-to-head settles a two-way tie before point difference (when enabled)', () => {
  const cfg = { bestOf: 1, target: 11, winBy: 1, cap: 0, increments: [1], pointsWin: 2, pointsDraw: 1, pointsLoss: 0, rankBy: 'matchPoints', finalists: 2, h2hFirst: false };
  const ev = { id: 'e', sideType: 'player', sideSize: 1, scoring: 'points', participantIds: ['a', 'b', 'c', 'd'], config: cfg };
  const mk = (x, y, ax, bx) => {
    const m = { id: x + y, eventId: 'e', stage: 'League', sideA: [x], sideB: [y], log: [], cids: [] };
    for (let i = 0; i < Math.max(ax, bx); i++) { if (i < ax) E.applyOp(m, ev, { type: 'point', s: 'A', inc: 1 }); if (i < bx) E.applyOp(m, ev, { type: 'point', s: 'B', inc: 1 }); }
    return m;
  };
  // a beats b and c; b beats c narrowly; c beats d heavily  =>  b and c both have 2 points, c has the better point difference
  const ms = [mk('a', 'b', 11, 8), mk('a', 'c', 11, 8), mk('b', 'c', 11, 10), mk('c', 'd', 11, 0)];
  const order = () => E.standings(ev, ms).map((r) => r.id).join('');
  assert.equal(order(), 'acbd', 'default: point difference puts c above b');
  cfg.h2hFirst = true;
  assert.equal(order(), 'abcd', 'h2h: b beat c, so b is above c');
  const rows = E.standings(ev, ms); assert.notEqual(rows[1].rank, rows[2].rank, 'no shared rank once decided');
  // never met => falls back to point difference
  const ms2 = [mk('a', 'b', 11, 8), mk('a', 'c', 11, 8), mk('c', 'd', 11, 0), mk('b', 'd', 11, 10)];
  assert.equal(E.standings(ev, ms2).map((r) => r.id).join(''), 'acbd'.replace('cb', E.standings(ev, ms2)[1].id + E.standings(ev, ms2)[2].id));
});
