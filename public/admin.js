'use strict';
/* Admin screens: setup, players, teams, referees, events, sponsors, data, fixtures, generators, certificates */

/* Tick the sports a referee covers. */
const sportChecks = (sel) => checkList(['badminton', 'tt', 'carrom', 'chess'].map((k) => ({ id: k, name: SPORT_ICON[k] + ' ' + SPORT_LABEL[k] })), sel || []);
/* Select players (one, several or all) – a sticky bar with the count, Select all, the action and Done. */
function playerSelBar(shown, actionLabel, onAction, eligible) {
  const ok = shown.filter((p) => !eligible || eligible(p));
  if (!ui.pickP) return h('div', { class: 'actions noprint' }, h('button', { class: 'btn ghost sm', onclick: () => { ui.pickP = new Set(); render(); } }, '☑ Select players'));
  const ids = new Set(ok.map((p) => p.id)), sel = [...ui.pickP].filter((id) => ids.has(id)), all = ok.length > 0 && sel.length === ok.length;
  return h('div', { class: 'selbar noprint' }, h('b', {}, sel.length + ' of ' + ok.length + ' selected'),
    h('button', { class: 'btn ghost sm', disabled: !ok.length, onclick: () => { ok.forEach((p) => (all ? ui.pickP.delete(p.id) : ui.pickP.add(p.id))); render(); } }, all ? 'Select none' : 'Select all (' + ok.length + ')'),
    h('button', { class: 'btn sm danger', disabled: !sel.length, onclick: () => onAction(sel) }, actionLabel + (sel.length ? ' (' + sel.length + ')' : '')),
    h('button', { class: 'btn ghost sm', onclick: () => { ui.pickP = null; render(); } }, 'Done'));
}
const pickBox = (p, enabled) => h('input', { type: 'checkbox', class: 'pick', checked: ui.pickP.has(p.id), disabled: !enabled, 'aria-label': 'Select ' + p.name, onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) ui.pickP.add(p.id); else ui.pickP.delete(p.id); render(); } });
/* Has this person played (a match, a line-up, a team that played, or results from a past season)? Their profile is then permanent. */
function playedSet() {
  const set = new Set(), add = (id) => { set.add(id); ((byId('teams', id) || {}).memberIds || []).forEach((x) => set.add(x)); };
  SA.matches.forEach((m) => { [...(m.sideA || []), ...(m.sideB || [])].forEach(add); (m.rubbers || []).forEach((r) => [...(r.sideA || []), ...(r.sideB || [])].forEach((x) => set.add(x))); JSON.stringify([m.lineupA || '', m.lineupB || '']).replace(/"([\w-]{6,})"/g, (_, id) => set.add(id)); });
  (SA.seasons || []).forEach((x) => Object.keys(x.records || {}).forEach((id) => set.add(id)));
  return set;
}
const checkList = (items, selected) => {
  const boxes = items.map((it) => ({ it, cb: h('input', { type: 'checkbox', checked: selected.includes(it.id), 'aria-label': it.name }) }));
  const el = h('div', { class: 'checks' },
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => boxes.forEach((b) => (b.cb.checked = true)) }, 'Select all'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => boxes.forEach((b) => (b.cb.checked = false)) }, 'None')),
    boxes.length ? boxes.map((b) => h('label', { class: 'chk' }, b.cb, b.it.name)) : h('p', { class: 'empty' }, 'Nothing to choose yet.'));
  el.values = () => boxes.filter((b) => b.cb.checked).map((b) => b.it.id);
  return el;
};
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));
const sel = (opts, val) => h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: String(val) === String(v) }, l)));
const inp = (val, o) => h('input', { value: val == null ? '' : val, ...(o || {}) });
const SECTION_OPTS = [['adults', 'Adults'], ['kids', 'Kids']];
const playersIn = (section, tid) => { const T = tourById(tid || curTid()) || { playerIds: [] }; return S.players.filter((p) => (p.section || 'adults') === section && (T.kind === 'friendly' || T.playerIds.includes(p.id))); };

/* ------------------------------------------------------------------ player */
const STYLE_HINTS = {
  badminton: ['Attacking', 'Defensive', 'All-round', 'Net player', 'Baseline smasher'],
  tt: ['Attacker', 'Defender', 'All-round', 'Penhold', 'Shakehand'],
  carrom: ['Striker', 'Defender', 'Queen specialist', 'Slammer'],
  chess: ['Aggressive', 'Positional', 'Tactical', 'Defensive'],
};
/* Contact details are masked on screen ("98•••••343"); "Show" reveals them for editing. Unrevealed fields are not sent back, so they stay unchanged. */
function secretInput(v, attrs, kind) {
  const masked = !v ? '' : kind === 'email' ? String(v).replace(/^(.).*(@.*)$/, '$1•••$2') : kind === 'text' ? '•••••• (hidden)' : maskPhone(v);
  const i = inp(masked, attrs || {}); i.readOnly = !!v;
  let open = !v;
  const btn = v ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { i.value = v; i.readOnly = false; open = true; btn.remove(); } }, 'Show') : null;
  const el = h('div', { class: 'secret' }, i, btn);
  Object.defineProperty(el, 'value', { get: () => (open ? i.value : undefined) });
  return el;
}
function secretText(prefix, v) {
  const span = h('span', {}, prefix + maskPhone(v) + ' ');
  span.append(h('button', { type: 'button', class: 'btn ghost sm', onclick: (e) => { span.textContent = prefix + v; e.stopPropagation(); } }, 'Show'));
  return span;
}

/* Add people by typing a name or picking someone from the player list. values(): ["Typed Name", { playerId }] */
function staffAdder(label) {
  const picked = [], dl = 'pl-' + Math.random().toString(36).slice(2);
  const list = h('datalist', { id: dl }, S.players.filter((p) => p.status !== 'pending').map((p) => h('option', { value: p.name })));
  const input = h('input', { list: dl, placeholder: label + ': type a name or pick a player', 'aria-label': label });
  const chips = h('div', { class: 'chips' });
  const draw = () => chips.replaceChildren(...picked.map((x, i) => h('span', { class: 'chip plain' }, (x.playerId ? '👤 ' : '') + x.name, ' ', h('button', { type: 'button', class: 'x', 'aria-label': 'Remove', onclick: () => { picked.splice(i, 1); draw(); } }, '✕'))));
  const add = () => { const v = input.value.trim(); if (!v) return; const pl = S.players.find((p) => p.name.toLowerCase() === v.toLowerCase()); if (!picked.some((x) => x.name.toLowerCase() === v.toLowerCase())) picked.push(pl ? { name: pl.name, playerId: pl.id } : { name: v }); input.value = ''; draw(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const el = h('div', { class: 'adder' }, h('div', { class: 'secret' }, input, list, h('button', { type: 'button', class: 'btn ghost sm', onclick: add }, 'Add')), chips);
  return { el, values: () => { if (input.value.trim()) add(); return picked.map((x) => (x.playerId ? { playerId: x.playerId } : x.name)); } };
}
/* New event: name, dates, organizers, referees and its games (or copy the games of another event). */
function newEventModal() {
  const name = inp('', { placeholder: 'e.g. CSSL - Season 4 or Diwali Kids Cup', maxlength: 80 }), dates = inp('', { placeholder: 'e.g. 29–30 Nov 2026' }), venue = inp('');
  const myRef = me.role === 'referee' ? S.referees.find((r) => r.name === me.name) : null;
  const orgs = checkList((S.organizers || []).map((a) => ({ id: a.id, name: a.name })), isAdmin() ? [me.adminId] : []), newOrgs = staffAdder('New organizer');
  const refs = checkList(S.referees.filter((r) => r.status !== 'pending').map((r) => ({ id: r.id, name: r.name + ' – ' + refSportsTxt(r) })), myRef ? [myRef.id] : []), newRefs = staffAdder('New referee'), newRefSports = sportChecks();
  const copy = sel([['', '— set up games below —']].concat(realTours().map((t) => [t.id, 'Copy the games of ' + t.name])), '');
  const rows = [], box = h('div', {});
  const drawRows = () => box.replaceChildren(...rows.map((r, i) => h('div', { class: 'gamerow' }, r.sport, r.kind, r.section, r.name, h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Remove game', onclick: () => { rows.splice(i, 1); drawRows(); } }, '✕'))));
  const row = (g) => { rows.push({ sport: sel([['badminton', '🏸 Badminton'], ['tt', '🏓 Table tennis'], ['carrom', '🎯 Carrom'], ['chess', '♟️ Chess'], ['other', '🏅 Other']], g.sport), kind: sel([['singles', 'Singles'], ['doubles', 'Doubles'], ['team', 'Team']], g.kind || 'singles'), section: sel(SECTION_OPTS, g.section || 'adults'), name: inp(g.name || '', { placeholder: 'Name (optional)' }) }); drawRows(); };
  ['badminton', 'tt', 'carrom', 'chess'].forEach((sp) => row({ sport: sp }));
  const addBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => row({ sport: 'badminton' }) }, '+ Add game');
  copy.addEventListener('change', () => { box.hidden = addBtn.hidden = !!copy.value; });
  modal('New event', h('div', {}, field('Event name', name), h('div', { class: 'two' }, field('Dates', dates), field('Venue', venue)),
    h('b', {}, '👔 Organizers'), h('p', { class: 'muted small' }, (isAdmin() ? 'You are an organizer of this event. ' : 'Add at least one organizer – add yourself by name to get an organizer PIN. ') + 'Organizers manage the event.'), orgs, newOrgs.el,
    h('b', {}, '🧑‍⚖️ Referees'), h('p', { class: 'muted small' }, 'Each game only offers the referees mapped to its sport.'), refs, newRefs.el, h('div', { class: 'muted small' }, 'Sports the new referees cover:'), newRefSports,
    h('b', {}, '🏸 Games'), copy, box, addBtn,
    h('p', { class: 'muted small' }, 'Players join by registering for this event, by an uploaded player list, or when an organizer enrols them. Everything can be changed later.')),
  [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Create event', fn: async () => {
    const r = await api('POST', '/api/staff/tournaments', { name: name.value, dates: dates.value, venue: venue.value, organizerIds: orgs.values(), newOrganizers: newOrgs.values(), refereeIds: refs.values(), newReferees: newRefs.values(), newRefereeSports: newRefSports.values(),
      copyFrom: copy.value, games: copy.value ? [] : rows.map((x) => ({ sport: x.sport.value, kind: x.kind.value, section: x.section.value, name: x.name.value })) });
    await refresh(); ui.tid = r.tournament.id; store.set('tid', r.tournament.id); scope(); location.hash = '#/season/games'; showPins(r.pins, () => render());
  } }]);
}
function tourDetailsModal(T) {
  const name = inp(T.name), dates = inp(T.dates), venue = inp(T.venue), closed = T.status === 'closed';
  modal('Event details', h('div', {}, field('Event name', name), field('Dates', dates), field('Venue', venue),
    h('p', { class: 'muted small' }, closed ? 'This event is closed: scores are frozen. Reopen it to change anything.' : 'Close the event when it is over – scores freeze; it stays in All events and in all-time rankings.')),
  [{ label: closed ? 'Reopen event' : 'Close event', cls: closed ? 'ghost' : 'danger', close: false, fn: (close) => confirmBox((closed ? 'Reopen ' : 'Close ') + T.name + '?', guard(async () => { await api('PUT', '/api/staff/tournaments/' + T.id, { status: closed ? 'open' : 'closed' }); close(); await refresh(); }), closed ? 'Reopen' : 'Close event') },
    { label: 'Save', fn: async () => { await api('PUT', '/api/staff/tournaments/' + T.id, { name: name.value, dates: dates.value, venue: venue.value }); await refresh(); } }]);
}
function tourStaffModal(T, what) {
  const orgsMode = what === 'organizers';
  const pool = orgsMode ? (S.organizers || []).map((a) => ({ id: a.id, name: a.name })) : S.referees.filter((r) => r.status !== 'pending').map((r) => ({ id: r.id, name: r.name + ' – ' + refSportsTxt(r) }));
  const list = checkList(pool, orgsMode ? T.organizerIds : T.refereeIds), adder = staffAdder(orgsMode ? 'New organizer' : 'New referee'), adderSports = orgsMode ? null : sportChecks();
  modal((orgsMode ? 'Organizers' : 'Referees') + ' – ' + T.name, h('div', {}, h('p', { class: 'muted small' }, 'Tick existing ' + (orgsMode ? 'organizers' : 'referees') + ', or add new ones by name or from the player list. At least one is needed. New people get a PIN.'), list, adder.el, adderSports ? h('div', { class: 'muted small' }, 'Sports the new referees cover (each game only offers referees mapped to its sport). Change existing referees’ sports in the Referees tab → Edit.') : null, adderSports),
    [{ label: 'Save', fn: async () => { const r = await api('PUT', '/api/staff/tournaments/' + T.id, orgsMode ? { organizerIds: list.values(), newOrganizers: adder.values() } : { refereeIds: list.values(), newReferees: adder.values(), newRefereeSports: adderSports.values() }); await refresh(); showPins(r.pins); } }]);
}
/* Event → Teams: teams made from the event's players, and the team games each plays. */
function eventTeams(T) {
  const mine = canManageTour(T), teamGames = S.events.filter((e) => e.sideType === 'team');
  const gamesOf = (t) => teamGames.filter((e) => e.participantIds.includes(t.id)).map((e) => e.name);
  return h('div', {},
    mine && T.status !== 'closed' ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => eventTeamModal(T, null) }, '+ New team'), !teamGames.length ? h('span', { class: 'muted small' }, 'Tip: add a team game first (Games → + New game → Team).') : null) : null,
    teamGames.map((ev) => { const placed = new Set(ev.participantIds.flatMap((id) => (byId('teams', id) || { memberIds: [] }).memberIds)); const w = (ev.interestedIds || []).filter((id) => !placed.has(id)).length;
      return w && mine ? h('a', { class: 'card tip', href: '#/event/' + ev.id, onclick: () => { ui.eventTab[ev.id] = 'people'; } }, '🙋 ' + w + ' players chose ' + ev.name + ' and are waiting for a team – build or auto-make teams ›') : null; }),
    S.teams.length ? groupBySection(S.teams, (t) => h('div', { class: 'row', onclick: () => (mine ? eventTeamModal(T, t) : null) }, h('div', { class: 'grow' }, h('b', {}, t.name),
      h('div', { class: 'muted small' }, t.memberIds.map((i) => (byId('players', i) || {}).name).filter(Boolean).join(', ') || 'No players yet'),
      h('div', { class: 'small' }, '🏆 ' + (gamesOf(t).join(', ') || 'not in a game yet'))), mine ? h('span', { class: 'muted' }, 'Edit') : null))
      : h('p', { class: 'empty' }, 'No teams yet.'));
}
function eventTeamModal(T, t) {
  const name = inp(t ? t.name : ''), section = sel(SECTION_OPTS, t ? t.section : ui.section), wrap = h('div', {});
  let members = checkList([], []), games = checkList([], []);
  const draw = () => {
    members = checkList(playersIn(section.value, T.id).sort((a, b) => a.name.localeCompare(b.name)), t && t.section === section.value ? t.memberIds : []);
    games = checkList(S.events.filter((e) => e.sideType === 'team' && secOf(e) === section.value), t ? S.events.filter((e) => e.participantIds.includes(t.id)).map((e) => e.id) : []);
    wrap.replaceChildren(h('b', {}, 'Players (from ' + T.name + ')'), members, h('b', {}, 'Team games this team plays'), games);
  };
  section.addEventListener('change', draw); draw();
  modal(t ? 'Edit team' : 'New team in ' + T.name, h('div', {}, field('Team name', name), t ? null : field('Section', section), wrap),
    [t ? { label: 'Delete team', cls: 'danger', close: false, fn: (close) => confirmBox('Delete team ' + t.name + '?', guard(async () => { await api('DELETE', '/api/admin/teams/' + t.id); close(); await refresh(); }), 'Delete') } : null,
      { label: 'Save', fn: async () => {
        if (t) { await api('PUT', '/api/admin/teams/' + t.id, { name: name.value, memberIds: members.values() }); const r = await api('PUT', '/api/admin/teams/' + t.id + '/games', { eventIds: games.values() }); if (r.kept.length) toast('Still in ' + r.kept.join(', ') + ' – it already has fixtures', true); }
        else await api('POST', '/api/admin/tournaments/' + T.id + '/teams', { name: name.value, section: section.value, memberIds: members.values(), eventIds: games.values() });
        await refresh();
      } }].filter(Boolean));
}
/* Event → Players: the event's roster. Players join by registering, an uploaded list, or being enrolled by an organizer. */
function eventPlayers(T) {
  const mine = canManageTour(T), R = S.registration || {};
  let q = '';
  const list = h('div', { class: 'list' });
  const shown = () => S.players.filter((p) => (T.playerIds || []).includes(p.id) && p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  const picking = !!ui.pickP && mine && T.status !== 'closed';
  const draw = () => list.replaceChildren(...shown().map((p) =>
    h('div', { class: 'row' }, picking ? pickBox(p, true) : null, avatar(p, 32), h('a', { class: 'grow', href: '#/player/' + p.id }, h('b', {}, p.name), h('div', { class: 'muted small' }, [SEC[p.section || 'adults'], S.events.filter((e) => e.participantIds.includes(p.id) || (e.interestedIds || []).includes(p.id)).map((e) => e.name).join(', ') || 'no games yet'].join(' • '))),
      mine && T.status !== 'closed' && !picking ? h('button', { class: 'btn ghost sm', 'aria-label': 'Remove ' + p.name + ' from ' + T.name, onclick: () => confirmBox('Remove ' + p.name + ' from ' + T.name + '? Their profile stays in the player database.', guard(async () => { await api('POST', '/api/admin/tournaments/' + T.id + '/roster', { remove: p.id }); await refresh(); }), 'Remove') }, '✕') : null)));
  draw();
  return h('div', {},
    mine && T.status !== 'closed' ? h('div', {},
      h('div', { class: 'card' }, h('b', {}, '📝 Registration for ' + T.name), h('p', { class: 'muted small' }, R.open ? 'Open' + (R.deadline ? ' until ' + R.deadline : '') + (R.pending ? ' • ' + R.pending + ' waiting for approval' : '') : 'Closed'),
        h('div', { class: 'actions' }, h('a', { class: 'btn ghost sm', href: '#/admin', onclick: () => { ui.adminTab = 'registration'; } }, 'Settings & approvals ›'), R.open ? copyBtn(BASE() + '/#/register/' + T.id, 'Copy registration link') : null)),
      importCard(),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => enrolModal(T) }, '➕ Enrol existing player'), h('button', { class: 'btn ghost', onclick: () => playerModal(null, ui.section) }, '+ New player'))) : null,
    h('input', { class: 'search', type: 'search', placeholder: 'Search ' + (T.playerIds || []).length + ' players…', 'aria-label': 'Search players', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
    mine && T.status !== 'closed' && (T.playerIds || []).length ? playerSelBar(shown(), '✕ Remove from event', (sel) => confirmBox('Remove ' + sel.length + ' player' + (sel.length === 1 ? '' : 's') + ' from ' + T.name + ' (and its games and teams)? Their profiles, history and other events stay. Players who already have fixtures here are skipped.',
      guard(async () => { const r = await api('POST', '/api/admin/tournaments/' + T.id + '/roster', { remove: sel }); ui.pickP = null; await refresh();
        if (r.skipped.length) modal(r.removed + ' removed, ' + r.skipped.length + ' kept', h('div', {}, h('p', { class: 'small' }, 'These players already have fixtures in this event. Delete those fixtures (or use Withdraw / replace in the game) first:'), h('ul', {}, r.skipped.map((x) => h('li', {}, x)))), [{ label: 'OK', fn: () => {} }]);
        else toast(r.removed + ' removed from ' + T.name); }), 'Remove')) : null,
    list, !(T.playerIds || []).length ? h('p', { class: 'empty' }, 'No players in this event yet. They register, are uploaded, or are enrolled.') : null);
}
function enrolModal(T) {
  const out = S.players.filter((p) => p.status === 'approved' && !(T.playerIds || []).includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const list = checkList(out.map((p) => ({ id: p.id, name: p.name + (p.section === 'kids' ? ' (kids)' : '') })), []);
  modal('Enrol players in ' + T.name, h('div', {}, h('p', { class: 'muted small' }, 'Players already in the database (from other events). After enrolling, put them in games from the game’s settings or their profile.'), out.length ? list : h('p', { class: 'empty' }, 'Everyone is already in this event.')),
    [{ label: 'Enrol', fn: async () => { const r = await api('POST', '/api/admin/tournaments/' + T.id + '/roster', { add: list.values() }); toast(r.added + ' enrolled'); await refresh(); } }]);
}

/* ---- games (sub-events) with their organizer and referees ---- */
function staffPicker(ev, sportSel) {
  const orgs = (S.organizers || []).map((a) => ({ id: a.id, name: a.name + (a.limited ? ' (game organizer)' : (a.sports || []).length ? ' (sport lead)' : ' (main organizer)') }));
  const orgList = checkList(orgs, ev ? ev.organizerIds || [] : []), newRefs = staffAdder('New referee'), newOrgs = staffAdder('Extra organizer');
  const refBox = h('div', {}); let refList = checkList([], []);
  const drawRefs = () => {
    const g = { sport: sportSel ? sportSel.value : ev.sport, id: ev ? ev.id : '' }, label = SPORT_ICON[g.sport] ? SPORT_ICON[g.sport] + ' ' + SPORT_LABEL[g.sport] : 'this sport';
    const all = S.referees.filter((r) => r.status !== 'pending' && r.kind !== 'volunteer'), ok = all.filter((r) => refFor(r, g)), hidden = all.filter((r) => !refFor(r, g));
    const was = refList.values(), chosen = was.length ? was : ev ? ev.refereeIds || [] : curT().refereeIds || [];
    refList = checkList(ok.map((r) => ({ id: r.id, name: r.name + (r.kind === 'chief' ? ' (chief)' : '') })), chosen.filter((id) => ok.some((r) => r.id === id)));
    const stale = ev ? (ev.refereeIds || []).map((id) => byId('referees', id)).filter((r) => r && !refFor(r, g)) : [];
    refBox.replaceChildren(...[h('div', { class: 'muted small' }, 'Only referees mapped to ' + label + ' are listed.'), refList,
      hidden.length ? h('div', { class: 'muted small' }, 'Not mapped to ' + label + ': ' + hidden.map((r) => r.name).join(', ') + ' – map sports in Event → Referees → Edit.') : null,
      stale.length ? h('div', { class: 'warnbox small' }, stale.map((r) => r.name).join(', ') + ' will be removed from this game on Save (not mapped to ' + label + ').') : null].filter(Boolean));
  };
  drawRefs(); if (sportSel) sportSel.addEventListener('change', () => { refList = checkList([], []); drawRefs(); });
  const el = h('div', {},
    h('b', {}, '🧑‍⚖️ Referees for this game (at least one)'), refBox, h('div', { class: 'muted small' }, '…or add new ones – type a name or pick a player (they are mapped to this sport):'), newRefs.el,
    h('details', {}, h('summary', { class: 'small' }, 'Extra organizer just for this game (optional – the event’s organizers already manage it)'), orgList, newOrgs.el));
  return { el, values: () => ({ organizerIds: orgList.values(), refereeIds: refList.values(), newOrganizers: newOrgs.values(), newReferees: newRefs.values() }) };
}
function showPins(pins, after) {
  if (!pins || !pins.length) { if (after) after(); return; }
  modal('New PINs – shown only once', h('div', {}, h('p', { class: 'small' }, 'Give each person their PIN. They sign in from Menu → Sign in.'),
    pins.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, x.name), h('div', { class: 'muted small' }, x.role)), h('div', { class: 'bigpin', style: 'font-size:22px' }, x.pin)))),
  [{ label: 'Done', fn: () => { if (after) after(); } }]);
}
function newGameModal() {
  const sport = sel([['badminton', '🏸 Badminton'], ['tt', '🏓 Table tennis'], ['carrom', '🎯 Carrom'], ['chess', '♟️ Chess'], ['other', '🏅 Other']], me.sports && me.sports[0] || 'badminton');
  const section = sel(SECTION_OPTS, ui.section), kind = sel([['singles', 'Individual – singles'], ['doubles', 'Individual – doubles (pairs)'], ['team', 'Team event']], 'singles');
  const name = inp('', { placeholder: 'Optional, e.g. Men’s Doubles', maxlength: 80 });
  const staff = staffPicker(null, sport);
  modal('New game – ' + curT().name, h('div', {}, field('Sport', sport), field('Who plays', kind), field('Section', section), field('Name', name, 'Leave empty to name it after the sport.'), staff.el,
    h('p', { class: 'muted small' }, 'Scoring rules start from the usual rules for the sport – change them later under ⚙ Game settings.')),
  [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Create game', fn: async () => {
    const r = await api('POST', '/api/admin/games', { tid: curTid(), sport: sport.value, section: section.value, kind: kind.value, name: name.value, ...staff.values() });
    await refresh(); showPins(r.pins, () => { location.hash = '#/event/' + r.event.id; });
  } }]);
}
function staffModal(ev) {
  const staff = staffPicker(ev);
  modal('Referees – ' + ev.name, staff.el, [{ label: 'Save', fn: async () => { const r = await api('PUT', '/api/admin/events/' + ev.id + '/staff', staff.values()); await refresh(); showPins(r.pins); } }]);
}
function seasonModal() {
  const T = S.tournament, f = { season: inp(T.seasonName || ''), dates: inp(T.dates, { placeholder: 'e.g. 29–30 Nov 2026' }), venue: inp(T.venue) };
  modal('Event details', h('div', {}, field('Event / season name', f.season), field('Dates', f.dates), field('Venue', f.venue), h('p', { class: 'muted small' }, 'Several events can run at the same time.')),
    [{ label: 'Save', fn: async () => { await api('POST', '/api/admin/tournament', { seasonName: f.season.value, dates: f.dates.value, venue: f.venue.value }); await refresh(); } }]);
}
const shiftModal = () => modal('Running late?', shiftCard());

