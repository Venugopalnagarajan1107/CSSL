'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const E = require('../public/engine.js');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('stage 4: duplicates flagged, name+DOB blocked, merge, lockout, code rotation, reachability', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
    await A('POST', '/registration', { enabled: true, joinCode: 'X1' });
    let n = 0; const reg = (b) => call('POST', '/api/register', { code: 'X1', consent: true, section: 'adults', eventIds: [tt.id], ...b }, '', { 'x-forwarded-for': '10.2.0.' + (++n) });
    const a = (await reg({ name: 'Ravi Kumar', phone: '9811100000', dob: '1990-05-05' })).body;
    // siblings share a phone: accepted, not flagged as the same person
    const sib = await reg({ name: 'Rani Kumar', phone: '9811100000', dob: '1992-02-02' });
    assert.equal(sib.status, 200);
    let st = (await call('GET', '/api/state', null, admin)).body;
    assert.deepEqual(st.players.find((p) => p.id === sib.body.id).dupOf, []);
    // same name+phone, different DOB missing: flagged, not blocked
    const d1 = await reg({ name: 'ravi kumar', phone: '98111 00000' });
    assert.equal(d1.status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.deepEqual(st.players.find((p) => p.id === d1.body.id).dupOf, [a.id]);
    // identical name + DOB in the same event: blocked
    assert.equal((await reg({ name: 'Ravi Kumar', dob: '1990-05-05', phone: '9000000000' })).status, 409);
    // dob never leaves the server in a feed
    assert.ok(!JSON.stringify((await call('GET', '/api/state')).body).includes('1990-05-05'));
    assert.ok(!JSON.stringify(st).includes('1990-05-05'));
    // merge duplicate into the original
    await A('POST', '/players/' + a.id + '/approve', {});
    assert.equal((await A('POST', '/players/' + d1.body.id + '/merge', { intoId: d1.body.id })).status, 400);
    assert.equal((await A('POST', '/players/' + d1.body.id + '/merge', { intoId: a.id })).status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(!st.players.some((p) => p.id === d1.body.id)); assert.ok(st.players.some((p) => p.id === a.id));

    // join code rotation
    const before = (await call('GET', '/api/state', null, admin)).body.registration.joinCode;
    await A('POST', '/registration', { rotateCode: true });
    const after = (await call('GET', '/api/state', null, admin)).body.registration.joinCode;
    assert.notEqual(before, after); assert.match(after, /^[A-Z0-9]{6}$/);
    assert.equal((await reg({ name: 'Late Code', phone: '9333333333', code: before })).status, 403);

    // referee lockout after 5 wrong PINs, even from different networks
    const ref = (await A('POST', '/referees', { name: 'Ref', pin: '1234' })).body;
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '9999' }, '', { 'x-forwarded-for': '10.3.0.' + i })).status, 401);
    assert.equal((await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '1234' }, '', { 'x-forwarded-for': '10.3.1.1' })).status, 429, 'locked for 15 minutes');

    // reachability list
    const r = (await call('GET', '/api/admin/reachability?link=https://x.test', null, admin)).body;
    assert.ok(r.rows.find((x) => x.id === a.id).status === 'unknown'); assert.match(r.message, /https:\/\/x\.test/);
    assert.equal((await A('POST', '/players/' + a.id + '/test-push', {})).body.sent, 0);
  } finally { await s.stop(); }
});

test('stage 4: announcements and the in-app updates feed (first names only)', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    assert.equal((await call('POST', '/api/admin/broadcast', { text: 'Lunch at 1' })).status, 401);
    const r = await call('POST', '/api/admin/broadcast', { title: 'Lunch', text: 'Lunch break until 2pm' }, admin);
    assert.equal(r.status, 200); assert.equal((await call('POST', '/api/admin/broadcast', { text: 'x' }, admin)).status, 400);
    const feed = (await call('GET', '/api/state')).body.feed;
    assert.equal(feed[0].title, 'Lunch'); assert.equal(feed[0].kind, 'announcement');
    // match results land in the feed with first names only
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
    const p1 = (await A('POST', '/players', { name: 'Arun Menon', section: 'adults' })).body.id, p2 = (await A('POST', '/players', { name: 'Bina Shah', section: 'adults' })).body.id;
    await A('PUT', '/events/' + tt.id, { participantIds: [p1, p2] });
    const m = (await A('POST', '/matches', { eventId: tt.id, sideA: [p1], sideB: [p2] })).body;
    const ref = (await A('POST', '/referees', { name: 'Ref', pin: '1234' })).body;
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '1234' })).body.token;
    await call('POST', '/api/matches/' + m.id + '/ops', { ops: [{ type: 'result', result: 'A', cid: 'q1' }] }, rt).catch(() => {});
    const f2 = JSON.stringify((await call('GET', '/api/state')).body.feed);
    assert.ok(!f2.includes('Menon') && !f2.includes('Shah'), 'surnames never reach the public feed');
  } finally { await s.stop(); }
});

