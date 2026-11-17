'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/engine.js');
const Fx = require('../lib/fixtures.js');
const { start, chiefTok } = require('./helpers');

const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;
const CFG = { bestOf: 1, target: 3, winBy: 1, cap: 0, increments: [1], pointsWin: 2, pointsDraw: 1, pointsLoss: 0, finalists: 4 };
const evOf = (o) => ({ id: 'e', name: 'E', scoring: 'points', sideType: 'player', sideSize: 1, participantIds: [], config: { ...CFG, ...(o && o.config) }, ...o });
const pts = (m, ev, seq, rid) => seq.split('').forEach((c, i) => E.applyOp(m, ev, { type: 'point', s: c, inc: 1, cid: (rid || 'm') + c + i + Math.random(), ...(rid ? { rid } : {}) }, 't'));

test('engine: team tie made of rubbers (clinch, standings, undo, profile stats)', () => {
  const ev = evOf({ sideType: 'team', participantIds: ['T1', 'T2'], rubbers: [{ name: 'S1' }], rubberRules: { clinch: true } });
  const mkRub = (id, a, b) => ({ id, name: id, size: 1, gender: '', config: {}, sideA: a, sideB: b, log: [], cids: [], result: null });
  const m = { id: 'tie', eventId: 'e', stage: 'League', sideA: ['T1'], sideB: ['T2'], log: [], cids: [], result: null, rubbers: [mkRub('r1', ['a1'], ['b1']), mkRub('r2', ['a2'], ['b2']), mkRub('r3', ['a3'], ['b3'])] };
  assert.equal(E.derive(m, ev).status, 'scheduled');
  pts(m, ev, 'AAA', 'r1');
  let d = E.derive(m, ev); assert.equal(d.status, 'live'); assert.equal(d.gamesA, 1);
  pts(m, ev, 'BBB', 'r2');
  d = E.derive(m, ev); assert.equal(d.status, 'live'); assert.equal(d.gamesB, 1);
  pts(m, ev, 'AAA', 'r3');
  d = E.derive(m, ev); assert.equal(d.status, 'completed'); assert.equal(d.winner, 'A'); assert.equal(d.gamesA, 2);
  assert.equal(E.scoreText(d), '2-1 rubbers');
  /* undo (no rid) removes the most recent point of the tie */
  E.applyOp(m, ev, { type: 'undo', cid: 'u1' }, 't');
  assert.equal(E.derive(m, ev).status, 'live');
  /* a rubber with empty sides cannot be scored */
  const m2 = { ...m, rubbers: [mkRub('x', [], [])], cids: [] };
  assert.equal(E.applyOp(m2, ev, { type: 'point', s: 'A', inc: 1, rid: 'x', cid: 'z' }, 't'), false);
  /* standings: tie points, rubber difference breaks ties before point difference */
  const done = { ...m, rubbers: m.rubbers.map((r) => ({ ...r, log: r.log.slice() })), cids: [] }; pts(done, ev, 'AAA', 'r3');
  const rows = E.standings(ev, [done]);
  assert.equal(rows[0].id, 'T1'); assert.equal(rows[0].mp, 2); assert.equal(rows[0].rw, 2); assert.equal(rows[1].rl, 2);
  /* profile counts rubbers a player took part in */
  const data = { players: [{ id: 'a1', name: 'A1' }, { id: 'b1', name: 'B1' }], teams: [{ id: 'T1', name: 'One', memberIds: ['a1'] }, { id: 'T2', name: 'Two', memberIds: ['b1'] }], events: [ev], matches: [done] };
  const st = E.playerStats('a1', data); assert.equal(st.totals.played, 1); assert.equal(st.totals.won, 1);
});