/* ---- team builder (team game → Teams tab): players who chose the game, waiting for a team ---- */
function teamBuilder(ev) {
  const entered = (ev.participantIds || []).map((id) => byId('teams', id)).filter(Boolean);
  const placed = new Set(entered.flatMap((t) => t.memberIds));
  const waiting = (ev.interestedIds || []).filter((id) => !placed.has(id)).map((id) => byId('players', id)).filter(Boolean);
  const hasFx = (tid) => S.matches.some((m) => m.eventId === ev.id && (m.sideA.includes(tid) || m.sideB.includes(tid)));
  const size = inp(4, { type: 'number', min: 2, max: 20, inputmode: 'numeric', 'aria-label': 'Players per team', style: 'width:70px' });
  const names = (ids) => ids.map((i) => (byId('players', i) || {}).name).filter(Boolean).join(', ');
  return h('div', {},
    h('div', { class: 'card' }, h('b', {}, '🙋 Waiting for a team (' + waiting.length + ')'),
      h('p', { class: 'muted small' }, 'Players who chose ' + ev.name + ' (registration or Excel upload) and are not in a team yet.'),
      waiting.length ? h('div', { class: 'chips' }, waiting.map((p) => h('span', { class: 'chip plain' }, p.name + (p.gender ? ' · ' + p.gender : '')))) : h('p', { class: 'muted small' }, 'Nobody is waiting.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => newTeamForEvent(ev, waiting) }, '+ New team'),
        waiting.length >= 2 ? h('span', { class: 'actions' }, h('span', { class: 'muted small' }, 'Players per team'), size,
          h('button', { class: 'btn ghost', onclick: () => confirmBox('Split the ' + waiting.length + ' waiting players into teams of about ' + size.value + '? Teams are mixed evenly (women and men) and named Team 1, Team 2… – you can rename and edit them afterwards.', guard(async () => { const r = await api('POST', '/api/admin/events/' + ev.id + '/auto-teams', { size: size.value }); toast(r.teams + ' teams made from ' + r.players + ' players'); await refresh(); }), 'Make teams') }, '⚡ Auto-make teams')) : null,
        S.teams.some((t) => t.section === secOf(ev) && !(ev.participantIds || []).includes(t.id)) ? h('button', { class: 'btn ghost', onclick: () => addExistingTeams(ev) }, 'Add existing team') : null)),
    h('h3', {}, 'Teams in this game (' + entered.length + ')'),
    entered.length ? h('div', { class: 'list' }, entered.map((t) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('b', {}, t.name), h('div', { class: 'muted small' }, names(t.memberIds) || 'No players yet')),
      h('button', { class: 'btn ghost sm', onclick: () => teamModal(t) }, 'Edit'),
      hasFx(t.id) ? null : h('button', { class: 'btn danger sm', 'aria-label': 'Remove ' + t.name + ' from this game', onclick: () => confirmBox('Take ' + t.name + ' out of ' + ev.name + '? Its players go back to the waiting list; the team itself is kept.', guard(async () => { await api('POST', '/api/admin/events/' + ev.id + '/teams/' + t.id + '/remove'); await refresh(); }), 'Remove') }, '✕'))))
      : h('p', { class: 'empty' }, 'No teams yet. Make them from the waiting list above, or upload a Teams sheet (Admin → Players → Upload).'));
}
function newTeamForEvent(ev, waiting) {
  const name = inp('', { placeholder: 'e.g. Red Hawks', 'aria-label': 'Team name' });
  const w = new Set(waiting.map((p) => p.id));
  const others = playersIn(secOf(ev)).filter((p) => !w.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const list = checkList(waiting.map((p) => ({ id: p.id, name: p.name + (p.gender ? ' · ' + p.gender : '') })).concat(others.map((p) => ({ id: p.id, name: p.name + ' (did not choose this game)' }))), []);
  modal('New team in ' + ev.name, h('div', {}, field('Team name', name, 'Leave empty for Team 1, Team 2…'), h('b', {}, 'Players'), h('p', { class: 'muted small' }, 'Players waiting for this game are listed first.'), list),
    [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Create & enter team', fn: async () => { const t = await api('POST', '/api/admin/events/' + ev.id + '/teams', { name: name.value, memberIds: list.values() }); toast(t.name + ' entered in ' + ev.name); await refresh(); } }]);
}
function addExistingTeams(ev) {
  const list = checkList(S.teams.filter((t) => t.section === secOf(ev) && !(ev.participantIds || []).includes(t.id)).map((t) => ({ id: t.id, name: t.name })), []);
  modal('Add teams to ' + ev.name, list, [{ label: 'Add', fn: async () => { await api('PUT', '/api/admin/events/' + ev.id, { participantIds: (ev.participantIds || []).concat(list.values()) }); await refresh(); } }]);
}

/* ---- referees (organizer) ---- */
const REF_KINDS = [['referee', 'Referee – scores matches'], ['chief', 'Chief referee – scores everything, corrects, resolves reports'], ['volunteer', 'Volunteer – check-in only, no scoring']];
/* Which sports / games a referee may score. Nothing ticked = everything. */
function scopePicker(sports, eventIds) {
  const sp = Object.keys(SPORT_LABEL).filter((k) => S.events.some((e) => e.sport === k)).map((k) => ({ k, cb: h('input', { type: 'checkbox', checked: sports.includes(k) }) }));
  const evs = checkList(S.events.map((e) => ({ id: e.id, name: e.name + (secOf(e) === 'kids' ? ' (kids)' : '') })), eventIds);
  const el = h('div', {}, h('div', { class: 'field' }, h('span', {}, 'May score these sports'), h('div', { class: 'checks' }, sp.map((x) => h('label', { class: 'chk' }, x.cb, SPORT_ICON[x.k] + ' ' + SPORT_LABEL[x.k])))),
    h('details', { open: eventIds.length > 0 }, h('summary', { class: 'small' }, '…or only specific games'), evs),
    h('small', { class: 'muted' }, 'Leave everything unticked to allow all sports. Chief referees can always score everything.'));
  return { el, values: () => ({ sports: sp.filter((x) => x.cb.checked).map((x) => x.k), eventIds: evs.values() }) };
}
function refereesAdmin() {
  const t = S.tournament, pend = S.referees.filter((r) => r.status === 'pending');
  const name = inp('', { placeholder: 'Name', 'aria-label': 'Name' }), kind = sel(REF_KINDS, 'referee'), scope = scopePicker([], []);
  const link = BASE() + '/#/refsignup';
  return h('div', {},
    pend.length ? h('div', { class: 'card warnbox' }, h('b', {}, '🙋 ' + pend.length + ' referee sign-up(s) waiting for approval'),
      pend.map((r) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, r.name), h('div', { class: 'muted small' }, [maskPhone(r.phone), (r.sports || []).map((k) => SPORT_LABEL[k]).join(', '), r.note].filter(Boolean).join(' • '))),
        h('button', { class: 'btn sm', onclick: () => refereeModal(r, true) }, 'Review'),
        h('button', { class: 'btn danger sm', 'aria-label': 'Reject ' + r.name, onclick: () => confirmBox('Reject ' + r.name + '’s sign-up?', guard(async () => { await api('DELETE', '/api/admin/referees/' + r.id); await refresh(); }), 'Reject') }, '✕')))) : null,
    h('div', { class: 'card' }, h('b', {}, 'Add a referee'), h('p', { class: 'muted small' }, 'Only referees change scores; organizers do not. A personal PIN is shown once – give it to the person. They sign in from Menu → Sign in.'),
      field('Name', name), field('Role', kind), scope.el,
      h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/admin/referees', { name: name.value, kind: kind.value, ...scope.values() }); await refresh(); showPin(r.name, r.pin); }) }, 'Add referee')),
    h('div', { class: 'card' }, h('b', {}, 'Referee sign-up'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!t.refSignupOpen, onchange: guard(async (e) => { await api('POST', '/api/admin/tournament', { refSignupOpen: e.target.checked }); toast(e.target.checked ? 'Referee sign-up is open' : 'Referee sign-up is closed'); await refresh(); }) }), 'Let people sign up as referees (you approve each one)'),
      t.refSignupOpen ? h('div', {}, h('div', { class: 'muted small wrap' }, link), h('div', { class: 'actions' },
        h('button', { class: 'btn ghost sm', onclick: guard(async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }) }, 'Copy link'),
        h('button', { class: 'btn ghost sm', onclick: () => modal('Referee sign-up', h('div', { class: 'center' }, h('img', { class: 'qr', src: '/api/qr.svg?text=' + encodeURIComponent(link), alt: 'QR code for referee sign-up' }), h('div', { class: 'muted small wrap' }, link))) }, 'QR code'))) : null));
}
function refereeModal(r, approving) {
  const name = inp(r.name), kind = sel(REF_KINDS, r.kind || 'referee'), scope = scopePicker(r.sports || [], r.eventIds || []);
  modal(approving ? 'Approve referee' : 'Edit referee', h('div', {}, approving ? h('p', { class: 'small' }, r.phone ? secretText('📞 ', r.phone) : null, r.note ? ' • ' + r.note : '') : null, field('Name', name), field('Role', kind), scope.el),
    [approving ? null : { label: 'Remove', cls: 'danger', close: false, fn: (close) => confirmBox('Remove ' + r.name + '?', guard(async () => { await api('DELETE', '/api/admin/referees/' + r.id); close(); await refresh(); }), 'Remove') },
      approving ? null : { label: 'New PIN', cls: 'ghost', fn: async () => { const x = await api('PUT', '/api/admin/referees/' + r.id, { resetPin: true }); await refresh(); showPin(x.name, x.pin); } },
      { label: approving ? 'Approve & get PIN' : 'Save', fn: async () => {
        if (approving) { await api('PUT', '/api/admin/referees/' + r.id, { name: name.value }); const x = await api('POST', '/api/admin/referees/' + r.id + '/approve', { kind: kind.value, ...scope.values() }); await refresh(); showPin(x.name, x.pin); }
        else { await api('PUT', '/api/admin/referees/' + r.id, { name: name.value, kind: kind.value, ...scope.values() }); toast('Saved'); await refresh(); }
      } }].filter(Boolean));
}
function rankPtsModal() {
  const P = rankPts(), L = { win: 'Win', draw: 'Draw', loss: 'Loss', gold: 'Champion bonus', silver: 'Runner-up bonus', bronze: 'Third place bonus' };
  const f = Object.keys(L).map((k) => ({ k, i: inp(P[k], { type: 'number', min: 0, max: 100, inputmode: 'numeric' }) }));
  modal('Ranking points', h('div', {}, h('p', { class: 'muted small' }, 'Points each player gets. Changing them recalculates every ranking, including past seasons.'), f.map((x) => field(L[x.k], x.i))),
    [{ label: 'Save', fn: async () => { await api('POST', '/api/admin/tournament', { rankPts: Object.fromEntries(f.map((x) => [x.k, x.i.value])) }); toast('Points saved'); await refresh(); } }]);
}

