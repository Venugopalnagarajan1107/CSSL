'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/engine.js');
const { start, chiefTok } = require('./helpers');

const cfg = { bestOf: 3, target: 15, winBy: 1, cap: 0, increments: [1], pointsWin: 2, pointsDraw: 1, pointsLoss: 0, rankBy: 'tally', finalists: 2 };
const ev = { id: 'e', name: 'WD', sport: 'badminton', scoring: 'points', sideType: 'player', sideSize: 2, participantIds: ['a', 'b', 'c', 'd'], config: cfg };
const data = { players: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() })), teams: [], events: [ev], matches: [] };
let n = 0;
const mk = (A, B, seq, stage, t) => {
  const m = { id: 'm' + n++, eventId: 'e', stage: stage || 'League', sideA: A, sideB: B, log: [], cids: [], result: null, createdAt: t, startedAt: t };
  for (const tok of seq.split(' ')) for (let i = 0; i < Number(tok.slice(1)); i++) E.applyOp(m, ev, { type: 'point', s: tok[0], inc: 1 });
  data.matches.push(m); return m;
};

test('playerStats: record, form, streaks, partners, h2h, records, honours', () => {
  mk(['a', 'b'], ['c', 'd'], 'B9 A15 B5 A15', 'League', 1);   // a,b win 30-14 (margin 16)
  mk(['a', 'c'], ['b', 'd'], 'A10 B15 A8 B15', 'League', 2);  // a,c lose
  mk(['a', 'd'], ['b', 'c'], 'B3 A15 B4 A15', 'League', 3);   // a,d win
  mk(['a', 'b'], ['c', 'd'], 'A15 A15', 'Final', 4);          // a,b win final (stage Final)
  const s = E.playerStats('a', data);
  assert.equal(s.totals.played, 4); assert.equal(s.totals.won, 3); assert.equal(s.totals.lost, 1);
  assert.deepEqual(s.form, ['W', 'L', 'W', 'W']);
  assert.deepEqual(s.streak.current, { type: 'W', count: 2 }); assert.equal(s.streak.bestWin, 2);
  assert.equal(s.records.biggestWin.margin, 30, 'final 30-0');
  assert.equal(s.records.highestGame.score, 15);
  const pb = s.partners.find((x) => x.id === 'b'); assert.equal(pb.played, 2); assert.equal(pb.won, 2);
  assert.equal(s.partners.find((x) => x.id === 'c').won, 0);
  const vsD = s.h2h.find((x) => x.id === 'd'); assert.equal(vsD.played, 3, 'opposed d in 3 matches (a&c lost vs b&d too)');
  assert.deepEqual(s.honours.map((h) => h.place), ['Champion']);
  // league tally excludes finals, per-event totals include all games
  assert.equal(s.bySport.badminton.played, 4);
  const sc = E.playerStats('c', data);
  assert.deepEqual(sc.honours.map((h) => h.place), ['Runner-up']);
  assert.equal(sc.history[0].res, 'L', 'history newest first');
});

test('team lineup limits stats to players who played', () => {
  const tev = { id: 't', name: 'Team', sport: 'badminton', scoring: 'points', sideType: 'team', sideSize: 1, participantIds: ['T1', 'T2'], config: cfg };
  const d = { players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }], teams: [{ id: 'T1', name: 'One', memberIds: ['p1', 'p2'] }, { id: 'T2', name: 'Two', memberIds: ['p3'] }], events: [tev],
    matches: [{ id: 'x', eventId: 't', stage: 'League', sideA: ['T1'], sideB: ['T2'], lineupA: ['p1'], lineupB: [], log: [], result: 'A', createdAt: 1 }] };
  assert.equal(E.playerStats('p1', d).totals.played, 1);
  assert.equal(E.playerStats('p2', d).totals.played, 0, 'p2 not in recorded lineup');
  assert.equal(E.playerStats('p3', d).totals.lost, 1, 'no lineup => whole team');
});

