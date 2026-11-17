'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/engine.js');

const cfg = { bestOf: 3, target: 15, winBy: 1, cap: 0, increments: [1], pointsWin: 2, pointsDraw: 1, pointsLoss: 0, rankBy: 'tally', finalists: 2 };
const ev = { id: 'e', scoring: 'points', sideType: 'player', sideSize: 2, participantIds: ['a', 'b', 'c', 'd'], config: cfg };

function play(m, seq) { // seq like 'A15 B10' => points
  for (const tok of seq.split(' ')) {
    const s = tok[0]; const n = Number(tok.slice(1));
    for (let i = 0; i < n; i++) E.applyOp(m, ev, { type: 'point', s, inc: 1 });
  }
}
const mk = (id, A, B, stage) => ({ id, eventId: 'e', stage: stage || 'League', sideA: A, sideB: B, log: [], cids: [], result: null });

test('game ends at 15 and match auto-ends at 2 games', () => {
  const m = mk('m1', ['a', 'b'], ['c', 'd']);
  play(m, 'B10 A15'); // game1 A 15-10
  let d = E.derive(m, ev);
  assert.equal(d.gamesA, 1); assert.equal(d.status, 'live');
  play(m, 'A15');
  d = E.derive(m, ev);
  assert.equal(d.status, 'completed'); assert.equal(d.winner, 'A');
  assert.equal(E.applyOp(m, ev, { type: 'point', s: 'B', inc: 1 }), false, 'no scoring after match end');
});

test('doubles tally: each game score is split between partners (decimals kept)', () => {
  const m = mk('m1', ['a', 'b'], ['c', 'd']);
  play(m, 'B10 A15'); // 15-10
  play(m, 'A12 B15'); // 12-15
  play(m, 'B7 A15'); // 15-7
  const rows = Object.fromEntries(E.standings(ev, [m]).map((r) => [r.id, r]));
  // A side scored 15+12+15 = 42 => 21 each; conceded 10+15+7 = 32 => 16 each
  assert.equal(rows.a.pf, 21); assert.equal(rows.b.pf, 21);
  assert.equal(rows.a.pa, 16); assert.equal(rows.a.pd, 5);
  // B side scored 32 => 16 each; conceded 42 => 21 each
  assert.equal(rows.c.pf, 16); assert.equal(rows.d.pd, -5);
  assert.equal(rows.a.won, 1); assert.equal(rows.c.lost, 1);
});

test('odd scores give .5 shares', () => {
  const m = mk('m1', ['a', 'b'], ['c', 'd']);
  play(m, 'B9 A15'); // 15-9 -> 7.5 / 4.5
  const rows = Object.fromEntries(E.standings(ev, [m]).map((r) => [r.id, r]));
  assert.equal(rows.a.pf, 7.5); assert.equal(rows.c.pf, 4.5);
});

test('partner changes: individual tally follows the player across matches', () => {
  const m1 = mk('m1', ['a', 'b'], ['c', 'd']);
  const m2 = mk('m2', ['a', 'c'], ['b', 'd']);
  play(m1, 'A15 A15');
  play(m2, 'B15 B15');
  const rows = Object.fromEntries(E.standings(ev, [m1, m2]).map((r) => [r.id, r]));
  assert.equal(rows.a.pf, 15); // 30/2 in m1 + 0 in m2
  assert.equal(rows.b.pf, 30); // 15 (with a, m1) + 15 (with d, m2)
  assert.equal(rows.c.pf, 0); assert.equal(rows.d.pf, 15);
  assert.equal(rows.a.played, 2);
});

test('finals do not count in league standings; champion detected', () => {
  const lg = mk('m1', ['a', 'b'], ['c', 'd']); play(lg, 'A15 A15');
  const fin = mk('f1', ['a', 'c'], ['b', 'd'], 'Final'); play(fin, 'B15 B15');
  const rows = E.standings(ev, [lg, fin]);
  assert.equal(rows.find((r) => r.id === 'a').played, 1);
  const ch = E.champion(ev, [lg, fin]);
  assert.deepEqual(ch.winnerIds, ['b', 'd']);
});

test('win-by-2 and cap', () => {
  const tt = { ...ev, sideSize: 1, config: { ...cfg, bestOf: 1, target: 11, winBy: 2, cap: 15 } };
  const m = { id: 'x', eventId: 'e', sideA: ['a'], sideB: ['c'], log: [], cids: [], result: null };
  for (let i = 0; i < 10; i++) { E.applyOp(m, tt, { type: 'point', s: 'A', inc: 1 }); E.applyOp(m, tt, { type: 'point', s: 'B', inc: 1 }); }
  E.applyOp(m, tt, { type: 'point', s: 'A', inc: 1 }); // 11-10 not over
  assert.equal(E.derive(m, tt).status, 'live');
  E.applyOp(m, tt, { type: 'point', s: 'A', inc: 1 }); // 12-10 over
  assert.equal(E.derive(m, tt).winner, 'A');
});

test('undo and idempotent cids', () => {
  const m = mk('m1', ['a', 'b'], ['c', 'd']);
  E.applyOp(m, ev, { type: 'point', s: 'A', inc: 1, cid: 'z1' });
  E.applyOp(m, ev, { type: 'point', s: 'A', inc: 1, cid: 'z1' }); // replay ignored
  assert.equal(m.log.length, 1);
  E.applyOp(m, ev, { type: 'undo' });
  assert.equal(m.log.length, 0);
});

test('result-mode (chess) win/draw/loss', () => {
  const chess = { id: 'e', scoring: 'result', sideType: 'player', sideSize: 1, participantIds: ['a', 'b'], config: { ...cfg, rankBy: 'matchPoints', pointsWin: 1, pointsDraw: 0.5, pointsLoss: 0 } };
  const m = { id: 'x', eventId: 'e', sideA: ['a'], sideB: ['b'], log: [], cids: [], result: null };
  E.applyOp(m, chess, { type: 'result', result: 'D' });
  const rows = E.standings(chess, [m]);
  assert.equal(rows[0].mp, 0.5); assert.equal(rows[0].drawn, 1);
});