test('stage 5: panic controls, paper scores with sign-off, rollback, clone, Excel import', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
    const ids = []; for (const n of ['Aa', 'Bb', 'Cc', 'Dd']) ids.push((await A('POST', '/players', { name: n, section: 'adults' })).body.id);
    await A('PUT', '/events/' + tt.id, { participantIds: ids });
    const m1 = (await A('POST', '/matches', { eventId: tt.id, sideA: [ids[0]], sideB: [ids[1]] })).body, m2 = (await A('POST', '/matches', { eventId: tt.id, sideA: [ids[2]], sideB: [ids[3]] })).body;
    const mkRef = async (name, kind, pin) => { const r = (await A('POST', '/referees', { name, kind, pin })).body; return (await call('POST', '/api/login', { role: 'referee', refereeId: r.id, pin })).body.token; };
    const ref = await mkRef('Ref', 'referee', '1111'), chief = await mkRef('Chief', 'chief', '2222');
    const point = (tok, id, cid) => call('POST', '/api/matches/' + id + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid }] }, tok);

    // panic: needs the typed word, freezes scoring, then resumes
    assert.equal((await A('POST', '/panic', { action: 'freeze', confirm: 'no' })).status, 400);
    assert.equal((await A('POST', '/panic', { action: 'freeze', confirm: 'freeze' })).status, 200);
    assert.equal((await point(ref, m1.id, 'f1')).status, 423);
    assert.equal((await call('GET', '/api/state')).body.panic.freezeScoring, true);
    await A('POST', '/panic', { action: 'unfreeze', confirm: 'RESUME' });
    assert.equal((await point(ref, m1.id, 'f2')).status, 200);
    await A('POST', '/panic', { action: 'lock', eventId: tt.id, confirm: 'LOCK' });
    assert.equal((await point(ref, m1.id, 'f3')).status, 423, 'locked event');
    await A('POST', '/panic', { action: 'unlock', eventId: tt.id, confirm: 'UNLOCK' });

    // paper score: referee enters, labelled, chief signs; invalid scores rejected
    assert.equal((await call('POST', '/api/matches/' + m2.id + '/paper', { games: [{ a: 11, b: 11 }] }, ref)).status, 400);
    assert.equal((await call('POST', '/api/matches/' + m2.id + '/paper', { games: [{ a: 11, b: 5 }, { a: 11, b: 8 }], note: 'sheet 12' }, ref)).status, 200);
    let st = (await call('GET', '/api/state')).body, pm = st.matches.find((x) => x.id === m2.id);
    assert.equal(pm.paper.signed, false); assert.ok(!pm.paper.by, 'staff name not public');
    assert.equal(E.derive(pm, st.events.find((e) => e.id === tt.id)).winner, 'A');
    assert.equal((await call('POST', '/api/matches/' + m2.id + '/paper/sign', {}, ref)).status, 403);
    assert.equal((await call('POST', '/api/matches/' + m2.id + '/paper/sign', {}, chief)).status, 200);
    assert.equal((await call('GET', '/api/state')).body.matches.find((x) => x.id === m2.id).paper.signed, true);
    // live-scored match cannot be overwritten by a referee from paper
    assert.equal((await call('POST', '/api/matches/' + m1.id + '/paper', { games: [{ a: 11, b: 2 }, { a: 11, b: 2 }] }, ref)).status, 409);

    // hide scoreboard: public sees no scores, staff still do
    await A('POST', '/panic', { action: 'hide', confirm: 'HIDE' });
    st = (await call('GET', '/api/state')).body; assert.equal(st.matches.find((x) => x.id === m2.id).log.length, 0);
    assert.ok((await call('GET', '/api/state', null, ref)).body.matches.find((x) => x.id === m2.id).log.length > 0);
    await A('POST', '/panic', { action: 'show', confirm: 'SHOW' });

    // excel paper template downloads for referees
    const t = await fetch(s.base + '/api/staff/paper-template.xlsx', { headers: { 'x-token': ref } }); assert.equal(t.status, 200);

    // rollback: restore an earlier snapshot, after a typed confirmation
    const snaps = (await A('GET', '/snapshots')).body; assert.ok(snaps.length >= 1);
    assert.equal((await A('POST', '/rollback', { file: snaps[snaps.length - 1].file, confirm: 'x' })).status, 400);
    await A('POST', '/players', { name: 'After Snapshot', section: 'adults' });
    assert.equal((await A('POST', '/rollback', { file: snaps[snaps.length - 1].file, confirm: 'rollback' })).status, 200);
    assert.ok(!(await call('GET', '/api/state', null, admin)).body.players.some((p) => p.name === 'After Snapshot'));
    assert.equal((await call('POST', '/api/login', { role: 'admin', pin: s.pin })).status, 200, 'admins survive a rollback');

    // clone an event
    const c = await A('POST', '/events/' + tt.id + '/clone', { name: 'Table Tennis B' });
    assert.equal(c.status, 200); assert.deepEqual(c.body.participantIds, []); assert.equal(c.body.config.target, tt.config.target);

    // excel import
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Players');
    ws.addRow(['Name', 'Section', 'Gender', 'Phone', 'Email', 'DOB', 'Age', 'Dept', 'Events', 'Team']);
    ws.addRow(['Imp One', 'adults', 'F', '9000000001', '', '1990-01-01', '', 'Eng', 'Table Tennis, Carrom', 'Reds']);
    ws.addRow(['Imp Two', 'adults', 'M', '9000000002', '', '', '', '', 'Nonexistent Event', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = async (q) => (await fetch(s.base + '/api/admin/import-players' + q, { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream' }, body: buf })).json();
    const dry = await imp('?dry=1'); assert.equal(dry.created, 1); assert.equal(dry.errors.length, 1);
    assert.ok(!(await call('GET', '/api/state', null, admin)).body.players.some((p) => p.name === 'Imp One'), 'dry run adds nothing');
    const real = await imp(''); assert.equal(real.created, 1);
    st = (await call('GET', '/api/state', null, admin)).body; const ip = st.players.find((p) => p.name === 'Imp One');
    assert.ok(ip && st.events.find((e) => e.name === 'Carrom').participantIds.includes(ip.id));
    assert.ok(st.teams.some((t2) => t2.name === 'Reds' && t2.memberIds.includes(ip.id)));
  } finally { await s.stop(); }
});
