'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('master player list: upload without an event; bulk delete teams and referees', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Players'); ws.addRow(['Participant Name', 'Phone Number', 'Select Games to Participate [Chess]', 'Category']);
    ws.addRow(['Ravi Master', 9000000101, 'Yes', 'Seniors']); ws.addRow(['Lalitha Master', 9000000102, '', 'Seniors']);
    const fx = wb.addWorksheet('Fixtures'); fx.addRow(['Game', 'Side A', 'Side B']); fx.addRow(['Chess', 'Ravi Master', 'Lalitha Master']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const post = (tok, q) => fetch(s.base + '/api/admin/import-players?tid=none' + (q || ''), { method: 'POST', headers: { 'x-token': tok, 'Content-Type': 'application/octet-stream' }, body: xlsx }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const dry = (await post(admin, '&dry=1')).body;
    assert.equal(dry.created, 2); assert.equal(dry.master, true);
    assert.ok(dry.warnings.some((w) => w.name === 'Fixtures'), 'fixture sheet is skipped and named');
    let st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(!st.players.some((p) => p.name === 'Ravi Master'), 'preview changes nothing');
    const r = (await post(admin)).body; assert.equal(r.created, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    const ravi = st.players.find((p) => p.name === 'Ravi Master');
    assert.ok(ravi, 'in the master list');
    assert.ok(!st.tournaments.some((t) => (t.playerIds || []).includes(ravi.id)), 'not put into any event');
    assert.ok(!st.events.some((e) => e.participantIds.includes(ravi.id) || (e.interestedIds || []).includes(ravi.id)), 'not put into any game');
    assert.equal(st.matches.length, 0, 'no fixtures made');
    // only a main admin uploads to the master list
    const lead = (await call('POST', '/api/admin/admins', { name: 'Lead', sports: ['chess'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.equal((await post(lt, '&dry=1')).status, 403);

    // teams: several at once; a team with a match is kept
    const P = []; for (const n of ['T1', 'T2', 'T3', 'T4']) P.push((await call('POST', '/api/admin/players', { name: n }, admin)).body.id);
    const mk = async (name, ids) => (await call('POST', '/api/admin/teams', { name, memberIds: ids }, admin)).body.id;
    const A = await mk('Alpha', [P[0]]), B = await mk('Bravo', [P[1]]), C = await mk('Charlie', [P[2]]);
    const team = st.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    await call('PUT', '/api/admin/events/' + team.id, { participantIds: [A, B] }, admin);
    await call('POST', '/api/admin/matches', { eventId: team.id, sideA: [A], sideB: [B] }, admin);
    const td = (await call('POST', '/api/admin/teams/bulk-delete', { ids: [A, C] }, admin)).body;
    assert.equal(td.removed, 1); assert.deepEqual(td.kept, ['Alpha (has matches)']);

    // referees: several at once (main admin only)
    const R1 = (await call('POST', '/api/admin/referees', { name: 'Ref A', sports: ['tt'] }, admin)).body.id, R2 = (await call('POST', '/api/admin/referees', { name: 'Ref B', sports: ['tt'] }, admin)).body.id;
    assert.equal((await call('POST', '/api/admin/referees/bulk-delete', { ids: [R1] }, lt)).status, 403);
    assert.equal((await call('POST', '/api/admin/referees/bulk-delete', { ids: [R1, R2] }, admin)).body.removed, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(!st.referees.some((x) => x.id === R1 || x.id === R2));
    assert.ok(!st.teams.some((t) => t.id === C) && st.teams.some((t) => t.id === A));
  } finally { await s.stop(); }
});