async function playerModal(p, defaultSection) {
  let priv = {};
  if (p) { try { priv = await api('GET', '/api/admin/players/' + p.id); } catch (e) { toast(e.message, true); return; } }
  const f = {
    name: inp(p && p.name), section: sel(SECTION_OPTS, p ? p.section : defaultSection || ui.section), ageGroup: inp(p && p.ageGroup, { placeholder: 'e.g. Under-10 (kids)' }),
    gender: sel([['', '—'], ['F', 'Female'], ['M', 'Male']], p ? p.gender : ''), hand: sel([['', '—'], ['R', 'Right-handed'], ['L', 'Left-handed'], ['B', 'Ambidextrous']], priv.hand),
    affiliation: inp(priv.affiliation, { placeholder: 'Department / company / school' }), bio: h('textarea', { rows: 2, maxlength: 300, placeholder: 'A line or two about the player' }, priv.bio || ''),
    achievements: h('textarea', { rows: 3, placeholder: 'One per line, e.g.\n2025 – Carrom runner-up' }, (priv.achievements || []).join('\n')),
    public: h('input', { type: 'checkbox', checked: p ? priv.profilePublic !== false : (defaultSection || ui.section) !== 'kids' }),
    phone: secretInput(priv.phone, { type: 'tel' }), email: secretInput(priv.email, { type: 'email' }, 'email'), emergency: secretInput(priv.emergency, { placeholder: 'Name and phone' }, 'text'), tshirt: inp(priv.tshirt, { placeholder: 'e.g. M' }),
    notes: h('textarea', { rows: 2, placeholder: 'Anything the organisers should remember' }, priv.notes || ''),
    guardianName: inp(priv.guardianName, { placeholder: 'Parent / guardian name (kids)' }), guardianPhone: secretInput(priv.guardianPhone, { type: 'tel', placeholder: 'Parent / guardian phone (kids)' }),
  };
  if (!p) f.section.addEventListener('change', () => { f.public.checked = f.section.value !== 'kids'; });
  const sportRows = ['badminton', 'tt', 'carrom', 'chess'].map((k) => {
    const sp = (priv.sports || {})[k] || {};
    const dl = h('datalist', { id: 'dl-' + k }, STYLE_HINTS[k].map((x) => h('option', { value: x })));
    return { k, level: sel([['', 'Level —'], ['Beginner', 'Beginner'], ['Intermediate', 'Intermediate'], ['Advanced', 'Advanced'], ['Pro', 'Pro']], sp.level), style: inp(sp.style, { list: 'dl-' + k, placeholder: 'Style, e.g. ' + STYLE_HINTS[k][0], maxlength: 60 }), rating: k === 'chess' ? inp(sp.rating, { type: 'number', min: 0, max: 3500, placeholder: 'Rating (optional)' }) : null, dl };
  });
  /* Games this player takes part in (individual events = enrolled; team events = interested list). */
  const gameSet = new Set(p ? S.events.filter((e) => e.participantIds.includes(p.id) || (e.interestedIds || []).includes(p.id)).map((e) => e.id).concat(p.status === 'pending' ? p.requestedEventIds || [] : []) : []);
  const gamesBox = h('div', {});
  const drawGames = () => {
    const evs = S.events.filter((e) => (e.section || 'adults') === f.section.value);
    gamesBox.replaceChildren(...(evs.length ? evs.map((e) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: gameSet.has(e.id), onchange: (ev) => { ev.target.checked ? gameSet.add(e.id) : gameSet.delete(e.id); } }), e.name + (e.sideType === 'team' ? ' (team event – interested list)' : ''))) : [h('p', { class: 'muted small' }, 'No events in this section yet.')]));
  };
  f.section.addEventListener('change', drawGames); drawGames();
  let photo = priv.photo || '';
  const prev = h('div', {}, avatar({ name: (p && p.name) || '?', photo }, 64));
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { if (!e.target.files[0]) return; photo = await uploadImage(e.target.files[0], 400); prev.replaceChildren(avatar({ name: f.name.value || '?', photo }, 64)); }) });
  modal(p ? 'Edit player' : 'Add player', h('div', {},
    p ? h('div', { class: 'muted small' }, 'Player ID ' + (priv.playerNo || '')) : null,
    field('Name', f.name), h('div', { class: 'two' }, field('Section', f.section), field('Age group', f.ageGroup)), h('div', { class: 'two' }, field('Gender (optional)', f.gender), field('Playing hand', f.hand)),
    field('Affiliation', f.affiliation), field('Bio', f.bio),
    h('b', {}, 'Games this player will play'), gamesBox, h('div', { class: 'muted small' }, 'Tick the events to enter this player in. Team events add the player to an interested list; place them in a team under Teams. To drop a player who already has fixtures, use Withdraw / replace on the event.'),
    h('b', {}, 'Sports & playing style'), sportRows.map((r) => h('div', { class: 'sport-edit' }, h('div', { class: 'muted small' }, SPORT_ICON[r.k] + ' ' + SPORT_LABEL[r.k]), h('div', { class: 'two' }, r.level, r.style), r.rating, r.dl)),
    field('Honours & achievements', f.achievements, 'Past titles shown on the profile. Titles won here are added automatically.'),
    h('label', { class: 'chk' }, f.public, 'Show extended profile publicly (bio, style, honours, history)'),
    h('div', { class: 'muted small' }, 'Name, age group, photo (kids’ photos stay hidden unless enabled in Setup) and match statistics are always visible.'),
    h('b', {}, 'Private (admins only)'),
    priv.consentAt ? h('div', { class: 'muted small' }, 'Registered online ' + new Date(priv.registeredAt || priv.consentAt).toLocaleString('en-IN') + ' • consent recorded ' + new Date(priv.consentAt).toLocaleString('en-IN')) : null,
    field('Guardian name', f.guardianName), field('Guardian phone', f.guardianPhone), field('Phone', f.phone), field('Email', f.email), field('Emergency contact', f.emergency), field('T-shirt size', f.tshirt), field('Private notes', f.notes),
    h('p', { class: 'muted small' }, 'Collect contact details only with the player’s (or a guardian’s) consent.'),
    h('div', { class: 'actions' }, prev, file, h('button', { type: 'button', class: 'btn ghost', onclick: () => file.click() }, '📷 Photo'))),
  [
    { label: 'Save', fn: async () => {
      const sports = {}; sportRows.forEach((r) => { sports[r.k] = { level: r.level.value, style: r.style.value, rating: r.rating ? r.rating.value : '' }; });
      const body = { name: f.name.value, section: f.section.value, ageGroup: f.ageGroup.value, gender: f.gender.value, hand: f.hand.value, affiliation: f.affiliation.value, bio: f.bio.value, sports,
        achievements: f.achievements.value.split('\n'), profilePublic: f.public.checked, phone: f.phone.value, email: f.email.value, emergency: f.emergency.value, tshirt: f.tshirt.value, notes: f.notes.value, guardianName: f.guardianName.value, guardianPhone: f.guardianPhone.value, photo };
      const saved = p ? (await api('PUT', '/api/admin/players/' + p.id, body), p) : await api('POST', '/api/admin/players', { ...body, tid: curTid() });
      const g = await api('PUT', '/api/admin/players/' + saved.id + '/games', { eventIds: [...gameSet] });
      if (g.skipped && g.skipped.length) toast('Saved. Not changed: ' + g.skipped.join('; '), true);
      await refresh();
    } }].filter(Boolean));
}

