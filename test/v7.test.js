'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const E = require('../public/engine.js');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('stage 3: captains set line-ups, opposing line-up stays hidden, locked at start', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const te = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Badminton – Team Event');
    const mk = async (n, g) => (await A('POST', '/players', { name: n, gender: g, section: 'adults' })).body;
    const r = await Promise.all([mk('Ma', 'M'), mk('Mb', 'M'), mk('Wa', 'F'), mk('Na', 'M'), mk('Nb', 'M'), mk('Xa', 'F')]);
    const [ma, mb, wa, na, nb, xa] = r;
    const t1 = (await A('POST', '/teams', { name: 'Reds', memberIds: [ma.id, mb.id, wa.id] })).body;
    const t2 = (await A('POST', '/teams', { name: 'Blues', memberIds: [na.id, nb.id, xa.id] })).body;
    await A('PUT', '/events/' + te.id, { participantIds: [t1.id, t2.id], config: { bestOf: 1, target: 3, winBy: 1 }, rubbers: [{ name: 'MS', size: 1, gender: 'M', count: 1 }, { name: 'WS', size: 1, gender: 'F', count: 1 }], rubberRules: { clinch: true, maxPerPlayer: 2 } });
    const tie = (await A('POST', '/matches', { eventId: te.id, sideA: [t1.id], sideB: [t2.id], round: 2, totalRounds: 5 })).body;
    assert.equal(tie.round, 2); assert.equal(tie.totalRounds, 5);
    const rid = (n) => tie.rubbers.find((x) => x.name === n).id;

    // captain codes
    assert.equal((await call('POST', '/api/admin/teams/' + t1.id + '/captain-code', {}, undefined)).status, 401);
    const c1 = (await A('POST', '/teams/' + t1.id + '/captain-code', { playerId: ma.id })).body, c2 = (await A('POST', '/teams/' + t2.id + '/captain-code', { playerId: na.id })).body;
    assert.match(c1.code, /^\d{6}$/);
    assert.ok(!JSON.stringify((await call('GET', '/api/state')).body.teams).includes('captainHash'));
    assert.equal((await call('POST', '/api/login', { role: 'captain', teamId: t1.id, pin: '000000' })).status, 401);
    const k1 = (await call('POST', '/api/login', { role: 'captain', teamId: t1.id, pin: c1.code })).body, k2 = (await call('POST', '/api/login', { role: 'captain', teamId: t2.id, pin: c2.code })).body;
    assert.equal(k1.role, 'captain');
    // captains are not staff
    assert.equal((await call('POST', '/api/matches/' + tie.id + '/ops', { ops: [] }, k1.token)).status, 403);
    assert.equal((await call('GET', '/api/staff/cards', null, k1.token)).status, 403);
    assert.ok(!JSON.stringify((await call('GET', '/api/state', null, k1.token)).body).includes('"card"'), 'captains get the public view');

    const lineup = (tok, rubbers) => call('POST', '/api/matches/' + tie.id + '/lineup', { rubbers }, tok);
    // captain A sets own side only
    assert.equal((await lineup(k1.token, [{ id: rid('MS'), sideA: [ma.id] }, { id: rid('WS'), sideA: [wa.id] }])).status, 200);
    assert.equal((await lineup(k1.token, [{ id: rid('MS'), sideA: [wa.id] }])).status, 400, 'woman cannot play men\'s singles');
    assert.equal((await lineup(k1.token, [{ id: rid('MS'), sideB: [na.id] }])).status, 200, 'other side in the request is ignored');
    let pubTie = (await call('GET', '/api/state')).body.matches.find((m) => m.id === tie.id);
    assert.ok(pubTie.lineupHidden && pubTie.rubbers.every((x) => !x.sideA.length && !x.sideB.length), 'hidden publicly until both captains have set theirs');
    const view1 = (await call('GET', '/api/captain/ties', null, k1.token)).body.ties[0];
    assert.deepEqual(view1.rubbers.find((x) => x.name === 'MS').sideA, [ma.id], 'captain sees own line-up');
    assert.deepEqual(view1.rubbers.find((x) => x.name === 'MS').sideB, [], 'but not the opponent’s');
    // captain B cannot touch captain A's ties for other team
    assert.equal((await lineup(k2.token, [{ id: rid('MS'), sideB: [na.id] }, { id: rid('WS'), sideB: [xa.id] }])).status, 200);
    pubTie = (await call('GET', '/api/state')).body.matches.find((m) => m.id === tie.id);
    assert.ok(!pubTie.lineupHidden); assert.deepEqual(pubTie.rubbers.find((x) => x.name === 'MS').sideA, [ma.id]);
    // shuffle until tie starts
    assert.equal((await lineup(k1.token, [{ id: rid('MS'), sideA: [mb.id] }])).status, 200);
    // started -> locked
    const ref = (await A('POST', '/referees', { name: 'Ref', pin: '1234' })).body;
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '1234' })).body.token;
    await call('POST', '/api/matches/' + tie.id + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, rid: rid('MS'), cid: 'z1' }] }, rt);
    assert.equal((await lineup(k1.token, [{ id: rid('WS'), sideA: [wa.id] }])).status, 409, 'locked once the tie starts');
    // captain of an unrelated team
    const t3 = (await A('POST', '/teams', { name: 'Greens', memberIds: [] })).body;
    const c3 = (await A('POST', '/teams/' + t3.id + '/captain-code', {})).body;
    const k3 = (await call('POST', '/api/login', { role: 'captain', teamId: t3.id, pin: c3.code })).body;
    assert.equal((await lineup(k3.token, [{ id: rid('WS'), sideA: [wa.id] }])).status, 403);
  } finally { await s.stop(); }
});

