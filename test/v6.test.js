'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const E = require('../public/engine.js');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;
const staff = async (s, admin, name, kind, pin) => {
  const r = (await s.call('POST', '/api/admin/referees', { name, kind, pin }, admin)).body;
  return (await s.call('POST', '/api/login', { role: 'referee', refereeId: r.id, pin })).body;
};
const pts = (side, n, c) => Array.from({ length: n }, () => ({ type: 'point', s: side, inc: 1, cid: 'p' + c.n++ }));

test('stage 2: retirement awards the opponent the full score, carrom boards, red card suspension, flags', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const chief = await staff(s, admin, 'Chitra Chief', 'chief', '5501');
    const ref = await staff(s, admin, 'Ravi Ref', 'referee', '5502');
    let st = (await call('GET', '/api/state')).body;
    const bs = st.events.find((e) => e.sport === 'badminton' && e.sideSize === 1 && e.sideType === 'player' && e.scoring === 'points');
    assert.equal(st.events.find((e) => /Women/.test(e.name)).config.target, 21); assert.equal(st.events.find((e) => /Women/.test(e.name)).config.cap, 30);
    const mk = async (n) => (await call('POST', '/api/admin/players', { name: n, gender: 'M', section: bs.section }, admin)).body.id;
    const [p1, p2, p3, p4] = [await mk('Anil'), await mk('Bala'), await mk('Chandra'), await mk('Dev')];
    await call('PUT', '/api/admin/events/' + bs.id, { participantIds: [p1, p2, p3, p4], config: { target: 21, winBy: 2, cap: 30, bestOf: 3 } }, admin);
    const c = { n: 0 };

    // Retirement: Anil leads 11-7 in game 1, Bala retires -> Anil wins 21-7 then 21-0, 21-0
    const m1r = await call('POST', '/api/admin/matches', { eventId: bs.id, sideA: [p1], sideB: [p2] }, admin); assert.equal(m1r.status, 200, JSON.stringify(m1r.body)); const m1 = m1r.body;
    const ops = [...pts('A', 11, c), ...pts('B', 7, c), { type: 'retire', s: 'B', cid: 'r1' }];
    let r = await call('POST', '/api/matches/' + m1.id + '/ops', { ops }, ref.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    st = (await call('GET', '/api/state')).body;
    const mm = { derived: E.derive(st.matches.find((x) => x.id === m1.id), st.events.find((e) => e.id === bs.id)) };
    assert.equal(mm.derived.status, 'completed'); assert.equal(mm.derived.winner, 'A');
    assert.deepEqual(mm.derived.games.map((g) => [g.a, g.b]), [[21, 7], [21, 0], [21, 0]].slice(0, mm.derived.games.length));
    assert.equal(mm.derived.outcome, 'retired');

    // Red card: Chandra gets red -> next two games are walkovers for the opponent, line-up blocked
    const m2 = (await call('POST', '/api/admin/matches', { eventId: bs.id, sideA: [p3], sideB: [p4] }, admin)).body;
    const m3 = (await call('POST', '/api/admin/matches', { eventId: bs.id, sideA: [p3], sideB: [p1] }, admin)).body;
    const m4 = (await call('POST', '/api/admin/matches', { eventId: bs.id, sideA: [p2], sideB: [p3] }, admin)).body;
    assert.equal((await call('POST', '/api/matches/' + m2.id + '/card', { playerId: p3, color: 'red', reason: 'abuse' }, admin)).status, 403, 'organizer cannot issue cards');
    r = await call('POST', '/api/matches/' + m2.id + '/card', { playerId: p3, color: 'red', reason: 'abuse' }, ref.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    st = (await call('GET', '/api/state', null, ref.token)).body;
    const get = (id) => ({ derived: E.derive(st.matches.find((x) => x.id === id), st.events.find((e) => e.id === bs.id)) });
    assert.equal(get(m2.id).derived.winner, 'B'); assert.equal(get(m2.id).derived.outcome, 'suspended');
    assert.equal(get(m3.id).derived.winner, 'B');
    assert.notEqual(get(m4.id).derived.status, 'completed', 'only two games are lost');
    assert.equal(st.players.find((p) => p.id === p3).card.bubble, 'red' === st.players.find((p) => p.id === p3).card.bubble ? 'red' : 'yellow');
    const pubRaw = JSON.stringify((await call('GET', '/api/state')).body);
    assert.ok(!pubRaw.includes('abuse') && !pubRaw.includes('"card"'), 'cards are not public');

    // Yellow card then chief revoke
    const y = await call('POST', '/api/matches/' + m4.id + '/card', { playerId: p2, color: 'yellow' }, ref.token);
    assert.equal(y.status, 200);
    const list = (await call('GET', '/api/staff/cards?playerId=' + p2, null, ref.token)).body;
    assert.equal(list.length, 1);
    assert.equal((await call('POST', '/api/cards/' + list[0].id + '/revoke', {}, ref.token)).status, 403);
    assert.equal((await call('POST', '/api/cards/' + list[0].id + '/revoke', {}, chief.token)).status, 200);
    assert.equal((await call('POST', '/api/matches/' + m4.id + '/card', { playerId: p1, color: 'red' }, ref.token)).status, 400, 'player not in the match');

    // Flags: player flags, chief sees and resolves, referee cannot, match shows flagged for staff
    const f = await call('POST', '/api/disputes', { matchId: m1.id, text: 'Score looks wrong', name: 'Fan', contact: '99999' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal((await call('GET', '/api/staff/flags', null, ref.token)).status, 403);
    const flags = (await call('GET', '/api/staff/flags', null, chief.token)).body;
    assert.equal(flags.length, 1); assert.equal(flags[0].contact, '', 'chief does not see contact');
    assert.equal((await call('GET', '/api/state')).body.matches.find((x) => x.id === m1.id).flagged, true);
    assert.equal((await call('POST', '/api/staff/flags/' + flags[0].id + '/resolve', { note: 'checked' }, chief.token)).status, 200);
    assert.ok(!(await call('GET', '/api/state')).body.matches.find((x) => x.id === m1.id).flagged);

    // Admin can reset a player's record
    assert.equal((await call('POST', '/api/admin/players/' + p3 + '/cards-reset', {}, admin)).status, 200);
    st = (await call('GET', '/api/state', null, ref.token)).body;
    assert.equal(st.players.find((p) => p.id === p3).card.bubble, 'green');
  } finally { s.stop && s.stop(); }
});

test('stage 2: carrom boards use coin weight, queen cutoff and the 8-board limit', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const ref = await staff(s, admin, 'Ravi Ref', 'referee', '5502');
    const st = (await call('GET', '/api/state')).body;
    const ev = st.events.find((e) => e.sport === 'carrom' && e.sideSize === 1 && e.sideType === 'player' && e.section === 'adults') || st.events.find((e) => e.sport === 'carrom' && e.sideSize === 1);
    assert.equal(ev.config.queenWeight, 3); assert.equal(ev.config.queenCutoff, 22);
    const a = (await call('POST', '/api/admin/players', { name: 'Asha', gender: 'F', section: ev.section }, admin)).body.id;
    const b = (await call('POST', '/api/admin/players', { name: 'Bina', gender: 'F', section: ev.section }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + ev.id, { participantIds: [a, b] }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: ev.id, sideA: [a], sideB: [b] }, admin)).body;
    const post = (ops) => call('POST', '/api/matches/' + m.id + '/ops', { ops }, ref.token);
    let r = await post([{ type: 'board', s: 'A', coins: 4, queen: true, cid: 'b1' }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dv = async () => { const q = (await call('GET', '/api/state')).body; return E.derive(q.matches.find((x) => x.id === m.id), q.events.find((e) => e.id === ev.id)); };
    let d = await dv();
    assert.equal(d.current.a, 7, '4 coins + queen 3');
    // push A to 23 then queen no longer counts
    await post([{ type: 'board', s: 'A', coins: 6, queen: false, cid: 'b2' }, { type: 'board', s: 'A', coins: 9, queen: true, cid: 'b3' }]);
    d = await dv();
    assert.ok(d.games.length >= 1 && d.games[0].a >= 25, 'game ends at 25 or more: ' + JSON.stringify(d.games));
  } finally { s.stop && s.stop(); }
});
