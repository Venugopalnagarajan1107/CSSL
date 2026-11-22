'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('events side by side: create with structure, roster-only entries, teams, match numbers, friendlies, close', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    let st = (await call('GET', '/api/state', null, admin)).body;
    const season = st.tournaments.find((t) => t.kind !== 'friendly');
    assert.equal(season.name, 'CSSL - Season 3'); assert.ok(st.tournaments.some((t) => t.kind === 'friendly'));
    const dbPlayer = (await call('POST', '/api/admin/players', { name: 'Old Timer' }, admin)).body;   // enrolled in Season 3 only

    // a referee may create an event and name its organizers / referees (typed or from the player list)
    const ref = (await call('POST', '/api/admin/referees', { name: 'Ref Maker', pin: '4321' }, admin)).body;
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '4321' })).body.token;
    assert.equal((await call('POST', '/api/staff/tournaments', { name: 'Diwali Cup' })).status, 401, 'needs a PIN');
    assert.match((await call('POST', '/api/staff/tournaments', { name: 'Diwali Cup', refereeIds: [ref.id] }, rt)).body.error, /organizer/);
    const made = await call('POST', '/api/staff/tournaments', { name: 'Diwali Cup', dates: '1 Nov', newOrganizers: [{ playerId: dbPlayer.id }, 'Typed Org'], refereeIds: [ref.id],
      games: [{ sport: 'badminton', kind: 'doubles', name: "Women's Doubles" }, { sport: 'carrom', kind: 'team' }, { sport: 'chess' }] }, rt);
    assert.equal(made.status, 200); assert.equal(made.body.games, 3);
    assert.deepEqual(made.body.pins.map((x) => x.name), ['Old Timer', 'Typed Org']);
    const cup = made.body.tournament;
    st = (await call('GET', '/api/state', null, admin)).body;
    const wd = st.events.find((e) => e.tid === cup.id && e.name === "Women's Doubles"), cTeam = st.events.find((e) => e.tid === cup.id && e.sideType === 'team');
    assert.deepEqual(wd.refereeIds, [ref.id]); assert.equal(wd.sideSize, 2);

    // the new organizer manages Diwali Cup only
    const org = (await call('POST', '/api/login', { role: 'admin', pin: made.body.pins[1].pin })).body.token;
    assert.equal((await call('PUT', '/api/staff/tournaments/' + cup.id, { venue: 'Clubhouse' }, org)).status, 200);
    assert.equal((await call('PUT', '/api/staff/tournaments/' + season.id, { venue: 'X' }, org)).status, 403);
    assert.equal((await call('POST', '/api/admin/games', { tid: cup.id, sport: 'tt', kind: 'singles' }, org)).status, 200, 'event organizer adds games; event referees by default');

    // players from the database cannot be entered directly – only registered / uploaded / enrolled ones
    assert.equal((await call('PUT', '/api/admin/events/' + wd.id, { participantIds: [dbPlayer.id] }, org)).status, 400);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('P'); ws.addRow(['Name', 'Gender']);
    ['Ann', 'Bea', 'Cid', 'Dee'].forEach((n, i) => ws.addRow([n, i < 2 ? 'F' : 'M']));
    const up = await fetch(s.base + '/api/admin/import-players?tid=' + cup.id, { method: 'POST', headers: { 'x-token': org, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(await wb.xlsx.writeBuffer()) }).then((r) => r.json());
    assert.equal(up.created, 4);
    st = (await call('GET', '/api/state', null, admin)).body;
    const ids = ['Ann', 'Bea', 'Cid', 'Dee'].map((n) => st.players.find((p) => p.name === n).id);
    assert.ok(ids.every((id) => st.tournaments.find((t) => t.id === cup.id).playerIds.includes(id)) && !st.tournaments.find((t) => t.id === season.id).playerIds.includes(ids[0]));
    assert.equal((await call('PUT', '/api/admin/events/' + wd.id, { participantIds: ids }, org)).status, 200);
    assert.equal((await call('POST', '/api/admin/tournaments/' + cup.id + '/roster', { add: [dbPlayer.id] }, org)).status, 200, 'organizer may enrol an existing player');

    // teams under the event, with the team games they play
    const tm = await call('POST', '/api/admin/tournaments/' + cup.id + '/teams', { name: 'Kings', memberIds: ids.slice(0, 2), eventIds: [cTeam.id] }, org);
    assert.equal(tm.status, 200); assert.equal(tm.body.added, 1);
    await call('POST', '/api/admin/tournaments/' + cup.id + '/teams', { name: 'Queens', memberIds: ids.slice(2), eventIds: [cTeam.id] }, org);
    assert.equal((await call('POST', '/api/admin/tournaments/' + cup.id + '/teams', { name: 'Ghosts', memberIds: [ids[0]], eventIds: [] }, admin)).status, 200);
    assert.equal((await call('POST', '/api/admin/tournaments/' + season.id + '/teams', { name: 'Wrong', memberIds: [ids[0]] }, admin)).status, 400, 'members must be in that event');

    // match numbers per game
    const m1 = (await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: ids.slice(0, 2), sideB: ids.slice(2) }, org)).body;
    const m2 = (await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: [ids[0], ids[2]], sideB: [ids[1], ids[3]] }, org)).body;
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.deepEqual([m1.id, m2.id].map((id) => st.matches.find((m) => m.id === id).no), [1, 2]);
    const teams = st.teams.filter((t) => t.tid === cup.id && t.name !== 'Ghosts').map((t) => t.id);
    const tie = (await call('POST', '/api/admin/matches', { eventId: cTeam.id, sideA: [teams[0]], sideB: [teams[1]] }, org)).body;
    assert.equal((await call('GET', '/api/state', null, admin)).body.matches.find((m) => m.id === tie.id).no, 1, 'team event numbering starts at 1');

    // friendly match between any database players, outside every event
    const f = await call('POST', '/api/staff/friendly', { sport: 'chess', sideA: [dbPlayer.id], sideB: [ids[0]] }, rt);
    assert.equal(f.status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.equal(st.events.find((e) => e.id === f.body.eventId).tid, 'friendly');

    // closing an event freezes it
    assert.equal((await call('PUT', '/api/staff/tournaments/' + cup.id, { status: 'closed' }, org)).status, 200);
    assert.equal((await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: ids.slice(0, 2), sideB: ids.slice(2) }, org)).status, 409);
    assert.equal((await call('PUT', '/api/staff/tournaments/' + season.id, { status: 'closed' }, admin)).status, 400, 'one event must stay open');
  } finally { await s.stop(); }
});