test('engine: knockout bracket with byes, third place and podium', () => {
  assert.deepEqual(E.seedsOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  const ev = evOf({ participantIds: ids, format: { type: 'knockout', thirdPlace: true } });
  ev.bracket = { order: E.bracketOrder(ids) };
  const matches = [];
  const add = (plan) => plan.forEach((x, i) => matches.push({ id: x.stage + i, eventId: 'e', log: [], cids: [], result: null, ...x }));
  const win = (m, side) => E.applyOp(m, ev, { type: 'result', result: side, cid: m.id }, 't');
  let plan = Fx.koPlan(ev, matches, E.bracket);
  assert.deepEqual(plan.map((x) => x.stage), ['Quarter-final'], 'only the real quarter-final is played; 1-3 have byes');
  assert.deepEqual([plan[0].sideA[0], plan[0].sideB[0]].sort(), ['s4', 's5']);
  add(plan); assert.throws(() => Fx.koPlan(ev, matches, E.bracket), /Finish all Quarter-final/);
  win(matches[0], matches[0].sideA[0] === 's4' ? 'A' : 'B');
  plan = Fx.koPlan(ev, matches, E.bracket); assert.deepEqual(plan.map((x) => x.stage), ['Semi-final', 'Semi-final']); add(plan);
  matches.filter((m) => m.stage === 'Semi-final').forEach((m) => win(m, 'A'));
  plan = Fx.koPlan(ev, matches, E.bracket);
  assert.deepEqual(plan.map((x) => x.stage).sort(), ['Final', 'Third place']); add(plan);
  matches.filter((m) => m.stage === 'Final' || m.stage === 'Third place').forEach((m) => win(m, 'A'));
  assert.throws(() => Fx.koPlan(ev, matches, E.bracket), /already been created/);
  const pod = E.podium(ev, matches);
  assert.equal(pod.first.length, 1); assert.equal(pod.second.length, 1); assert.equal(pod.third.length, 1);
  assert.notEqual(pod.first[0], pod.second[0]);
});

test('engine: groups tables and Swiss pairing never repeat a pairing', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const g = Fx.drawGroups(ids.concat(['h']), 2);
  assert.equal(Object.keys(g).length, 2); assert.equal(g.A.length + g.B.length, 8);
  assert.throws(() => Fx.drawGroups(['a', 'b', 'c'], 2), /at least 4/);
  const ev = evOf({ participantIds: ids, format: { type: 'swiss' } });
  const matches = []; const byes = new Set(); const played = new Set();
  for (let round = 1; round <= 5; round++) {
    const r = Fx.swissPairs(ids, E.standings({ ...ev, byes: [...byes].map((id) => ({ id })) }, matches), played, byes);
    assert.equal(r.rematch, false, 'round ' + round + ' has no rematch');
    assert.ok(r.bye && !byes.has(r.bye), 'odd field: a different player sits out each round');
    byes.add(r.bye);
    r.pairs.forEach(([x, y], i) => { assert.ok(!played.has(Fx.pairKey(x, y))); played.add(Fx.pairKey(x, y)); const m = { id: 'm' + round + i, eventId: 'e', stage: 'League', round, sideA: [x], sideB: [y], log: [], cids: [], result: x < y ? 'A' : 'B' }; matches.push(m); });
  }
  const rows = E.standings({ ...ev, byes: [...byes].map((id) => ({ id })) }, matches);
  assert.equal(rows.reduce((n, r) => n + r.byes, 0), 5);
});