/* -------------------------------------------------------------------- team */
function teamModal(t, defaultSection) {
  const name = inp(t && t.name);
  const section = sel(SECTION_OPTS, t ? t.section : defaultSection || ui.section);
  const wrap = h('div', {});
  let members = checkList([], []);
  const draw = () => { members = checkList(playersIn(section.value, t && t.tid), ((t && t.section === section.value) ? t.memberIds : [])); wrap.replaceChildren(h('b', {}, 'Members'), members); };
  section.addEventListener('change', draw); draw();
  const capBox = t ? h('div', { class: 'card' }, h('b', {}, 'Captain'), h('p', { class: 'muted small' }, 'The captain signs in with a team code to choose and shuffle the line-up for their ties (until a tie starts). They cannot change the team.'),
    (() => { const capSel = sel([['', '— choose captain —']].concat(t.memberIds.map((id) => [id, (byId('players', id) || {}).name || id])), t.captainId || '');
      return h('div', {}, capSel, h('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: guard(async () => { if (!capSel.value) throw new Error('Choose a captain first'); const r = await api('POST', '/api/admin/teams/' + t.id + '/captain-code', { playerId: capSel.value }); await refresh(); modal('Captain code for ' + r.team, h('div', { class: 'center' }, h('div', { class: 'bigpin' }, r.code), h('p', { class: 'muted small' }, 'Share this with the captain privately. It is shown only now; issuing a new code signs the old one out.')), [{ label: 'Done', fn: () => {} }]); }) }, t.hasCode ? 'New captain code' : 'Issue captain code')); })()) : null;
  modal(t ? 'Edit team' : 'Create team', h('div', {}, field('Team name', name), field('Section', section), wrap, capBox),
    [t ? { label: 'Delete', cls: 'danger', close: false, fn: (close) => confirmBox('Delete team ' + t.name + '?', async () => { await api('DELETE', '/api/admin/teams/' + t.id); close(); await refresh(); }, 'Delete') } : null,
      { label: 'Save', fn: async () => {
        const body = { name: name.value, section: section.value, memberIds: members.values(), tid: (t && t.tid) || curTid() };
        if (t) await api('PUT', '/api/admin/teams/' + t.id, body); else await api('POST', '/api/admin/teams', body);
        await refresh();
      } }].filter(Boolean));
}

/* ------------------------------------------------------------------- event */
function eventModal(ev, defaultSection) {
  const c = (ev && ev.config) || { bestOf: 3, target: 15, winBy: 1, cap: 0, increments: [1], pointsWin: 2, pointsDraw: 1, pointsLoss: 0, rankBy: 'matchPoints', finalists: 4 };
  const f = {
    name: inp(ev && ev.name), section: sel(SECTION_OPTS, ev ? ev.section : defaultSection || ui.section),
    sport: sel([['badminton', 'Badminton'], ['tt', 'Table tennis'], ['carrom', 'Carrom'], ['chess', 'Chess'], ['other', 'Other']], ev ? ev.sport : 'badminton'),
    scoring: sel([['points', 'Live points (referee taps +1)'], ['result', 'Result only (win / draw / loss)']], ev ? ev.scoring : 'points'),
    sideType: sel([['player', 'Individual players'], ['team', 'Teams']], ev ? ev.sideType : 'player'),
    sideSize: sel([['1', 'Singles (1 per side)'], ['2', 'Doubles (2 per side)']], ev ? ev.sideSize : 1),
    bestOf: inp(c.bestOf, { type: 'number', min: 1, max: 9 }), target: inp(c.target, { type: 'number', min: 1 }), winBy: inp(c.winBy, { type: 'number', min: 1 }), cap: inp(c.cap, { type: 'number', min: 0 }),
    increments: inp(c.increments.join(','), {}),
    maxBoards: inp(c.maxBoards != null ? c.maxBoards : 8, { type: 'number', min: 0 }), coinWeight: inp(c.coinWeight != null ? c.coinWeight : 1, { type: 'number', min: 0, step: 'any' }), queenWeight: inp(c.queenWeight != null ? c.queenWeight : 3, { type: 'number', min: 0, step: 'any' }), queenCutoff: inp(c.queenCutoff != null ? c.queenCutoff : 22, { type: 'number', min: 0 }),
    pointsWin: inp(c.pointsWin, { type: 'number', step: '0.5' }), pointsDraw: inp(c.pointsDraw, { type: 'number', step: '0.5' }), pointsLoss: inp(c.pointsLoss, { type: 'number', step: '0.5' }),
    rankBy: sel([['matchPoints', 'Match points (win/draw/loss points)'], ['tally', 'Tally (points scored; doubles split between partners)']], c.rankBy),
    finalists: inp(c.finalists, { type: 'number', min: 0 }), smallBelow: inp(c.smallBelow || '', { type: 'number', min: 0, placeholder: 'off' }), finalistsSmall: inp(c.finalistsSmall != null ? c.finalistsSmall : 2, { type: 'number', min: 0 }), note: inp(ev && ev.note),
    h2h: h('input', { type: 'checkbox', checked: !!c.h2hFirst }), walk: inp(c.walkoverPoints == null ? '' : c.walkoverPoints, { type: 'number', min: 0, placeholder: 'default = points per game' }),
    max: inp(ev ? ev.maxParticipants || 0 : 0, { type: 'number', min: 0 }), selfReg: h('input', { type: 'checkbox', checked: ev ? ev.selfRegister !== false : true }),
    ageMin: inp(ev && ev.ageMin ? ev.ageMin : '', { type: 'number', min: 0, max: 99, placeholder: 'from' }), ageMax: inp(ev && ev.ageMax ? ev.ageMax : '', { type: 'number', min: 0, max: 99, placeholder: 'to' }),
  };
  /* ---- tournament format ---- */
  const F0 = (ev && ev.format) || { type: 'roundrobin', groups: 2, qualifiers: 2, thirdPlace: false, swissRounds: 0, autoAdvance: false, doubleRR: false };
  const ff = {
    type: sel([['roundrobin', 'Round robin – everyone plays everyone, then optional finals'], ['groups', 'Groups – round robin inside groups, then a knockout'], ['knockout', 'Knockout – lose and you are out'], ['swiss', 'Swiss – fixed number of rounds, similar scores meet']], F0.type),
    groups: inp(F0.groups, { type: 'number', min: 2, max: 8 }), quals: inp(F0.qualifiers, { type: 'number', min: 1, max: 8 }),
    third: h('input', { type: 'checkbox', checked: !!F0.thirdPlace }), swissR: inp(F0.swissRounds || '', { type: 'number', min: 0, max: 15, placeholder: 'auto' }),
    auto: h('input', { type: 'checkbox', checked: !!F0.autoAdvance }), dbl: h('input', { type: 'checkbox', checked: !!F0.doubleRR }),
  };
  const fmtBox = h('div', { class: 'card' });
  const drawFmt = () => {
    const t = ff.type.value, dbls = Number(f.sideSize.value) === 2;
    fill(fmtBox, h('b', {}, 'Tournament format'),
      dbls ? h('p', { class: 'muted small' }, 'Doubles use rotating partners (random pairs each round, tally ranking) and a final between the top 4.') : [
        field('Format', ff.type),
        t === 'groups' ? h('div', { class: 'two' }, field('Number of groups', ff.groups), field('Qualify per group', ff.quals)) : null,
        t === 'swiss' ? field('Number of rounds', ff.swissR, 'Empty = automatic (enough rounds to find a clear winner).') : null,
        t === 'roundrobin' || t === 'swiss' ? h('p', { class: 'muted small' }, 'Finals: set “Qualify for finals (top N)” below (0 = none). 2 = a final, 4 = semi-finals + final, 8 = quarter-finals…') : null,
        t === 'knockout' ? h('p', { class: 'muted small' }, 'Seeds follow the enrolment order (or tick Random draw when generating). If the number of entries is not a power of 2, the top seeds get byes.') : null,
        t !== 'swiss' && t !== 'knockout' ? h('label', { class: 'chk' }, ff.dbl, 'Groups / league: also play return matches') : null,
        h('label', { class: 'chk' }, ff.third, 'Play a third-place match (needs semi-finals)'),
        h('label', { class: 'chk' }, ff.auto, 'Create the next round / finals automatically when a round finishes')]);
  };
  ff.type.addEventListener('change', drawFmt); f.sideSize.addEventListener('change', drawFmt); drawFmt();
  /* ---- team ties made of rubbers ---- */
  let rub = ((ev && ev.rubbers) || []).map((x) => ({ ...x }));
  const RR0 = (ev && ev.rubberRules) || { clinch: true, maxPerPlayer: 2 };
  const rr = { clinch: h('input', { type: 'checkbox', checked: RR0.clinch !== false }), max: inp(RR0.maxPerPlayer || 2, { type: 'number', min: 1, max: 6 }) };
  const rubBox = h('div', { class: 'card' });
  const drawRub = () => {
    if (f.sideType.value !== 'team') { fill(rubBox); rubBox.hidden = true; return; }
    rubBox.hidden = false;
    fill(rubBox, h('b', {}, 'Team tie structure (rubbers)'),
      h('p', { class: 'muted small' }, 'A tie between two teams is made of several rubbers (sub-matches). The team that wins most rubbers wins the tie. Leave empty to score a tie as one single match. Example: Men’s singles, Women’s singles, Mixed doubles.'),
      rub.map((x, i) => h('div', { class: 'rubrow' },
        inp(x.name, { placeholder: 'Rubber name', oninput: (e) => { x.name = e.target.value; } }),
        sel([['1', 'Singles'], ['2', 'Doubles']], x.size || 1), sel([['', 'Anyone'], ['M', 'Men'], ['F', 'Women']], x.gender || ''),
        inp(x.count || 1, { type: 'number', min: 1, max: 5, title: 'How many of this rubber', oninput: (e) => { x.count = Number(e.target.value) || 1; } }),
        h('button', { type: 'button', class: 'btn danger sm', 'aria-label': 'Remove rubber', onclick: () => { rub.splice(i, 1); drawRub(); } }, '✕'))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { rub.push({ name: '', size: 1, gender: '', count: 1 }); drawRub(); } }, '+ Add rubber')),
      h('label', { class: 'chk' }, rr.clinch, 'End the tie as soon as one team has won most rubbers'), field('Most rubbers one player may play in a tie', rr.max));
    /* selects have no oninput hook above: wire them after the row exists */
    rubBox.querySelectorAll('.rubrow').forEach((row, i) => { const [nm, sz, gd] = row.querySelectorAll('input, select'); sz.onchange = () => { rub[i].size = Number(sz.value); }; gd.onchange = () => { rub[i].gender = gd.value; }; void nm; });
  };
  f.sideType.addEventListener('change', drawRub); drawRub();
  const enrol = h('div', {});
  let boxes = checkList([], []);
  const drawEnrol = () => {
    const team = f.sideType.value === 'team', sec = f.section.value;
    const same = ev && ev.sideType === f.sideType.value && ev.section === sec;
    boxes = checkList(team ? S.teams.filter((x) => (x.section || 'adults') === sec) : playersIn(sec), same ? ev.participantIds : []);
    enrol.replaceChildren(h('b', {}, (team ? 'Teams' : 'Players') + ' in this event (' + SEC[sec] + ' section)'), boxes);
  };
  f.sideType.addEventListener('change', drawEnrol); f.section.addEventListener('change', drawEnrol); drawEnrol();
  const body = h('div', {},
    field('Event name', f.name), field('Section', f.section), field('Sport', f.sport), field('Scoring', f.scoring), field('Who plays', f.sideType), field('Singles / doubles', f.sideSize),
    h('div', { class: 'two' }, field('Best of (games)', f.bestOf), field('Points per game', f.target), field('Win by', f.winBy), field('Hard cap (0 = none)', f.cap)),
    field('Score buttons', f.increments, 'Comma separated, e.g. 1 or 1,2,3 (carrom)'),
    h('div', {}, h('div', { class: 'two' }, field('Carrom: boards per game (0 = none)', f.maxBoards), field('Points per coin left', f.coinWeight)), h('div', { class: 'two' }, field('Queen weight', f.queenWeight), field('Queen bonus lost at', f.queenCutoff, 'Scorer at or above this gets no queen bonus'))),
    h('div', { class: 'two' }, field('Win pts', f.pointsWin), field('Draw pts', f.pointsDraw), field('Loss pts', f.pointsLoss), field('Qualify for finals (top N)', f.finalists)),
    h('div', { class: 'two' }, field('Fewer players than…', f.smallBelow, 'Empty = rule off. Example: 8'), field('…then only top N qualify', f.finalistsSmall, 'Example: 2 = straight to the final')),
    field('Rank table by', f.rankBy, 'Then point difference.'),
    h('label', { class: 'chk' }, f.h2h, 'Settle two-way ties by the head-to-head result first (singles)'),
    field('Walkover: points awarded per game', f.walk, 'Used when a side does not turn up. Empty = the full game target (e.g. 15 or 11) to the winner, 0 to the other side.'),
    h('div', { class: 'two' }, field('Max players (0 = no limit)', f.max), h('label', { class: 'chk' }, f.selfReg, 'Open for online registration')),
    field('Age range (optional, kids events)', h('div', { class: 'two' }, f.ageMin, f.ageMax), 'Players whose age is outside this range cannot be enrolled. Ages are read from the age field, e.g. 9 or Under-10.'),
    fmtBox, rubBox,
    field('Note (shown to everyone)', f.note), enrol);
  modal(ev ? 'Edit event' : 'New event', body, [
    ev ? { label: 'Duplicate', cls: 'ghost', close: false, fn: async (close) => {
      const { id, participantIds, groups, bracket, byes, withdrawn, ...copy } = ev;
      await api('POST', '/api/admin/events', { ...copy, name: ev.name + ' (copy)', participantIds: [] }); toast('Copied – edit the copy to change its age range or players'); close(); await refresh();
    } } : null,
    ev ? { label: 'Clone', cls: 'ghost', close: false, fn: (close) => { const nm = inp(ev.name + ' (copy)'); modal('Clone ' + ev.name, h('div', {}, h('p', { class: 'muted small' }, 'Copies the rules, format and team rubbers. Players and matches are not copied.'), field('New event name', nm)), [{ label: 'Clone', fn: async () => { await api('POST', '/api/admin/events/' + ev.id + '/clone', { name: nm.value }); toast('Event cloned'); close(); await refresh(); } }]); } } : null,
    ev ? { label: 'Delete', cls: 'danger', close: false, fn: (close) => confirmBox('Delete ' + ev.name + ' and all its matches?', async () => { await api('DELETE', '/api/admin/events/' + ev.id); close(); location.hash = '#/'; await refresh(); }, 'Delete') } : null,
    { label: 'Save', fn: async () => {
      const b = {
        name: f.name.value, section: f.section.value, sport: f.sport.value, scoring: f.scoring.value, sideType: f.sideType.value, sideSize: Number(f.sideSize.value), note: f.note.value, participantIds: boxes.values(),
        config: { bestOf: f.bestOf.value, target: f.target.value, winBy: f.winBy.value, cap: f.cap.value, increments: f.increments.value, maxBoards: f.maxBoards.value, coinWeight: f.coinWeight.value, queenWeight: f.queenWeight.value, queenCutoff: f.queenCutoff.value, pointsWin: f.pointsWin.value, pointsDraw: f.pointsDraw.value, pointsLoss: f.pointsLoss.value, rankBy: f.rankBy.value, finalists: f.finalists.value, smallBelow: f.smallBelow.value || 0, finalistsSmall: f.finalistsSmall.value, h2hFirst: f.h2h.checked, walkoverPoints: f.walk.value },
        maxParticipants: f.max.value, selfRegister: f.selfReg.checked, ageMin: f.ageMin.value || 0, ageMax: f.ageMax.value || 0,
        format: { type: ff.type.value, groups: ff.groups.value, qualifiers: ff.quals.value, thirdPlace: ff.third.checked, swissRounds: ff.swissR.value || 0, autoAdvance: ff.auto.checked, doubleRR: ff.dbl.checked },
        rubbers: f.sideType.value === 'team' ? rub.filter((x) => x.name.trim()) : [], rubberRules: { clinch: rr.clinch.checked, maxPerPlayer: rr.max.value },
      };
      if (ev) await api('PUT', '/api/admin/events/' + ev.id, b); else await api('POST', '/api/admin/events', { ...b, tid: curTid() });
      await refresh();
    } }].filter(Boolean));
}

/* ----------------------------------------------------------------- fixture */
function fixtureModal(eventId, match) {
  const evs = S.events;
  if (!evs.length) { toast('Create an event first', true); return; }
  const f = {
    event: h('select', {}, ['adults', 'kids'].map((sec) => h('optgroup', { label: SEC[sec] }, eventsOf(sec).map((e) => h('option', { value: e.id, selected: ((match && match.eventId) || eventId || evs[0].id) === e.id }, e.name))))),
    stage: sel([['League', 'League (counts in standings)'], ['Quarter-final', 'Quarter-final'], ['Semi-final', 'Semi-final'], ['Final', 'Final'], ['Third place', 'Third-place match'], ['Play-off', 'Play-off (tie-break, not in standings)']], match ? match.stage : 'League'),
    court: inp(match && match.court, { placeholder: 'e.g. Court 1 / Table 2' }), startsAt: inp(match && match.startsAt, { type: 'datetime-local' }),
    ref: h('div', {}),
    round: inp(match && match.round || '', { type: 'number', min: 0, max: 99, placeholder: 'e.g. 3' }), total: inp(match && match.totalRounds || '', { type: 'number', min: 0, max: 99, placeholder: 'e.g. 7' }),
    cBest: inp(match && match.cfg && match.cfg.bestOf || '', { type: 'number', min: 1, max: 9, placeholder: 'event default' }), cTarget: inp(match && match.cfg && match.cfg.target || '', { type: 'number', min: 1, placeholder: 'event default' }),
    cWin: inp(match && match.cfg && match.cfg.winBy || '', { type: 'number', min: 1, placeholder: 'event default' }), cCap: inp(match && match.cfg && match.cfg.cap || '', { type: 'number', min: 0, placeholder: 'event default' }),
  };
  if (match) f.event.disabled = true;
  const sides = h('div', {});
  let A = [], B = [], LA, LB;
  const drawSides = () => {
    const ev = byId('events', f.event.value);
    const col = ev.sideType === 'team' ? S.teams : S.players;
    const sameSec = col.filter((x) => (x.section || 'adults') === secOf(ev)).map((x) => x.id);
    const pool = (ev.participantIds.length ? ev.participantIds : sameSec.filter((id) => ev.sideType === 'team' || (curT().playerIds || []).includes(id))).map((id) => [id, nameOf(ev, id)]);
    const lineup = (selects, prevIds) => {
      if (ev.sideType !== 'team') return null;
      const box = h('div', {});
      const draw = () => {
        const members = selects.flatMap((s) => (byId('teams', s.value) || { memberIds: [] }).memberIds).map((id) => byId('players', id)).filter(Boolean);
        box.list = checkList(members, prevIds);
        box.replaceChildren(h('div', { class: 'muted small' }, 'Players who played (optional – leave empty to count the whole team)'), box.list);
      };
      selects.forEach((s) => s.addEventListener('change', draw)); draw();
      box.values = () => (box.list ? box.list.values() : []);
      return box;
    };
    const mk = (arr, side, prevIds) => Array.from({ length: ev.sideSize }, (_, i) => { const s = sel([['', '— choose —']].concat(pool), prevIds[i] || ''); arr[i] = s; return field(side + (ev.sideSize > 1 ? ' – ' + (ev.sideType === 'team' ? 'team ' : 'player ') + (i + 1) : ''), s); });
    A = []; B = [];
    const keep = match && match.eventId === ev.id;
    const fa = mk(A, 'Side A', keep ? match.sideA : []); LA = lineup(A, keep ? match.lineupA || [] : []);
    const fb = mk(B, 'Side B', keep ? match.sideB : []); LB = lineup(B, keep ? match.lineupB || [] : []);
    [...A, ...B].forEach((x) => x.addEventListener('change', drawRefs));
    sides.replaceChildren(...[...fa, LA, h('div', { class: 'center muted' }, 'vs'), ...fb, LB,
      ev.participantIds.length ? null : h('p', { class: 'muted small' }, 'Tip: enrol players in the event (Edit event) to shorten this list. Only ' + SEC[secOf(ev)] + ' section players are listed.')].filter(Boolean));
  };
  /* Referees: only people who are not playing in this match (themselves or through their team). Team matches may have several. */
  let refList = checkList([], []), refTouched = false;
  const drawRefs = () => {
    const ev = byId('events', f.event.value); if (!ev) return;
    const ids = [...A, ...B].map((x) => x.value).filter(Boolean);
    const playing = new Set(ids.flatMap((id) => [id, ...((byId('teams', id) || {}).memberIds || [])]));
    const chosen = refTouched ? refList.values() : match && match.eventId === ev.id ? match.refereeIds || [] : ev.refereeIds || [];
    const free = S.referees.filter((r) => r.status !== 'pending' && r.kind !== 'volunteer' && refFor(r, ev) && !(r.playerId && playing.has(r.playerId)));
    const blocked = S.referees.filter((r) => r.playerId && playing.has(r.playerId) && refFor(r, ev)), unmapped = S.referees.filter((r) => r.status !== 'pending' && r.kind !== 'volunteer' && !refFor(r, ev));
    refList = checkList(free.map((r) => ({ id: r.id, name: r.name + (r.kind === 'chief' ? ' (chief)' : '') })), chosen.filter((id) => free.some((r) => r.id === id)));
    refList.addEventListener('change', () => { refTouched = true; });
    f.ref.replaceChildren(...[refList, blocked.length ? h('div', { class: 'muted small' }, 'Not offered because they play in this match: ' + blocked.map((r) => r.name).join(', ')) : null,
      unmapped.length ? h('div', { class: 'muted small' }, 'Not mapped to ' + (SPORT_LABEL[ev.sport] || 'this sport') + ': ' + unmapped.map((r) => r.name).join(', ')) : null,
      ev.sideType === 'team' ? h('div', { class: 'muted small' }, 'Team matches can have several referees.') : null].filter(Boolean));
  };
  f.event.addEventListener('change', () => { refTouched = false; drawSides(); drawRefs(); }); drawSides(); drawRefs();
  modal(match ? 'Edit fixture' : 'New fixture', h('div', {}, field('Event', f.event), field('Stage', f.stage), sides,
    h('div', { class: 'two' }, field('Court / table', f.court), field('Start time', f.startsAt)), field('Referees', f.ref),
    h('div', { class: 'two' }, field('Round', f.round), field('Total rounds', f.total, 'Shown as “Round x of y”')),
    h('details', {}, h('summary', {}, 'Points for this match only (optional)'), h('div', { class: 'two' }, field('Best of', f.cBest), field('Points per game', f.cTarget)), h('div', { class: 'two' }, field('Win by', f.cWin), field('Hard cap', f.cCap)), h('p', { class: 'muted small' }, 'Leave empty to use the event’s settings. Carrom weights can be set per match from Edit event.'))),
  [{ label: 'Save', fn: async () => {
    const b = { eventId: f.event.value, stage: f.stage.value, court: f.court.value, startsAt: f.startsAt.value, refereeIds: refList.values(), round: f.round.value || 0, totalRounds: f.total.value || 0, cfg: { bestOf: f.cBest.value, target: f.cTarget.value, winBy: f.cWin.value, cap: f.cCap.value }, sideA: A.map((s) => s.value), sideB: B.map((s) => s.value), lineupA: LA ? LA.values() : [], lineupB: LB ? LB.values() : [] };
    if (b.sideA.includes('') || b.sideB.includes('')) throw new Error('Choose everyone for both sides');
    const submit = (force) => (match ? api('PUT', '/api/admin/matches/' + match.id, { ...b, force }) : api('POST', '/api/admin/matches', { ...b, force }));
    try {
      const r = await submit(false); await refresh(); if (!match) location.hash = '#/match/' + r.id;
    } catch (e) {
      if (e.data && e.data.clash) {
        confirmBox(e.message + '\n\nSave anyway?', guard(async () => { const r = await submit(true); await refresh(); if (!match) location.hash = '#/match/' + r.id; modalCloseAll(); }), 'Save anyway');
        return false;
      }
      throw e;
    }
  } }]);
}
const modalCloseAll = () => document.querySelectorAll('.modal').forEach((m) => m.remove());

/* ---------------------------------------------------- withdraw / replace */
function participantModal(ev) {
  const inEvent = (ev.participantIds || []).filter((id) => !(ev.withdrawn || []).includes(id)).map((id) => [id, nameOf(ev, id)]);
  if (!inEvent.length) { toast('Nobody is enrolled in this event', true); return; }
  const who = sel(inEvent, inEvent[0][0]);
  const col = ev.sideType === 'team' ? S.teams : S.players;
  const spare = col.filter((x) => (x.section || 'adults') === secOf(ev) && !ev.participantIds.includes(x.id) && x.status !== 'pending').map((x) => [x.id, x.name]);
  const repl = sel([['', '— choose replacement —']].concat(spare), '');
  modal('Withdraw or replace', h('div', {}, field('Who?', who),
    h('div', { class: 'card' }, h('b', {}, 'Withdraw'), h('p', { class: 'muted small' }, 'All their unplayed matches are awarded to the opponents as walkovers. Played matches stay as they are.'),
      h('button', { class: 'btn danger', onclick: () => confirmBox('Withdraw ' + nameOf(ev, who.value) + ' and award their unplayed matches to the opponents?', guard(async () => { const r = await api('POST', '/api/admin/events/' + ev.id + '/withdraw', { participantId: who.value }); toast(r.awarded + ' match(es) awarded'); modalCloseAll(); await refresh(); }), 'Withdraw') }, 'Withdraw')),
    h('div', { class: 'card' }, h('b', {}, 'Replace with someone else'), h('p', { class: 'muted small' }, 'Swaps the new player into all unplayed matches. Played matches keep the original player.'), repl,
      h('button', { class: 'btn', onclick: guard(async () => { if (!repl.value) throw new Error('Choose a replacement'); const r = await api('POST', '/api/admin/events/' + ev.id + '/replace', { oldId: who.value, newId: repl.value }); toast(r.updated + ' match(es) updated'); modalCloseAll(); await refresh(); }) }, 'Replace'))), null);
}

/* --------------------------------------------------- generate fixtures/finals */
function generateModal(ev) {
  const n = (ev.participantIds || []).length - (ev.withdrawn || []).length;
  const doubles = ev.sideSize === 2, fmt = ev.format || { type: 'roundrobin' }, type = doubles ? 'doubles' : fmt.type;
  const league = S.matches.filter((m) => m.eventId === ev.id && (m.stage || 'League') === 'League');
  const f = {
    rounds: inp(3, { type: 'number', min: 1, max: 20 }), double: h('input', { type: 'checkbox' }),
    random: h('input', { type: 'checkbox' }), courts: inp('', { placeholder: 'Court 1, Court 2' }), start: inp('', { type: 'datetime-local' }), slot: inp(25, { type: 'number', min: 5 }),
  };
  const swissTotal = fmt.swissRounds || Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
  const swissNo = Math.max(0, ...league.map((m) => m.round || 0)) + 1;
  const info = {
    doubles: h('p', { class: 'muted small' }, n + ' players enrolled. Each round re-pairs players randomly into doubles teams, avoiding repeat partners and opponents where possible. ' + (n % 4 ? 'Players left over in a round rest and play first next round.' : '')),
    roundrobin: h('p', { class: 'muted small' }, n + ' enrolled → ' + (n * (n - 1)) / 2 + ' round-robin matches. Already-created pairings are skipped.'),
    groups: h('p', { class: 'muted small' }, ev.groups && Object.keys(ev.groups).length ? 'Groups are already drawn (' + Object.keys(ev.groups).join(', ') + '). Use “Reset draw” on the event page to draw again.' : n + ' enrolled → ' + fmt.groups + ' groups (snake-seeded in the enrolment order, or random). Every group plays a round robin; the top ' + fmt.qualifiers + ' of each group go to the knockout.'),
    knockout: h('p', { class: 'muted small' }, ev.bracket ? 'The bracket is already drawn. Use “Reset draw” on the event page to draw again.' : n + ' entries → first round ' + E.stageName(Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, n))))) + (2 ** Math.ceil(Math.log2(Math.max(2, n))) !== n ? ' with byes for the top seeds' : '') + '. Later rounds are created with “Next round” (or automatically if you switched that on).'),
    swiss: h('p', { class: 'muted small' }, 'Round ' + swissNo + ' of ' + swissTotal + '. Players on similar scores meet, nobody plays the same opponent twice' + (n % 2 ? ', and the lowest-placed player who has not had one gets a bye (counts as a win)' : '') + '. Finish every match of the current round first.'),
  }[type];
  const opts = { doubles: [field('Number of rounds', f.rounds)], roundrobin: [h('label', { class: 'chk' }, f.double, 'Also create return matches (home & away)'), h('label', { class: 'chk' }, f.random, 'Random draw (otherwise the enrolment order is the seeding)')],
    groups: [h('label', { class: 'chk' }, f.random, 'Random draw (otherwise groups follow the enrolment order)')], knockout: [h('label', { class: 'chk' }, f.random, 'Random draw (otherwise seeds follow the enrolment order)')], swiss: [] }[type];
  const title = { doubles: 'Generate fixtures', roundrobin: 'Generate fixtures', groups: 'Draw groups', knockout: 'Draw knockout bracket', swiss: 'Swiss round ' + swissNo }[type];
  modal(title, h('div', {}, info, opts,
    field('Courts / tables (comma separated, optional)', f.courts), field('First match starts (optional)', f.start), field('Minutes per match slot', f.slot),
    h('p', { class: 'muted small' }, 'Fixtures can be edited or deleted individually afterwards.')),
  [{ label: 'Generate', fn: async () => {
    const mode = type === 'roundrobin' ? 'roundrobin' : type;
    const r = await api('POST', '/api/admin/events/' + ev.id + '/generate', { mode, rounds: f.rounds.value, double: f.double.checked, random: f.random.checked, courts: f.courts.value, start: f.start.value, slotMinutes: f.slot.value });
    toast(r.created + ' matches created' + (r.bye ? ' • 1 bye' : '') + (r.rematch ? ' • a repeat pairing was unavoidable' : '')); await refresh();
    ui.eventTab[ev.id] = type === 'knockout' ? 'bracket' : 'fixtures'; render();
  } }]);
}

