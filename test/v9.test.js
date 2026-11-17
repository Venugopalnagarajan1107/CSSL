'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('public web address saved/validated; team events open for registration as an interest list', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const A = (b) => call('POST', '/api/admin/registration', b, admin);
    assert.equal((await A({ publicUrl: 'https://abc.tail1234.ts.net/' })).status, 200);
    assert.equal((await call('GET', '/api/state')).body.registration.publicUrl, 'https://abc.tail1234.ts.net');
    assert.equal((await A({ publicUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await A({ publicUrl: 'https://x.com/path' })).status, 400);
    assert.equal((await A({ publicUrl: '' })).status, 200);
    assert.equal((await call('GET', '/api/state')).body.registration.publicUrl, '');
    await A({ enabled: true });
    const st = (await call('GET', '/api/state')).body;
    const teamEv = st.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const ttEv = st.events.find((e) => e.name === 'Table Tennis');
    assert.ok(st.registration.events.find((e) => e.id === teamEv.id).team);
    const r = await call('POST', '/api/register', { consent: true, section: 'adults', name: 'Team Hopeful', phone: '9800000001', eventIds: [teamEv.id, ttEv.id] }, '', { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pid = r.body.id;
    const ap = await call('POST', '/api/admin/players/' + pid + '/approve', {}, admin);
    assert.equal(ap.status, 200);
    const st2 = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(st2.events.find((e) => e.id === teamEv.id).interestedIds.includes(pid));
    assert.ok(!st2.events.find((e) => e.id === teamEv.id).participantIds.includes(pid));
    assert.ok(st2.events.find((e) => e.id === ttEv.id).participantIds.includes(pid));
  } finally { await s.stop(); }
});

test('games: organizer and player can both choose games; limits and fixtures respected', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    await call('POST', '/api/admin/registration', { enabled: true }, admin);
    const st = (await call('GET', '/api/state')).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const team = st.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const r = await call('POST', '/api/register', { consent: true, section: 'adults', name: 'Gita Rao', phone: '9800000002', eventIds: [tt.id] }, '', { 'x-forwarded-for': '8.8.8.8' });
    const pid = r.body.id, tok = r.body.editToken;
    await call('POST', '/api/admin/players/' + pid + '/approve', {}, admin);
    // organizer adds a team-event interest too
    let g = await call('PUT', '/api/admin/players/' + pid + '/games', { eventIds: [tt.id, team.id] }, admin);
    assert.equal(g.status, 200);
    let ev = (await call('GET', '/api/state', null, admin)).body.events;
    assert.ok(ev.find((e) => e.id === tt.id).participantIds.includes(pid));
    assert.ok(ev.find((e) => e.id === team.id).interestedIds.includes(pid));
    // player drops the team event herself
    const self = await call('PUT', '/api/self/' + pid + '/games', { eventIds: [tt.id] }, '', { 'x-edit-token': tok, 'x-forwarded-for': '8.8.8.8' });
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.deepEqual(self.body.gameIds, [tt.id]);
    ev = (await call('GET', '/api/state', null, admin)).body.events;
    assert.ok(!ev.find((e) => e.id === team.id).interestedIds.includes(pid));
    // wrong token refused
    assert.equal((await call('PUT', '/api/self/' + pid + '/games', { eventIds: [] }, '', { 'x-edit-token': 'nope', 'x-forwarded-for': '8.8.8.8' })).status, 403);
    // once registration is closed a player cannot change games, organizer still can
    await call('POST', '/api/admin/registration', { enabled: false }, admin);
    assert.equal((await call('PUT', '/api/self/' + pid + '/games', { eventIds: [] }, '', { 'x-edit-token': tok, 'x-forwarded-for': '8.8.8.8' })).status, 403);
    g = await call('PUT', '/api/admin/players/' + pid + '/games', { eventIds: [] }, admin);
    assert.equal(g.status, 200);
    ev = (await call('GET', '/api/state', null, admin)).body.events;
    assert.ok(!ev.find((e) => e.id === tt.id).participantIds.includes(pid));
  } finally { await s.stop(); }
});

test('excel import maps players, games, teams and team events', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Players');
    const st = (await call('GET', '/api/state')).body;
    const team = st.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    ws.addRow(['Name', 'Section', 'Gender', 'Phone', 'Email', 'DOB', 'Age', 'Dept', 'Games', 'Team']);
    ws.addRow(['Imp One', 'adults', 'M', '9100000001', '', '1990-01-01', '', 'X', tt.name + ', ' + team.name, 'Red Hawks']);
    ws.addRow(['Imp Two', 'adults', 'F', '9100000002', '', '1991-02-02', '', 'X', team.name, 'Red Hawks']);
    ws.addRow(['Imp Three', 'adults', 'F', '9100000003', '', '1992-03-03', '', 'X', team.name, '']);
    ws.addRow(['Imp Bad', 'adults', 'F', '', '', '', '', '', 'No Such Game', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const post = (q) => fetch(s.base + '/api/admin/import-players' + q, { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream' }, body: buf }).then((r) => r.json());
    const dry = await post('?dry=1');
    assert.equal(dry.created, 3); assert.equal(dry.errors.length, 1);
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.filter((p) => /^Imp /.test(p.name)).length, 0);
    const r = await post('');
    assert.equal(r.created, 3); assert.equal(r.teamsMade, 1); assert.equal(r.teamEntries, 1); assert.equal(r.interested, 1);
    const f = (await call('GET', '/api/state', null, admin)).body;
    const t = f.teams.find((x) => x.name === 'Red Hawks'); assert.equal(t.memberIds.length, 2);
    const te = f.events.find((e) => e.id === team.id);
    assert.deepEqual(te.participantIds, [t.id]); assert.equal(te.interestedIds.length, 1);
    assert.equal(f.events.find((e) => e.id === tt.id).participantIds.length, 1);
    const tpl = await fetch(s.base + '/api/admin/import-template.xlsx', { headers: { 'x-token': admin } });
    assert.equal(tpl.status, 200);
  } finally { await s.stop(); }
});
