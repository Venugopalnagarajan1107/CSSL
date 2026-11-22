'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('one workbook sets up games, players, teams and fixtures; preview changes nothing', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const st0 = (await call('GET', '/api/state', null, admin)).body;
    const teamGame = st0.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
    const g = wb.addWorksheet('Games'); g.addRow(['Game', 'Sport', 'Category', 'Type']); g.addRow(['Badminton – Men Doubles', 'Badminton', 'Seniors', 'Doubles']); g.addRow([teamGame.name, 'Badminton', 'Seniors', 'Team']);
    const p = wb.addWorksheet('Form Responses'); p.addRow(['Participant Name', 'Phone Number', 'Select Games to Participate [Table Tennis]', 'Category', 'Gender']);
    ['Ann One', 'Bob Two', 'Cat Three', 'Dan Four'].forEach((n, i) => p.addRow([n, '90000001' + i + '0', 'Yes', 'Seniors', i % 2 ? 'Male' : 'Female']));
    const t = wb.addWorksheet('Teams'); t.addRow(['Team', 'Game', 'Player 1', 'Player 2']); t.addRow(['Red Hawks', teamGame.name, 'ann one', 'Bob Two']); t.addRow(['Blue Jays', teamGame.name, 'Cat Three', 'Nobody Here']);
    const f = wb.addWorksheet('Fixtures'); f.addRow(['Game', 'Side A', 'Side B', 'Round', 'Date', 'Time', 'Court']);
    f.addRow(['Table Tennis', 'Ann One', 'Bob Two', 'Semi final', '30/11/2026', '10:30 AM', 'Table 1']);
    f.addRow([teamGame.name, 'Red Hawks', 'Blue Jays', 'Final', '30/11/2026', '4:00 PM', 'Court 2']);
    f.addRow(['Table Tennis', 'Ann One', 'Ghost', '', '', '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const post = (path, q, opts) => fetch(s.base + path + (q || ''), { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream', ...(opts ? { 'x-import-options': JSON.stringify(opts) } : {}) }, body: buf }).then((r) => r.json());

    const info = await post('/api/admin/import-inspect');
    assert.deepEqual(info.sheets.map((x) => x.kind), ['games', 'players', 'teams', 'fixtures']);

    const before = JSON.stringify((await call('GET', '/api/state', null, admin)).body.events);
    const dry = await post('/api/admin/import-players', '?dry=1');
    assert.equal(dry.gamesMade, 1); assert.equal(dry.gamesExisting, 1); assert.equal(dry.created, 4);
    assert.equal(dry.teamsCreated, 2); assert.equal(dry.teamEntries, 2); assert.equal(dry.fixturesMade, 2);
    assert.ok(dry.warnings.some((w) => /Nobody Here/.test(w.error))); assert.ok(dry.errors.some((e) => /Ghost/.test(e.error)));
    const after = (await call('GET', '/api/state', null, admin)).body;
    assert.equal(JSON.stringify(after.events), before, 'preview leaves games untouched');
    assert.equal(after.players.length, 0); assert.equal(after.teams.length, 0); assert.equal(after.matches.length, 0);

    const r = await post('/api/admin/import-players');
    assert.equal(r.fixturesMade, 2);
    const st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(st.events.some((e) => e.name === 'Badminton – Men Doubles' && e.sideSize === 2 && e.sport === 'badminton'));
    const red = st.teams.find((x) => x.name === 'Red Hawks');
    assert.equal(red.memberIds.length, 2); assert.ok(st.events.find((e) => e.id === teamGame.id).participantIds.includes(red.id));
    const tt = st.matches.find((m) => st.events.find((e) => e.id === m.eventId).name === 'Table Tennis');
    assert.equal(tt.stage, 'Semi-final'); assert.equal(tt.startsAt, '2026-11-30T10:30'); assert.equal(tt.court, 'Table 1');
    assert.equal(st.matches.find((m) => m.eventId === teamGame.id).startsAt, '2026-11-30T16:00');
    // uploading the same file again does not duplicate anything
    const again = await post('/api/admin/import-players');
    assert.equal(again.fixturesMade || 0, 0); assert.equal(again.fixturesExisting, 2); assert.equal(again.teamsCreated || 0, 0); assert.equal(again.created, 0);
    assert.equal((await call('GET', '/api/state', null, admin)).body.matches.length, 2);
  } finally { await s.stop(); }
});

test('team builder: waiting players, new team, auto-make teams, remove team', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const ev = (await call('GET', '/api/state', null, admin)).body.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const ids = [];
    for (let i = 0; i < 9; i++) ids.push((await call('POST', '/api/admin/players', { name: 'Waiter ' + i, gender: i < 3 ? 'F' : 'M' }, admin)).body.id);
    let e;
    { // the waiting list is filled by registration or the upload (a Games column naming the team game)
      const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('P'); ws.addRow(['Name', 'Games']);
      for (let i = 0; i < 9; i++) ws.addRow(['Waiter ' + i, ev.name]);
      await fetch(s.base + '/api/admin/import-players', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(await wb.xlsx.writeBuffer()) });
      e = (await call('GET', '/api/state', null, admin)).body.events.find((x) => x.id === ev.id);
    }
    assert.equal(e.interestedIds.length, 9);
    const t1 = await call('POST', '/api/admin/events/' + ev.id + '/teams', { name: 'Smashers', memberIds: [ids[0], ids[3]] }, admin);
    assert.equal(t1.status, 200);
    assert.equal((await call('POST', '/api/admin/events/' + ev.id + '/teams', { name: 'smashers', memberIds: [] }, admin)).status, 409, 'duplicate team name');
    const auto = (await call('POST', '/api/admin/events/' + ev.id + '/auto-teams', { size: 3 }, admin)).body;
    assert.equal(auto.players, 7); assert.equal(auto.teams, 2);
    const st = (await call('GET', '/api/state', null, admin)).body; e = st.events.find((x) => x.id === ev.id);
    assert.equal(e.participantIds.length, 3); assert.equal(e.interestedIds.length, 0);
    const made = st.teams.filter((t) => /^Team \d$/.test(t.name));
    assert.deepEqual(made.map((t) => t.memberIds.length).sort(), [3, 4]);
    made.forEach((t) => assert.ok(t.memberIds.some((id) => ids.slice(0, 3).includes(id)), 'women spread across teams'));
    assert.equal((await call('POST', '/api/admin/events/' + ev.id + '/teams/' + t1.body.id + '/remove', null, admin)).status, 200);
    e = (await call('GET', '/api/state', null, admin)).body.events.find((x) => x.id === ev.id);
    assert.equal(e.participantIds.length, 2); assert.equal(e.interestedIds.length, 2, 'members back on the waiting list');
  } finally { await s.stop(); }
});
