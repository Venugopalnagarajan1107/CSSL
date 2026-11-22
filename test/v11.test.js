'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');
const E = require('../public/engine.js');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('rankings engine: points for wins and medals, per sport, shared ranks, all-time sums seasons', () => {
  const cfg = { bestOf: 1, target: 11, winBy: 1, cap: 0, increments: [1] };
  const ev = (id, sport) => ({ id, name: id, sport, scoring: 'points', sideType: 'player', sideSize: 1, participantIds: ['a', 'b', 'c'], config: cfg });
  const data = { players: ['a', 'b', 'c'].map((id) => ({ id, name: id, section: 'adults' })), teams: [], events: [ev('chess', 'chess'), ev('carrom', 'carrom')], matches: [] };
  // use the engine's own score path so the test does not depend on match internals
  const mk = (id, eventId, A, B, stage) => { const m = { id, eventId, sideA: [A], sideB: [B], stage: stage || 'Group', log: [] }; for (let i = 0; i < 11; i++) E.applyOp(m, data.events.find((e) => e.id === eventId), { type: 'point', s: 'A' }, 'ref'); return m; };
  data.matches = [mk('m1', 'chess', 'a', 'b'), mk('m2', 'chess', 'a', 'c', 'Final'), mk('m3', 'carrom', 'c', 'b')];
  const rec = E.seasonRecords(data, data.matches);
  assert.equal(rec.a.chess.won, 2); assert.equal(rec.a.chess.gold, 1); assert.equal(rec.c.chess.silver, 1); assert.equal(rec.c.carrom.won, 1);
  const overall = E.rankings([rec]);
  assert.equal(overall[0].id, 'a'); assert.equal(overall[0].points, 2 * 3 + 10);
  const carrom = E.rankings([rec], { sport: 'carrom' });
  assert.deepEqual(carrom.map((r) => [r.id, r.rank]), [['c', 1], ['b', 2]]);
  const allTime = E.rankings([rec, { b: { chess: { played: 5, won: 5, drawn: 0, lost: 0, pf: 0, pa: 0, gold: 1, silver: 0, bronze: 0 } } }]);
  assert.equal(allTime[0].id, 'b', 'past season results count all-time');
  const custom = E.rankings([rec], { pts: { win: 1, gold: 0 } });
  assert.equal(custom.find((r) => r.id === 'a').points, 2);
});

test('season, rankings settings, referee limits, sign-up and approval', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    let st = (await call('GET', '/api/state')).body;
    assert.equal(st.tournament.seasonName, 'CSSL - Season 3'); assert.deepEqual(st.seasons, []);

    // players + a table tennis final, scored by the chief referee
    const bd = st.events.find((e) => e.name === 'Table Tennis' && (e.section || 'adults') === 'adults');
    await call('PUT', '/api/admin/events/' + bd.id, { config: { target: 11, winBy: 1, cap: 0, bestOf: 1 } }, admin);
    const a = (await call('POST', '/api/admin/players', { name: 'Rank Alpha' }, admin)).body, b = (await call('POST', '/api/admin/players', { name: 'Rank Beta' }, admin)).body;
    await call('PUT', '/api/admin/events/' + bd.id, { participantIds: [a.id, b.id] }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: bd.id, sideA: [a.id], sideB: [b.id], stage: 'Final' }, admin)).body;
    assert.equal((await call('POST', '/api/admin/matches/' + m.id + '/scores', { games: [{ a: 11, b: 4 }] }, await chiefTok(s, admin))).status, 200);
    st = (await call('GET', '/api/state', null, admin)).body;
    const rows = E.rankings([E.seasonRecords(st, st.matches)], { players: st.players });
    assert.equal(rows[0].id, a.id); assert.equal(rows[0].points, 3 + 10); assert.equal(rows[1].points, 6);

    // ranking points and season name are organizer settings
    assert.equal((await call('POST', '/api/admin/tournament', { rankPts: { win: 2, gold: 5 } }, admin)).status, 200);
    st = (await call('GET', '/api/state')).body; assert.equal(st.tournament.rankPts.win, 2); assert.equal(st.tournament.rankPts.draw, 1);

    // referee limited to chess cannot score a table tennis match
    const ref = (await call('POST', '/api/admin/referees', { name: 'Chess Only', sports: ['chess'] }, admin)).body;
    assert.deepEqual(ref.sports, ['chess']);
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: ref.pin })).body.token;
    const blocked = await call('POST', '/api/matches/' + m.id + '/paper', { result: 'A' }, rt);
    assert.equal(blocked.status, 403); assert.match(blocked.body.error, /Chess/);

    // referee sign-up: closed by default, then open -> pending -> cannot sign in -> approved with PIN
    assert.equal((await call('POST', '/api/referee-signup', { name: 'New Ref', phone: '9876543210' })).status, 403);
    await call('POST', '/api/admin/tournament', { refSignupOpen: true }, admin);
    assert.equal((await call('POST', '/api/referee-signup', { name: 'New Ref', phone: '12' })).status, 400);
    assert.equal((await call('POST', '/api/referee-signup', { name: 'New Ref', phone: '9876543210', sports: ['carrom', 'nope'] })).status, 200);
    assert.equal((await call('POST', '/api/referee-signup', { name: 'New Ref', phone: '98765 43210' })).status, 409);
    assert.ok(!(await call('GET', '/api/state')).body.referees.some((r) => r.name === 'New Ref'), 'pending sign-ups are not public');
    const pend = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.name === 'New Ref');
    assert.equal(pend.status, 'pending'); assert.deepEqual(pend.sports, ['carrom']); assert.equal(pend.phone, '9876543210');
    assert.equal((await call('POST', '/api/login', { role: 'referee', refereeId: pend.id, pin: '0000' })).status, 403);
    const ok = (await call('POST', '/api/admin/referees/' + pend.id + '/approve', { kind: 'referee', sports: ['carrom', 'chess'] }, admin)).body;
    assert.match(ok.pin, /^\d{4}$/);
    assert.equal((await call('POST', '/api/login', { role: 'referee', refereeId: pend.id, pin: ok.pin })).status, 200);

    // next season: Season 3 is frozen with its champion and records; name counts up; all-time keeps results
    const ns = (await call('POST', '/api/admin/new-tournament', { keepPlayers: true, keepGames: true, keepReferees: true, keepSponsors: true }, admin)).body;
    assert.equal(ns.season, 'CSSL - Season 4');
    st = (await call('GET', '/api/state')).body;
    assert.equal(st.tournament.seasonName, 'CSSL - Season 4'); assert.equal(st.matches.length, 0);
    assert.equal(st.seasons.length, 1); assert.equal(st.seasons[0].name, 'CSSL - Season 3');
    assert.ok(st.seasons[0].champions.some((c) => c.event === bd.name && /Rank/.test(c.first)));
    assert.equal(st.seasons[0].records[a.id].tt.gold, 1);
    assert.ok(st.events.some((e) => e.name === bd.name && !e.participantIds.length), 'same games kept, without entries');
    const allTime = E.rankings([E.seasonRecords(st, st.matches), ...st.seasons.map((x) => x.records)], { players: st.players, pts: st.tournament.rankPts });
    assert.equal(allTime[0].id, a.id); assert.equal(allTime[0].points, 2 + 5);
    assert.ok((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === a.id).career[0].season === 'CSSL - Season 3');
  } finally { await s.stop(); }
});
