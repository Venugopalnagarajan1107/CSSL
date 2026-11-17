'use strict';
/* Fixture generators (server side): round-robin, rotating-partner doubles rounds, finals, time slots. */

/* Circle method. Returns an array of rounds; each round is an array of [a, b] pairs. */
function roundRobin(ids) {
  const p = ids.slice();
  if (p.length % 2) p.push(null);
  const n = p.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = p[i], b = p[n - 1 - i];
      if (a != null && b != null) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    p.splice(1, 0, p.pop());
  }
  return rounds;
}

const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/* History of partners / opponents / games played from existing doubles matches. */
function buildHistory(matches) {
  const h = { partner: new Map(), opp: new Map(), played: new Map() };
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const m of matches) record(h, m.sideA, m.sideB, inc);
  return h;
}
function record(h, A, B, inc) {
  inc = inc || ((m, k) => m.set(k, (m.get(k) || 0) + 1));
  if (A.length === 2) inc(h.partner, pairKey(A[0], A[1]));
  if (B.length === 2) inc(h.partner, pairKey(B[0], B[1]));
  for (const a of A) for (const b of B) inc(h.opp, pairKey(a, b));
  [...A, ...B].forEach((x) => h.played.set(x, (h.played.get(x) || 0) + 1));
}

/* Random doubles rounds that avoid repeated partners/opponents as far as possible.
   Players who have played the least sit in first; leftover players rest. */
function doublesRounds(ids, hist, nRounds, rnd) {
  rnd = rnd || Math.random;
  const per = Math.floor(ids.length / 4) * 4;
  if (per < 4) throw new Error('Need at least 4 enrolled players for doubles');
  const h = { partner: new Map(hist.partner), opp: new Map(hist.opp), played: new Map(hist.played) };
  const out = [];
  for (let r = 0; r < nRounds; r++) {
    const sorted = ids.slice().map((id) => ({ id, k: (h.played.get(id) || 0) + rnd() * 0.5 })).sort((a, b) => a.k - b.k).map((x) => x.id);
    const pick = sorted.slice(0, per);
    let best = null, bestScore = Infinity;
    for (let t = 0; t < 400; t++) {
      const s = pick.slice();
      for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
      let score = 0; const ms = [];
      for (let i = 0; i < per; i += 4) {
        const A = [s[i], s[i + 1]], B = [s[i + 2], s[i + 3]];
        score += 100 * ((h.partner.get(pairKey(A[0], A[1])) || 0) + (h.partner.get(pairKey(B[0], B[1])) || 0));
        for (const a of A) for (const b of B) score += 10 * (h.opp.get(pairKey(a, b)) || 0);
        ms.push({ sideA: A, sideB: B });
      }
      if (score < bestScore) { bestScore = score; best = ms; if (score === 0) break; }
    }
    best.forEach((m) => record(h, m.sideA, m.sideB));
    out.push(best);
  }
  return out;
}

function addMinutes(local, min) {
  const [d, t] = local.split('T');
  const dt = new Date(d + 'T' + t + ':00Z');
  dt.setUTCMinutes(dt.getUTCMinutes() + min);
  return dt.toISOString().slice(0, 16);
}

/* Assign courts and start times to rounds of matches. rounds: array of arrays (any items). */
function assignSlots(rounds, courts, start, slotMin) {
  let wave = 0;
  return rounds.map((r) => {
    const per = courts.length || r.length || 1;
    const res = r.map((_, k) => ({
      court: courts.length ? courts[k % courts.length] : '',
      startsAt: start ? addMinutes(start, (wave + Math.floor(k / per)) * slotMin) : '',
    }));
    wave += Math.ceil(r.length / per);
    return res;
  });
}

/* Finals plan from standings rows (sorted) and existing matches of the event. */
function finalsPlan(event, rows, matches, derive) {
  const n = event.config.finalists || 0;
  const mine = matches.filter((m) => m.eventId === event.id);
  const has = (stage) => mine.some((m) => m.stage === stage);
  const top = rows.filter((r) => r.played > 0).slice(0, n).map((r) => r.id);
  if (top.length < n || n < 2) throw new Error('Not enough players have played to pick ' + n + ' finalists');
  const size = event.sideSize;
  if (size === 2) {
    if (n !== 4) throw new Error('Auto-finals for doubles needs exactly 4 finalists. Create the final manually.');
    if (has('Final')) throw new Error('A final already exists');
    return [{ stage: 'Final', sideA: [top[0], top[3]], sideB: [top[1], top[2]] }];
  }
  if (n === 2) {
    if (has('Final')) throw new Error('A final already exists');
    return [{ stage: 'Final', sideA: [top[0]], sideB: [top[1]] }];
  }
  if (n === 4) {
    const semis = mine.filter((m) => m.stage === 'Semi-final');
    if (!semis.length) return [{ stage: 'Semi-final', sideA: [top[0]], sideB: [top[3]] }, { stage: 'Semi-final', sideA: [top[1]], sideB: [top[2]] }];
    if (has('Final')) throw new Error('A final already exists');
    const done = semis.map((m) => ({ m, d: derive(m, event) }));
    if (done.some((x) => x.d.status !== 'completed' || !x.d.winner || x.d.draw)) throw new Error('Finish both semi-finals first (a draw needs a decision)');
    const winners = done.map((x) => (x.d.winner === 'A' ? x.m.sideA : x.m.sideB)[0]);
    return [{ stage: 'Final', sideA: [winners[0]], sideB: [winners[1]] }];
  }
  throw new Error('Auto-finals supports 2 or 4 finalists. Create fixtures manually.');
}


