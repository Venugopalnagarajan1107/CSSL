'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');

test('players: remove many from an event; delete profiles only without history; parallel events; all events may close', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ref = await chiefTok(s, admin);
    let st = (await call('GET', '/api/state', null, admin)).body;
    const season = st.tournaments.find((t) => t.kind !== 'friendly');
    const P = {}; for (const n of ['Anu', 'Bala', 'Chitra', 'Deepa', 'Esha']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + season.id + '/roster', { add: Object.values(P) }, admin);
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults' && e.tid === season.id);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: [P.Anu, P.Bala, P.Chitra] }, admin);
    const mt = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P.Anu], sideB: [P.Bala] }, admin)).body;
    await call('POST', '/api/matches/' + mt.id + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'z' }] }, ref);

    // a second event running in parallel with the same players
    const cup = (await call('POST', '/api/staff/tournaments', { name: 'Winter Cup', refereeIds: st.referees.slice(0, 1).map((r) => r.id).concat([]), newReferees: st.referees.length ? [] : ['Ref W'], games: [{ sport: 'chess' }] }, admin)).body.tournament;
    assert.equal((await call('POST', '/api/admin/tournaments/' + cup.id + '/roster', { add: [P.Anu, P.Chitra] }, admin)).body.added, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(st.tournaments.filter((t) => t.playerIds.includes(P.Anu)).length >= 2, 'Anu is in both events');

    // remove several from the season: players with fixtures there are skipped and named
    const r = (await call('POST', '/api/admin/tournaments/' + season.id + '/roster', { remove: [P.Anu, P.Chitra, P.Deepa] }, admin)).body;
    assert.equal(r.removed, 2); assert.equal(r.skipped.length, 1); assert.match(r.skipped[0], /^Anu \(Table Tennis\)/);
    st = (await call('GET', '/api/state', null, admin)).body;
    const T = st.tournaments.find((t) => t.id === season.id);
    assert.ok(T.playerIds.includes(P.Anu) && !T.playerIds.includes(P.Chitra) && !T.playerIds.includes(P.Deepa));
    assert.ok(!st.events.find((e) => e.id === tt.id).participantIds.includes(P.Chitra), 'out of the game too');
    assert.ok(st.tournaments.find((t) => t.id === cup.id).playerIds.includes(P.Chitra), 'still in the other event');

    // delete profiles: only those who never played and hold no role
    await call('POST', '/api/admin/people/' + P.Esha + '/roles', { referee: 'referee', sports: ['tt'] }, admin);
    const d = (await call('POST', '/api/admin/players/bulk-delete', { ids: [P.Anu, P.Chitra, P.Esha] }, admin)).body;
    assert.equal(d.removed, 1);
    assert.deepEqual(d.kept.sort(), ['Anu (has played)', 'Esha (admin / referee role)']);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(!st.players.some((x) => x.id === P.Chitra));
    // restoring from Trash puts Chitra back in Winter Cup
    const tr = (await call('GET', '/api/admin/trash', null, admin)).body.find((x) => x.col === 'players');
    await call('POST', '/api/admin/trash/' + tr.id + '/restore', null, admin);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(st.tournaments.find((t) => t.id === cup.id).playerIds.includes(P.Chitra));
    // single delete follows the same rule; sport leads cannot delete profiles
    assert.equal((await call('DELETE', '/api/admin/players/' + P.Anu, null, admin)).status, 403);
    const lead = (await call('POST', '/api/admin/admins', { name: 'Lead', sports: ['tt'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.equal((await call('POST', '/api/admin/players/bulk-delete', { ids: [P.Deepa] }, lt)).status, 403);

    // every event may be closed – nothing has to stay open
    for (const t of st.tournaments.filter((x) => x.kind !== 'friendly')) assert.equal((await call('PUT', '/api/staff/tournaments/' + t.id, { status: 'closed' }, admin)).status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.ok(st.tournaments.filter((x) => x.kind !== 'friendly').every((t) => t.status === 'closed'));
  } finally { await s.stop(); }
});