async function finalsFlow(ev) {
  const go = async (force) => { const r = await api('POST', '/api/admin/events/' + ev.id + '/finals', { force }); toast(r.created + ' ' + r.stage + ' fixture(s) created'); ui.eventTab[ev.id] = ev.bracket || (ev.format || {}).type === 'groups' || ev.config.finalists > 2 ? 'bracket' : 'fixtures'; await refresh(); };
  try { await go(false); }
  catch (e) {
    if (e.data && e.data.needForce) confirmBox(e.message + ' Create the next stage from the current standings anyway?', guard(() => go(true)), 'Create anyway');
    else toast(e.message, true);
  }
}

function resetDrawFlow(ev) {
  const go = (force) => api('POST', '/api/admin/events/' + ev.id + '/reset-draw', { force }).then(async (r) => { toast(r.removed + ' fixtures removed'); await refresh(); });
  const n = S.matches.filter((m) => m.eventId === ev.id).length;
  confirmBox('Delete all ' + n + ' fixture' + (n === 1 ? '' : 's') + ' of ' + ev.name + ' (and its groups / bracket)? They go to Admin → Trash, where you can restore them for 30 days.', guard(async () => {
    try { await go(false); } catch (e) { if (e.data && e.data.needForce) confirmBox(e.message + ' Delete them anyway? (They can still be restored from Trash.)', guard(() => go(true)), 'Delete all'); else throw e; }
  }), 'Delete all');
}

function scoresModal(m, ev, d, rid) {
  const rub = rid ? (m.rubbers || []).find((r) => r.id === rid) : null;
  const rd = rub ? d.rubbers.find((x) => x.id === rid) : d, rEv = rub ? E.rubberEvent(ev, rub) : ev;
  const rows = Array.from({ length: rEv.config.bestOf }, (_, i) => ({ a: inp(rd.games[i] ? rd.games[i].a : '', { type: 'number', min: 0, inputmode: 'numeric', 'aria-label': 'Game ' + (i + 1) + ' side A' }), b: inp(rd.games[i] ? rd.games[i].b : '', { type: 'number', min: 0, inputmode: 'numeric', 'aria-label': 'Game ' + (i + 1) + ' side B' }) }));
  modal('Correct scores' + (rub ? ': ' + rub.name : ''), h('div', {},
    h('p', { class: 'muted small' }, 'Enter the final score of each completed game. This replaces all scores for ' + (rub ? 'this rubber' : 'the match') + '. Leave unused games empty.'),
    h('div', { class: 'two' }, h('b', {}, rub ? rubPlayers(rub, 'A') : sideLabel(ev, m.sideA)), h('b', {}, rub ? rubPlayers(rub, 'B') : sideLabel(ev, m.sideB))),
    rows.map((r, i) => h('div', { class: 'two' }, field('Game ' + (i + 1), r.a), field(' ', r.b)))),
  [{ label: 'Save scores', fn: async () => { await api('POST', '/api/admin/matches/' + m.id + '/scores', { rid, games: rows.map((r) => ({ a: r.a.value, b: r.b.value })) }); toast('Scores corrected'); await refresh(); } }]);
}

/* ------------------------------------------------------------------- admin */
Views.admin = () => {
  if (!isAdmin()) return h('div', {}, h('p', { class: 'empty' }, 'Admins only.'), h('a', { class: 'btn', href: '#/login' }, 'Sign in'));
  const R = S.registration || {};
  const tabs = [['setup', 'Setup'], ['registration', 'Registration' + (R.pending ? ' (' + R.pending + ')' : '')], ['broadcast', 'Announce'], ['safety', 'Event day'], ['reach', 'Reachability'], ['players', 'Players'], ...(isOrganizer() ? [['people', 'People & roles']] : []), ['sponsors', 'Sponsors'], ['disputes', 'Reports' + (S.openDisputes ? ' (' + S.openDisputes + ')' : '')], ['trash', 'Trash'], ['data', 'Data']];
  const t = tabs.some(([k]) => k === ui.adminTab) ? ui.adminTab : 'setup';
  return h('div', {}, h('h1', {}, 'Admin'), h('a', { class: 'card tip', href: '#/season' }, '🏆 Games, teams, organizers and referees are set up under ', h('b', {}, 'Event'), ' – pick the event at the top of that page ›'), h('div', { class: 'seg scroll' }, tabs.map(([k, l]) => h('button', { class: t === k ? 'on' : '', onclick: () => { ui.adminTab = k; render(); } }, l))), adminTabs[t]());
};

function rolesModal(x, done) {
  const admin = h('input', { type: 'checkbox', checked: x.admin }), ref = sel([['', 'Not a referee'], ['referee', 'Referee – scores matches'], ['chief', 'Chief referee – also corrects scores'], ['volunteer', 'Volunteer – check-in only']], x.referee || '');
  const sports = sportChecks(x.refSports || []), sBox = h('div', { hidden: !ref.value }, h('div', { class: 'muted small' }, 'Sports they referee – they are only offered for games of these sports (chief referees cover all):'), sports);
  ref.addEventListener('change', () => { sBox.hidden = !ref.value; });
  modal('Roles – ' + x.name, h('div', {}, h('label', { class: 'chk' }, admin, '🛡 Main admin – manages everything, including people and roles'), field('Referee', ref, 'A referee never referees a match they or their team play in.'), sBox,
    h('p', { class: 'muted small' }, 'Organizers are set per event (Event → Organizers). Team captains are set on the team.')),
  [{ label: 'Save', fn: async () => { const r = await api('POST', '/api/admin/people/' + x.id + '/roles', { admin: admin.checked, referee: ref.value, ...(ref.value ? { sports: sports.values() } : {}) }); if (r.pin) showPin(r.name, r.pin); else toast('Roles saved'); done(); await refresh(); } }]);
}
function pinsList(pins) {
  if (!pins.length) return toast('Everyone already has a PIN');
  const csv = 'Name,PIN\n' + pins.map((x) => '"' + x.name.replace(/"/g, '""') + '",' + x.pin).join('\n');
  modal(pins.length + ' new PINs – shown only once', h('div', {}, h('p', { class: 'small' }, 'Share each PIN privately with that person (e.g. WhatsApp). Download the list now – it is not shown again.'),
    h('div', { class: 'list' }, pins.map((x) => h('div', { class: 'row' }, h('b', { class: 'grow' }, x.name), h('code', {}, x.pin))))),
  [{ label: '⬇ Download list', cls: 'ghost', close: false, fn: () => { const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'pins-' + curT().name.replace(/\W+/g, '-') + '.csv' }); document.body.append(a); a.click(); a.remove(); } }, { label: 'Done', fn: () => {} }]);
}
const showPin = (name, pin) => modal('PIN for ' + name, h('div', { class: 'center' }, h('p', {}, 'Give this PIN to ', h('b', {}, name), '. It is shown only once.'), h('div', { class: 'bigpin' }, pin)), [{ label: 'Done', fn: () => {} }]);
const groupBySection = (items, render1) => ['adults', 'kids'].map((sec) => { const list = items.filter((x) => (x.section || 'adults') === sec); return list.length ? h('div', {}, h('h2', {}, (sec === 'kids' ? '🧒 ' : '🧑 ') + SEC[sec] + ' (' + list.length + ')'), h('div', { class: 'list' }, list.map(render1))) : null; });