/* ---------------------------------------------------------------- formats */
const GROUP_NAMES = 'ABCDEFGHIJKLMNOP'.split('');

/* Snake-draw participants into n groups (random order if rnd given). Returns {A:[ids], B:[ids], ...}. */
function drawGroups(ids, n, rnd) {
  n = Math.max(2, Math.min(16, Math.round(n) || 2));
  if (ids.length < n * 2) throw new Error('Need at least ' + n * 2 + ' participants for ' + n + ' groups (2 per group)');
  const list = ids.slice();
  if (rnd) for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const g = {}; for (let i = 0; i < n; i++) g[GROUP_NAMES[i]] = [];
  list.forEach((id, i) => { const k = i % (2 * n); g[GROUP_NAMES[k < n ? k : 2 * n - 1 - k]].push(id); });
  return g;
}

/* Round-robin inside every group; round r of all groups is played in the same wave. */
function groupRounds(groups, double) {
  const per = Object.keys(groups).sort().map((gn) => { let rr = roundRobin(groups[gn]); if (double) rr = rr.concat(rr.map((r) => r.map(([x, y]) => [y, x]))); return rr.map((r) => r.map(([x, y]) => ({ sideA: [x], sideB: [y], group: gn }))); });
  const n = Math.max(...per.map((r) => r.length));
  return Array.from({ length: n }, (_, i) => per.flatMap((r) => r[i] || []));
}

/* One Swiss round. rows: standings rows (best first). played: Set of pairKeys. byeIds: ids that already had a bye.
   Returns { pairs:[[a,b]], bye:id|null, rematch:boolean }. */
function swissPairs(ids, rows, played, byeIds, rnd) {
  rnd = rnd || Math.random;
  const score = new Map(rows.map((r) => [r.id, r.mp * 1000 + (r.bh || 0)]));
  let order = ids.slice().map((id) => ({ id, k: (score.get(id) || 0) + rnd() * 0.01 })).sort((a, b) => b.k - a.k).map((x) => x.id);
  let bye = null;
  if (order.length % 2) {
    for (let i = order.length - 1; i >= 0; i--) if (!byeIds.has(order[i])) { bye = order[i]; break; }
    if (bye == null) bye = order[order.length - 1];
    order = order.filter((x) => x !== bye);
  }
  const solve = (list, allowRematch) => {
    if (!list.length) return [];
    const a = list[0];
    for (let j = 1; j < list.length; j++) {
      const b = list[j];
      if (!allowRematch && played.has(pairKey(a, b))) continue;
      const rest = solve(list.slice(1, j).concat(list.slice(j + 1)), allowRematch);
      if (rest) return [[a, b]].concat(rest);
    }
    return null;
  };
  let pairs = solve(order, false), rematch = false;
  if (!pairs) { pairs = solve(order, true); rematch = true; }
  return { pairs, bye, rematch };
}

/* Next knockout matches for an event that already has a bracket. `bracketOf` = Engine.bracket. */
function koPlan(event, matches, bracketOf) {
  const rounds = bracketOf(event, matches);
  if (!rounds) throw new Error('No bracket has been drawn yet');
  const third = !!(event.format && event.format.thirdPlace);
  const has = (stage) => matches.some((m) => m.eventId === event.id && m.stage === stage);
  const thirdItem = (semi) => (third && !has('Third place') && semi && semi.stage === 'Semi-final' && semi.pairs.length === 2 && semi.pairs.every((p) => p.loser != null)
    ? [{ stage: 'Third place', sideA: [semi.pairs[0].loser], sideB: [semi.pairs[1].loser] }] : []);
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const missing = r.pairs.filter((p) => !p.bye && !p.match);
    if (missing.length) return missing.map((p) => ({ stage: r.stage, sideA: [p.a], sideB: [p.b] })).concat(r.stage === 'Final' ? thirdItem(rounds[i - 1]) : []);
    if (!r.complete) throw new Error('Finish all ' + r.stage + ' matches first (a drawn match needs a decision: use "End match early" to pick the winner).');
  }
  const extra = thirdItem(rounds[rounds.length - 2]);
  if (extra.length) return extra;
  throw new Error('The final has already been created');
}

module.exports = { roundRobin, buildHistory, doublesRounds, assignSlots, addMinutes, finalsPlan, pairKey, drawGroups, groupRounds, swissPairs, koPlan, GROUP_NAMES };