test('v4 server: configurable formats end to end', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s); const chief = await chiefTok(s, admin);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const st0 = (await call('GET', '/api/state')).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis');
    const mkp = async (n, g, o) => (await A('POST', '/players', { name: n, gender: g || 'M', section: 'adults', ...(o || {}) })).body;
    const P = []; for (let i = 1; i <= 8; i++) P.push(await mkp('Player' + i));
    const result = async (matchId, side, token) => call('POST', '/api/matches/' + matchId + '/ops', { ops: [{ type: 'result', result: side, cid: 'c' + Math.random() }] }, token || chief);
    const matchesOf = async (evId, stage) => (await call('GET', '/api/state', null, admin)).body.matches.filter((m) => m.eventId === evId && (!stage || m.stage === stage));

    /* --- knockout with a third-place match and hands-free progress --- */
    let r = await A('PUT', '/events/' + tt.id, { participantIds: P.map((p) => p.id), format: { type: 'knockout', thirdPlace: true, autoAdvance: true } });
    assert.equal(r.status, 200); assert.equal(r.body.format.type, 'knockout'); assert.equal(r.body.config.finalists, 0);
    r = await A('POST', '/events/' + tt.id + '/generate', { mode: 'knockout', courts: 'T1,T2', start: '2026-11-28T09:00' });
    assert.equal(r.status, 200); assert.equal(r.body.stage, 'Quarter-final'); assert.equal(r.body.created, 4);
    assert.equal((await A('POST', '/events/' + tt.id + '/generate', { mode: 'knockout' })).status, 409, 'cannot draw twice');
    for (const m of await matchesOf(tt.id, 'Quarter-final')) await result(m.id, 'A');
    assert.equal((await matchesOf(tt.id, 'Semi-final')).length, 2, 'semi-finals created automatically');
    for (const m of await matchesOf(tt.id, 'Semi-final')) await result(m.id, 'B');
    assert.equal((await matchesOf(tt.id, 'Final')).length, 1);
    assert.equal((await matchesOf(tt.id, 'Third place')).length, 1);
    for (const m of [...await matchesOf(tt.id, 'Final'), ...await matchesOf(tt.id, 'Third place')]) await result(m.id, 'A');
    const fin = (await call('GET', '/api/state')).body;
    const pod = E.podium(fin.events.find((e) => e.id === tt.id), fin.matches);
    assert.ok(pod && pod.first.length === 1 && pod.second.length === 1 && pod.third.length === 1, 'podium has gold, silver and bronze');
    assert.equal((await A('POST', '/events/' + tt.id + '/reset-draw', {})).status, 409, 'played matches need confirmation');
    assert.equal((await A('POST', '/events/' + tt.id + '/reset-draw', { force: true })).body.removed, 8);
    assert.equal((await matchesOf(tt.id)).length, 0);

    /* --- groups then knockout --- */
    r = await A('PUT', '/events/' + tt.id, { format: { type: 'groups', groups: 2, qualifiers: 2, thirdPlace: false, autoAdvance: false } });
    assert.equal(r.body.config.finalists, 4);
    r = await A('POST', '/events/' + tt.id + '/generate', { mode: 'groups', random: true });
    assert.equal(r.body.created, 12); assert.equal(r.body.groups, 2);
    let st = (await call('GET', '/api/state')).body;
    const gev = st.events.find((e) => e.id === tt.id); const tabs = E.groupTables(gev, st.matches);
    assert.equal(tabs.length, 2); assert.equal(tabs[0].rows.length, 4);
    assert.equal((await A('POST', '/events/' + tt.id + '/finals', {})).status, 409, 'league not finished');
    for (const m of await matchesOf(tt.id, 'League')) await result(m.id, 'A');
    r = await A('POST', '/events/' + tt.id + '/finals', {}); assert.equal(r.status, 200); assert.equal(r.body.stage, 'Semi-final');
    const semis = await matchesOf(tt.id, 'Semi-final'); assert.equal(semis.length, 2);
    st = (await call('GET', '/api/state')).body;
    const tabs2 = E.groupTables(st.events.find((e) => e.id === tt.id), st.matches);
    const firsts = tabs2.map((t) => t.rows[0].id), seconds = tabs2.map((t) => t.rows[1].id);
    semis.forEach((m) => { const ids = [m.sideA[0], m.sideB[0]]; assert.ok(ids.some((x) => firsts.includes(x)) && ids.some((x) => seconds.includes(x)), 'group winner meets the other group\'s runner-up'); });

    const xl = await fetch(s.base + '/api/export.xlsx', { headers: { 'x-token': admin } });
    const xb = Buffer.from(await xl.arrayBuffer());
    assert.equal(xl.status, 200); assert.equal(xb.toString('latin1', 0, 2), 'PK', 'Excel export works with groups and brackets');

    /* --- Swiss --- */
    const chess = st0.events.find((e) => e.name === 'Chess');
    await A('PUT', '/events/' + chess.id, { participantIds: P.slice(0, 5).map((p) => p.id), format: { type: 'swiss', swissRounds: 3 }, config: { finalists: 0 } });
    r = await A('POST', '/events/' + chess.id + '/generate', { mode: 'swiss' }); assert.equal(r.body.created, 2); assert.ok(r.body.bye);
    assert.equal((await A('POST', '/events/' + chess.id + '/generate', { mode: 'swiss' })).status, 409, 'finish the round first');
    for (let k = 1; k <= 3; k++) {
      for (const m of await matchesOf(chess.id, 'League')) if (E.derive(m, chess).status !== 'completed') await result(m.id, 'A');
      if (k < 3) assert.equal((await A('POST', '/events/' + chess.id + '/generate', { mode: 'swiss' })).status, 200);
    }
    assert.equal((await A('POST', '/events/' + chess.id + '/generate', { mode: 'swiss' })).status, 400, 'only 3 rounds');
    const sw = (await matchesOf(chess.id, 'League')); const pairs = sw.map((m) => Fx.pairKey(m.sideA[0], m.sideB[0]));
    assert.equal(new Set(pairs).size, pairs.length, 'no repeated pairing');
  } finally { await s.stop(); }
});