function linkCard() {
  const url = BASE() + '/', temp = /trycloudflare\.com$/i.test(location.hostname), local = isPrivateHost();
  return h('div', { class: 'card' }, h('b', {}, '🔗 Link everyone uses'), h('div', { class: 'wrap muted small' }, url),
    temp ? h('div', { class: 'warnbox small' }, 'This is a temporary link. It changes every time the Mac restarts or loses its connection, which breaks printed QR codes, WhatsApp messages and registration links. Share it only once you are sure it will not restart – or move to a permanent address (see the hosting guide in the app folder: deploy/DEPLOY.md).')
      : local ? h('div', { class: 'warnbox small' }, 'This address only works on the same Wi-Fi. Use the public link for people on other networks.') : h('div', { class: 'tip small' }, 'This looks like a permanent address.'),
    h('div', { class: 'actions' }, copyBtn(url, 'Copy link'), h('a', { class: 'btn ghost', href: 'https://wa.me/?text=' + encodeURIComponent(S.tournament.name + ': ' + url), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp')));
}

function shiftCard() {
  const d = new Date(); d.setSeconds(0, 0);
  const mins = inp(15, { type: 'number', min: -600, max: 600 }), from = inp(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16), { type: 'datetime-local' });
  const evs = sel([['', 'All events']].concat(S.events.map((e) => [e.id, e.name])), ''), court = inp('', { placeholder: 'All courts / tables' });
  return h('div', { class: 'card' }, h('b', {}, '⏱ Running late?'),
    h('p', { class: 'muted small' }, 'Moves every unfinished match that starts at or after the chosen time. “Starting soon” alerts are sent again for the new times.'),
    h('div', { class: 'two' }, field('Shift by (minutes)', mins, 'Negative = earlier'), field('From', from)), field('Only this event', evs), field('Only this court / table', court),
    h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/admin/shift', { minutes: mins.value, from: from.value, eventId: evs.value, court: court.value }); toast(r.moved + ' match(es) moved'); await refresh(); }) }, 'Shift schedule'));
}

const adminTabs = {
  setup() {
    const T = S.tournament;
    const f = { season: inp(T.seasonName || '', { placeholder: 'e.g. CSSL - Season 3' }), name: inp(T.name), tagline: inp(T.tagline), dates: inp(T.dates, { placeholder: 'e.g. 29–30 Nov 2026' }), venue: inp(T.venue), primary: inp(T.primary, { type: 'color' }), tz: inp(T.tz || 'Asia/Kolkata'), sponsorSecs: inp(T.sponsorSeconds || 8, { type: 'number', min: 3, max: 60 }), kidsPhotos: h('input', { type: 'checkbox', checked: !!T.showKidsPhotos }), enforceRef: h('input', { type: 'checkbox', checked: !!T.enforceReferee }) };
    let logo = T.logo;
    const prev = h('div', {}, logo ? h('img', { src: logo, class: 'logo big' }) : h('span', { class: 'logo ph big' }, '🏆'));
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { if (!e.target.files[0]) return; logo = await uploadImage(e.target.files[0], 400, 'image/png'); prev.replaceChildren(h('img', { src: logo, class: 'logo big' })); }) });
    const signers = (T.signers || []).slice(0, 2).map((sg) => ({ sg, name: inp(sg.name, { placeholder: 'Name' }), title: inp(sg.title, { placeholder: 'Title, e.g. Organizer' }), image: sg.image || '', note: h('span', { class: 'muted small' }, sg.image ? 'Signature added ✓' : '') }));
    const sigRows = signers.map((x, i) => {
      const fl = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { if (!e.target.files[0]) return; x.image = await uploadImage(e.target.files[0], 500, 'image/png'); x.note.textContent = 'Signature added ✓'; }) });
      return h('div', { class: 'card' }, h('b', {}, 'Certificate signatory ' + (i + 1)), x.name, x.title, h('div', { class: 'actions' }, fl, h('button', { class: 'btn ghost sm', onclick: () => fl.click() }, 'Upload signature image'), x.note));
    });
    const pin = inp('', { type: 'password', inputmode: 'numeric', placeholder: 'New PIN (6–10 digits)', autocomplete: 'new-password' });
    return h('div', {}, linkCard(),
      h('div', { class: 'card' }, field('Original season name', f.season, 'Only used for data from before events existed. Events are created, run side by side and closed under 🏆 Event.'), field('Tournament name', f.name), field('Tagline', f.tagline), field('Dates', f.dates), field('Venue', f.venue), field('Brand colour', f.primary), field('Venue time zone', f.tz, 'Used for “starting soon” alerts and the registration deadline. India: Asia/Kolkata'), field('Sponsor rotation (seconds)', f.sponsorSecs),
        h('div', { class: 'actions' }, prev, file, h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Upload logo')),
        h('label', { class: 'chk' }, f.kidsPhotos, 'Show kids’ photos publicly (off = initials only)'),
        h('label', { class: 'chk' }, f.enforceRef, 'Referees can only score matches assigned to them (matches with no referee stay open to everyone)')),
      sigRows,
      h('button', { class: 'btn full', onclick: guard(async () => { await api('POST', '/api/admin/tournament', { seasonName: f.season.value, name: f.name.value, tagline: f.tagline.value, dates: f.dates.value, venue: f.venue.value, primary: f.primary.value, logo, tz: f.tz.value, sponsorSeconds: f.sponsorSecs.value, showKidsPhotos: f.kidsPhotos.checked, enforceReferee: f.enforceRef.checked, signers: signers.map((x) => ({ name: x.name.value, title: x.title.value, image: x.image })) }); toast('Saved'); await refresh(); }) }, 'Save'),
      h('div', { class: 'card' }, h('b', {}, 'Change my admin PIN'), h('p', { class: 'muted small' }, 'Only your other sessions are signed out. Forgot it? Another admin can reset it, or run ./start.command --reset-pin on the Mac.'), pin,
        h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/admin/pin', { pin: pin.value }); pin.value = ''; toast('PIN changed'); }) }, 'Change PIN')),
      isOrganizer() ? h('a', { class: 'btn ghost', href: '#/season/organizers' }, '👔 Organizers & sign-out of lost phones ›') : null);
  },
  players() {
    const played = ui.pickP ? playedSet() : new Set(), roles = new Set([...(SA.referees || []).map((r) => r.playerId), ...(SA.organizers || []).map((a) => a.playerId)].filter(Boolean));
    const canDel = (p) => !played.has(p.id) && !roles.has(p.id);
    return h('div', {},
      h('a', { class: 'card tip', href: '#/season/players' }, '➕ To add players, upload a player list or enrol someone, open ', h('b', {}, '🏆 Event → Players'), ' for ' + curT().name + '. Every player who joins an event stays in this database for good.'),
      isOrganizer() && S.players.length ? (() => {
        return h('div', {}, ui.pickP ? h('p', { class: 'muted small' }, 'Only players who never played a match and hold no role can be deleted (duplicates, test entries). Anyone with results stays for good. Deleted profiles go to Trash for 30 days.') : null,
          playerSelBar(S.players, '🗑 Delete profiles', (sel) => confirmBox('Delete ' + sel.length + ' player profile' + (sel.length === 1 ? '' : 's') + '? They are removed from every event and go to Admin → Trash for 30 days.', guard(async () => {
            const r = await api('POST', '/api/admin/players/bulk-delete', { ids: sel }); ui.pickP = null; await refresh();
            if (r.kept.length) modal(r.removed + ' deleted, ' + r.kept.length + ' kept', h('div', {}, h('p', { class: 'small' }, 'These profiles are permanent:'), h('ul', {}, r.kept.map((x) => h('li', {}, x)))), [{ label: 'OK', fn: () => {} }]); else toast(r.removed + ' deleted – restore from Trash'); }), 'Delete'),
            canDel)); })() : null,
      groupBySection(S.players, (p) => h('div', { class: 'row', onclick: () => (ui.pickP ? null : playerModal(p)) }, ui.pickP ? (canDel(p) ? pickBox(p, true) : h('span', { class: 'chip plain', title: played.has(p.id) ? 'Has played – permanent' : 'Has an admin / referee role' }, played.has(p.id) ? '🏅' : '🛡')) : null, avatar(p, 32), h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'muted small' }, [p.ageGroup, realTours().filter((t) => (t.playerIds || []).includes(p.id)).map((t) => t.name).join(', ')].filter(Boolean).join(' • '))), h('span', { class: 'muted' }, 'Edit'))),
      !S.players.length ? h('p', { class: 'empty' }, 'No players yet.') : null);
  },
  people() {
    if (!isOrganizer()) return h('p', { class: 'empty' }, 'Only a main admin manages people and roles.');
    const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
    let q = '';
    const KL = { referee: 'Referee', chief: 'Chief referee', volunteer: 'Volunteer' };
    const load2 = () => api('GET', '/api/admin/people').then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
    const draw = (d) => {
      const list = h('div', { class: 'list' });
      const rows = () => list.replaceChildren(...d.people.filter((x) => x.name.toLowerCase().includes(q)).sort((a, b) => (b.admin + b.organizer + !!b.referee) - (a.admin + a.organizer + !!a.referee) || a.name.localeCompare(b.name)).slice(0, 300).map((x) =>
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, x.name),
          h('div', { class: 'chips' }, [x.admin ? '🛡 Admin' : '', x.organizer ? '👔 Organizer' : '', x.referee ? '🧑‍⚖️ ' + KL[x.referee] : '', x.captain ? '🧢 Captain' : '', x.hasPin ? '🔑 has PIN' : 'no PIN yet'].filter(Boolean).map((c) => h('span', { class: 'chip plain' }, c)))),
          h('button', { class: 'btn ghost sm', onclick: () => rolesModal(x, load2) }, 'Roles'),
          h('button', { class: 'btn ghost sm', onclick: () => confirmBox((x.hasPin ? 'Replace ' : 'Make ') + x.name + '’s PIN? ' + (x.hasPin ? 'The old one stops working.' : ''), guard(async () => { const r = await api('POST', '/api/admin/people/' + x.id + '/pin'); showPin(r.name, r.pin); load2(); }), x.hasPin ? 'New PIN' : 'Make PIN') }, x.hasPin ? 'New PIN' : 'Make PIN'))));
      rows();
      const missing = d.people.filter((x) => !x.hasPin).length;
      box.replaceChildren(
        h('div', { class: 'card' }, h('b', {}, '🔑 One PIN per person'), h('p', { class: 'muted small' }, 'Everyone signs in with just their PIN. Give roles here once – the same PIN then works for playing, refereeing (never in a match they or their team play), organizing and admin. People can change their PIN in My profile.'),
          missing ? h('button', { class: 'btn', onclick: () => confirmBox('Make PINs for the ' + missing + ' people in ' + curT().name + ' who do not have one?', guard(async () => { const r = await api('POST', '/api/admin/people/pins', { tid: curTid() }); pinsList(r.pins); load2(); }), 'Make PINs') }, '🔑 Make PINs for everyone in ' + curT().name + ' without one') : h('p', { class: 'small' }, 'Everyone has a PIN.')),
        d.unlinked.length ? h('div', { class: 'card warnbox' }, h('b', {}, 'Older sign-ins not linked to a player'), h('p', { class: 'small' }, 'Link each to the right person so they use one PIN. Their old PIN keeps working until they change it.'),
          d.unlinked.map((u) => { const s2 = sel([['', '— choose the player —']].concat(d.people.map((x) => [x.id, x.name])), ''); return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, u.name), h('span', { class: 'muted small' }, ' (' + (u.type === 'admin' ? 'admin / organizer' : 'referee') + ')')), s2, h('button', { class: 'btn ghost sm', onclick: guard(async () => { if (!s2.value) throw new Error('Choose a player'); await api('POST', '/api/admin/people/link', { type: u.type, id: u.id, playerId: s2.value }); toast('Linked'); load2(); await refresh(); }) }, 'Link')); })) : null,
        h('input', { class: 'search', type: 'search', placeholder: 'Search people…', 'aria-label': 'Search people', oninput: (e) => { q = e.target.value.toLowerCase(); rows(); } }), list);
    };
    load2(); return box;
  },
  sponsors() {
    const name = inp('', { placeholder: 'Sponsor name', 'aria-label': 'Sponsor name' }), url = inp('', { placeholder: 'Website (optional)', 'aria-label': 'Website' });
    let image = '';
    const status = h('span', { class: 'muted small' });
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { if (!e.target.files[0]) return; image = await uploadImage(e.target.files[0], 800, 'image/png'); status.textContent = 'Banner uploaded ✓'; }) });
    return h('div', {}, h('div', { class: 'card' }, name, url, h('div', { class: 'actions' }, file, h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Upload banner/logo'), status),
      h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/admin/sponsors', { name: name.value, url: url.value, image }); await refresh(); }) }, 'Add sponsor')),
      h('div', { class: 'list' }, S.sponsors.map((s) => h('div', { class: 'row' }, s.image ? h('img', { src: s.image, class: 'sp-thumb', alt: '' }) : null, h('b', { class: 'grow' }, s.name || 'Sponsor'), h('button', { class: 'btn danger sm', 'aria-label': 'Remove sponsor', onclick: guard(async () => { await api('DELETE', '/api/admin/sponsors/' + s.id); await refresh(); }) }, '✕')))));
  },
  data() {
    const file = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: (e) => {
      const f = e.target.files[0]; if (!f) return;
      confirmBox('Replace ALL tournament data with this backup? A safety copy is kept on the server.', guard(async () => { await api('POST', '/api/admin/restore', await f.text(), 'application/json'); toast('Restored'); await refresh(); }), 'Restore');
    } });
    const dl = async (url, name) => { const r = await fetch(url, { headers: { 'x-token': me.token } }); if (!r.ok) throw new Error('Download failed'); const b = await r.blob(); const a = h('a', { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); };
    const newT = () => {
      const cur = S.tournament.seasonName || '', next = /\d+\s*$/.test(cur) ? cur.replace(/(\d+)\s*$/, (x) => String(Number(x) + 1)) : '';
      const o = { players: h('input', { type: 'checkbox', checked: true }), games: h('input', { type: 'checkbox', checked: true }), refs: h('input', { type: 'checkbox', checked: true }), sp: h('input', { type: 'checkbox', checked: true }), season: inp(next, { placeholder: 'Next season name' }), confirm: inp('', { placeholder: 'Type NEW to confirm' }) };
      modal('Start the next season', h('div', {}, h('p', {}, h('b', {}, cur), ' is closed and kept under Seasons (champions and every player’s results, for all-time rankings). An archive file is also saved on the server. Then matches, entries, teams and gallery are cleared.'),
        field('Next season', o.season),
        h('label', { class: 'chk' }, o.players, 'Keep players (profiles and all-time rankings carry over)'), h('label', { class: 'chk' }, o.games, 'Keep the same games (without entries or fixtures)'), h('label', { class: 'chk' }, o.refs, 'Keep referees'), h('label', { class: 'chk' }, o.sp, 'Keep sponsors'), o.confirm),
      [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Start next season', cls: 'danger', fn: async () => {
        if (o.confirm.value.trim() !== 'NEW') throw new Error('Type NEW to confirm');
        const r = await api('POST', '/api/admin/new-tournament', { keepPlayers: o.players.checked, keepGames: o.games.checked, keepReferees: o.refs.checked, keepSponsors: o.sp.checked, season: o.season.value });
        toast(r.season + ' started • previous season saved'); await refresh();
      } }]);
    };
    return h('div', {}, h('div', { class: 'card' }, h('b', {}, 'Backup'), h('p', { class: 'muted small' }, 'Includes photos, logos and sponsor images. Data is saved in the data/ folder of the server and auto-backed-up every 2 minutes (encrypted when a backup passphrase is set). Download a copy before and after the event.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: guard(() => dl('/api/admin/backup', 'tournament-backup.json')) }, '⬇ Download backup'), file, h('button', { class: 'btn ghost', onclick: () => file.click() }, '⬆ Restore backup'))),
      h('div', { class: 'card' }, h('b', {}, 'Reports & display'), h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: guard(() => dl('/api/export.xlsx', 'tournament-results.xlsx')) }, '📊 Excel'), h('a', { class: 'btn ghost', href: '#/report' }, '🖨 PDF report'), h('a', { class: 'btn ghost', href: '#/certs' }, '🎖 Certificates'), h('a', { class: 'btn ghost', href: '#/tv' }, '📺 Big screen'))),
      privacyCard(),
      h('div', { class: 'card' }, h('b', {}, 'Events'), h('p', { class: 'muted small' }, 'Several events can run at the same time, and the same players can be in more than one. Start a new event from 🏆 Event → “+ New event” whenever you need one – there does not have to be one running. Close an event from its ⚙ Details when it is over; it stays in All events and in the all-time rankings.'), h('a', { class: 'btn ghost', href: '#/seasons' }, '📜 All events')));
  },
};

/* ------------------------------------------------------- admins & security */
function adminsCard() {
  const box = h('div', { class: 'card' }, h('b', {}, 'Organizers'), h('p', { class: 'muted small' }, 'Loading…'));
  const draw = (list) => {
    const nm = inp('', { placeholder: 'Name of new organizer', 'aria-label': 'New organizer name' });
    const sp = sel([['main', 'Main organizer – everything'], ['game', 'Game organizer – only the games assigned to them'], ['badminton', 'Sport lead – Badminton'], ['tt', 'Sport lead – Table tennis'], ['carrom', 'Sport lead – Carrom'], ['chess', 'Sport lead – Chess']], 'game');
    box.replaceChildren(h('b', {}, 'Organizers'), h('p', { class: 'muted small' }, 'Each organizer has their own PIN, so the activity log shows who did what. Assign game organizers on each game (Event → game → Change).'),
      h('div', { class: 'list' }, list.map((a) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, a.name), a.me ? h('span', { class: 'muted small' }, '  (you)') : null, h('div', { class: 'muted small' }, a.limited ? 'Game organizer' + (a.games && a.games.length ? ': ' + a.games.join(', ') : ' – no games yet') : (a.sports || []).length ? 'Sport lead: ' + a.sports.join(', ') : 'Organizer')),
        h('button', { class: 'btn ghost sm', onclick: guard(async () => { const x = await api('PUT', '/api/admin/admins/' + a.id, { resetPin: true }); showPin(x.name, x.pin); }) }, 'New PIN'),
        a.me ? null : h('button', { class: 'btn danger sm', 'aria-label': 'Remove ' + a.name, onclick: () => confirmBox('Remove admin ' + a.name + '?', guard(async () => { await api('DELETE', '/api/admin/admins/' + a.id); load2(); }), 'Remove') }, '✕')))),
      nm, sp, h('button', { class: 'btn', onclick: guard(async () => { const x = await api('POST', '/api/admin/admins', { name: nm.value, limited: sp.value === 'game', sports: ['main', 'game'].includes(sp.value) ? [] : [sp.value] }); showPin(x.name, x.pin); load2(); await refresh(); }) }, 'Add admin'),
      h('hr'), h('b', {}, 'Lost a phone?'), h('p', { class: 'muted small' }, 'Signs out every other admin and referee device. They sign in again with their PIN.'),
      h('button', { class: 'btn danger', onclick: () => confirmBox('Sign out everyone else?', guard(async () => { const r = await api('POST', '/api/admin/revoke-sessions'); toast(r.signedOut + ' session(s) signed out'); }), 'Sign them out') }, 'Sign out all other devices'));
  };
  const load2 = () => api('GET', '/api/admin/admins').then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  load2(); return box;
}

/* Excel import of players, their games and teams (shared by Registration, Players and Safety screens).
   Step 1: the server inspects every sheet. Step 2: the admin picks sheets and checks the column mapping.
   Step 3: preview (dry run). Step 4: import. */