test('stage 3: per-fixture points settings, round x of y, finals count frozen at first match', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push((await A('POST', '/players', { name: 'T' + i, gender: 'M', section: 'adults' })).body.id);
    await A('PUT', '/events/' + tt.id, { participantIds: ids });
    const m = (await A('POST', '/matches', { eventId: tt.id, sideA: [ids[0]], sideB: [ids[1]], round: 1, totalRounds: 7, cfg: { bestOf: 5, target: 7, winBy: 2 } })).body;
    assert.equal(m.totalRounds, 7); assert.deepEqual(m.cfg, { bestOf: 5, target: 7, winBy: 2 });
    const ref = (await A('POST', '/referees', { name: 'Ref', pin: '1234' })).body;
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '1234' })).body.token;
    const ops = []; for (let g = 0; g < 3; g++) for (let i = 0; i < 7; i++) ops.push({ type: 'point', s: 'A', inc: 1, cid: 'a' + g + i });
    assert.equal((await call('POST', '/api/matches/' + m.id + '/ops', { ops }, rt)).status, 200);
    let st = (await call('GET', '/api/state')).body;
    const d = E.derive(st.matches.find((x) => x.id === m.id), st.events.find((x) => x.id === tt.id));
    assert.equal(d.status, 'completed'); assert.equal(d.gamesA, 3, 'best of 5 to 7 points');
    // frozen finalists: 8 players -> top 4; a late withdrawal/late entry no longer changes the format
    let ev = st.events.find((x) => x.id === tt.id);
    assert.equal(ev.frozenCount, 8); assert.equal(E.finalistsFor(ev), 4);
    const late = (await A('POST', '/players', { name: 'Late', gender: 'M', section: 'adults' })).body.id;
    await A('PUT', '/events/' + tt.id, { participantIds: [...ids.slice(0, 5), late] });
    st = (await call('GET', '/api/state')).body; ev = st.events.find((x) => x.id === tt.id);
    assert.equal(ev.frozenCount, 8); assert.equal(E.finalistsFor(ev), 4, 'still four finalists');
  } finally { await s.stop(); }
});