test('v4 server: team rubbers, line-ups, referee assignment, schedule shift, age bands, uploads', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s); const chief = await chiefTok(s, admin);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const st0 = (await call('GET', '/api/state')).body;
    const te = st0.events.find((e) => e.name === 'Badminton – Team Event');
    const mkp = async (n, g, sec, extra) => (await A('POST', '/players', { name: n, gender: g, section: sec || 'adults', ...(extra || {}) })).body;
    const m1 = await mkp('Mo1', 'M'), m2 = await mkp('Mo2', 'M'), w1 = await mkp('Wo1', 'F'), w2 = await mkp('Wo2', 'F');
    const n1 = await mkp('No1', 'M'), n2 = await mkp('No2', 'M'), x1 = await mkp('Xo1', 'F'), x2 = await mkp('Xo2', 'F');
    const t1 = (await A('POST', '/teams', { name: 'Reds', memberIds: [m1, m2, w1, w2].map((p) => p.id) })).body;
    const t2 = (await A('POST', '/teams', { name: 'Blues', memberIds: [n1, n2, x1, x2].map((p) => p.id) })).body;
    let r = await A('PUT', '/events/' + te.id, { participantIds: [t1.id, t2.id], config: { bestOf: 1, target: 3, winBy: 1 },
      rubbers: [{ name: "Men's singles", size: 1, gender: 'M', count: 1 }, { name: "Women's singles", size: 1, gender: 'F', count: 1 }, { name: 'Mixed doubles', size: 2, gender: '', count: 1 }], rubberRules: { clinch: true, maxPerPlayer: 2 } });
    assert.equal(r.status, 200); assert.equal(r.body.rubbers.length, 3);
    const tie = (await A('POST', '/matches', { eventId: te.id, sideA: [t1.id], sideB: [t2.id], refereeId: '' })).body;
    assert.equal(tie.rubbers.length, 3, 'rubbers are created from the event template');
    const rid = (name) => tie.rubbers.find((x) => x.name === name).id;
    const lineup = (rubbers, tok) => call('POST', '/api/matches/' + tie.id + '/lineup', { rubbers }, tok || admin);
    assert.equal((await lineup([{ id: rid("Men's singles"), sideA: [w1.id], sideB: [n1.id] }])).status, 400, 'a woman cannot play men\'s singles');
    assert.equal((await lineup([{ id: rid("Men's singles"), sideA: [n2.id], sideB: [n1.id] }])).status, 400, 'a player from the other team is refused');
    assert.equal((await lineup([{ id: rid('Mixed doubles'), sideA: [m1.id], sideB: [n1.id, x1.id] }])).status, 400, 'doubles needs two players');
    assert.equal((await lineup([{ id: rid("Men's singles"), sideA: [m1.id], sideB: [n1.id] }, { id: rid("Women's singles"), sideA: [w1.id], sideB: [x1.id] }, { id: rid('Mixed doubles'), sideA: [m1.id, w1.id], sideB: [n1.id, x1.id] }])).status, 200);
    assert.equal((await lineup([{ id: rid('Mixed doubles'), sideA: [m1.id, w1.id], sideB: [n1.id, x1.id] }, { id: rid("Men's singles"), sideA: [m1.id], sideB: [n1.id] }])).status, 200, 'two rubbers per player is allowed');

    /* referees: assignment can be enforced */
    const ref1 = (await A('POST', '/referees', { name: 'Ref One', pin: '1111' })).body, ref2 = (await A('POST', '/referees', { name: 'Ref Two', pin: '2222' })).body;
    await A('PUT', '/matches/' + tie.id, { refereeId: ref1.id });
    const tok1 = (await call('POST', '/api/login', { role: 'referee', refereeId: ref1.id, pin: '1111' })).body.token;
    const tok2 = (await call('POST', '/api/login', { role: 'referee', refereeId: ref2.id, pin: '2222' })).body.token;
    const ops = (tok, rub, side, n) => call('POST', '/api/matches/' + tie.id + '/ops', { force: true, ops: Array.from({ length: n }, () => ({ type: 'point', s: side, inc: 1, rid: rub, cid: 'p' + Math.random() })) }, tok);
    assert.equal((await ops(tok2, rid("Men's singles"), 'A', 1)).status, 200, 'enforcement is off by default');
    await A('POST', '/tournament', { enforceReferee: true });
    assert.equal((await ops(tok2, rid("Men's singles"), 'A', 1)).status, 403, 'another referee is blocked');
    assert.equal((await ops(tok1, rid("Men's singles"), 'A', 2)).status, 200);
    assert.equal((await call('POST', '/api/matches/' + tie.id + '/lineup', { rubbers: [] }, tok2)).status, 403);

    /* score two rubbers -> tie clinched 2-0 */
    await ops(tok1, rid("Women's singles"), 'A', 3);
    let st = (await call('GET', '/api/state')).body;
    const live = st.matches.find((m) => m.id === tie.id);
    const d = E.derive(live, st.events.find((e) => e.id === te.id));
    assert.equal(d.status, 'completed'); assert.equal(d.winner, 'A'); assert.equal(d.gamesA, 2); assert.equal(d.gamesB, 0);
    assert.ok(!JSON.stringify(live).includes('"cids"'), 'internal ids are not published');
    assert.equal((await ops(tok1, rid('Mixed doubles'), 'B', 1)).body.changed, false, 'no more scoring once the tie is clinched');
    /* admin score correction targets one rubber */
    assert.equal((await call('POST', '/api/admin/matches/' + tie.id + '/scores', { games: [{ a: 3, b: 1 }] }, chief)).status, 400, 'must choose a rubber');
    assert.equal((await call('POST', '/api/admin/matches/' + tie.id + '/scores', { rid: rid('Mixed doubles'), games: [{ a: 1, b: 3 }] }, chief)).status, 200);
    st = (await call('GET', '/api/state')).body;
    assert.equal(E.derive(st.matches.find((m) => m.id === tie.id), st.events.find((e) => e.id === te.id)).gamesB, 1);

    /* schedule shift */
    const tt = st0.events.find((e) => e.name === 'Table Tennis');
    const ps = []; for (let i = 0; i < 4; i++) ps.push(await mkp('TT' + i, 'M'));
    await A('PUT', '/events/' + tt.id, { participantIds: ps.map((p) => p.id) });
    await A('POST', '/events/' + tt.id + '/generate', { mode: 'roundrobin', courts: 'C1', start: '2026-11-28T09:00', slotMinutes: 30 });
    const before = (await call('GET', '/api/state')).body.matches.filter((m) => m.eventId === tt.id).map((m) => m.startsAt).sort();
    r = await A('POST', '/shift', { minutes: 20, from: '2026-11-28T10:00', eventId: tt.id });
    const after = (await call('GET', '/api/state')).body.matches.filter((m) => m.eventId === tt.id).map((m) => m.startsAt).sort();
    assert.equal(r.body.moved, before.filter((x) => x >= '2026-11-28T10:00').length);
    assert.equal(after[0], before[0], 'earlier matches are untouched'); assert.notEqual(after[after.length - 1], before[before.length - 1]);
    assert.equal((await A('POST', '/shift', { minutes: 0 })).status, 400);

    /* age bands */
    const kt = st0.events.find((e) => e.name === 'Kids – Table Tennis');
    const k8 = await mkp('Kid Eight', 'M', 'kids', { ageGroup: '8' }), k13 = await mkp('Kid Thirteen', 'F', 'kids', { ageGroup: 'Under-14' }), kx = await mkp('Kid Unknown', 'F', 'kids', { ageGroup: 'junior' });
    assert.equal((await A('PUT', '/events/' + kt.id, { ageMin: 6, ageMax: 10, participantIds: [k8.id] })).status, 200);
    r = await A('PUT', '/events/' + kt.id, { participantIds: [k8.id, k13.id] });
    assert.equal(r.status, 400); assert.match(r.body.error, /age range/);
    assert.equal((await A('PUT', '/events/' + kt.id, { participantIds: [k8.id, kx.id] })).status, 200, 'unreadable ages are not blocked');
    await A('POST', '/registration', { enabled: true });
    const reg = (b) => call('POST', '/api/register', { section: 'kids', gender: 'F', phone: '98450 22222', guardianName: 'Parent', guardianPhone: '98450 33333', consent: true, eventIds: [kt.id], ...b }, '', { 'x-forwarded-for': '10.7.0.' + Math.floor(Math.random() * 200) });
    assert.equal((await reg({ name: 'Too Old', ageGroup: '14' })).status, 400);
    assert.equal((await reg({ name: 'Just Right', ageGroup: '9' })).status, 200);

    /* uploads must really be images */
    const up = (buf, type) => fetch(s.base + '/api/upload', { method: 'POST', headers: { 'content-type': type, 'x-token': admin }, body: buf });
    assert.equal((await up(Buffer.from('<?php echo 1;'), 'image/png')).status, 400, 'text pretending to be PNG');
    assert.equal((await up(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(20)]), 'image/png')).status, 200);
  } finally { await s.stop(); }
});

