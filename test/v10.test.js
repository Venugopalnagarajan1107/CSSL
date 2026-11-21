'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('multi-sheet excel import: sheet picker, header mapping, event-per-sheet, merge, admin delete', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const st = (await call('GET', '/api/state')).body;
    const adultInd = st.events.filter((e) => e.sideType !== 'team' && (e.section || 'adults') === 'adults');
    const e1 = adultInd[0], e2 = adultInd[1];
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
    // sheet 1: named after an event, title row above the header, own column order, Male/Female, dd/mm/yyyy
    const a = wb.addWorksheet(e1.name);
    a.addRow(['Company sports day – registrations']);
    a.addRow(['S.No', 'Player ID', 'Mobile No', 'Name of the Employee', 'Dept', 'Sex', 'DOB']);
    a.addRow([1, 'E-1', 9200000001, 'Sheet Alpha', 'Finance', 'Female', '05/06/1990']);
    a.addRow([2, 'E-2', 9200000002, 'Sheet Beta', 'HR', 'Male', '']);
    // sheet 2: wide format, Yes in an event column; Alpha again (same phone) -> merged
    const b = wb.addWorksheet('Second list');
    b.addRow(['First Name', 'Surname', 'Contact Number', e2.name]);
    b.addRow(['Sheet', 'Alpha', '+91 92000 00001', 'Yes']);
    b.addRow(['Sheet', 'Gamma', '9200000003', 'yes']);
    // sheet 3: notes, not a player list
    wb.addWorksheet('Notes').addRow(['Bring your own racket']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const post = (path, q, opts) => fetch(s.base + path + (q || ''), { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream', ...(opts ? { 'x-import-options': JSON.stringify(opts) } : {}) }, body: buf }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const info = (await post('/api/admin/import-inspect')).body;
    assert.equal(info.sheets.length, 3);
    const [s1, s2, s3] = info.sheets;
    assert.ok(s1.looksLikePlayers && s1.rows === 2 && s1.headerRow === 2 && s1.eventId === e1.id, 'sheet named after event');
    assert.equal(s1.map.name, 4); assert.equal(s1.map.phone, 3); assert.ok(!s1.map.ageGroup);
    assert.ok(s2.looksLikePlayers && s2.eventCols.some((x) => x.eventId === e2.id), 'event column detected');
    assert.ok(!s3.looksLikePlayers);

    // only sheet 1 chosen
    const only1 = { sheets: [{ index: 0, headerRow: s1.headerRow, map: s1.map, eventId: s1.eventId }] };
    const d1 = (await post('/api/admin/import-players', '?dry=1', only1)).body;
    assert.equal(d1.created, 2); assert.equal(d1.sheets.length, 1);

    // both sheets: Alpha merged into one player entered in both events
    const both = { sheets: [{ index: 0, headerRow: s1.headerRow, map: s1.map, eventId: s1.eventId }, { index: 1, headerRow: s2.headerRow, map: s2.map }] };
    const dry = (await post('/api/admin/import-players', '?dry=1', both)).body;
    assert.equal(dry.created, 3); assert.equal(dry.merged, 1); assert.equal(dry.errors.length, 0);
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.filter((p) => /^Sheet /.test(p.name)).length, 0, 'dry run adds nothing');
    const r = (await post('/api/admin/import-players', '', both)).body;
    assert.equal(r.created, 3);
    const f = (await call('GET', '/api/state', null, admin)).body;
    const alpha = f.players.filter((p) => p.name === 'Sheet Alpha');
    assert.equal(alpha.length, 1);
    assert.ok(f.events.find((e) => e.id === e1.id).participantIds.includes(alpha[0].id));
    assert.ok(f.events.find((e) => e.id === e2.id).participantIds.includes(alpha[0].id));
    const priv = (await call('GET', '/api/admin/players/' + alpha[0].id, null, admin)).body;
    assert.equal(priv.dob, '1990-06-05'); assert.equal(priv.gender, 'F'); assert.equal(priv.affiliation, 'Finance');

    // missing name column is refused
    assert.equal((await post('/api/admin/import-players', '?dry=1', { sheets: [{ index: 2, map: {} }] })).status, 400);

    // profiles are permanent; the organizer removes the player from the event instead
    assert.equal((await call('DELETE', '/api/admin/players/' + alpha[0].id, null, admin)).status, 403);
    const tid = (await call('GET', '/api/state', null, admin)).body.tournaments[0].id;
    assert.equal((await call('POST', '/api/admin/tournaments/' + tid + '/roster', { remove: alpha[0].id }, admin)).status, 200);
    const g = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(g.players.some((p) => p.id === alpha[0].id), 'profile kept');
    assert.ok(!g.events.find((e) => e.id === e1.id).participantIds.includes(alpha[0].id), 'out of the event’s games');
    assert.ok(!g.tournaments[0].playerIds.includes(alpha[0].id), 'off the event roster');
  } finally { await s.stop(); }
});
