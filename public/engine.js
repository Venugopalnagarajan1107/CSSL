/* Shared scoring engine: runs on the server (authoritative) and in the browser (offline/optimistic). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const r2 = (x) => Math.round(x * 100) / 100;
  const need = (cfg) => Math.ceil((cfg.bestOf || 1) / 2);

  function gameOver(a, b, cfg) {
    const m = Math.max(a, b);
    if (cfg.cap && m >= cfg.cap) return true;
    return m >= cfg.target && Math.abs(a - b) >= (cfg.winBy || 1);
  }

  /* A rubber (one sub-match of a team tie) is scored like a normal match, with its own side size and optional rule overrides. */
  function rubberEvent(ev, r) {
    const c = { ...ev.config };
    ['bestOf', 'target', 'winBy', 'cap'].forEach((k) => { if (r.config && r.config[k] != null && r.config[k] !== '') c[k] = Number(r.config[k]); });
    return { ...ev, sideType: 'player', sideSize: r.size === 2 ? 2 : 1, config: c };
  }

  /* A team tie made of rubbers: winner is the side that wins most rubbers (optionally stops once clinched). */
  function deriveTie(match, event) {
    const rs = match.rubbers.map((r) => ({ r, d: derive(r, rubberEvent(event, r)) }));
    const total = rs.length, rules = event.rubberRules || {};
    let ra = 0, rb = 0, done = 0, started = false, pts = 0;
    rs.forEach(({ d }) => {
      if (d.status === 'completed') { done++; if (d.winner === 'A') ra++; else if (d.winner === 'B') rb++; }
      if (d.status !== 'scheduled') started = true;
      pts += d.points;
    });
    const need = Math.floor(total / 2) + 1;
    let winner = null, draw = false, outcome = '';
    if (match.walkover === 'A' || match.walkover === 'B') { winner = match.walkover; outcome = match.outcome || 'walkover'; ra = winner === 'A' ? total : 0; rb = winner === 'B' ? total : 0; }
    else if (match.result) { if (match.result === 'D') draw = true; else winner = match.result; outcome = match.outcome || ''; }
    else if (rules.clinch !== false && (ra >= need || rb >= need)) winner = ra > rb ? 'A' : 'B';
    else if (done === total) { if (ra > rb) winner = 'A'; else if (rb > ra) winner = 'B'; else draw = true; }
    const completed = !!winner || draw;
    return {
      games: [], current: null, gamesA: ra, gamesB: rb, winner, draw, tie: true,
      status: completed ? 'completed' : (started || match.walkover) ? 'live' : 'scheduled', points: pts, outcome,
      rubbers: rs.map(({ r, d }) => ({ id: r.id, name: r.name, ...d })),
    };
  }

  /* Derive full match state from the point log. */
  /* A fixture may override points settings (best of, points per game, win by, cap, carrom weights) for itself only. */
  function withCfg(match, event) { return match && match.cfg && Object.keys(match.cfg).length ? { ...event, config: { ...event.config, ...match.cfg } } : event; }
  /* A cancelled match keeps whatever was recorded, but counts for nothing (standings, records, progress). */
  function derive(match, event) { const d = deriveRaw(match, event); if (match && match.cancelled) d.status = 'cancelled'; return d; }
  function deriveRaw(match, event) {
    event = withCfg(match, event);
    if (match.rubbers && match.rubbers.length && event.sideType === 'team') return deriveTie(match, event);
    const cfg = event.config;
    const log = match.log || [];
    if (match.walkover === 'A' || match.walkover === 'B') {   /* awarded without play (no-show / withdrawal / disqualification) */
      const w = match.walkover, pts = cfg.walkoverPoints != null ? cfg.walkoverPoints : cfg.target;
      const games = event.scoring === 'points' && pts > 0 ? Array.from({ length: need(cfg) }, () => ({ a: w === 'A' ? pts : 0, b: w === 'B' ? pts : 0, winner: w })) : [];
      return { games, current: null, gamesA: w === 'A' ? games.length : 0, gamesB: w === 'B' ? games.length : 0, winner: w, draw: false, status: 'completed', points: 0, outcome: match.outcome || 'walkover' };
    }
    const games = [];
    let a = 0, b = 0, gA = 0, gB = 0, over = false, boards = 0;
    if (event.scoring === 'points') {
      for (const e of log) {
        if (over) break;
        if (e.s === 'A') a += e.inc; else b += e.inc;
        if (e.board) boards++;
        /* carrom: a game also ends after the maximum number of boards, won by whoever leads */
        const byBoards = e.board && cfg.maxBoards && boards >= cfg.maxBoards && a !== b;
        if (gameOver(a, b, cfg) || byBoards) {
          games.push({ a, b, winner: a > b ? 'A' : 'B' });
          if (a > b) gA++; else gB++;
          a = 0; b = 0; boards = 0;
          if (gA >= need(cfg) || gB >= need(cfg)) over = true;
        }
      }
    }
    if ((match.retired === 'A' || match.retired === 'B') && event.scoring === 'points' && !over) {
      /* Retirement: the opponent wins. Their score in the current game is raised to the game target (kept legal under win-by and cap),
         and every unplayed game is recorded as target–0 to them. */
      const opp = match.retired === 'A' ? 'B' : 'A', wb = cfg.winBy || 1, aw = cfg.walkoverPoints != null ? cfg.walkoverPoints : cfg.target;
      const mine = opp === 'A' ? b : a;                      /* the retiring side's score in the game in progress */
      let os = Math.max(cfg.target, mine + wb); if (cfg.cap) os = Math.min(os, cfg.cap);
      games.push({ a: opp === 'A' ? os : mine, b: opp === 'B' ? os : mine, winner: opp, awarded: true });
      if (opp === 'A') gA++; else gB++;
      while ((opp === 'A' ? gA : gB) < need(cfg)) { games.push({ a: opp === 'A' ? aw : 0, b: opp === 'B' ? aw : 0, winner: opp, awarded: true }); if (opp === 'A') gA++; else gB++; }
      return { games, current: null, gamesA: gA, gamesB: gB, winner: opp, draw: false, status: 'completed', points: log.length, outcome: 'retired' };
    }
    let winner = null, draw = false;
    if (over) winner = gA > gB ? 'A' : 'B';
    if (match.result) { if (match.result === 'D') draw = true; else winner = match.result; }
    const completed = over || !!match.result;
    const started = log.length > 0;
    return {
      games,
      current: completed ? null : { a, b, boards },
      gamesA: gA, gamesB: gB, winner, draw,
      status: completed ? 'completed' : started ? 'live' : 'scheduled',
      points: log.length, outcome: completed ? match.outcome || '' : '',
    };
  }

  /* Apply one referee operation to a match (mutates). Returns true if it changed anything. */
  function applyOp(m, ev, op, who) {
    ev = withCfg(m, ev);
    m.log = m.log || [];
    m.cids = m.cids || [];
    if (op.cid && m.cids.includes(op.cid)) return false;
    let changed = false;
    const isTie = ev.sideType === 'team' && m.rubbers && m.rubbers.length;
    if (isTie && op.rid) {
      const r = m.rubbers.find((x) => x.id === op.rid);
      if (r) {
        const tieDone = derive(m, ev).status === 'completed';
        const full = r.sideA.length === (r.size === 2 ? 2 : 1) && r.sideB.length === (r.size === 2 ? 2 : 1);
        if (op.type !== 'undo' && (tieDone || !full)) changed = false;
        else { const o = { ...op }; delete o.cid; delete o.rid; changed = applyOp(r, rubberEvent(ev, r), o, who); }
      }
      if (op.cid) { m.cids.push(op.cid); if (m.cids.length > 300) m.cids.shift(); }
      return changed;
    }
    if (op.type === 'point') {
      const inc = Number(op.inc) || 1;
      const ok = !isTie && ev.scoring === 'points' && (op.s === 'A' || op.s === 'B') &&
        (ev.config.increments || [1]).includes(inc) && derive(m, ev).status !== 'completed';
      if (ok) { m.log.push({ s: op.s, inc, t: Date.now(), by: who || '' }); changed = true; }
    } else if (op.type === 'board' && ev.scoring === 'points' && !isTie) {
      /* carrom: score one finished board = coins left × coin weight, plus the queen if covered and the scorer is still below the cutoff */
      const c = ev.config, d0 = derive(m, ev), coins = Math.max(0, Math.min(9, Math.round(Number(op.coins) || 0)));
      if ((op.s === 'A' || op.s === 'B') && d0.status !== 'completed') {
        const mine = op.s === 'A' ? d0.current.a : d0.current.b;
        const coin = c.coinWeight != null ? Number(c.coinWeight) : 1, qw = c.queenWeight != null ? Number(c.queenWeight) : 3, cut = c.queenCutoff != null ? Number(c.queenCutoff) : 22;
        const inc = coins * coin + (op.queen && mine < cut ? qw : 0);
        m.log.push({ s: op.s, inc, t: Date.now(), by: who || '', board: true, coins, queen: !!op.queen }); changed = true;
      }
    } else if (op.type === 'retire') {
      if ((op.s === 'A' || op.s === 'B') && derive(m, ev).status !== 'completed') {
        if (ev.scoring === 'points') { m.retired = op.s; m.outcome = 'retired'; } else { m.result = op.s === 'A' ? 'B' : 'A'; m.outcome = 'retired'; }
        changed = true;
      }
    } else if (op.type === 'walkover') {
      if ((op.s === 'A' || op.s === 'B') && derive(m, ev).status !== 'completed') { m.walkover = op.s; m.outcome = op.reason === 'dq' ? 'dq' : 'walkover'; changed = true; }
    } else if (op.type === 'undo') {
      if (m.walkover) { m.walkover = null; m.outcome = ''; changed = true; }
      else if (m.retired) { m.retired = null; m.outcome = ''; changed = true; }
      else if (m.result) { m.result = null; m.outcome = ''; changed = true; }
      else if (isTie) {
        let best = null;
        m.rubbers.forEach((r) => { const l = r.log && r.log[r.log.length - 1]; if (l && (!best || l.t >= best.t)) best = { r, t: l.t }; });
        if (best) { best.r.log.pop(); changed = true; } else { const rr = m.rubbers.find((r) => r.result || r.walkover); if (rr) { rr.result = null; rr.walkover = null; rr.outcome = ''; changed = true; } }
      }
      else if (m.log.length) { m.log.pop(); changed = true; }
    } else if (op.type === 'result') {
      const allowed = op.result === null || op.result === 'A' || op.result === 'B' || (op.result === 'D' && ev.scoring === 'result');
      if (allowed) { m.result = op.result; m.outcome = op.result && (op.reason === 'retired' || op.reason === 'dq') ? op.reason : ''; changed = true; }
    }
    if (op.cid) { m.cids.push(op.cid); if (m.cids.length > 300) m.cids.shift(); }
    return changed;
  }

  const sideIds = (m, s) => (s === 'A' ? m.sideA : m.sideB) || [];

  /* How many players reach the finals. Optional rule: fewer than `smallBelow` active players -> only `finalistsSmall` (e.g. 2 = straight to the final). */
  function finalistsFor(event) {
    const c = event.config || {};
    const n = event.frozenCount != null ? event.frozenCount : (event.participantIds || []).filter((x) => !(event.withdrawn || []).includes(x)).length;
    return c.smallBelow && n < c.smallBelow ? (c.finalistsSmall != null ? c.finalistsSmall : 2) : (c.finalists || 0);
  }

  /* Standings for one event (or one group of it). Only 'League' stage matches count. */
  function standings(event, matches, group) {
    const cfg = event.config, fmt = event.format || {};
    const rows = {};
    const row = (id) => (rows[id] = rows[id] || { id, played: 0, won: 0, drawn: 0, lost: 0, mp: 0, pf: 0, pa: 0, gw: 0, gl: 0, rw: 0, rl: 0, bh: 0, byes: 0 });
    const ids = group ? ((event.groups || {})[group] || []) : (event.participantIds || []);
    ids.forEach(row);
    const inScope = (m) => m.eventId === event.id && (m.stage || 'League') === 'League' && (!group || m.group === group);
    for (const m of matches) {
      if (!inScope(m)) continue;
      const d = derive(m, event);
      if (d.status === 'cancelled') continue;
      const A = sideIds(m, 'A'), B = sideIds(m, 'B');
      // Each finished game: score is divided between the players on a side (doubles => split by 2).
      const games = d.rubbers ? d.rubbers.flatMap((x) => x.games) : d.games;
      for (const g of games) {
        A.forEach((id) => { const r = row(id); r.pf += g.a / A.length; r.pa += g.b / A.length; if (g.winner === 'A') r.gw++; else r.gl++; });
        B.forEach((id) => { const r = row(id); r.pf += g.b / B.length; r.pa += g.a / B.length; if (g.winner === 'B') r.gw++; else r.gl++; });
      }
      if (d.status === 'completed') {
        if (d.tie) { A.forEach((id) => { const r = row(id); r.rw += d.gamesA; r.rl += d.gamesB; }); B.forEach((id) => { const r = row(id); r.rw += d.gamesB; r.rl += d.gamesA; }); }
        [['A', A], ['B', B]].forEach(([s, sd]) => sd.forEach((id) => {
          const r = row(id);
          r.played++;
          if (d.draw) { r.drawn++; r.mp += cfg.pointsDraw; }
          else if (d.winner === s) { r.won++; r.mp += cfg.pointsWin; }
          else { r.lost++; r.mp += cfg.pointsLoss; }
        }));
      }
    }
    /* Swiss byes count as a win without a match. */
    (event.byes || []).forEach((b) => { if (!group || ids.includes(b.id)) { const r = row(b.id); r.mp += cfg.pointsWin; r.byes++; } });
    if (fmt.type === 'swiss') {
      for (const m of matches) {
        if (!inScope(m)) continue;
        const d = derive(m, event); if (d.status !== 'completed') continue;
        const A = sideIds(m, 'A'), B = sideIds(m, 'B');
        A.forEach((a) => B.forEach((b) => { rows[a].bh += rows[b].mp; rows[b].bh += rows[a].mp; }));
      }
    }
    const list = Object.values(rows).map((r) => ({
      ...r, pf: r2(r.pf), pa: r2(r.pa), pd: r2(r.pf - r.pa), mp: r2(r.mp), bh: r2(r.bh),
    }));
    const byTally = cfg.rankBy === 'tally';
    const swiss = fmt.type === 'swiss', rub = (event.rubbers || []).length > 0;
    const rd = (r) => (rub ? r.rw - r.rl : 0), bhk = (r) => (swiss ? r.bh : 0);
    /* Table tennis (and any game set to it): Points -> set difference -> sets won, then point difference. */
    const bySets = !byTally && (cfg.tiebreak ? cfg.tiebreak === 'sets' : event.sport === 'tt'), sd = (r) => r.gw - r.gl;
    list.sort((x, y) => byTally
      ? (y.pf - x.pf) || (y.pd - x.pd) || (y.mp - x.mp) || (y.won - x.won)
      : bySets ? (y.mp - x.mp) || (bhk(y) - bhk(x)) || (sd(y) - sd(x)) || (y.gw - x.gw) || (y.pd - x.pd) || (y.pf - x.pf)
      : (y.mp - x.mp) || (bhk(y) - bhk(x)) || (rd(y) - rd(x)) || (y.pd - x.pd) || (y.pf - x.pf) || (y.won - x.won));
    /* Optional rule: a two-way tie on the main score is settled by the match between the two (before point difference). */
    if (cfg.h2hFirst && event.sideSize === 1) {
      const pk = (r) => (byTally ? r.pf : r.mp);
      const h2h = (a, b) => matches.reduce((t, m) => {
        if (!inScope(m)) return t;
        const dd = derive(m, event); if (dd.status !== 'completed' || dd.draw) return t;
        const sa = sideIds(m, 'A')[0], sb = sideIds(m, 'B')[0];
        if (sa === a && sb === b) return t + (dd.winner === 'A' ? 1 : -1);
        if (sa === b && sb === a) return t + (dd.winner === 'B' ? 1 : -1);
        return t;
      }, 0);
      for (let i = 0; i < list.length - 1;) {
        let j = i; while (j + 1 < list.length && pk(list[j + 1]) === pk(list[i])) j++;
        if (j - i === 1) {
          const sc = h2h(list[i].id, list[j].id);
          if (sc < 0) { const t = list[i]; list[i] = list[j]; list[j] = t; }
          if (sc !== 0) { list[i].hb = 1; list[j].hb = 0; }
        }
        i = j + 1;
      }
    }
    // Equal on every ranking key => share a rank.
    const key = (r) => (byTally ? [r.pf, r.pd, r.mp, r.won] : bySets ? [r.mp, bhk(r), sd(r), r.gw, r.pd, r.pf] : [r.mp, bhk(r), rd(r), r.pd, r.pf, r.won]).concat([r.hb || 0]).join('|');
    const places = group ? (fmt.qualifiers || 0) : fmt.type === 'groups' ? 0 : finalistsFor(event);
    list.forEach((r, i) => {
      r.rank = i > 0 && key(list[i - 1]) === key(r) ? list[i - 1].rank : i + 1;
      r.qualified = r.rank <= places && r.played > 0;
    });
    return list;
  }

  /* Group stage tables: [{group:'A', rows:[...]}, ...] */
  function groupTables(event, matches) {
    return Object.keys(event.groups || {}).sort().map((g) => ({ group: g, rows: standings(event, matches, g) }));
  }

  /* ---- knockout bracket ---- */
  const stageName = (n) => (n === 2 ? 'Final' : n === 4 ? 'Semi-final' : n === 8 ? 'Quarter-final' : 'Round of ' + n);
  const KO_STAGES = ['Round of 64', 'Round of 32', 'Round of 16', 'Quarter-final', 'Semi-final', 'Final', 'Third place'];
  /* Standard seeding order so that seed 1 and 2 can only meet in the final: 4 -> [1,4,2,3], 8 -> [1,8,4,5,2,7,3,6]. */
  function seedsOrder(P) { let o = [1]; while (o.length < P) { const n = o.length * 2; o = o.flatMap((x) => [x, n + 1 - x]); } return o; }
  function bracketOrder(ids) {
    let P = 2; while (P < ids.length) P *= 2;
    return seedsOrder(P).map((sd) => (sd <= ids.length ? ids[sd - 1] : null));
  }
  /* Rounds of the event's bracket with the current state of each pairing. */
  function bracket(event, matches) {
    const order = event.bracket && event.bracket.order;
    if (!order || order.length < 2) return null;
    const mine = matches.filter((m) => m.eventId === event.id);
    const rounds = []; let cur = order.slice();
    while (cur.length >= 2) {
      const stage = stageName(cur.length), next = [], pairs = []; let complete = true;
      for (let i = 0; i < cur.length; i += 2) {
        const a = cur[i], b = cur[i + 1];
        const pr = { a, b, match: null, bye: false, winner: undefined, loser: undefined };
        if (a == null || b == null) { pr.bye = true; pr.winner = a == null ? b : a; }
        else {
          const m = mine.find((x) => x.stage === stage && ((x.sideA[0] === a && x.sideB[0] === b) || (x.sideA[0] === b && x.sideB[0] === a)));
          pr.match = m || null;
          const d = m ? derive(m, event) : null;
          if (d && d.status === 'completed' && !d.draw && d.winner) { pr.winner = sideIds(m, d.winner)[0]; pr.loser = pr.winner === a ? b : a; } else complete = false;
        }
        pairs.push(pr); next.push(pr.winner);
      }
      rounds.push({ stage, pairs, complete });
      if (cur.length === 2 || next.some((x) => x === undefined)) break;
      cur = next;
    }
    return rounds;
  }

  /* Medal places from finished knockout matches: {first:[ids], second:[ids], third:[ids]} or null. */
  function podium(event, matches) {
    const c = champion(event, matches); if (!c) return null;
    const done = (stage) => matches.filter((m) => m.eventId === event.id && m.stage === stage).map((m) => ({ m, d: derive(m, event) })).filter((x) => x.d.status === 'completed' && x.d.winner);
    let third = [];
    const tp = done('Third place');
    if (tp.length) { const x = tp[tp.length - 1]; third = sideIds(x.m, x.d.winner); }
    else third = done('Semi-final').flatMap((x) => sideIds(x.m, x.d.winner === 'A' ? 'B' : 'A')).filter((id) => !c.winnerIds.includes(id) && !c.runnerIds.includes(id));
    return { first: c.winnerIds, second: c.runnerIds, third };
  }

  /* Champion / runner-up from the last completed 'Final' match. */
  function champion(event, matches) {
    const finals = matches.filter((m) => m.eventId === event.id && m.stage === 'Final')
      .map((m) => ({ m, d: derive(m, event) })).filter((x) => x.d.status === 'completed' && x.d.winner);
    if (!finals.length) return null;
    const { m, d } = finals[finals.length - 1];
    return { winnerIds: sideIds(m, d.winner), runnerIds: sideIds(m, d.winner === 'A' ? 'B' : 'A'), matchId: m.id };
  }


  /* Everything a player profile needs, computed from the matches. data = {players, teams, events, matches}.
     Pass a different `matches` array to include unsynced (optimistic) scores. */
  function playerStats(pid, data, matches) {
    matches = matches || data.matches;
    const byId = (col, id) => (data[col] || []).find((x) => x.id === id);
    const nm = (ev, id) => { const x = byId(ev.sideType === 'team' ? 'teams' : 'players', id); return x ? x.name : '?'; };
    const label = (ev, ids) => ids.map((i) => nm(ev, i)).join(' & ');
    const per = {}, history = [], bySport = {}, partners = {}, h2h = {}, chron = [];
    const totals = { played: 0, won: 0, lost: 0, drawn: 0, pf: 0, pa: 0, gw: 0, gl: 0 };
    const records = { biggestWin: null, highestGame: null };
    const expanded = [];
    for (const m0 of matches) {
      if (m0.cancelled) continue;   /* cancelled matches count for nothing */
      const e0 = byId('events', m0.eventId);
      if (e0 && e0.sideType === 'team' && m0.rubbers && m0.rubbers.length) m0.rubbers.forEach((r) => expanded.push({ ...r, id: m0.id, eventId: m0.eventId, stage: m0.stage, startedAt: m0.startedAt, createdAt: m0.createdAt, _rev: rubberEvent(e0, r) }));
      else expanded.push(m0);
    }
    for (const m of expanded) {
      const ev0 = byId('events', m.eventId); if (!ev0) continue;
      const ev = m._rev || ev0;
      let side = null, via = '';
      if (ev.sideType === 'player') side = m.sideA.includes(pid) ? 'A' : m.sideB.includes(pid) ? 'B' : null;
      else {
        const teamOf = (ids) => ids.find((t) => (byId('teams', t) || { memberIds: [] }).memberIds.includes(pid));
        const ta = teamOf(m.sideA), tb = teamOf(m.sideB);
        side = ta ? 'A' : tb ? 'B' : null; via = ta || tb ? nm(ev, ta || tb) : '';
        const lineup = side === 'A' ? m.lineupA : side === 'B' ? m.lineupB : null;
        if (side && lineup && lineup.length && !lineup.includes(pid)) side = null; /* lineup recorded and this player did not play */
      }
      if (!side) continue;
      const d = derive(m, ev);
      const mine = sideIds(m, side), theirs = sideIds(m, side === 'A' ? 'B' : 'A');
      const r = (per[ev.id] = per[ev.id] || { ev: ev0, played: 0, won: 0, lost: 0, drawn: 0, pf: 0, pa: 0 });
      const sp = (bySport[ev.sport] = bySport[ev.sport] || { played: 0, won: 0, lost: 0, drawn: 0 });
      let own = 0, opp = 0, bestGame = 0;
      d.games.forEach((g) => {
        const f = side === 'A' ? g.a : g.b, a = side === 'A' ? g.b : g.a;
        own += f; opp += a; bestGame = Math.max(bestGame, f);
        if (ev.sideType === 'player') {
          r.pf += f / mine.length; r.pa += a / mine.length; totals.pf += f / mine.length; totals.pa += a / mine.length;
          if (g.winner === side) totals.gw++; else totals.gl++;
        }
      });
      let res = '';
      if (d.status === 'completed') {
        r.played++; sp.played++; totals.played++;
        if (d.draw) { r.drawn++; sp.drawn++; totals.drawn++; res = 'D'; }
        else if (d.winner === side) { r.won++; sp.won++; totals.won++; res = 'W'; }
        else { r.lost++; sp.lost++; totals.lost++; res = 'L'; }
        if (ev.sideType === 'player') {
          if (mine.length === 2) {
            const pr = mine.find((x) => x !== pid);
            const x = (partners[pr] = partners[pr] || { id: pr, played: 0, won: 0 });
            x.played++; if (res === 'W') x.won++;
          }
          theirs.forEach((o) => { const x = (h2h[o] = h2h[o] || { id: o, played: 0, won: 0, lost: 0, drawn: 0 }); x.played++; if (res === 'W') x.won++; else if (res === 'L') x.lost++; else x.drawn++; });
        }
        if (res === 'W' && d.games.length && (!records.biggestWin || own - opp > records.biggestWin.margin))
          records.biggestWin = { margin: own - opp, matchId: m.id, event: ev.name, vs: label(ev, theirs), score: d.games.map((g) => (side === 'A' ? g.a + '-' + g.b : g.b + '-' + g.a)).join(', ') };
        chron.push({ t: m.startedAt || m.createdAt || 0, res });
      }
      if (bestGame && (!records.highestGame || bestGame > records.highestGame.score)) records.highestGame = { score: bestGame, matchId: m.id, event: ev.name };
      history.push({
        m, ev: ev0, res, status: d.status, vs: label(ev, theirs), via,
        partner: ev.sideType === 'player' ? mine.filter((x) => x !== pid).map((x) => nm(ev, x)).join('') : '',
        score: d.games.map((g) => (side === 'A' ? g.a + '-' + g.b : g.b + '-' + g.a)).join(', '),
      });
    }
    chron.sort((a, b) => a.t - b.t);
    const form = chron.slice(-5).map((x) => x.res);
    let bestWin = 0, run = 0;
    chron.forEach((x) => { if (x.res === 'W') { run++; bestWin = Math.max(bestWin, run); } else run = 0; });
    let current = { type: '', count: 0 };
    for (let i = chron.length - 1; i >= 0; i--) {
      const t = chron[i].res; if (t === 'D') break;
      if (!current.type) current = { type: t, count: 1 }; else if (current.type === t) current.count++; else break;
    }
    const honours = [];
    (data.events || []).forEach((ev) => {
      const c = champion(ev, matches); if (!c) return;
      const inIds = (ids) => (ev.sideType === 'player' ? ids.includes(pid) : ids.some((t) => (byId('teams', t) || { memberIds: [] }).memberIds.includes(pid)));
      const tag = ev.sideType === 'team' ? ' (' + label(ev, (inIds(c.winnerIds) ? c.winnerIds : c.runnerIds)) + ')' : '';
      if (inIds(c.winnerIds)) honours.push({ event: ev.name, place: 'Champion' + tag });
      else if (inIds(c.runnerIds)) honours.push({ event: ev.name, place: 'Runner-up' + tag });
    });
    const pname = (id) => (byId('players', id) || {}).name || '?';
    return {
      per: Object.values(per), totals, history: history.reverse(), bySport, form, streak: { current, bestWin }, records, honours,
      partners: Object.values(partners).map((x) => ({ ...x, name: pname(x.id) })).sort((a, b) => b.played - a.played || b.won - a.won).slice(0, 5),
      h2h: Object.values(h2h).map((x) => ({ ...x, name: pname(x.id) })).sort((a, b) => b.played - a.played || b.won - a.won).slice(0, 6),
    };
  }

  /* Season record of every player, per sport, in one pass: { pid: { sport: {played,won,drawn,lost,pf,pa,gold,silver,bronze} } }.
     Team events count for the team members who played (line-up when recorded). Medals come from each game's podium. */
  function seasonRecords(data, matches) {
    matches = matches || data.matches;
    const byId = (col, id) => (data[col] || []).find((x) => x.id === id);
    const members = (tid) => (byId('teams', tid) || { memberIds: [] }).memberIds;
    const out = {};
    const rec = (pid, sport) => { const p = (out[pid] = out[pid] || {}); return (p[sport] = p[sport] || { played: 0, won: 0, drawn: 0, lost: 0, pf: 0, pa: 0, gold: 0, silver: 0, bronze: 0 }); };
    const people = (ev, ids, lineup) => (ev.sideType === 'player' ? ids : ids.flatMap((t) => members(t)).filter((pid) => !lineup || !lineup.length || lineup.includes(pid)));
    for (const m0 of matches) {
      if (m0.cancelled) continue;   /* cancelled matches count for nothing */
      const e0 = byId('events', m0.eventId); if (!e0) continue;
      const list = e0.sideType === 'team' && m0.rubbers && m0.rubbers.length ? m0.rubbers.map((r) => ({ m: r, ev: rubberEvent(e0, r) })) : [{ m: m0, ev: e0 }];
      for (const { m, ev } of list) {
        const d = derive(m, ev); if (d.status !== 'completed') continue;
        const sides = { A: people(ev, m.sideA || [], m0.lineupA), B: people(ev, m.sideB || [], m0.lineupB) };
        ['A', 'B'].forEach((s) => {
          sides[s].forEach((pid) => {
            const r = rec(pid, e0.sport || 'other');
            r.played++;
            if (d.draw) r.drawn++; else if (d.winner === s) r.won++; else r.lost++;
            if (ev.sideType === 'player') d.games.forEach((g) => { r.pf += (s === 'A' ? g.a : g.b) / sides[s].length; r.pa += (s === 'A' ? g.b : g.a) / sides[s].length; });
          });
        });
      }
    }
    (data.events || []).forEach((ev) => {
      const pod = podium(ev, matches); if (!pod) return;
      const who = (ids) => (ev.sideType === 'player' ? ids : ids.flatMap((t) => members(t)));
      who(pod.first).forEach((pid) => rec(pid, ev.sport || 'other').gold++);
      who(pod.second).forEach((pid) => rec(pid, ev.sport || 'other').silver++);
      who(pod.third).forEach((pid) => rec(pid, ev.sport || 'other').bronze++);
    });
    Object.values(out).forEach((p) => Object.values(p).forEach((r) => { r.pf = r2(r.pf); r.pa = r2(r.pa); }));
    return out;
  }

  const RANK_POINTS = { win: 3, draw: 1, loss: 0, gold: 10, silver: 6, bronze: 4 };
  /* Sports with their own match points: a table tennis win is one match worth 2 points, however many sets it took. */
  const RANK_SPORT = { tt: { win: 2, draw: 1, loss: 0 } };
  /* Ranking table from one or more season records (current season + past seasons for all-time).
     opts: { sport: '' for all, players: [...] to include, pts } -> rows sorted, with shared ranks on ties. */
  function rankings(recordSets, opts) {
    opts = opts || {};
    const pts = { ...RANK_POINTS, ...(opts.pts || {}) };
    const allow = opts.players ? new Set(opts.players.map((p) => p.id)) : null;
    const tot = {};
    recordSets.forEach((set) => Object.entries(set || {}).forEach(([pid, sports]) => {
      if (allow && !allow.has(pid)) return;
      Object.entries(sports).forEach(([sp, r]) => {
        if (opts.sport && sp !== opts.sport) return;
        const t = (tot[pid] = tot[pid] || { id: pid, played: 0, won: 0, drawn: 0, lost: 0, pf: 0, pa: 0, gold: 0, silver: 0, bronze: 0, points: 0 });
        Object.keys(t).forEach((k) => { if (k !== 'id' && k !== 'points') t[k] += Number(r[k]) || 0; });
        const P = { ...pts, ...(RANK_SPORT[sp] || {}), ...((opts.ptsBySport || {})[sp] || {}) }, n = (k) => Number(r[k]) || 0;
        t.points += n('won') * P.win + n('drawn') * P.draw + n('lost') * P.loss + n('gold') * P.gold + n('silver') * P.silver + n('bronze') * P.bronze;
      });
    }));
    const rows = Object.values(tot).filter((t) => t.played > 0 || t.gold + t.silver + t.bronze > 0).map((t) => ({
      ...t, pf: r2(t.pf), pa: r2(t.pa), winPct: t.played ? Math.round((t.won / t.played) * 100) : 0,
      points: r2(t.points),
    }));
    rows.sort((a, b) => b.points - a.points || b.won - a.won || b.winPct - a.winPct || (b.pf - b.pa) - (a.pf - a.pa) || a.played - b.played);
    rows.forEach((r, i) => {
      const p = rows[i - 1];
      r.rank = p && p.points === r.points && p.won === r.won && p.winPct === r.winPct && (p.pf - p.pa) === (r.pf - r.pa) && p.played === r.played ? p.rank : i + 1;
    });
    return rows;
  }

  /* Is there a tie across the qualification cutoff? (more qualifiers than places) */
  function cutoffInfo(rows, finalists) {
    if (!finalists) return { tie: false };
    const q = rows.filter((r) => r.rank <= finalists && r.played > 0);
    return { tie: q.length > finalists, count: q.length, places: finalists };
  }

  const scoreText = (d) => (d.tie ? d.gamesA + '-' + d.gamesB + ' rubbers' : d.games.map((g) => g.a + '-' + g.b).join(', '));

  return { withCfg, finalistsFor, derive, applyOp, standings, groupTables, bracket, bracketOrder, seedsOrder, stageName, KO_STAGES, podium, rubberEvent, champion, cutoffInfo, playerStats, seasonRecords, rankings, RANK_POINTS, RANK_SPORT, gameOver, need, scoreText, sideIds, r2 };
});