function importCard() {
  const imp = h('input', { type: 'file', accept: '.xlsx,.csv,.tsv,.txt', hidden: true, onchange: guard(async (e) => {
    const f = e.target.files[0]; if (!f) return; const buf = await f.arrayBuffer(); e.target.value = '';
    const send = (path, q, opts) => fetch(path + '?tid=' + encodeURIComponent(curTid()) + (q ? '&' + q.replace(/^\?/, '') : ''), { method: 'POST', headers: { 'x-token': me.token, 'Content-Type': 'application/octet-stream', ...(opts ? { 'x-import-options': JSON.stringify(opts) } : {}) }, body: buf })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
    const info = await send('/api/admin/import-inspect');
    chooseSheets(info, send);
  }) });
  function chooseSheets(info, send) {
    const evOpts = [['', '— none (use the Games column) —']].concat(S.events.map((e) => [e.id, e.name + ((e.section || 'adults') === 'kids' ? ' (kids)' : '')]));
    const blocks = info.sheets.map((sh) => {
      const KIND = { players: 'Players', games: 'Games', teams: 'Teams', fixtures: 'Fixtures', other: 'Not recognised' };
      const cb = h('input', { type: 'checkbox', checked: sh.kind !== 'other' && sh.rows > 0, 'aria-label': 'Import sheet ' + sh.name });
      const kind = sel([['players', 'Players'], ['games', 'Games'], ['teams', 'Teams'], ['fixtures', 'Fixtures']], sh.kind === 'other' ? 'players' : sh.kind);
      const KC = { name: 'Game', sport: 'Sport', section: 'Category', type: 'Type', team: 'Team', games: 'Game', members: 'Members', member: 'Player columns', game: 'Game', a: 'Side A', b: 'Side B', stage: 'Round', group: 'Group', date: 'Date', time: 'Time', when: 'Date & time', court: 'Court', referee: 'Referee', bestOf: 'Best of', target: 'Points' };
      const colOpts = [['', '— not in this sheet —']].concat(sh.headers.map((x) => [x.col, x.text]));
      const maps = info.fields.map((fd) => ({ key: fd.key, label: fd.label, s: sel(colOpts, sh.map[fd.key] || '') }));
      const ev = sel(evOpts, sh.eventId), sec = sel([['', 'From the sheet (default adults)'], ['adults', 'Adults'], ['kids', 'Kids']], sh.section);
      const found = maps.filter((m) => sh.map[m.key]).map((m) => m.label).concat((sh.sportCols || []).map((x) => SPORT_LABEL[x.sport] + ' (yes/no)'));
      const sportSel = [...new Set((sh.sportCols || []).map((x) => x.sport))].flatMap((sp) => ['adults', 'kids'].map((sec) => {
        const evs = S.events.filter((e) => e.sport === sp && secOf(e) === sec);
        return { sport: sp, section: sec, s: sel([['', 'Automatic' + (evs.length ? '' : ' (no game yet)')]].concat(evs.map((e) => [e.id, e.name + (e.sideType === 'team' ? ' (team – interested list)' : '')]), [['skip', 'Skip – do not enter']]), '') };
      }));
      const details = h('details', {}, h('summary', { class: 'small' }, 'Columns & options'),
        h('p', { class: 'muted small' }, 'Pick which column of this sheet holds each detail. Header row: ' + sh.headerRow + '.'),
        maps.map((m) => field(m.label, m.s)),
        sh.eventCols.length ? h('p', { class: 'small' }, 'Event columns (a "Yes"/✓ enters the player): ' + sh.eventCols.map((x) => x.eventName).join(', ')) : null,
        sportSel.length ? h('div', {}, h('b', { class: 'small' }, 'Sport columns – which game a "Yes" enters'), h('p', { class: 'muted small' }, 'Automatic picks the game of that sport that fits the player’s section, gender and age (individual games first; for a team game the player goes on its interested list).'),
          sportSel.map((x) => field(SPORT_ICON[x.sport] + ' ' + SPORT_LABEL[x.sport] + ' – ' + (x.section === 'kids' ? 'kids' : 'adults'), x.s))) : null,
        field('Players with no games go into', ev, sh.eventId ? 'Guessed from the sheet name.' : 'Useful when each sheet is one event, e.g. a sheet called "Chess".'),
        field('Section when the sheet has no Section column', sec));
      const other = h('div', { class: 'muted small' }, sh.kind !== 'players' && sh.kind !== 'other' ? 'Recognised: ' + Object.keys(sh.kindCols || {}).map((k) => KC[k] || k).join(', ') : '');
      const showKind = () => { details.hidden = kind.value !== 'players'; other.hidden = kind.value === 'players'; };
      kind.addEventListener('change', showKind);
      const el = h('div', { class: 'card' },
        h('label', { class: 'chk' }, cb, h('b', {}, sh.name), h('span', { class: 'muted small' }, ' • ' + (sh.kind === 'other' ? (sh.reason || 'not recognised') : sh.rows + ' ' + KIND[sh.kind].toLowerCase() + ' rows'))),
        field('This sheet holds', kind),
        sh.kind === 'players' && sh.sample.length ? h('div', { class: 'muted small' }, 'e.g. ' + sh.sample.join(', ')) : null,
        sh.kind === 'players' && found.length ? h('div', { class: 'muted small' }, 'Recognised: ' + found.join(', ')) : null,
        other, details);
      showKind();
      return { sh, cb, kind, maps, ev, sec, el, sportSel };
    });
    const nothing = info.sheets.every((x) => x.kind === 'other');
    modal('Which sheets should be imported?', h('div', {},
      h('p', { class: 'small' }, 'This file has ' + info.sheets.length + ' sheet(s). Recognised sheets are ticked – games are created first, then players, then teams, then fixtures. For a players sheet, open "Columns & options" to check how columns are read.'),
      nothing ? h('div', { class: 'warnbox small' }, 'No sheet was recognised. Tick a sheet, choose what it holds, and for players choose its Name column under "Columns & options".') : null,
      blocks.map((b) => b.el)),
    [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Preview', close: false, fn: async (close) => {
      const chosen = blocks.filter((b) => b.cb.checked);
      if (!chosen.length) { toast('Tick at least one sheet', true); return; }
      const opts = { sheets: chosen.map((b) => ({ index: b.sh.index, kind: b.kind.value, headerRow: b.sh.headerRow, eventId: b.ev.value, section: b.sec.value, map: Object.fromEntries(b.maps.filter((m) => m.s.value).map((m) => [m.key, Number(m.s.value)])), sportMap: Object.fromEntries(b.sportSel.filter((x) => x.s.value).map((x) => [x.sport + '|' + x.section, x.s.value])) })) };
      const dry = await send('/api/admin/import-players', '?dry=1', opts);
      close(); preview(dry, () => send('/api/admin/import-players', '', opts));
    } }]);
  }
  function preview(dry, run) {
    const n = (x) => x || 0, extras = [n(dry.gamesMade) ? dry.gamesMade + ' new games' : '', n(dry.gamesExisting) ? dry.gamesExisting + ' games already exist (skipped)' : '',
      n(dry.teamsCreated) ? dry.teamsCreated + ' new teams' : '', n(dry.teamsUpdated) ? dry.teamsUpdated + ' teams updated' : '', n(dry.teamEntries) ? dry.teamEntries + ' teams entered in games' : '',
      n(dry.fixturesMade) ? dry.fixturesMade + ' new fixtures' : '', n(dry.fixturesExisting) ? dry.fixturesExisting + ' fixtures already exist (skipped)' : ''].filter(Boolean);
    const any = dry.created || dry.updated || n(dry.gamesMade) || n(dry.teamsCreated) || n(dry.teamsUpdated) || n(dry.fixturesMade);
    modal('Check before importing', h('div', {}, extras.length ? h('p', {}, h('b', {}, extras.join(' • '))) : null,
      dry.created || !extras.length ? h('p', {}, h('b', {}, dry.created + ' new players'), ' will be added' + (dry.flagged ? ' (' + dry.flagged + ' look like possible duplicates and will be flagged)' : '') + '.') : null,
      dry.updated ? h('p', {}, h('b', {}, dry.updated + ' players already in the app'), ' are matched' + (dry.changed ? ' – ' + dry.changed + ' of them get the sheet’s newer details' : ' – no details change') + (dry.removedGames ? ' and ' + dry.removedGames + ' game entr' + (dry.removedGames === 1 ? 'y is' : 'ies are') + ' removed because they are no longer ticked' : '') + '. The latest sheet wins for phone, villa, age, gender, category and games; photo, bio and results are kept, and the replaced values are written in each player’s private notes.') : null,
      dry.sheets && dry.sheets.length ? h('div', { class: 'small' }, dry.sheets.map((x) => h('div', {}, '• ' + x.sheet + ': ' + x.rows + ' ' + (x.kind || 'player') + ' rows' + (x.kind ? '' : ' → ' + x.added + ' new' + (x.updated ? ', ' + x.updated + ' updated' : ''))))) : null,
      dry.merged ? h('p', { class: 'small' }, dry.merged + ' rows are the same person as another row (same name and phone/email/date of birth) and are merged, so that player is entered in all their events.') : null,
      dry.created || dry.updated ? h('p', { class: 'small' }, dry.games + ' game entries will be mapped. Players in teams: teams are created or reused by name. Team events: a player with a team enters that team; a player with no team goes on the interested list – build teams from it on the game’s Teams tab.') : null,
      (dry.warnings || []).length ? h('details', { class: 'small' }, h('summary', {}, (dry.warnings || []).length + ' note(s) – the rest is still imported'), dry.warnings.slice(0, 40).map((x) => h('div', {}, (x.row ? 'Row ' + x.row + ' ' : '') + x.name + ': ' + x.error))) : null,
      dry.errors.length ? h('div', { class: 'warnbox small' }, h('b', {}, dry.errors.length + ' rows will be skipped:'), dry.errors.slice(0, 20).map((x) => h('div', {}, (x.sheet ? x.sheet + ' ' : '') + 'row ' + x.row + ' ' + x.name + ': ' + x.error))) : null),
    [any ? { label: 'Import', fn: async () => { const r = await run(); toast([r.gamesMade ? r.gamesMade + ' games' : '', r.teamsCreated ? r.teamsCreated + ' teams' : '', r.fixturesMade ? r.fixturesMade + ' fixtures' : ''].filter(Boolean).concat(['']).join(' • ') + r.created + ' players added' + (r.updated ? ' • ' + r.updated + ' updated' : '') + ' • ' + r.games + ' game entries' + (r.teamsMade ? ' • ' + r.teamsMade + ' new teams' : '') + (r.teamEntries ? ' • ' + r.teamEntries + ' team entries' : '') + (r.interested ? ' • ' + r.interested + ' on interested lists' : '')); await refresh(); } } : null].filter(Boolean));
  }
  return h('div', { class: 'card' }, h('b', {}, '📥 Upload to ' + curT().name + ': players, games, teams & fixtures (Excel)'),
    h('p', { class: 'muted small' }, 'Upload any Excel or CSV file (a Google Forms export works) – one sheet or many. Sheets can hold players, games, teams or fixtures; download the Template to see each layout. Columns like “Select Games to Participate [Badminton]” with Yes, Category (Seniors / Under-16), Villa Number and Age are understood. Players already in the app are not duplicated: the latest sheet updates their details and game choices (upload it every season), and the old values are kept in their private notes. You choose which sheets to import, and columns are matched by their header (Name, Phone, Dept, Games, Team…), so your own layout works. A sheet named after an event (e.g. "Chess") puts its players in that event. You see a preview first, and possible duplicates are flagged rather than blocked.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: guard(() => downloadWith('/api/admin/import-template.xlsx?tid=' + encodeURIComponent(curTid()), 'players-import-template.xlsx')) }, '⬇ Template'), imp, h('button', { class: 'btn', onclick: () => imp.click() }, '⬆ Upload filled sheet')));
}

adminTabs.registration = function () {
  const R = S.registration || {};
  const pending = S.players.filter((p) => p.status === 'pending').sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));
  const f = { enabled: h('input', { type: 'checkbox', checked: !!R.enabled }), deadline: inp(R.deadline || '', { type: 'date' }), pub: inp(R.publicUrl || '', { placeholder: 'https://your-name.tailnet.ts.net', autocapitalize: 'off', autocomplete: 'off' }), code: inp(R.joinCode || '', { placeholder: 'e.g. SMASH-26 (leave empty for no code)', maxlength: 24, autocapitalize: 'off' }),
    notice: h('textarea', { rows: 3 }, R.notice || ''), kidsNotice: h('textarea', { rows: 4 }, R.kidsNotice || '') };
  const gen = () => { const w = ['SMASH', 'ACE', 'RALLY', 'SERVE', 'CHECK', 'QUEEN', 'DROP']; f.code.value = w[Math.floor(Math.random() * w.length)] + '-' + String(Math.floor(1000 + Math.random() * 9000)); };
  const row = (p) => {
    const evs = (p.requestedEventIds || []).map((i) => (byId('events', i) || {}).name).filter(Boolean);
    return h('div', { class: 'card' }, h('div', { class: 'row' }, avatar(p, 36), h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'muted small' }, [SEC[p.section], p.ageGroup, p.playerNo, new Date(p.registeredAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' • ')))),
      h('div', { class: 'small' }, 'Wants: ' + (evs.join(', ') || '—')),
      (p.dupOf || []).length ? h('div', { class: 'warnbox small' }, '⚠ Possible duplicate of ' + p.dupOf.map((i) => (byId('players', i) || {}).name || '?').join(', '), ' ', ...p.dupOf.map((i) => h('button', { class: 'btn ghost sm', onclick: () => confirmBox('Merge ' + p.name + ' into ' + ((byId('players', i) || {}).name || 'this player') + '? Their events, teams and matches move to the existing record; this registration is removed.', guard(async () => { await api('POST', '/api/admin/players/' + p.id + '/merge', { intoId: i }); toast('Merged'); await refresh(); }), 'Merge') }, 'Merge into ' + ((byId('players', i) || {}).name || '?')))) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/admin/players/' + p.id + '/approve'); toast('Approved' + (r.enrolled.length ? ' and enrolled in ' + r.enrolled.join(', ') : '') + (r.skipped.length ? ' • skipped: ' + r.skipped.join(', ') : '')); await refresh(); }) }, '✓ Approve'),
        h('button', { class: 'btn ghost', onclick: () => playerModal(p) }, 'View / edit'),
        h('button', { class: 'btn danger', onclick: () => confirmBox('Reject and remove ' + p.name + '? (It can be restored from Trash for 30 days.)', guard(async () => { await api('DELETE', '/api/admin/players/' + p.id); await refresh(); }), 'Reject') }, '✕ Reject')));
  };
  return h('div', {},
    h('div', { class: 'card' }, h('b', {}, 'Online registration'),
      h('label', { class: 'chk' }, f.enabled, 'Registration is open'), field('Closes after (optional)', f.deadline, 'Registration stops at the end of this date (venue time).'),
      field('Public web address', f.pub, 'Every shared link (WhatsApp, QR, profile links) uses this, whatever address you are browsing on. Use your permanent https link; leave empty to use the current address.'),
      field('Join code', f.code, 'Only people who know this code can register. Share it in your invitation, not on the public page.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost sm', onclick: gen }, 'Make a code'), h('button', { class: 'btn ghost sm', onclick: () => confirmBox('Change the join code now? The old code stops working immediately.', guard(async () => { await api('POST', '/api/admin/registration?tid=' + encodeURIComponent(curTid()), { rotateCode: true }); toast('New code created'); await refresh(); }), 'Change code') }, '🔄 Change code now')),
      field('Notice shown to adults (consent text)', f.notice), field('Consent text for parents / guardians', f.kidsNotice),
      h('button', { class: 'btn full', onclick: guard(async () => { await api('POST', '/api/admin/registration?tid=' + encodeURIComponent(curTid()), { enabled: f.enabled.checked, deadline: f.deadline.value, joinCode: f.code.value.trim(), publicUrl: f.pub.value.trim(), notice: f.notice.value, kidsNotice: f.kidsNotice.value }); toast('Saved'); await refresh(); }) }, 'Save registration settings'),
      h('p', { class: 'muted small' }, 'Every registration waits here for your approval. Set a limit per event under Events → Edit event.'),
      f.enabled.checked ? h('a', { class: 'btn ghost', href: '#/menu' }, 'Show QR / link (Menu)') : null),
    (() => { const te = S.events.filter((e) => e.sideType === 'team' && (e.interestedIds || []).length); return te.length ? h('div', { class: 'card' }, h('b', {}, 'Players interested in team events'),
      ...te.map((e) => h('div', {}, h('div', { class: 'small' }, h('b', {}, e.name + ' – ' + e.interestedIds.length + ' player' + (e.interestedIds.length > 1 ? 's' : '')), ' (' + SEC[e.section || 'adults'] + ')'),
        h('div', { class: 'muted small' }, e.interestedIds.map((i) => (byId('players', i) || {}).name).filter(Boolean).join(', ')))),
      h('p', { class: 'muted small' }, 'Use this list to form teams under Teams. Team count and match count come from the teams you create.')) : null; })(),
    importCard(),
    h('h2', {}, 'Waiting for approval (' + pending.length + ')'),
    pending.length > 1 ? h('button', { class: 'btn', onclick: () => confirmBox('Approve all ' + pending.length + ' registrations?', guard(async () => { const r = await api('POST', '/api/admin/players/approve-all'); toast(r.approved + ' approved'); await refresh(); }), 'Approve all') }, 'Approve all') : null,
    pending.length ? pending.map(row) : h('p', { class: 'empty' }, 'No registrations waiting.'));
};

/* Who will actually get notifications? Status is set at registration; test-send at check-in; unreachable people get a shareable message. */
adminTabs.reach = function () {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const LAB = { on: ['✅ On', 'ok'], off: ['🔕 Said no', 'warn'], unsupported: ['📵 Can’t', 'warn'], later: ['⏳ Later', 'warn'], unknown: ['❔ Not set', ''] };
  const draw = (d) => {
    const bad = d.rows.filter((r) => r.status !== 'on');
    box.replaceChildren(
      h('div', { class: 'card' }, h('b', {}, 'Notification status'), h('div', { class: 'chips' }, ['on', 'off', 'unsupported', 'later', 'unknown'].map((k) => h('span', { class: 'chip ' + LAB[k][1] }, LAB[k][0] + ' ' + (d.counts[k] || 0)))),
        h('p', { class: 'muted small' }, 'Players turn notifications on when they register. At check-in, tap “Send test” – the phone should buzz. Players who cannot receive them can still follow scores in the app or on the big screen.')),
      bad.length ? h('div', { class: 'card' }, h('b', {}, 'Not reachable (' + bad.length + ')'), h('p', { class: 'muted small' }, 'Send these players the message below on WhatsApp or SMS.'),
        h('textarea', { rows: 4, readonly: true }, d.message), h('div', { class: 'actions' }, copyBtn(d.message, 'Copy message'), h('a', { class: 'btn ghost', href: 'https://wa.me/?text=' + encodeURIComponent(d.message), target: '_blank', rel: 'noopener' }, 'WhatsApp'))) : null,
      h('div', { class: 'card' }, d.rows.length ? d.rows.map((r) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, r.name), h('div', { class: 'muted small' }, SEC[r.section] + (r.phone ? ' • ' + r.phone : ''))), h('span', { class: 'chip ' + LAB[r.status][1] }, LAB[r.status][0]),
        h('button', { class: 'btn ghost sm', onclick: guard(async () => { const x = await api('POST', '/api/admin/players/' + r.id + '/test-push'); toast(x.sent ? 'Test sent' : 'No phone registered for this player', !x.sent); load4(); }) }, 'Send test'))) : h('p', { class: 'empty' }, 'No approved players yet.')));
  };
  const load4 = () => api('GET', '/api/admin/reachability?link=' + encodeURIComponent(BASE() + '/')).then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  load4();
  return box;
};

