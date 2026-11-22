'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');
const E = require('../public/engine.js');

test('cancelled matches, table tennis tie-breaks, referees in Notify, organizer contact numbers', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ref = await chiefTok(s, admin);
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const P = {}; for (const [n, ph] of [['Anu', '9000000201'], ['Bala', '9000000202'], ['Chitra', '9000000203'], ['Dinesh', '']]) P[n] = (await call('POST', '/api/admin/players', { name: n, phone: ph }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: Object.values(P) }, admin);
    const mk = async (a, b, extra) => (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P[a]], sideB: [P[b]], ...(extra || {}) }, admin)).body.id;
    const score = (id, games) => call('POST', '/api/admin/matches/' + id + '/scores', { games }, ref);

    // tie-break by sets: Anu and Bala both win once (2 pts); Anu 2-0 (+2 sets), Bala 2-1 (+1 set) -> Anu first even with fewer points scored
    const m1 = await mk('Anu', 'Chitra'), m2 = await mk('Bala', 'Dinesh');
    await score(m1, [{ a: 11, b: 9 }, { a: 11, b: 9 }]);
    await score(m2, [{ a: 11, b: 0 }, { a: 0, b: 11 }, { a: 11, b: 0 }]);
    st = (await call('GET', '/api/state', null, admin)).body;
    let rows = E.standings(st.events.find((e) => e.id === tt.id), st.matches);
    assert.deepEqual(rows.slice(0, 2).map((r) => r.id), [P.Anu, P.Bala], 'set difference before point difference');

    // cancel: stays, counts for nothing, cannot be scored, can be restored; completed matches cannot be cancelled
    const m3 = await mk('Anu', 'Bala');
    await call('POST', '/api/matches/' + m3 + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'c1' }] }, ref);
    assert.equal((await call('POST', '/api/admin/matches/' + m1 + '/cancel', {}, admin)).status, 409, 'completed match');
    assert.equal((await call('POST', '/api/admin/matches/' + m3 + '/cancel', { reason: 'rain' }, admin)).status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    const c = st.matches.find((m) => m.id === m3);
    assert.equal(c.cancelled.reason, 'rain'); assert.equal(E.derive(c, st.events.find((e) => e.id === tt.id)).status, 'cancelled');
    rows = E.standings(st.events.find((e) => e.id === tt.id), st.matches);
    assert.equal(rows.find((r) => r.id === P.Anu).pf, 22, 'the cancelled point does not count');
    assert.equal((await call('POST', '/api/matches/' + m3 + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'c2' }] }, ref)).status, 409);
    assert.equal((await score(m3, [{ a: 11, b: 1 }, { a: 11, b: 1 }])).status, 409);
    await call('POST', '/api/admin/matches/' + m3 + '/uncancel', {}, admin);
    assert.equal((await call('POST', '/api/matches/' + m3 + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'c3' }] }, ref)).status, 200);

    // Notify includes the match's referees (own number, else their player profile's)
    const refP = (await call('POST', '/api/admin/players', { name: 'Umpire Uma', phone: '9000000299' }, admin)).body.id;
    await call('POST', '/api/admin/people/' + refP + '/roles', { referee: 'referee', sports: ['tt'] }, admin);
    const umaRef = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.playerId === refP).id;
    const m4 = await mk('Chitra', 'Dinesh', { refereeIds: [umaRef] });
    const plan = (await call('POST', '/api/staff/matches/' + m4 + '/notify', {}, admin)).body;
    assert.deepEqual(plan.recipients.map((r) => [r.name, r.role]), [['Chitra', 'player'], ['Umpire Uma', 'referee']]);
    assert.match(plan.recipients[1].text, /^Hi Umpire, you are the referee/);
    assert.deepEqual(plan.missing, ['Dinesh']);

    // organizer contact numbers: set by a main admin, shown publicly on Contact us
    const me = (await call('GET', '/api/admin/admins', null, admin)).body.find((a) => a.me);
    await call('PUT', '/api/admin/admins/' + me.id, { phone: '98450 12345' }, admin);
    const pub = (await call('GET', '/api/state')).body;
    assert.equal(pub.organizers.find((a) => a.id === me.id).phone, '98450 12345');
    // an organizer typed by name takes the number of the one player with that exact name (Dr / Mr ignored); ambiguous or no match -> none
    await call('POST', '/api/admin/players', { name: 'Kavitha Rao', phone: '9000000301' }, admin);
    await call('POST', '/api/admin/players', { name: 'Same Name', phone: '9000000302' }, admin); await call('POST', '/api/admin/players', { name: 'Same Name', phone: '9000000303', section: 'kids' }, admin);
    const kav = (await call('POST', '/api/admin/admins', { name: 'Dr Kavitha Rao', limited: true }, admin)).body.id;
    const amb = (await call('POST', '/api/admin/admins', { name: 'Same Name', limited: true }, admin)).body.id;
    const pub2 = (await call('GET', '/api/state')).body;
    assert.equal(pub2.organizers.find((a) => a.id === kav).phone, '9000000301');
    assert.equal(pub2.organizers.find((a) => a.id === amb).phone, '', 'two players with that name: no guess');
  } finally { await s.stop(); }
});