test('server: extended profile privacy, career snapshot, kids default private', async () => {
  const s = await start();
  try {
    const { call, pin } = s;
    const admin = (await call('POST', '/api/login', { role: 'admin', pin })).body.token;
    const body = { name: 'Asha', section: 'adults', hand: 'L', affiliation: 'Bosch – Energy', bio: 'Loves the net.', sports: { badminton: { level: 'Advanced', style: 'Net player' }, chess: { level: 'Beginner', style: '', rating: '1200' }, bogus: { level: 'Pro' } }, achievements: ['2025 – Carrom runner-up', '', ' '], emergency: 'Ravi 98', tshirt: 'M', phone: '1' };
    const a = (await call('POST', '/api/admin/players', body, admin)).body;
    const k = (await call('POST', '/api/admin/players', { name: 'Kid', section: 'kids', bio: 'secret kid bio', affiliation: 'School X', hand: 'R' }, admin)).body;
    assert.equal(a.playerNo, 'P001'); assert.equal(k.playerNo, 'P002');
    assert.equal(a.profilePublic, true); assert.equal(k.profilePublic, false, 'kids extended profile private by default');
    assert.deepEqual(a.achievements, ['2025 – Carrom runner-up']); assert.ok(!a.sports.bogus); assert.equal(a.sports.chess.rating, 1200);

    let pub = (await call('GET', '/api/state')).body.players;
    const pa = pub.find((p) => p.id === a.id), pk = pub.find((p) => p.id === k.id);
    assert.equal(pa.bio, undefined, 'no profile details are public'); assert.equal(pa.sports, undefined); assert.equal(pa.extHidden, true);
    assert.equal((await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === a.id).bio, 'Loves the net.');
    assert.equal(pa.emergency, undefined); assert.equal(pa.tshirt, undefined); assert.equal(pa.phone, undefined);
    assert.equal(pk.extHidden, true); assert.equal(pk.bio, undefined); assert.equal(pk.affiliation, undefined);
    const adm = (await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === k.id);
    assert.equal(adm.bio, 'secret kid bio', 'admin view includes hidden profile');
    assert.equal((await call('PUT', '/api/admin/players/' + k.id, { profilePublic: true }, admin)).body.profilePublic, true);
    assert.equal((await call('GET', '/api/state')).body.players.find((p) => p.id === k.id).bio, undefined, 'still not public');

    // career snapshot on new tournament
    const st = (await call('GET', '/api/state')).body;
    const wd = st.events.find((e) => /Women/.test(e.name));
    await call('PUT', '/api/admin/events/' + wd.id, { config: { target: 15, winBy: 1, cap: 0 } }, admin);
    const more = []; for (const nme of ['B', 'C', 'D']) more.push((await call('POST', '/api/admin/players', { name: nme }, admin)).body.id);
    await call('PUT', '/api/admin/events/' + wd.id, { participantIds: [a.id, ...more] }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: [a.id, more[0]], sideB: [more[1], more[2]], stage: 'Final' }, admin)).body;
    await call('POST', '/api/admin/matches/' + m.id + '/scores', { games: [{ a: 15, b: 10 }, { a: 15, b: 9 }] }, await chiefTok(s, admin));
    await call('POST', '/api/admin/tournament', { name: 'Edition One', dates: 'Nov 2026' }, admin);
    await call('POST', '/api/admin/new-tournament', { keepPlayers: true, name: 'Edition Two' }, admin);
    const after = (await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === a.id);
    assert.equal(after.career.length, 1);
    assert.equal(after.career[0].tournament, 'Edition One'); assert.equal(after.career[0].won, 1);
    assert.deepEqual(after.career[0].honours, ["Badminton – Women's Doubles – Champion"]);
    assert.equal(after.playerNo, 'P001', 'player ID persists across tournaments');
    assert.equal((await call('GET', '/api/state')).body.matches.length, 0);
  } finally { await s.stop(); }
});