test('v4 server: approval push registration and format validation', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s); const chief = await chiefTok(s, admin);
    const st0 = (await call('GET', '/api/state')).body;
    const wd = st0.events.find((e) => e.name.includes('Doubles'));
    const r = await call('PUT', '/api/admin/events/' + wd.id, { format: { type: 'swiss' } }, admin);
    assert.equal(r.body.format.type, 'roundrobin', 'doubles keep the rotating-partner format');
    const bad = await call('POST', '/api/admin/events/' + wd.id + '/generate', { mode: 'knockout' }, admin);
    assert.equal(bad.status, 400);
    const tt = st0.events.find((e) => e.name === 'Table Tennis');
    const big = await call('PUT', '/api/admin/events/' + tt.id, { rubbers: [{ name: 'x', count: 5 }] }, admin);
    assert.equal(big.body.rubbers.length, 0, 'rubbers only apply to team events');
    await call('POST', '/api/admin/registration', { enabled: true }, admin);
    const reg = (await call('POST', '/api/register', { name: 'Push Person', section: 'adults', gender: 'F', phone: '98450 44444', consent: true, eventIds: [tt.id] }, '', { 'x-forwarded-for': '10.8.0.1' })).body;
    const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) } };
    assert.equal((await call('POST', '/api/self/' + reg.id + '/push', { subscription: sub }, '', { 'x-edit-token': 'nope' })).status, 403);
    assert.equal((await call('POST', '/api/self/' + reg.id + '/push', { subscription: sub }, '', { 'x-edit-token': reg.editToken })).status, 200);
    assert.equal((await call('POST', '/api/admin/players/' + reg.id + '/approve', {}, admin)).status, 200);
    await s.settle(600);
  } finally { await s.stop(); }
});