adminTabs.broadcast = function () {
  const title = inp('', { placeholder: 'Title, e.g. Lunch break', maxlength: 60 }), text = h('textarea', { rows: 3, maxlength: 240, placeholder: 'Message to everyone (max 240 characters)' });
  const sport = sel([['', 'Everyone']].concat(Object.entries(SPORT_LABEL).map(([k, l]) => [k, l + ' players'])), '');
  return h('div', { class: 'card' }, h('b', {}, '📣 Send an announcement'), h('p', { class: 'muted small' }, 'Goes to the Updates page and as a notification to phones that have alerts on.'),
    field('Title', title), field('Message', text), field('Who', sport),
    h('button', { class: 'btn full', onclick: () => confirmBox('Send this announcement now?', guard(async () => { const r = await api('POST', '/api/admin/broadcast', { title: title.value, text: text.value, sport: sport.value }); toast('Sent to ' + r.sent + ' phone' + (r.sent === 1 ? '' : 's')); text.value = ''; title.value = ''; await refresh(); }), 'Send') }, 'Send announcement'));
};

/* Paper score sheet for one match (referee enters, chief signs off) */
function paperModal(m, ev) {
  const rows = Array.from({ length: ev.config.bestOf }, (_, i) => ({ a: inp('', { type: 'number', min: 0, inputmode: 'numeric', 'aria-label': 'Game ' + (i + 1) + ' side A' }), b: inp('', { type: 'number', min: 0, inputmode: 'numeric', 'aria-label': 'Game ' + (i + 1) + ' side B' }) }));
  const res = sel([['', '— choose —'], ['A', sideLabel(ev, m.sideA) + ' won'], ['B', sideLabel(ev, m.sideB) + ' won'], ['draw', 'Draw']], ''), note = inp('', { placeholder: 'Sheet number / who kept the sheet', maxlength: 120 });
  modal('Enter score from paper sheet', h('div', {}, h('p', { class: 'muted small' }, 'Use this when the network was down and the score was kept on paper. It is marked “from paper” until the chief referee signs it off.'),
    ev.scoring === 'points' ? [h('div', { class: 'two' }, h('b', {}, sideLabel(ev, m.sideA)), h('b', {}, sideLabel(ev, m.sideB))), rows.map((r, i) => h('div', { class: 'two' }, field('Game ' + (i + 1), r.a), field(' ', r.b)))] : field('Result', res), field('Note', note)),
  [{ label: 'Save from paper', fn: async () => { await api('POST', '/api/matches/' + m.id + '/paper', ev.scoring === 'points' ? { games: rows.map((r) => ({ a: r.a.value, b: r.b.value })), note: note.value } : { result: res.value, note: note.value }); toast('Saved – waiting for chief referee sign-off'); await refresh(); } }]);
}
async function downloadWith(url, name) { const r = await fetch(url, { headers: { 'x-token': me.token } }); if (!r.ok) throw new Error('Download failed'); const b = await r.blob(); const a = h('a', { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); }

/* Event day: panic controls, snapshots / rollback, Excel import */
adminTabs.safety = function () {
  const PC = S.panic || { freezeScoring: false, lockedEvents: [], hideScoreboard: false };
  const typed = (action, word, extra, msg) => { const t = inp('', { placeholder: 'Type ' + word, autocapitalize: 'characters', autocomplete: 'off' }); modal(msg, h('div', {}, field('Type ' + word + ' to confirm', t)), [{ label: 'Confirm', cls: 'danger', fn: async () => { await api('POST', '/api/admin/panic', { action, confirm: t.value, ...extra }); toast('Done'); await refresh(); } }]); };
  const state = (on, label) => h('span', { class: 'chip ' + (on ? 'warn' : 'ok') }, (on ? '⏸ ' : '✅ ') + label);
  const snaps = h('div', {}, h('p', { class: 'muted small' }, 'Loading…'));
  api('GET', '/api/admin/snapshots').then((l) => snaps.replaceChildren(l.length ? l.slice(0, 12).map((s) => h('div', { class: 'row' }, h('div', { class: 'grow' }, new Date(s.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })),
    h('button', { class: 'btn ghost sm', onclick: () => { const t = inp('', { placeholder: 'Type ROLLBACK', autocapitalize: 'characters' }); modal('Go back to this moment?', h('div', {}, h('p', { class: 'warnbox small' }, 'Everything entered after ' + new Date(s.at).toLocaleString('en-IN') + ' is undone. A copy of the current state is kept first.'), field('Type ROLLBACK to confirm', t)), [{ label: 'Roll back', cls: 'danger', fn: async () => { await api('POST', '/api/admin/rollback', { file: s.file, confirm: t.value }); toast('Rolled back'); await refresh(); } }]); } }, 'Restore'))) : h('p', { class: 'empty' }, 'No snapshots yet.'))).catch(() => {});
  return h('div', {},
    h('div', { class: 'card' }, h('b', {}, '🚨 Panic controls'), h('p', { class: 'muted small' }, 'If something goes wrong on the day. Each action asks you to type a word so nothing happens by accident.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Scoring'), h('div', { class: 'muted small' }, 'Stops every referee from changing scores')), state(PC.freezeScoring, PC.freezeScoring ? 'Frozen' : 'Live'),
        PC.freezeScoring ? h('button', { class: 'btn sm', onclick: () => typed('unfreeze', 'RESUME', {}, 'Resume scoring') }, 'Resume') : h('button', { class: 'btn danger sm', onclick: () => typed('freeze', 'FREEZE', {}, 'Freeze all scoring') }, 'Freeze')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Public scoreboard'), h('div', { class: 'muted small' }, 'Hides all scores from players and spectators (staff still see them)')), state(PC.hideScoreboard, PC.hideScoreboard ? 'Hidden' : 'Visible'),
        PC.hideScoreboard ? h('button', { class: 'btn sm', onclick: () => typed('show', 'SHOW', {}, 'Show scoreboard') }, 'Show') : h('button', { class: 'btn danger sm', onclick: () => typed('hide', 'HIDE', {}, 'Hide public scoreboard') }, 'Hide')),
      h('b', {}, 'Lock one event'), S.events.map((ev) => { const locked = (PC.lockedEvents || []).includes(ev.id); return h('div', { class: 'row' }, h('div', { class: 'grow' }, ev.name), state(locked, locked ? 'Locked' : 'Open'),
        locked ? h('button', { class: 'btn sm', onclick: () => typed('unlock', 'UNLOCK', { eventId: ev.id }, 'Unlock ' + ev.name) }, 'Unlock') : h('button', { class: 'btn ghost sm', onclick: () => typed('lock', 'LOCK', { eventId: ev.id }, 'Lock ' + ev.name) }, 'Lock')); })),
    h('div', { class: 'card' }, h('b', {}, '⏪ Go back in time'), h('p', { class: 'muted small' }, 'The app saves a snapshot every few minutes while anything changes. Restore one if scores or fixtures were entered wrongly. Admins and PINs are kept.'), snaps),
    importCard());
};

adminTabs.disputes = function () {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const draw = (list) => box.replaceChildren(list.length ? h('div', {}, list.map((d) => {
    const m = byId('matches', d.matchId), ev = m && evOf(m);
    return h('div', { class: 'card' + (d.resolved ? ' done' : '') }, h('b', {}, ev ? ev.name + ': ' + sideLabel(ev, m.sideA) + ' vs ' + sideLabel(ev, m.sideB) : 'Match removed'),
      h('p', {}, d.text), h('div', { class: 'muted small' }, [d.name, d.contact, new Date(d.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), d.resolved ? 'Resolved' + (d.by ? ' by ' + d.by : '') : ''].filter(Boolean).join(' • ')),
      h('div', { class: 'actions' }, m ? h('a', { class: 'btn ghost sm', href: '#/match/' + m.id }, 'Open match') : null,
        d.resolved ? null : h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/admin/disputes/' + d.id); await refresh(); }) }, 'Mark resolved'),
        h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('DELETE', '/api/admin/disputes/' + d.id); await refresh(); }) }, 'Delete')));
  })) : h('p', { class: 'empty' }, 'No score reports. Spectators and players can report a problem from any match page.'));
  api('GET', '/api/admin/disputes').then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return box;
};

adminTabs.trash = function () {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const KIND = { players: 'Player', teams: 'Team', events: 'Event', referees: 'Referee', matches: 'Match', sponsors: 'Sponsor', fixtures: 'Fixtures' };
  const draw = (list) => box.replaceChildren(h('p', { class: 'muted small' }, 'Deleted items are kept for 30 days so a mistake can be undone.'), list.length ? h('div', { class: 'list' }, list.map((x) => h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('b', {}, (KIND[x.col] || x.col) + ': ' + (x.name || '—')), h('div', { class: 'muted small' }, 'Deleted ' + new Date(x.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + (x.matches ? ' • with ' + x.matches + ' match(es)' : ''))),
    h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/admin/trash/' + x.id + '/restore'); toast('Restored'); await refresh(); }) }, 'Restore')))) : h('p', { class: 'empty' }, 'Trash is empty.'),
  list.length ? h('button', { class: 'btn danger', onclick: () => confirmBox('Permanently empty the trash?', guard(async () => { await api('DELETE', '/api/admin/trash'); render(); }), 'Empty trash') }, 'Empty trash') : null);
  api('GET', '/api/admin/trash').then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return box;
};

function privacyCard() {
  const o = { contacts: h('input', { type: 'checkbox' }), kids: h('input', { type: 'checkbox' }), trash: h('input', { type: 'checkbox', checked: true }), subs: h('input', { type: 'checkbox' }), audit: h('input', { type: 'checkbox' }), backups: h('input', { type: 'checkbox' }) };
  return h('div', { class: 'card' }, h('b', {}, '🔒 Privacy clean-up'), h('p', { class: 'muted small' }, 'After the event, remove personal data you no longer need. Match results and names stay. Download a backup first if you want to keep everything.'),
    h('label', { class: 'chk' }, o.contacts, 'Phone numbers, emails, emergency contacts, guardian details, private notes'), h('label', { class: 'chk' }, o.kids, 'Children’s photos'),
    h('label', { class: 'chk' }, o.trash, 'Trash'), h('label', { class: 'chk' }, o.subs, 'Notification subscriptions'), h('label', { class: 'chk' }, o.audit, 'Activity log'), h('label', { class: 'chk' }, o.backups, 'Old automatic backups and archives (cannot be undone)'),
    h('button', { class: 'btn danger', onclick: () => confirmBox('Remove the selected personal data? This cannot be undone.', guard(async () => {
      const r = await api('POST', '/api/admin/purge', { contacts: o.contacts.checked, kidsPhotos: o.kids.checked, trash: o.trash.checked, subs: o.subs.checked, audit: o.audit.checked, backups: o.backups.checked });
      toast('Removed: ' + (r.cleared.join(', ') || 'nothing selected') + (r.unusedFilesDeleted ? ' • ' + r.unusedFilesDeleted + ' unused photo(s) deleted' : '')); await refresh();
    }), 'Remove') }, 'Remove selected data'));
}

/* ------------------------------------------------------------ certificates */
const POS = ['Winner', 'Runner-up', 'Third place', 'Participation', 'None'];
const POS_TEXT = { Winner: 'for winning', 'Runner-up': 'for finishing as runner-up in', 'Third place': 'for finishing in third place in', Participation: 'for participating in' };

function certRecipients(ev) {
  const ch = E.champion(ev, S.matches);
  const rows = E.standings(ev, S.matches);
  const pod = E.podium(ev, S.matches);
  const posOfEntity = (id) => {
    if (ch) return ch.winnerIds.includes(id) ? 'Winner' : ch.runnerIds.includes(id) ? 'Runner-up' : pod && pod.third.includes(id) ? 'Third place' : 'Participation';
    const r = rows.find((x) => x.id === id);
    return r && r.played > 0 ? ({ 1: 'Winner', 2: 'Runner-up', 3: 'Third place' }[r.rank] || 'Participation') : 'Participation';
  };
  if (ev.sideType === 'team') {
    return ev.participantIds.flatMap((tid) => { const t = byId('teams', tid); return (t ? t.memberIds : []).map((pid) => ({ name: (byId('players', pid) || {}).name, sub: t.name, position: posOfEntity(tid) })); });
  }
  return ev.participantIds.map((pid) => ({ name: (byId('players', pid) || {}).name, sub: '', position: posOfEntity(pid) }));
}

Views.certs = (sub) => {
  if (!isAdmin()) return h('p', { class: 'empty' }, 'Admins only.');
  if (sub === 'print') return certPages();
  const evSel = h('select', {}, ['adults', 'kids'].map((sec) => h('optgroup', { label: SEC[sec] }, eventsOf(sec).map((e) => h('option', { value: e.id, selected: ui.certJob && ui.certJob.eventId === e.id }, e.name)))));
  const list = h('div', { class: 'list' });
  let items = [];
  const draw = () => {
    const ev = byId('events', evSel.value);
    items = ev ? certRecipients(ev).filter((x) => x.name).map((x) => ({ ...x, pick: h('select', { 'aria-label': 'Position for ' + x.name }, POS.map((p) => h('option', { value: p, selected: p === x.position }, p))) })) : [];
    list.replaceChildren(...items.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, x.name), x.sub ? h('div', { class: 'muted small' }, x.sub) : null), x.pick)));
    if (!items.length) list.append(h('p', { class: 'empty' }, 'Enrol players in this event first.'));
    const ev2 = byId('events', evSel.value);
    const ties = ev2 && !E.champion(ev2, S.matches) && E.cutoffInfo(E.standings(ev2, S.matches), 3).tie;
    note.textContent = ties ? 'Heads up: players are tied for the top places – check the positions below.' : '';
  };
  const note = h('p', { class: 'warnbox small' });
  evSel.addEventListener('change', draw); draw();
  return h('div', {}, h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/admin' }, '‹'), h('h1', {}, 'Certificates')),
    h('p', { class: 'muted small' }, 'Positions are pre-filled from the Final (or the standings). Adjust, then print or save as PDF. Set signatory names and signatures in Admin → Setup.'), field('Event', evSel), note, list,
    h('button', { class: 'btn big full', onclick: () => {
      const ev = byId('events', evSel.value);
      ui.certJob = { eventId: ev.id, items: items.filter((x) => x.pick.value !== 'None').map((x) => ({ name: x.name, sub: x.sub, position: x.pick.value })) };
      location.hash = '#/certs/print';
    } }, 'Preview & print'));
};

function certPages() {
  const job = ui.certJob;
  if (!job) return h('p', { class: 'empty' }, 'Choose recipients first.');
  const ev = byId('events', job.eventId), T = S.tournament;
  const order = Object.fromEntries(POS.map((p, i) => [p, i]));
  const items = job.items.slice().sort((a, b) => order[a.position] - order[b.position]);
  const signers = (T.signers || []).slice(0, 2);
  return h('div', {},
    h('div', { class: 'page-h noprint' }, h('a', { class: 'back', href: '#/certs' }, '‹'), h('h1', {}, items.length + ' certificate(s)'), h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print / Save PDF')),
    items.map((it) => h('div', { class: 'cert' }, h('div', { class: 'cert-in' },
      T.logo ? h('img', { src: T.logo, class: 'cert-logo', alt: '' }) : h('div', { class: 'cert-logo ph' }, '🏆'),
      h('div', { class: 'cert-org' }, T.name),
      h('div', { class: 'cert-title' }, it.position === 'Participation' ? 'Certificate of Participation' : 'Certificate of Achievement'),
      h('div', { class: 'cert-sm' }, 'This certificate is proudly presented to'),
      h('div', { class: 'cert-name' }, it.name),
      h('div', { class: 'cert-sm' }, POS_TEXT[it.position] + ' '),
      h('div', { class: 'cert-ev' }, ev.name),
      it.sub ? h('div', { class: 'cert-sm' }, 'Team: ' + it.sub) : null,
      h('div', { class: 'cert-sm' }, [T.venue, T.dates].filter(Boolean).join(' • ')),
      h('div', { class: 'cert-sign' }, signers.map((sg) => h('div', {}, sg.image ? h('img', { src: sg.image, class: 'cert-sig', alt: '' }) : h('div', { class: 'cert-sig-gap' }), h('hr'), sg.name ? h('b', {}, sg.name) : null, h('div', {}, sg.title || ''))))))));
}