test('house rule: carrom / table tennis / chess (adults and kids): under 8 players straight final, 8+ semi-finals', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s); const chief = await chiefTok(s, admin);
    const A = (m, u, b) => call(m, '/api/admin' + u, b, admin);
    const st0 = (await call('GET', '/api/state')).body;
    const names = ['Table Tennis', 'Carrom', 'Chess', 'Kids – Table Tennis', 'Kids – Carrom', 'Kids – Chess'];
    names.forEach((n) => { const e = st0.events.find((x) => x.name === n); assert.equal(e.config.smallBelow, 8, n); assert.equal(e.config.finalistsSmall, 2, n); assert.equal(e.config.finalists, 4, n); assert.equal(e.format.type, 'roundrobin', n); });
    const run = async (name, count) => {
      const ev = st0.events.find((x) => x.name === name), kids = ev.section === 'kids';
      const ids = []; for (let i = 0; i < count; i++) ids.push((await A('POST', '/players', { name: name + ' P' + i, section: kids ? 'kids' : 'adults', ageGroup: '9' })).body.id);
      await A('PUT', '/events/' + ev.id, { participantIds: ids });
      assert.equal((await A('POST', '/events/' + ev.id + '/generate', { mode: 'roundrobin' })).status, 200);
      const ms = (await call('GET', '/api/state')).body.matches.filter((m) => m.eventId === ev.id);
      for (const m of ms) await call('POST', '/api/matches/' + m.id + '/ops', { ops: [{ type: 'result', result: 'A', cid: 'r' + m.id }] }, chief);
      const r = await A('POST', '/events/' + ev.id + '/finals', {});
      assert.equal(r.status, 200, name + ' ' + JSON.stringify(r.body));
      return r.body;
    };
    let r = await run('Table Tennis', 7); assert.equal(r.stage, 'Final'); assert.equal(r.created, 1);
    r = await run('Carrom', 8); assert.equal(r.stage, 'Semi-final'); assert.equal(r.created, 2);
    r = await run('Chess', 5); assert.equal(r.stage, 'Final');
    r = await run('Kids – Table Tennis', 9); assert.equal(r.stage, 'Semi-final');
    r = await run('Kids – Carrom', 3); assert.equal(r.stage, 'Final');
    const st = (await call('GET', '/api/state')).body, tt = st.events.find((e) => e.name === 'Table Tennis');
    assert.equal(E.finalistsFor(tt), 2);
    assert.equal(E.standings(tt, st.matches).filter((x) => x.qualified).length, 2, 'only two rows are highlighted as qualified');
    assert.equal(E.finalistsFor(st.events.find((e) => e.name === 'Carrom')), 4);
    /* withdrawing after play started does not change the finals format (count frozen at the first match) */
    const k = st.events.find((e) => e.name === 'Carrom');
    await A('POST', '/events/' + k.id + '/withdraw', { participantId: k.participantIds[0] });
    assert.equal(E.finalistsFor((await call('GET', '/api/state')).body.events.find((e) => e.name === 'Carrom')), 4, 'player count is frozen once the first match is played');
  } finally { await s.stop(); }
});
