'use strict';
/* Tournament app – core, router and public views. Admin screens live in admin.js */
const E = window.Engine;
const $ = (s, r) => (r || document).querySelector(s);
const PROPS = ['value', 'checked', 'selected', 'disabled', 'multiple'];
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
/* If anything breaks, say so on screen (with details that can be copied) instead of failing silently. */
(function () {
  let shown = false;
  function report(msg) {
    if (shown) return; shown = true;
    const d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:70px;z-index:99999;background:#7a1c1c;color:#fff;padding:12px;border-radius:12px;font:14px/1.4 system-ui;box-shadow:0 4px 20px rgba(0,0,0,.4)';
    const info = (msg || 'Unknown error') + '\n' + location.href + '\n' + navigator.userAgent;
    d.innerHTML = '<b>Something went wrong.</b><div style="margin:6px 0;word-break:break-word"></div>';
    d.children[1].textContent = String(msg || '').slice(0, 300);
    const copy = document.createElement('button'); copy.textContent = 'Copy details'; copy.style.cssText = 'margin-right:8px;padding:8px 12px;border-radius:8px;border:0;font-weight:700';
    copy.onclick = () => { try { navigator.clipboard.writeText(info); copy.textContent = 'Copied'; } catch (e) { copy.textContent = info.slice(0, 80); } };
    const reload = document.createElement('button'); reload.textContent = 'Reload'; reload.style.cssText = 'padding:8px 12px;border-radius:8px;border:0;font-weight:700';
    reload.onclick = () => location.reload();
    const x = document.createElement('button'); x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss'); x.style.cssText = 'float:right;background:none;border:0;color:#fff;font-size:18px';
    x.onclick = () => { d.remove(); shown = false; };
    d.append(copy, reload); d.prepend(x); document.body.append(d);
  }
  window.addEventListener('error', (e) => report((e.message || 'Error') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')));
  window.addEventListener('unhandledrejection', (e) => report('Request failed: ' + ((e.reason && e.reason.message) || e.reason)));
})();

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

let S = store.get('state', null);
/* SA = everything from the server; S = the same data narrowed to the selected event (its games, matches, teams, registration).
   Player profiles, referees, organizers and the gallery are shared, so they are the same in both. */
let SA = S;
let me = store.get('me', { role: null });
let pending = store.get('pending', []);
let offline = false;
const Views = {};
let ui = { pick: null, pickP: null, tid: store.get('tid', ''), sport: store.get('sport', ''), eventTab: {}, matchFilter: { event: '', status: '' }, adminTab: 'setup', certJob: null, section: store.get('section', 'adults'), matchView: 'list', playerSection: '', tvIdx: 0, rubber: {} };

/* ------------------------------------------------------------------- api */
async function api(method, url, body, raw) {
  let res;
  try {
    res = await fetch(url, {
      method, headers: { 'x-token': me.token || '', ...(raw ? { 'Content-Type': raw } : body ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { const err = new Error('You are offline'); err.offline = true; throw err; }
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && me.role) { me = { role: null }; store.set('me', me); }
    const err = new Error(data.error || 'Request failed'); err.status = res.status; err.data = data; throw err;
  }
  return data;
}
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

let loadP = null, loadQueued = false;
function load() {
  if (loadP) { loadQueued = true; return loadP; }
  loadP = (async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-cache', headers: { 'x-token': me.token || '' } });
      if (!r.ok) throw new Error('bad status');
      SA = await r.json(); store.set('state', SA); scope(); offline = false;
    } catch (e) { offline = true; }
    if (S) document.documentElement.style.setProperty('--brand', S.tournament.primary || '#0f766e');
  })().finally(() => { loadP = null; if (loadQueued) { loadQueued = false; setTimeout(() => load().then(() => { if (!busy()) render(); }), 250); } });
  return loadP;
}
/* After a change: wait for any load that started before the change, then fetch again, so the screen never shows stale data. */
async function refresh() { if (loadP) { try { await loadP; } catch (e) { /* ignore */ } } await load(); render(); }

/* ---------------------------------------------------------- offline queue */
let flushing = false;
const takeover = {};   /* matchId -> time until which we may overwrite another scorer */
const askTakeover = (by) => new Promise((resolve) => {
  let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
  const m = modal(by + ' is scoring this match', h('p', {}, 'Two people entering points at once can double-count. Take over only if ' + by + ' has stopped scoring.'),
    [{ label: 'Not now', cls: 'ghost', fn: () => fin(false) }, { label: 'Take over', cls: 'danger', fn: () => fin(true) }]);
  m.el.addEventListener('click', (e) => { if (e.target === m.el || e.target.closest('.x')) fin(false); });
});
async function flush() {
  if (flushing || !pending.length) return;
  flushing = true;
  try {
    while (pending.length) {
      const mid = pending[0].matchId;
      const batch = pending.filter((p) => p.matchId === mid);
      let drop = true;
      try {
        await api('POST', '/api/matches/' + mid + '/ops', { ops: batch.map((b) => b.op), force: (takeover[mid] || 0) > Date.now() });
      } catch (e) {
        if (e.offline) { offline = true; break; }
        if (e.status === 401) { toast('Sign in again to sync your scores', true); break; }
        if (e.status === 409 && e.data && e.data.locked) {
          if (await askTakeover(e.data.by)) {
            takeover[mid] = Date.now() + 120e3; drop = false;
            continue;   /* retry this match with force */
          }
          toast('Not saved: ' + e.data.by + ' is scoring this match', true);
        }
        /* other HTTP errors: drop the ops so the queue cannot jam */
      }
      if (!drop) continue;
      const done = new Set(batch.map((b) => b.op.cid));
      pending = pending.filter((p) => !done.has(p.op.cid));
      store.set('pending', pending);
    }
  } finally { flushing = false; }
  await refresh();
}
function queueOp(matchId, op) {
  pending.push({ matchId, op: { ...op, cid: uid() } });
  store.set('pending', pending);
  render();
  flush();
}
setInterval(flush, 5000);
window.addEventListener('online', () => { offline = false; flush(); });

/* ------------------------------------------------------------ data helpers */
const byId = (col, id) => (((SA || S) || {})[col] || []).find((x) => x.id === id);
const realTours = () => ((SA && SA.tournaments) || []).filter((t) => t.kind !== 'friendly');
function curTid() { const ts = realTours(); if (!ts.some((t) => t.id === ui.tid)) ui.tid = (ts.find((t) => t.status !== 'closed') || ts[0] || {}).id || ''; return ui.tid; }
const tourById = (id) => ((SA && SA.tournaments) || []).find((t) => t.id === id);
const curT = () => tourById(curTid()) || { id: '', name: 'Event', organizerIds: [], refereeIds: [], playerIds: [], status: 'open' };
const isFriendlyEv = (ev) => !!ev && ev.tid === 'friendly';
function scope() {
  if (!SA) return;
  const tid = curTid(), games = new Set(SA.events.filter((e) => e.tid === tid).map((e) => e.id));
  const reg = SA.registration || {}, one = (reg.tours || []).find((x) => x.tid === tid);
  S = { ...SA, events: SA.events.filter((e) => games.has(e.id)), matches: SA.matches.filter((m) => games.has(m.eventId)), teams: SA.teams.filter((t) => !t.tid || t.tid === tid),
    registration: one ? { ...reg, ...one } : { ...reg, open: false, events: [], pending: 0 } };
}
function pickEvent(tid) { ui.tid = tid; store.set('tid', tid); scope(); render(); }
const canManageTour = (t) => isAdmin() && !!t && (isOrganizer() || (t.organizerIds || []).includes(me.adminId));
const evOf = (m) => byId('events', m.eventId);
const nameOf = (ev, id) => { const x = byId(ev.sideType === 'team' ? 'teams' : 'players', id); return x ? x.name : '?'; };
const sideLabel = (ev, ids) => ids.map((i) => nameOf(ev, i)).join(' & ');
const isStaff = () => !!(me.adminId || me.refId || me.role === 'admin' || me.role === 'referee');
const isAdmin = () => me.role === 'admin';
/* main organizer (full rights) vs sport lead / game organizer (only their games) */
const isOrganizer = () => isAdmin() && !(me.sports || []).length && !me.limited;
const canManage = (ev) => isAdmin() && !!ev && (isOrganizer() || (me.sports || []).includes(ev.sport) || (ev.organizerIds || []).includes(me.adminId) || ((tourById(ev.tid) || {}).organizerIds || []).includes(me.adminId));
const staffMissing = (ev) => (isFriendlyEv(ev) || (ev.refereeIds || []).length ? [] : ['a referee']);
const maskPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length < 5 ? (d ? '•••' : '') : d.slice(0, 2) + '•'.repeat(Math.max(3, d.length - 5)) + d.slice(-3); };
/* A match's referees, shown as one name-like object so existing "Referee: X" displays keep working. */
const refsOf = (m) => { const rs = (m.refereeIds || []).map((id) => byId('referees', id)).filter(Boolean); return rs.length ? { name: rs.map((r) => r.name).join(', '), id: rs[0].id } : null; };
const orgName = (id) => ((S.organizers || []).find((a) => a.id === id) || {}).name;
const refName = (id) => (byId('referees', id) || {}).name;
const canScore = () => !!(me.refId || me.role === 'referee') && me.kind !== 'volunteer';   /* only referees change scores */
const SEC = { adults: 'Adults', kids: 'Kids' };
const secOf = (ev) => (ev && ev.section) || 'adults';
const eventsOf = (sec) => S.events.filter((e) => secOf(e) === sec);
function fmtSlot(m) {
  if (m.startsAt) { const d = new Date(m.startsAt); return d.toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  return m.time || '';
}
/* Playo-style sport chips: one tap narrows Home and Matches to a single sport. */
function sportChips() {
  const present = [...new Set(S.events.map((e) => e.sport))].filter((k) => SPORT_LABEL[k]);
  if (present.length < 2) return null;
  const pick = (k) => { ui.sport = k; store.set('sport', k); render(); };
  return h('div', { class: 'sportchips', role: 'group', 'aria-label': 'Sport' }, [['', '🏆', 'All']].concat(present.map((k) => [k, SPORT_ICON[k], SPORT_LABEL[k]])).map(([k, i, l]) => h('button', { type: 'button', class: 'pill sp' + (ui.sport === k ? ' on' : ''), 'aria-pressed': ui.sport === k ? 'true' : 'false', onclick: () => pick(k) }, h('span', { 'aria-hidden': 'true' }, i), ' ', l)));
}
const sportPass = (ev) => !ui.sport || (ev && ev.sport === ui.sport);

function sectionTabs(onchange) {
  return h('div', { class: 'seg sections', role: 'tablist' }, ['adults', 'kids'].map((k) => h('button', { role: 'tab', 'aria-selected': ui.section === k ? 'true' : 'false', class: ui.section === k ? 'on' : '', onclick: () => { ui.section = k; store.set('section', k); if (onchange) onchange(); render(); } }, (k === 'kids' ? '🧒 ' : '🧑 ') + SEC[k])));
}

function liveMatch(m) {
  const ops = pending.filter((p) => p.matchId === m.id);
  if (!ops.length) return m;
  const c = { ...m, log: m.log.slice(), cids: [], ...(m.rubbers ? { rubbers: m.rubbers.map((r) => ({ ...r, log: r.log.slice(), cids: [] })) } : {}) };
  const ev = evOf(m);
  ops.forEach((p) => E.applyOp(c, ev, p.op, me.name));
  return c;
}
const pendingFor = (id) => pending.filter((p) => p.matchId === id).length;

const playerStats = (pid) => E.playerStats(pid, SA, SA.matches.map(liveMatch));   /* a profile covers every event */
const r2 = E.r2;

/* ----------------------------------------------------------------- images */
function resizeImage(file, max, type) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read image'))), type, 0.82);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}
async function uploadImage(file, max = 1280, type = 'image/jpeg') {
  const blob = await resizeImage(file, max, type);
  return (await api('POST', '/api/upload', blob, type)).url;
}
function avatar(p, size) {
  const s = size || 40;
  if (p && p.photo) return h('img', { class: 'avatar', src: p.photo, width: s, height: s, alt: '' });
  const ini = ((p && p.name) || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return h('span', { class: 'avatar ph', style: `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px` }, ini);
}

/* ------------------------------------------------------------------ modal */
function modal(title, body, buttons) {
  const close = () => ov.remove();
  const ov = h('div', { class: 'modal', onclick: (e) => { if (e.target === ov) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-h' }, h('b', {}, title), h('button', { class: 'x', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'sheet-b' }, body),
      buttons ? h('div', { class: 'sheet-f' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: guard(async () => { if ((await b.fn(close)) !== false && b.close !== false) close(); }) }, b.label))) : null));
  document.body.append(ov);
  return { close, el: ov };
}
const confirmBox = (msg, fn, label) => modal('Please confirm', h('p', {}, msg), [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: label || 'Yes', cls: 'danger', fn }]);
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);

/* ----------------------------------------------------------- shared pieces */
const OUT = { walkover: ' (walkover)', retired: ' (retired)', dq: ' (disqualified)', suspended: ' (suspension)' };
const BUB = { green: '#16a34a', yellow: '#eab308', red: '#dc2626' };
const bubble = (pid) => { const p = byId('players', pid), c = p && p.card; return h('span', { class: 'bubble', title: c ? (c.bubble === 'red' ? 'Suspended: ' + c.left + ' game(s) left' : c.bubble === 'yellow' ? 'Warning on record' : 'Clean record') : '', style: 'background:' + (BUB[(c || {}).bubble] || BUB.green) }); };
const chip = (status) => h('span', { class: 'chip ' + status }, { live: '● LIVE', completed: 'Full time', scheduled: 'Upcoming' }[status]);

/* 🔔 Notify – WhatsApp the players of a match that is still to be played (organizers and referees). */
const canNotify = (ev) => !!ev && isStaff() && (!!me.refId || canManage(ev) || isFriendlyEv(ev));
function notifyBtn(m, ev, d, cls) {
  if (!canNotify(ev) || d.status !== 'scheduled') return null;
  const n = m.notified;
  return h('button', { type: 'button', class: 'btn notify ' + (cls || 'ghost sm'), title: n ? 'Notified ' + ago(n.at) + ' by ' + n.by : 'Send a WhatsApp reminder to the players', 'aria-label': 'Notify players on WhatsApp',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); notifyModal(m); } }, h('span', { 'aria-hidden': 'true' }, n ? '🔔✓' : '🔔'), ' Notify');
}
/* "Delete this match?" plus what happens to the numbers after it. */
function delMsg(m, what) {
  const later = SA.matches.filter((x) => x.eventId === m.eventId && x.no > (m.no || 0)).map((x) => x.no), top = later.length ? Math.max(...later) : 0;
  return 'Delete ' + what + (m.no ? ' #' + m.no : '') + '?' + (m.no && top ? ' Match' + (top > m.no + 1 ? 'es #' + (m.no + 1) + '–#' + top + ' will become #' + m.no + '–#' + (top - 1) : ' #' + top + ' will become #' + m.no) + '.' : '');
}
const plannedTxt = (m) => (m.plannedNo && m.no && m.plannedNo !== m.no ? 'planned #' + m.plannedNo : null);
const renumbered = (m) => !!(m.notified && m.notified.no && m.no && m.notified.no !== m.no);
const cardBtn = (icon, label, fn, cls) => h('button', { type: 'button', class: 'btn ghost sm ' + (cls || ''), 'aria-label': label, title: label, onclick: (e) => { e.preventDefault(); e.stopPropagation(); fn(); } }, h('span', { 'aria-hidden': 'true' }, icon), ' ', label);
function ago(t) { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
async function notifyModal(m) {
  const plan = await api('POST', '/api/staff/matches/' + m.id + '/notify', { base: BASE() }).catch((e) => { toast(e.message, true); return null; });
  if (!plan) return;
  const sent = new Set();
  const msg = h('textarea', { rows: 8, 'aria-label': 'Message', oninput: () => draw() }, plan.message);
  const textFor = (r) => msg.value.replace(/\{name\}/g, r.first).replace(/\{link\}/g, plan.link);
  const list = h('div', { class: 'list' });
  const draw = () => {
    list.replaceChildren(...plan.recipients.map((r) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('b', {}, r.name), h('div', { class: 'muted small' }, maskPhone(r.phone) + (r.error ? ' • ⚠ ' + r.error : ''))),
      r.sent ? h('span', { class: 'chip completed' }, '✓ Sent') :
        h('a', { class: 'btn sm ' + (sent.has(r.id) ? 'ghost' : 'wa'), href: 'https://wa.me/' + r.phone + '?text=' + encodeURIComponent(textFor(r)), target: '_blank', rel: 'noopener',
          onclick: () => { sent.add(r.id); setTimeout(draw, 50); } }, sent.has(r.id) ? '✓ Opened' : 'WhatsApp'))));
  };
  draw();
  const n = plan.recipients.length, last = m.notified;
  const box = modal('🔔 Notify players', h('div', {},
    h('p', { class: 'small' }, h('b', {}, plan.title), h('br'), plan.line.split(' • ').slice(1).join(' • ')),
    last ? h('div', { class: (renumbered(m) ? 'warnbox' : 'tip card') + ' small' }, 'Already notified ' + ago(last.at) + ' by ' + last.by + ' (' + last.n + ' player' + (last.n === 1 ? '' : 's') + ').' + (renumbered(m) ? ' The match number has changed since then (was #' + last.no + ', now #' + m.no + ') – send again so players have the new number.' : '')) : null,
    field('Message', msg, '{name} becomes each player’s first name, {link} the live-score link.'),
    n ? h('div', {}, h('b', {}, n + ' player' + (n === 1 ? '' : 's') + ' with a phone number'),
      h('p', { class: 'muted small' }, plan.auto ? 'Send them all at once, or one by one.' : 'Tap each WhatsApp button – WhatsApp opens with the message ready; press send there, then come back for the next player.'), list)
      : h('div', { class: 'warnbox small' }, 'None of the players in this match has a phone number saved.'),
    plan.missing.length ? h('div', { class: 'warnbox small' }, 'No phone number: ' + plan.missing.join(', ') + '. Add it in their profile, or tell them in person.') : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: guard(async () => { await navigator.clipboard.writeText(msg.value.replace(/\{link\}/g, plan.link)); toast('Copied'); }) }, 'Copy message'),
      h('a', { class: 'btn ghost', href: '#', onclick: (e) => { e.preventDefault(); window.open('https://wa.me/?text=' + encodeURIComponent(msg.value.replace(/\{name\}/g, 'everyone').replace(/\{link\}/g, plan.link)), '_blank', 'noopener'); } }, 'Send to a WhatsApp group'))),
    plan.auto && n ? [{ label: 'Close', cls: 'ghost', fn: () => {} }, { label: 'Send to all ' + n, fn: async () => {
      const r = await api('POST', '/api/staff/matches/' + m.id + '/notify', { send: true, message: msg.value, base: BASE() });
      const ok = r.recipients.filter((x) => x.sent).length;
      plan.recipients = r.recipients; draw(); toast(ok + ' of ' + n + ' sent on WhatsApp', ok < n); await refresh();
      return ok < n ? false : undefined;
    } }] : null);
  /* Remember who was messaged by hand once the sheet closes. */
  const mark = () => { if (sent.size) api('POST', '/api/staff/matches/' + m.id + '/notify', { mark: sent.size, message: msg.value }).then(() => refresh()).catch(() => {}); };
  new MutationObserver((_, ob) => { if (!box.el.isConnected) { ob.disconnect(); mark(); } }).observe(document.body, { childList: true });
}

/* Select one, several or all of the matches in a list, then delete them together (they go to Trash as one item). */
function selectBar(list) {
  const mine = list.filter((m) => canManage(evOf(m)));
  if (!mine.length) { return null; }
  if (!ui.pick) return h('div', { class: 'actions noprint' }, h('button', { class: 'btn ghost sm', onclick: () => { ui.pick = new Set(); render(); } }, '☑ Select matches'));
  const shown = new Set(mine.map((m) => m.id)), sel = [...ui.pick].filter((id) => shown.has(id)), all = sel.length === mine.length;
  return h('div', { class: 'selbar noprint' },
    h('b', {}, sel.length + ' of ' + mine.length + ' selected'),
    h('button', { class: 'btn ghost sm', onclick: () => { mine.forEach((m) => (all ? ui.pick.delete(m.id) : ui.pick.add(m.id))); render(); } }, all ? 'Select none' : 'Select all (' + mine.length + ')'),
    h('button', { class: 'btn sm danger', disabled: !sel.length, onclick: () => {
      const ms = sel.map((id) => byId('matches', id)).filter(Boolean), played = ms.filter((m) => E.derive(liveMatch(m), evOf(m)).status !== 'scheduled').length;
      confirmBox('Delete ' + ms.length + ' match' + (ms.length === 1 ? '' : 'es') + '?' + (played ? ' ' + played + ' already ' + (played === 1 ? 'has' : 'have') + ' scores.' : '') + ' The match numbers after them close up. They go to Admin → Trash, where one tap restores them all (30 days).',
        guard(async () => { const r = await api('POST', '/api/admin/matches/bulk-delete', { ids: ms.map((m) => m.id) }); ui.pick = null; toast(r.removed + ' deleted – restore from Admin → Trash'); await refresh(); }), 'Delete ' + ms.length);
    } }, '🗑 Delete selected' + (sel.length ? ' (' + sel.length + ')' : '')),
    h('button', { class: 'btn ghost sm', onclick: () => { ui.pick = null; render(); } }, 'Done'));
}
function matchCard(m, opts) {
  opts = opts || {};
  const ev = evOf(m); if (!ev) return null;
  const d = E.derive(liveMatch(m), ev);
  const A = sideLabel(ev, m.sideA), B = sideLabel(ev, m.sideB);
  let mid = 'vs';
  if ((ev.scoring === 'points' || d.tie) && d.status !== 'scheduled') mid = d.gamesA + ' – ' + d.gamesB;
  if (ev.scoring === 'result' && d.status === 'completed') mid = d.draw ? '½ – ½' : d.winner === 'A' ? '1 – 0' : '0 – 1';
  const picking = !!ui.pick && canManage(ev), on = picking && ui.pick.has(m.id);
  return h('a', { class: 'card match ' + d.status + (picking ? ' picking' : '') + (on ? ' picked' : ''), href: '#/match/' + m.id, 'aria-pressed': picking ? String(on) : null,
    onclick: picking ? (e) => { e.preventDefault(); if (on) ui.pick.delete(m.id); else ui.pick.add(m.id); render(); } : null },
    h('div', { class: 'mc-top' }, picking ? h('span', { class: 'pickbox', 'aria-hidden': 'true' }, on ? '☑' : '☐') : null, chip(d.status),
      h('span', { class: 'muted' }, [opts.event ? ev.name + (m.no ? ' #' + m.no : '') : m.no ? 'Match #' + m.no : null, plannedTxt(m) ? '(' + plannedTxt(m) + ')' : null, m.stage !== 'League' ? m.stage : (m.round ? 'Round ' + m.round + (m.totalRounds ? ' of ' + m.totalRounds : '') : null), m.court, fmtSlot(m)].filter(Boolean).join(' • '))),
    h('div', { class: 'mc-row' },
      h('div', { class: 'mc-side' + (d.winner === 'A' ? ' win' : '') }, A),
      h('div', { class: 'mc-mid' }, mid),
      h('div', { class: 'mc-side right' + (d.winner === 'B' ? ' win' : '') }, B)),
    d.status === 'live' && ev.scoring === 'points' && d.current ? h('div', { class: 'mc-live' }, 'Game ' + (d.games.length + 1) + ': ' + d.current.a + ' – ' + d.current.b) : null,
    d.tie ? h('div', { class: 'mc-games' }, d.rubbers.filter((x) => x.status !== 'scheduled').map((x) => x.name + ' ' + (x.status === 'completed' ? (x.winner === 'A' ? '✓' : '✗') + ' ' + E.scoreText(x) : '● ' + (x.current ? x.current.a + '–' + x.current.b : ''))).join(' • ') || 'Line-ups and rubbers: tap to open') : null,
    !d.tie && (d.games.length || d.outcome) ? h('div', { class: 'mc-games' }, [d.outcome ? OUT[d.outcome].trim() : '', d.outcome === 'walkover' || d.outcome === 'dq' ? '' : E.scoreText(d)].filter(Boolean).join(' • ')) : null,
    !picking && ((d.status === 'scheduled' && canNotify(ev)) || canManage(ev)) ? h('div', { class: 'mc-notify noprint' },
      m.notified && d.status === 'scheduled' ? h('span', { class: renumbered(m) ? 'warn small' : 'muted small' }, renumbered(m) ? '⚠ Number changed since notified (was #' + m.notified.no + ')' : '🔔 Notified ' + ago(m.notified.at)) : h('span'),
      h('span', { class: 'mc-btns' }, notifyBtn(m, ev, d), canManage(ev) ? cardBtn('✏️', 'Edit', () => fixtureModal(ev.id, m)) : null,
        canManage(ev) ? cardBtn('🗑', 'Delete', () => confirmBox(delMsg(m, m.rubbers && m.rubbers.length ? 'tie' : 'match') + (d.status !== 'scheduled' ? ' It already has scores.' : '') + ' It goes to Trash for 30 days.', guard(async () => { await api('DELETE', '/api/admin/matches/' + m.id); toast('Deleted – restore it from Admin → Trash'); await refresh(); }), 'Delete'), 'danger-t') : null)) : null);
}

function standingsRows(ev, rows, qualText) {
  const pts = ev.scoring === 'points';
  const isTeam = ev.sideType === 'team', rub = (ev.rubbers || []).length > 0, swiss = (ev.format || {}).type === 'swiss';
  const head = pts ? ['#', isTeam ? 'Team' : 'Player', 'P', 'W', 'L', 'Pts'].concat(rub ? ['Rub'] : [], swiss ? ['BH'] : [], ['Tally', '+/−']) : ['#', 'Player', 'P', 'W', 'D', 'L', 'Pts'].concat(swiss ? ['BH'] : []);
  const tally = pts ? 5 + (rub ? 1 : 0) + (swiss ? 1 : 0) + 1 : -1, ptsCol = 5;
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, head.map((x, i) => h('th', { class: i === 1 ? 'l' : '' }, x)))),
    h('tbody', {}, rows.map((r) => {
      const nm = h('span', {}, nameOf(ev, r.id) + ((ev.withdrawn || []).includes(r.id) ? ' (withdrawn)' : ''));
      const link = ev.sideType === 'player' ? h('a', { href: '#/player/' + r.id }, nm) : nm;
      const cells = pts
        ? [r.rank, link, r.played, r.won, r.lost, r.mp].concat(rub ? [r.rw + '–' + r.rl] : [], swiss ? [r.bh] : [], [r.pf, (r.pd > 0 ? '+' : '') + r.pd])
        : [r.rank, link, r.played, r.won, r.drawn, r.lost, r.mp].concat(swiss ? [r.bh] : []);
      return h('tr', { class: r.qualified ? 'q' : '' }, cells.map((c, i) => h('td', { class: (i === 1 ? 'l ' : '') + (pts && ev.config.rankBy === 'tally' && i === tally ? 'em' : '') + (pts && ev.config.rankBy !== 'tally' && i === ptsCol ? 'em' : '') }, c)));
    }))));
}
function standingsTable(ev) {
  const live = S.matches.map(liveMatch);
  const fmt = ev.format || {}, pts = ev.scoring === 'points';
  const rankTxt = pts ? 'Ranked by ' + (ev.config.rankBy === 'tally' ? 'tally' : 'points') + ((ev.rubbers || []).length ? ', then rubbers won minus lost' : '') + (fmt.type === 'swiss' ? ', then Buchholz (the strength of opponents met)' : '') + (ev.config.h2hFirst && ev.sideSize === 1 ? ', then the head-to-head result (two-way ties), then point difference.' : ', then point difference.') : 'Ranked by points, then wins.' + (fmt.type === 'swiss' ? ' Ties: Buchholz (the strength of opponents met).' : '');
  if (fmt.type === 'groups' && ev.groups) {
    const tabs = E.groupTables(ev, live);
    return h('div', {}, tabs.map((t) => h('div', {}, h('h3', {}, 'Group ' + t.group), standingsRows(ev, t.rows))),
      h('p', { class: 'muted small' }, 'Top ' + fmt.qualifiers + ' of each group go through to the knockout (highlighted). ' + rankTxt));
  }
  if (fmt.type === 'knockout') return ev.bracket ? h('p', { class: 'muted small' }, 'Knockout event: see the Bracket tab.') : h('p', { class: 'empty' }, 'The bracket has not been drawn yet.');
  const rows = E.standings(ev, live);
  const nf = E.finalistsFor(ev), note = nf && fmt.type !== 'groups' ? (nf === 2 ? 'Top 2 play the final' : 'Top ' + nf + ' go to the semi-finals') + ' (highlighted)' + (ev.config.smallBelow ? ' – with fewer than ' + ev.config.smallBelow + ' players it is a straight final.' : '.') : '';
  const ci = E.cutoffInfo(rows, fmt.type === 'groups' ? 0 : nf);
  return h('div', {}, ci.tie ? h('div', { class: 'card warnbox' }, '⚠ Tie at the cut-off: ' + ci.count + ' players are level for the ' + ci.places + ' finals places. The organizer decides (for example a Play-off fixture).') : null,
    standingsRows(ev, rows), rows.length ? h('p', { class: 'muted small' }, [note, rankTxt].filter(Boolean).join(' ')) : h('p', { class: 'empty' }, 'No participants enrolled yet.'));
}

/* Knockout bracket: one column per round. */
function bracketView(ev) {
  const rounds = E.bracket(ev, S.matches.map(liveMatch));
  if (!rounds) return h('p', { class: 'empty' }, 'The bracket has not been drawn yet.');
  const nm = (id) => (id == null ? '—' : nameOf(ev, id));
  const third = S.matches.find((m) => m.eventId === ev.id && m.stage === 'Third place');
  const cell = (pr) => {
    const m = pr.match ? liveMatch(pr.match) : null, d = m ? E.derive(m, ev) : null;
    const row = (id, side) => h('div', { class: 'br-row' + (pr.winner === id && id != null ? ' win' : ''), }, h('span', { class: 'br-n' }, nm(id)), h('span', { class: 'br-s' }, d && d.status !== 'scheduled' && pr.match ? (pr.match.sideA[0] === id ? d.gamesA : d.gamesB) : ''));
    const inner = pr.bye ? [row(pr.a), h('div', { class: 'br-row muted' }, 'bye')] : [row(pr.a), row(pr.b)];
    return pr.match ? h('a', { class: 'br-m ' + (d ? d.status : ''), href: '#/match/' + pr.match.id }, inner) : h('div', { class: 'br-m' + (pr.bye ? ' bye' : '') }, inner);
  };
  const size = ev.bracket.order.length;
  const cols = rounds.map((r) => h('div', { class: 'br-col' }, h('div', { class: 'br-h' }, r.stage), r.pairs.map(cell)));
  for (let k = rounds.length; 2 ** (k + 1) <= size; k++) {   /* rounds that cannot be played yet */
    const left = size / 2 ** k;
    cols.push(h('div', { class: 'br-col' }, h('div', { class: 'br-h' }, E.stageName(left)), Array.from({ length: left / 2 }, () => h('div', { class: 'br-m bye' }, h('div', { class: 'br-row muted' }, 'to be decided'), h('div', { class: 'br-row muted' }, 'to be decided')))));
  }
  const tp = third ? matchCard(third) : null;
  return h('div', {}, h('div', { class: 'bracket' }, cols), tp ? h('div', {}, h('h3', {}, 'Third place'), tp) : null);
}

function standingsText(ev) {
  const rows = E.standings(ev, S.matches.map(liveMatch));
  return S.tournament.name + ' – ' + ev.name + '\n' + rows.map((r) => r.rank + '. ' + nameOf(ev, r.id) + ' – ' + (ev.config.rankBy === 'tally' ? r.pf + ' tally' : r.mp + ' pts') + ' (W' + r.won + ' L' + r.lost + ')').join('\n');
}
async function shareText(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  await navigator.clipboard.writeText(text); toast('Copied – paste into WhatsApp');
}

function championBanner(ev) {
  const c = E.champion(ev, S.matches); if (!c) return null;
  const pod = E.podium(ev, S.matches);
  return h('div', { class: 'champ' }, '🏆 ', h('b', {}, sideLabel(ev, c.winnerIds)), h('div', { class: 'muted' }, 'Champion • Runner-up: ' + sideLabel(ev, c.runnerIds) + (pod && pod.third.length ? ' • Third: ' + sideLabel(ev, pod.third) : '')));
}

/* ------------------------------------------------------------------ views */
Views.home = () => {
  const ms = S.matches.map((m) => ({ m, d: E.derive(liveMatch(m), evOf(m) || { scoring: 'points', config: {} }) })).filter((x) => evOf(x.m) && secOf(evOf(x.m)) === ui.section && sportPass(evOf(x.m)));
  const live = ms.filter((x) => x.d.status === 'live'), next = ms.filter((x) => x.d.status === 'scheduled').slice(0, 4);
  const done = ms.filter((x) => x.d.status === 'completed').slice(-4).reverse();
  return h('div', {},
    sponsorStrip(), eventSwitcher(), seasonCard(), sectionTabs(), sportChips(),
    S.registration && S.registration.open ? h('a', { class: 'card tip', href: '#/register' }, '📝 Registration is open – tap here to register as a player') : null,
    isAdmin() && S.registration && S.registration.pending ? h('a', { class: 'card warnbox', href: '#/admin', onclick: () => { ui.adminTab = 'registration'; } }, '⏳ ' + S.registration.pending + ' registration(s) waiting for your approval') : null,
    live.length ? h('section', {}, h('h2', {}, h('span', { class: 'dot' }), 'Live now'), live.map((x) => matchCard(x.m, { event: true }))) : null,
    h('section', {}, h('h2', {}, 'Games – ' + curT().name), h('div', { class: 'grid' }, eventsOf(ui.section).filter(sportPass).map((ev) => {
      const rows = E.standings(ev, S.matches.map(liveMatch)).filter((r) => r.played > 0).slice(0, 3);
      const c = E.champion(ev, S.matches);
      return h('a', { class: 'card ev', href: '#/event/' + ev.id },
        h('div', { class: 'ev-name' }, ev.name),
        h('div', { class: 'muted small' }, (ev.participantIds || []).length + (ev.sideType === 'team' ? ' teams' : ' players') + ' • ' + S.matches.filter((m) => m.eventId === ev.id).length + ' matches'),
        c ? h('div', { class: 'ev-champ' }, '🏆 ' + sideLabel(ev, c.winnerIds))
          : h('ol', { class: 'ev-top' }, rows.map((r) => h('li', {}, nameOf(ev, r.id), h('span', {}, ev.config.rankBy === 'tally' ? r.pf : r.mp)))),
        !c && !rows.length ? h('div', { class: 'muted small' }, 'Not started') : null);
    }))),
    next.length ? h('section', {}, h('h2', {}, 'Up next'), next.map((x) => matchCard(x.m, { event: true }))) : null,
    done.length ? h('section', {}, h('h2', {}, 'Recent results'), done.map((x) => matchCard(x.m, { event: true }))) : null,
    !S.matches.length && isAdmin() ? h('div', { class: 'card tip' }, 'Welcome! Open ', h('a', { href: '#/admin' }, 'Admin'), ' to add players and teams, enrol them in events, then create fixtures.') : null);
};

const sponsorStep = () => Math.max(3, Number((S && S.tournament.sponsorSeconds) || 8));
const sponsorPage = (pages) => Math.floor(Date.now() / (sponsorStep() * 1000)) % Math.max(1, pages);
function sponsorStrip() {
  if (!S.sponsors.length && !isAdmin()) return null;
  const all = S.sponsors.length ? S.sponsors : [{ name: 'Your sponsor here' }, { name: 'Your sponsor here' }, { name: 'Your sponsor here' }];
  const pages = Math.ceil(all.length / 3), pg = sponsorPage(pages);
  const tiles = all.slice(pg * 3, pg * 3 + 3);
  return h('div', { class: 'sponsors', 'data-pages': pages, 'data-page': pg }, tiles.map((sp) => {
    const inner = sp.image ? h('img', { src: sp.image, alt: sp.name, loading: 'lazy' }) : h('span', {}, sp.name);
    return sp.url ? h('a', { href: sp.url, target: '_blank', rel: 'noopener', class: 'sp' }, inner) : h('div', { class: 'sp' + (sp.image ? '' : ' ph') }, inner);
  }));
}
/* rotate sponsors (home strip and big-screen footer) every "sponsorSeconds" */
setInterval(() => {
  if (!S || document.hidden || busy()) return;
  const strip = document.querySelector('.sponsors[data-pages]');
  if (strip && Number(strip.dataset.pages) > 1 && Number(strip.dataset.page) !== sponsorPage(Number(strip.dataset.pages))) render();
  const foot = document.querySelector('.tv-foot[data-n]');
  if (foot && Number(foot.dataset.n) > 1 && Number(foot.dataset.i) !== sponsorPage(Number(foot.dataset.n))) render();
}, 1000);

Views.event = (id) => {
  const ev = byId('events', id); if (!ev) return notFound();
  const tab = ui.eventTab[id] || ((ev.format || {}).type === 'knockout' ? 'bracket' : 'standings');
  const setTab = (t) => { ui.eventTab[id] = t; render(); };
  const ms = S.matches.filter((m) => m.eventId === id).map((m) => ({ m, d: E.derive(liveMatch(m), ev) }));
  const order = { live: 0, scheduled: 1, completed: 2 };
  ms.sort((a, b) => order[a.d.status] - order[b.d.status] || (a.d.status === 'completed' ? b.m.createdAt - a.m.createdAt : a.m.createdAt - b.m.createdAt));
  const fmt = ev.format || {}, hasKO = !!ev.bracket;
  const nextLabel = hasKO ? '🏁 Next round' : fmt.type === 'groups' ? '🏁 Create knockout' : '🏁 Create finals';
  const canNext = ev.sideSize === 2 ? ev.config.finalists > 0 : fmt.type === 'knockout' ? hasKO : (fmt.type === 'groups' || E.finalistsFor(ev) > 0);
  const hasDraw = hasKO || (ev.groups && Object.keys(ev.groups).length) || ms.length;
  const body = tab === 'bracket' ? h('div', {}, championBanner(ev), bracketView(ev))
    : tab === 'standings' ? h('div', {}, championBanner(ev), standingsTable(ev), hasKO && fmt.type !== 'knockout' ? h('div', {}, h('h3', {}, 'Knockout'), bracketView(ev)) : null)
    : tab === 'fixtures' ? h('div', {}, selectBar(ms.map((x) => x.m)), ms.length ? ms.map((x) => matchCard(x.m)) : h('p', { class: 'empty' }, 'No fixtures yet.'))
      : ev.sideType === 'team' && canManage(ev) ? teamBuilder(ev)
      : h('div', { class: 'list' }, (ev.participantIds || []).map((pid) => {
        if (ev.sideType === 'team') { const t = byId('teams', pid); return h('div', { class: 'row' }, h('b', {}, t ? t.name : '?'), h('span', { class: 'muted small' }, t ? t.memberIds.map((x) => (byId('players', x) || {}).name).join(', ') : '')); }
        const p = byId('players', pid); return h('a', { class: 'row', href: '#/player/' + pid }, avatar(p, 32), h('b', {}, p ? p.name : '?'));
      }));
  return h('div', {},
    h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/season' }, '‹'), h('h1', {}, ev.name), secOf(ev) === 'kids' ? h('span', { class: 'chip kids' }, 'Kids') : null),
    ev.note ? h('p', { class: 'muted small' }, ev.note) : null,
    h('p', { class: 'muted small' }, formatSummary(ev)),
    staffLine(ev),
    h('div', { class: 'seg' }, [(fmt.type === 'knockout' ? ['bracket', 'Bracket'] : null), ['standings', fmt.type === 'knockout' ? 'Table' : 'Standings'], ['fixtures', 'Fixtures (' + ms.length + ')'], ['people', ev.sideType === 'team' ? 'Teams' : 'Players']].filter(Boolean).map(([k, l]) => h('button', { class: tab === k || (!ui.eventTab[id] && k === 'bracket') ? 'on' : '', onclick: () => setTab(k) }, l))),
    h('div', { class: 'actions noprint' },
      isStaff() ? h('button', { class: 'btn ghost', onclick: () => window.print() }, '🖨 Print / PDF') : null,
      h('button', { class: 'btn ghost', onclick: () => shareText(standingsText(ev)) }, '↗ Share'),
      canManage(ev) ? h('button', { class: 'btn', onclick: () => needStaff(ev, () => fixtureModal(ev.id)) }, '+ Fixture') : null,
      canManage(ev) ? h('button', { class: 'btn ghost', onclick: () => needStaff(ev, () => generateModal(ev)) }, fmt.type === 'swiss' ? '⚡ Next Swiss round' : fmt.type === 'knockout' ? '⚡ Draw bracket' : fmt.type === 'groups' ? '⚡ Draw groups' : '⚡ Generate fixtures') : null,
      canManage(ev) && canNext ? h('button', { class: 'btn ghost', onclick: () => finalsFlow(ev) }, nextLabel) : null,
      canManage(ev) && hasDraw ? h('button', { class: 'btn ghost danger-t', onclick: () => resetDrawFlow(ev) }, '🗑 Delete all fixtures') : null,
      canManage(ev) ? h('button', { class: 'btn ghost', onclick: () => participantModal(ev) }, '⇄ Withdraw / replace') : null,
      canManage(ev) ? h('button', { class: 'btn ghost', onclick: () => eventModal(ev) }, '⚙ Game settings') : null),
    body);
};

function formatSummary(ev) {
  const f = ev.format || {}, n = (ev.participantIds || []).length;
  const parts = [{ roundrobin: 'Round robin', groups: f.groups + ' groups → knockout (top ' + f.qualifiers + ' per group)', knockout: 'Knockout', swiss: 'Swiss' + (f.swissRounds ? ', ' + f.swissRounds + ' rounds' : '') }[f.type || 'roundrobin']];
  if (f.type === 'roundrobin' && E.finalistsFor(ev)) parts.push(ev.config.smallBelow ? 'top ' + ev.config.finalists + ' to semi-finals, top ' + ev.config.finalistsSmall + ' to a straight final if under ' + ev.config.smallBelow + ' players (now: top ' + E.finalistsFor(ev) + ')' : 'top ' + E.finalistsFor(ev) + ' to the finals');
  if (f.thirdPlace) parts.push('third-place match');
  if ((ev.rubbers || []).length) parts.push('ties of ' + ev.rubbers.reduce((a, t) => a + (t.count || 1), 0) + ' rubbers');
  if (ev.ageMin || ev.ageMax) parts.push(ev.ageMin && ev.ageMax ? 'ages ' + ev.ageMin + '–' + ev.ageMax : ev.ageMax ? 'age ' + ev.ageMax + ' and under' : 'age ' + ev.ageMin + '+');
  return 'Format: ' + parts.join(' • ') + ' • ' + n + ' enrolled';
}

const fmtTime = (t) => new Date('1970-01-01T' + t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

function scheduleView(rows) {
  const timed = rows.filter((x) => x.m.startsAt).sort((a, b) => a.m.startsAt.localeCompare(b.m.startsAt) || (a.m.court || '').localeCompare(b.m.court || ''));
  const untimed = rows.filter((x) => !x.m.startsAt);
  const days = {};
  timed.forEach((x) => { const day = x.m.startsAt.slice(0, 10); (days[day] = days[day] || []).push(x); });
  return h('div', {},
    Object.entries(days).map(([day, list]) => {
      const byTime = {};
      list.forEach((x) => { const t = x.m.startsAt.slice(11); (byTime[t] = byTime[t] || []).push(x); });
      return h('section', {}, h('h2', {}, new Date(day + 'T00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })),
        Object.entries(byTime).map(([t, items]) => h('div', { class: 'slot' }, h('div', { class: 'slot-t' }, fmtTime(t)), h('div', { class: 'slot-m' }, items.map((x) => matchCard(x.m, { event: true })))))); }),
    untimed.length ? h('section', {}, h('h2', {}, 'Not scheduled yet'), untimed.map((x) => matchCard(x.m, { event: true }))) : null,
    !rows.length ? h('p', { class: 'empty' }, 'No matches yet.') : null);
}

function eventMatches() {
  const f = ui.matchFilter, evs = eventsOf(ui.section).filter(sportPass);
  if (f.event && !evs.some((e) => e.id === f.event)) f.event = '';
  const rows = S.matches.map((m) => ({ m, ev: evOf(m), d: E.derive(liveMatch(m), evOf(m)) })).filter((x) => x.ev && secOf(x.ev) === ui.section && sportPass(x.ev) && (!f.event || x.m.eventId === f.event) && (!f.status || x.d.status === f.status));
  const order = { live: 0, scheduled: 1, completed: 2 };
  rows.sort((a, b) => order[a.d.status] - order[b.d.status] || b.m.createdAt - a.m.createdAt);
  return h('div', {},
    sectionTabs(), sportChips(),
    h('div', { class: 'seg' }, [['list', 'List'], ['schedule', 'Schedule']].map(([k, l]) => h('button', { class: ui.matchView === k ? 'on' : '', onclick: () => { ui.matchView = k; render(); } }, l))),
    h('div', { class: 'filters' },
      h('select', { 'aria-label': 'Game', onchange: (e) => { f.event = e.target.value; render(); } }, h('option', { value: '' }, 'All games'), evs.map((e) => h('option', { value: e.id, selected: f.event === e.id }, e.name))),
      h('select', { 'aria-label': 'Status', onchange: (e) => { f.status = e.target.value; render(); } }, [['', 'Any status'], ['live', 'Live'], ['scheduled', 'Upcoming'], ['completed', 'Completed']].map(([v, l]) => h('option', { value: v, selected: f.status === v }, l)))),
    ui.matchView === 'schedule' ? null : selectBar(rows.map((x) => x.m)),
    ui.matchView === 'schedule' ? scheduleView(rows) : (rows.length ? rows.map((x) => matchCard(x.m, { event: true })) : h('p', { class: 'empty' }, 'No matches yet.')),
    canManageTour(curT()) && curT().status !== 'closed' ? h('button', { class: 'btn', onclick: () => { const ev = byId('events', f.event) || evs[0]; if (!ev) return toast('Create a game first', true); needStaff(ev, () => fixtureModal(ev.id)); } }, '+ Fixture') : null);
}
/* Top-level Matches: friendly ("raw") matches between any players, outside every event. */
Views.matches = () => {
  const ms = SA.matches.filter((m) => isFriendlyEv(byId('events', m.eventId))).map((m) => ({ m, d: E.derive(liveMatch(m), byId('events', m.eventId)) }));
  const order = { live: 0, scheduled: 1, completed: 2 }; ms.sort((a, b) => order[a.d.status] - order[b.d.status] || b.m.createdAt - a.m.createdAt);
  return h('div', {}, h('h1', {}, 'Friendly matches'),
    h('p', { class: 'muted small' }, 'Quick matches between any players, outside the events. Results count in players’ profiles and all-time rankings. Event matches are under 🏆 Event → Matches.'),
    isStaff() ? h('button', { class: 'btn', onclick: () => friendlyModal() }, '+ New match') : h('p', { class: 'muted small' }, 'Organizers and referees can start a friendly match.'),
    selectBar(ms.map((x) => x.m)), ms.length ? ms.map((x) => matchCard(x.m, { event: true })) : h('p', { class: 'empty' }, 'No friendly matches yet.'));
};
function friendlyModal() {
  const people = SA.players.filter((p) => p.status !== 'pending').sort((a, b) => a.name.localeCompare(b.name));
  const sport = h('select', {}, [['badminton', '🏸 Badminton'], ['tt', '🏓 Table tennis'], ['carrom', '🎯 Carrom'], ['chess', '♟️ Chess']].map(([v, l]) => h('option', { value: v }, l)));
  const kind = h('select', {}, h('option', { value: 'singles' }, 'Singles'), h('option', { value: 'doubles' }, 'Doubles'));
  const pick = () => h('select', {}, h('option', { value: '' }, '— choose player —'), people.map((p) => h('option', { value: p.id }, p.name + (p.section === 'kids' ? ' (kids)' : ''))));
  const a = [pick(), pick()], b = [pick(), pick()], court = h('input', { placeholder: 'Court / table (optional)' });
  const sides = h('div', {});
  const draw = () => { const n = kind.value === 'doubles' ? 2 : 1; sides.replaceChildren(h('div', { class: 'two' }, h('div', {}, h('b', {}, 'Side A'), a.slice(0, n)), h('div', {}, h('b', {}, 'Side B'), b.slice(0, n)))); };
  kind.addEventListener('change', draw); draw();
  modal('New friendly match', h('div', {}, field('Sport', sport), field('Format', kind), sides, field('Court', court)),
    [{ label: 'Start', fn: async () => { const n = kind.value === 'doubles' ? 2 : 1; const m = await api('POST', '/api/staff/friendly', { sport: sport.value, kind: kind.value, sideA: a.slice(0, n).map((x) => x.value), sideB: b.slice(0, n).map((x) => x.value), court: court.value }); await refresh(); location.hash = '#/match/' + m.id; } }]);
}

/* ------- match page: scoreboard + referee controls ------- */
Views.match = (id) => {
  const m = byId('matches', id); if (!m) return notFound();
  if (m.rubbers && m.rubbers.length && evOf(m) && evOf(m).sideType === 'team') return tieView(m);
  const ev = evOf(m), lm = liveMatch(m), d = E.derive(lm, ev);
  const staff = canScore(), A = sideLabel(ev, m.sideA), B = sideLabel(ev, m.sideB);
  const can = staff && d.status !== 'completed';
  const ref = refsOf(m);
  const side = (s, name) => {
    const gw = s === 'A' ? d.gamesA : d.gamesB, cur = d.current ? (s === 'A' ? d.current.a : d.current.b) : null;
    const win = d.winner === s;
    return h('div', { class: 'sb-side' + (win ? ' win' : '') },
      h('div', { class: 'sb-name' }, name),
      ev.scoring === 'points' ? h('div', { class: 'sb-pts' }, cur != null ? cur : (d.games.length ? d.games[d.games.length - 1][s === 'A' ? 'a' : 'b'] : 0)) : h('div', { class: 'sb-pts' }, d.status === 'completed' ? (d.draw ? '½' : win ? '1' : '0') : '–'),
      ev.scoring === 'points' ? h('div', { class: 'sb-games' }, 'Games ', h('b', {}, gw)) : null,
      can && ev.scoring === 'points' && ev.sport === 'carrom' ? h('button', { class: 'btn big', onclick: () => boardModal(m, ev, s, name) }, 'Board won') : null,
      can && ev.scoring === 'points' ? h('div', { class: 'sb-btns' }, ev.config.increments.map((inc) => h('button', { class: 'btn big', onclick: () => { if (navigator.vibrate) navigator.vibrate(12); queueOp(m.id, { type: 'point', s, inc }); } }, '+' + inc))) : null,
      can && ev.scoring === 'result' ? h('button', { class: 'btn big', onclick: () => confirmBox(name + ' won?', () => queueOp(m.id, { type: 'result', result: s }), 'Confirm') }, 'Winner') : null);
  };
  if (staff && navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  const np = pendingFor(m.id);
  return h('div', {},
    h('div', { class: 'page-h' }, h('a', { class: 'back', href: isFriendlyEv(ev) ? '#/matches' : '#/event/' + ev.id }, '‹'), h('h1', {}, ev.name + (m.no ? ' #' + m.no : ''))),
    h('div', { class: 'muted small center' }, [plannedTxt(m) ? 'Planned as #' + m.plannedNo : null, m.stage === 'League' && m.round ? 'Round ' + m.round + (m.totalRounds ? ' of ' + m.totalRounds : '') : m.stage, m.court, m.time, ref ? 'Referee: ' + ref.name : null].filter(Boolean).join(' • ')),
    h('div', { class: 'center' }, chip(d.status)),
    d.status === 'scheduled' && canNotify(ev) ? h('div', { class: 'actions center' }, notifyBtn(m, ev, d, 'ghost')) : null,
    h('div', { class: 'scoreboard' }, side('A', A), h('div', { class: 'sb-vs' }, 'VS'), side('B', B)),
    staff || isAdmin() ? playersChips(m, ev) : null,
    ev.scoring === 'points' && d.status !== 'completed' ? h('div', { class: 'center muted' }, 'Game ' + (d.games.length + 1) + ' of ' + ev.config.bestOf + ' • first to ' + ev.config.target + (ev.config.winBy > 1 ? ' (win by ' + ev.config.winBy + ')' : '')) : null,
    d.status === 'completed' ? h('div', { class: 'champ' }, d.draw ? 'Match drawn' : '🏆 ' + (d.winner === 'A' ? A : B) + ' won' + (d.games.length ? ' ' + Math.max(d.gamesA, d.gamesB) + '–' + Math.min(d.gamesA, d.gamesB) : '') + (d.outcome ? OUT[d.outcome] : '')) : null,
    d.games.length ? h('div', { class: 'card' }, h('b', {}, 'Games'), d.games.map((g, i) => h('div', { class: 'gline' }, h('span', {}, 'Game ' + (i + 1)), h('span', { class: g.winner === 'A' ? 'w' : '' }, g.a), '–', h('span', { class: g.winner === 'B' ? 'w' : '' }, g.b),
      ev.sideSize === 2 && ev.config.rankBy === 'tally' ? h('span', { class: 'muted small' }, '(each: ' + r2(g.a / 2) + ' / ' + r2(g.b / 2) + ')') : null))) : null,
    np ? h('div', { class: 'card tip' }, '📲 ' + np + ' update' + (np > 1 ? 's' : '') + ' saved on this phone – will sync when online.') : null,
    staff ? h('div', { class: 'actions' },
      (d.points || m.result || np) ? h('button', { class: 'btn ghost', onclick: () => queueOp(m.id, { type: 'undo' }) }, '↩ Undo last') : null,
      can ? h('button', { class: 'btn ghost', onclick: () => endEarlyModal(m, ev, A, B) }, 'End match early…') : null,
      can && ev.scoring === 'result' ? h('button', { class: 'btn ghost', onclick: () => queueOp(m.id, { type: 'result', result: 'D' }) }, 'Draw') : null) : h('p', { class: 'muted small center' }, 'Referees: sign in from the Menu to score this match.'),
    !isAdmin() && d.status !== 'scheduled' ? h('div', { class: 'actions noprint' }, h('button', { class: 'btn ghost sm', onclick: () => disputeModal(m) }, '⚑ Report a score problem')) : null,
    m.paper ? h('div', { class: 'card ' + (m.paper.signed ? 'tip' : 'warnbox') }, '📄 Score entered from a paper sheet – ' + (m.paper.signed ? 'signed off by the chief referee' : 'waiting for chief referee sign-off'), me.kind === 'chief' && !m.paper.signed ? h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/matches/' + m.id + '/paper/sign'); toast('Signed off'); await refresh(); }) }, '✔ Sign off')) : null) : null,
    canScore() && !m.rubbers && (d.status === 'scheduled' || me.kind === 'chief') ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => paperModal(m, ev) }, '📄 Enter from paper sheet')) : null,
    me.kind === 'chief' && d.status !== 'scheduled' ? h('div', { class: 'actions' }, ev.scoring === 'points' ? h('button', { class: 'btn ghost', onclick: () => scoresModal(m, ev, d) }, '✏ Correct scores') : null, h('button', { class: 'btn ghost', onclick: () => confirmBox('Reset all scores for this match?', guard(async () => { await api('POST', '/api/admin/matches/' + m.id + '/reset'); await refresh(); }), 'Reset') }, 'Reset scores')) : null,
    isAdmin() ? h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: () => fixtureModal(ev.id, m) }, 'Edit fixture'),
      h('button', { class: 'btn ghost', onclick: guard(async () => { await api('POST', '/api/admin/announce', { matchId: m.id }); toast('“Up next” notification sent'); }) }, '🔔 Call to court'),
      h('button', { class: 'btn danger', onclick: () => confirmBox(delMsg(m, 'match'), guard(async () => { await api('DELETE', '/api/admin/matches/' + m.id); location.hash = '#/event/' + ev.id; await refresh(); }), 'Delete') }, 'Delete')) : null,
    isAdmin() ? activityBox(m) : null);
};

/* ---------------------------------------------------------- team ties (rubbers) */
const rubPlayers = (r, s) => (s === 'A' ? r.sideA : r.sideB).map((id) => (byId('players', id) || {}).name || '?').join(' & ') || 'line-up not set';
const rubFull = (r) => r.sideA.length === (r.size === 2 ? 2 : 1) && r.sideB.length === (r.size === 2 ? 2 : 1);
const rubStarted = (r) => r.log.length || r.result || r.walkover;

function scorePanel(m, ev, rub, rd, can) {
  const rEv = E.rubberEvent(ev, rub), pts = ev.scoring === 'points';
  const A = rubPlayers(rub, 'A'), B = rubPlayers(rub, 'B'), q = (op) => queueOp(m.id, { ...op, rid: rub.id });
  const side = (s, name) => {
    const gw = s === 'A' ? rd.gamesA : rd.gamesB, cur = rd.current ? (s === 'A' ? rd.current.a : rd.current.b) : null, win = rd.winner === s;
    return h('div', { class: 'sb-side' + (win ? ' win' : '') },
      h('div', { class: 'sb-name' }, name),
      pts ? h('div', { class: 'sb-pts' }, cur != null ? cur : (rd.games.length ? rd.games[rd.games.length - 1][s === 'A' ? 'a' : 'b'] : 0)) : h('div', { class: 'sb-pts' }, rd.status === 'completed' ? (rd.draw ? '½' : win ? '1' : '0') : '–'),
      pts ? h('div', { class: 'sb-games' }, 'Games ', h('b', {}, gw)) : null,
      can && pts && rd.status !== 'completed' ? h('div', { class: 'sb-btns' }, rEv.config.increments.map((inc) => h('button', { class: 'btn big', onclick: () => { if (navigator.vibrate) navigator.vibrate(12); q({ type: 'point', s, inc }); } }, '+' + inc))) : null,
      can && !pts && rd.status !== 'completed' ? h('button', { class: 'btn big', onclick: () => confirmBox(name + ' won?', () => q({ type: 'result', result: s }), 'Confirm') }, 'Winner') : null);
  };
  return h('div', { class: 'card' },
    h('div', { class: 'muted small center' }, rub.name + (pts && rd.status !== 'completed' ? ' • Game ' + (rd.games.length + 1) + ' of ' + rEv.config.bestOf + ' • first to ' + rEv.config.target + (rEv.config.winBy > 1 ? ' (win by ' + rEv.config.winBy + ')' : '') : '')),
    h('div', { class: 'scoreboard' }, side('A', A), h('div', { class: 'sb-vs' }, 'VS'), side('B', B)),
    h('div', { class: 'actions' }, can && !pts && rd.status !== 'completed' ? h('button', { class: 'btn ghost', onclick: () => q({ type: 'result', result: 'D' }) }, 'Draw') : null,
      h('button', { class: 'btn ghost', onclick: () => { delete ui.rubber[m.id]; render(); } }, 'Close scoring')));
}

function lineupModal(m, ev) {
  const lm = liveMatch(m), isAd = isAdmin();
  const team = (id) => byId('teams', id) || { memberIds: [], name: '?' };
  const tA = team(m.sideA[0]), tB = team(m.sideB[0]);
  const opts = (t, g) => [['', '— choose —']].concat(t.memberIds.map((id) => byId('players', id)).filter((p) => p && (!g || !p.gender || p.gender === g)).map((p) => [p.id, p.name + (p.gender ? ' (' + p.gender + ')' : '')]));
  const rows = lm.rubbers.map((r) => {
    const size = r.size === 2 ? 2 : 1, locked = rubStarted(r) && !isAd;
    const mk = (t, cur) => Array.from({ length: size }, (_, i) => { const x = sel(opts(t, r.gender), cur[i] || ''); x.disabled = locked; return x; });
    return { r, a: mk(tA, r.sideA), b: mk(tB, r.sideB), locked };
  });
  const body = h('div', {}, h('p', { class: 'muted small' }, 'Pick who plays each rubber. Rubbers that have started cannot be changed by referees. Each player can play at most ' + ((ev.rubberRules || {}).maxPerPlayer || 2) + ' rubbers.'),
    rows.map((x) => h('div', { class: 'card' }, h('b', {}, x.r.name), h('span', { class: 'muted small' }, ' ' + (x.r.size === 2 ? 'doubles' : 'singles') + (x.r.gender ? ' • ' + (x.r.gender === 'F' ? 'women' : 'men') : '') + (x.locked ? ' • started' : '')),
      field(tA.name, h('div', {}, x.a)), field(tB.name, h('div', {}, x.b)))));
  modal('Line-up: ' + tA.name + ' vs ' + tB.name, body, [{ label: 'Save line-up', fn: async () => {
    const payload = rows.filter((x) => !x.locked).map((x) => ({ id: x.r.id, sideA: x.a.map((e) => e.value).filter(Boolean), sideB: x.b.map((e) => e.value).filter(Boolean) }));
    await api('POST', '/api/matches/' + m.id + '/lineup', { rubbers: payload }); toast('Line-up saved'); await refresh();
  } }]);
}

function tieView(m) {
  const ev = evOf(m), lm = liveMatch(m), d = E.derive(lm, ev);
  const staff = canScore(), A = sideLabel(ev, m.sideA), B = sideLabel(ev, m.sideB);
  const can = staff && d.status !== 'completed';
  const ref = refsOf(m), np = pendingFor(m.id);
  const total = d.rubbers.length, needW = Math.floor(total / 2) + 1, clinch = (ev.rubberRules || {}).clinch !== false;
  const selId = ui.rubber[m.id], selR = lm.rubbers.find((r) => r.id === selId);
  if (staff && navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  const cards = lm.rubbers.map((r, i) => {
    const rd = d.rubbers[i], full = rubFull(r);
    return h('div', { class: 'card rubber ' + rd.status + (selId === r.id ? ' sel' : '') },
      h('div', { class: 'rb-top' }, h('b', {}, r.name), h('span', { class: 'muted small' }, (r.size === 2 ? 'doubles' : 'singles') + (r.gender ? ' • ' + (r.gender === 'F' ? 'women' : 'men') : '')), chip(rd.status)),
      h('div', { class: 'rb-names' }, h('span', { class: rd.winner === 'A' ? 'w' : '' }, rubPlayers(r, 'A')), h('span', { class: 'muted' }, ' vs '), h('span', { class: rd.winner === 'B' ? 'w' : '' }, rubPlayers(r, 'B'))),
      (rd.games.length || rd.current) && rd.status !== 'scheduled' ? h('div', { class: 'muted small' }, rd.games.map((g) => g.a + '–' + g.b).join(', ') + (rd.current && rd.status === 'live' ? (rd.games.length ? ' • now ' : 'now ') + rd.current.a + '–' + rd.current.b : '')) : null,
      rd.outcome ? h('div', { class: 'muted small' }, OUT[rd.outcome].trim()) : null,
      h('div', { class: 'actions' },
        can && full && rd.status !== 'completed' ? h('button', { class: 'btn sm', onclick: () => { ui.rubber[m.id] = r.id; render(); } }, rd.status === 'live' ? 'Continue scoring' : 'Score this rubber') : null,
        can && !full ? h('span', { class: 'muted small' }, 'Set the line-up to start scoring') : null,
        me.kind === 'chief' && ev.scoring === 'points' ? h('button', { class: 'btn ghost sm', onclick: () => scoresModal(m, ev, d, r.id) }, '✏ Correct') : null));
  });
  return h('div', {},
    h('div', { class: 'page-h' }, h('a', { class: 'back', href: isFriendlyEv(ev) ? '#/matches' : '#/event/' + ev.id }, '‹'), h('h1', {}, ev.name + (m.no ? ' #' + m.no : ''))),
    h('div', { class: 'muted small center' }, [plannedTxt(m) ? 'Planned as #' + m.plannedNo : null, m.stage, m.court, fmtSlot(m), ref ? 'Referee: ' + ref.name : null].filter(Boolean).join(' • ')),
    h('div', { class: 'center' }, chip(d.status)),
    d.status === 'scheduled' && canNotify(ev) ? h('div', { class: 'actions center' }, notifyBtn(m, ev, d, 'ghost')) : null,
    h('div', { class: 'scoreboard' },
      h('div', { class: 'sb-side' + (d.winner === 'A' ? ' win' : '') }, h('div', { class: 'sb-name' }, A), h('div', { class: 'sb-pts' }, d.gamesA), h('div', { class: 'sb-games' }, 'rubbers won')),
      h('div', { class: 'sb-vs' }, 'VS'),
      h('div', { class: 'sb-side' + (d.winner === 'B' ? ' win' : '') }, h('div', { class: 'sb-name' }, B), h('div', { class: 'sb-pts' }, d.gamesB), h('div', { class: 'sb-games' }, 'rubbers won'))),
    d.status !== 'completed' ? h('div', { class: 'center muted small' }, total + ' rubbers' + (clinch ? ' • first to ' + needW + ' wins the tie' : ' • all are played')) : null,
    d.status === 'completed' ? h('div', { class: 'champ' }, d.draw ? 'Tie drawn ' + d.gamesA + '–' + d.gamesB : '🏆 ' + (d.winner === 'A' ? A : B) + ' won the tie ' + Math.max(d.gamesA, d.gamesB) + '–' + Math.min(d.gamesA, d.gamesB) + (d.outcome ? OUT[d.outcome] : '')) : null,
    np ? h('div', { class: 'card tip' }, '📲 ' + np + ' update' + (np > 1 ? 's' : '') + ' saved on this phone – will sync when online.') : null,
    selR && can ? scorePanel(m, ev, selR, d.rubbers[lm.rubbers.indexOf(selR)], can) : null,
    h('div', {}, cards),
    staff ? h('div', { class: 'actions' },
      d.status !== 'completed' || d.points || m.result || m.walkover ? h('button', { class: 'btn ghost', onclick: () => queueOp(m.id, { type: 'undo' }) }, '↩ Undo last') : null,
      h('button', { class: 'btn ghost', onclick: () => lineupModal(m, ev) }, '👥 Set line-ups'),
      can ? h('button', { class: 'btn ghost', onclick: () => endEarlyModal(m, ev, A, B) }, 'End tie early…') : null) : h('p', { class: 'muted small center' }, 'Referees: sign in from the Menu to score this tie.'),
    !isAdmin() && d.status !== 'scheduled' ? h('div', { class: 'actions noprint' }, h('button', { class: 'btn ghost sm', onclick: () => disputeModal(m) }, '⚑ Report a score problem')) : null,
    me.kind === 'chief' && d.status !== 'scheduled' ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => confirmBox('Reset all scores for this tie?', guard(async () => { await api('POST', '/api/admin/matches/' + m.id + '/reset'); await refresh(); }), 'Reset') }, 'Reset scores')) : null,
    isAdmin() ? h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: () => fixtureModal(ev.id, m) }, 'Edit fixture'),
      h('button', { class: 'btn ghost', onclick: guard(async () => { await api('POST', '/api/admin/announce', { matchId: m.id }); toast('“Up next” notification sent'); }) }, '🔔 Call to court'),
      h('button', { class: 'btn danger', onclick: () => confirmBox(delMsg(m, 'tie'), guard(async () => { await api('DELETE', '/api/admin/matches/' + m.id); location.hash = '#/event/' + ev.id; await refresh(); }), 'Delete') }, 'Delete')) : null,
    isAdmin() ? activityBox(m) : null);
}

function endEarlyModal(m, ev, A, B) {
  const kind = h('select', { 'aria-label': 'What happened' }, [['walkover', 'No-show / walkover – full score awarded'], ev.scoring === 'points' ? ['retired', 'Retired / injured – opponent wins, remaining points awarded'] : null, ['dq', 'Disqualified – full score awarded']].filter(Boolean).map(([v, l]) => h('option', { value: v }, l)));
  const win = h('select', { 'aria-label': 'Who wins' }, [['A', A + ' wins'], ['B', B + ' wins']].map(([v, l]) => h('option', { value: v }, l)));
  modal('End the match early', h('div', {}, field('What happened?', kind), field('Winner', win), h('p', { class: 'muted small' }, 'This is recorded in the activity log. Use “Undo last” to reverse it.')),
    [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Confirm', cls: 'danger', fn: () => {
      const w = win.value;
      if (kind.value === 'retired') queueOp(m.id, ev.scoring === 'points' ? { type: 'retire', s: w === 'A' ? 'B' : 'A' } : { type: 'result', result: w, reason: 'retired' });
      else queueOp(m.id, { type: 'walkover', s: w, reason: kind.value === 'dq' ? 'dq' : 'walkover' });
    } }]);
}
/* Carrom: score one finished board = coins left × coin weight (+ queen if covered and the scorer is below the cutoff) */
function boardModal(m, ev, s, name) {
  const c = ev.config, coins = h('input', { type: 'number', min: 0, max: 9, value: 0, inputmode: 'numeric', 'aria-label': 'Opponent coins left on the board' });
  const queen = h('input', { type: 'checkbox' });
  const out = h('div', { class: 'muted small' });
  const calc = () => { const cur = E.derive(liveMatch(m), ev).current || { a: 0, b: 0 }, mine = s === 'A' ? cur.a : cur.b; const q = queen.checked && mine < (c.queenCutoff != null ? c.queenCutoff : 22); out.textContent = 'Adds ' + ((Number(coins.value) || 0) * (c.coinWeight != null ? c.coinWeight : 1) + (q ? (c.queenWeight != null ? c.queenWeight : 3) : 0)) + ' point(s)' + (queen.checked && !q ? ' (queen bonus no longer counts at ' + (c.queenCutoff != null ? c.queenCutoff : 22) + '+)' : ''); };
  coins.oninput = calc; queen.onchange = calc; calc();
  modal('Board won by ' + name, h('div', {}, field('Opponent coins left on the board', coins, 'Each is worth ' + (c.coinWeight != null ? c.coinWeight : 1) + ' point(s)'), h('label', { class: 'chk' }, queen, 'Queen covered (worth ' + (c.queenWeight != null ? c.queenWeight : 3) + ')'), out),
    [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Add board', fn: () => { queueOp(m.id, { type: 'board', s, coins: Number(coins.value) || 0, queen: queen.checked }); } }]);
}
/* Discipline: green by default, yellow warning, red = next two games lost */
function playersChips(m, ev) {
  if (ev.sideType !== 'player') return null;
  const ids = [...m.sideA, ...m.sideB];
  return h('div', { class: 'chips center' }, ids.map((id) => { const p = byId('players', id); return p ? h('button', { class: 'chip plain', onclick: () => canScore() ? cardModal(m, p) : null }, bubble(id), ' ', p.name) : null; }));
}
function cardModal(m, p) {
  const reason = h('input', { placeholder: 'Reason (optional)', maxlength: 120 }), c = p.card || {};
  const send = (color) => guard(async () => { await api('POST', '/api/matches/' + m.id + '/card', { playerId: p.id, color, reason: reason.value }); toast(color === 'red' ? 'Red card: next two games are lost' : 'Yellow card recorded'); await refresh(); });
  modal('Card for ' + p.name, h('div', {}, h('p', { class: 'muted small' }, 'Now: ' + (c.bubble === 'red' ? 'suspended for ' + c.left + ' more game(s)' : c.yellow || c.red ? c.yellow + ' yellow, ' + c.red + ' red on record' : 'clean record')), field('Reason', reason),
    h('div', { class: 'actions' }, h('button', { class: 'btn', style: 'background:#eab308;color:#000', onclick: send('yellow') }, '🟨 Yellow – warning'), h('button', { class: 'btn danger', onclick: () => confirmBox('Red card: ' + p.name + ' cannot play their next two games. Confirm?', send('red'), 'Issue red card') }, '🟥 Red – next 2 games lost'))),
    [{ label: 'Close', cls: 'ghost', fn: () => {} }]);
}
function disputeModal(m) {
  const text = h('textarea', { rows: 3, maxlength: 300, placeholder: 'What looks wrong? e.g. Game 2 was 11–9, not 11–8' });
  const name = h('input', { placeholder: 'Your name (optional)', maxlength: 40 }), contact = h('input', { placeholder: 'Phone or email (optional)', maxlength: 60 });
  modal('Report a score problem', h('div', {}, field('What is wrong?', text), field('Your name', name), field('How can we reach you?', contact), h('p', { class: 'muted small' }, 'The organisers will check this with the referee.')),
    [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Send report', fn: async () => { await api('POST', '/api/disputes', { matchId: m.id, text: text.value, name: name.value, contact: contact.value }); toast('Thanks – the organisers have been told'); } }]);
}

function activityBox(m) {
  const box = h('div', { class: 'card small' }, h('b', {}, 'Activity'), h('div', { class: 'muted' }, 'Loading…'));
  const by = {}; m.log.forEach((e) => { by[e.by || '?'] = (by[e.by || '?'] || 0) + 1; });
  api('GET', '/api/admin/audit?matchId=' + m.id).then((rows) => {
    box.replaceChildren(...[h('b', {}, 'Activity'),
      Object.keys(by).length ? h('div', { class: 'muted' }, 'Points entered by: ' + Object.entries(by).map(([k, v]) => k + ' (' + v + ')').join(', ')) : null,
      ...(rows.length ? rows.slice(0, 12).map((a) => h('div', { class: 'muted' }, new Date(a.t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) + ' • ' + a.who + ' • ' + a.action + (a.detail ? ' (' + a.detail + ')' : ''))) : [h('div', { class: 'muted' }, 'No corrections or admin actions.')])].filter(Boolean));
  }).catch(() => box.remove());
  return box;
}

/* ------- players ------- */
Views.players = () => {
  let q = '';
  const list = h('div', { class: 'list' });
  const draw = () => {
    list.replaceChildren(...S.players.filter((p) => (p.section || 'adults') === ui.section && p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const st = playerStats(p.id).totals;
      return h('a', { class: 'row', href: '#/player/' + p.id }, avatar(p, 40), h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'muted small' }, [p.status === 'pending' ? '⏳ Pending approval' : '', p.ageGroup, st.played + ' played', st.won + ' won'].filter(Boolean).join(' • '))));
    }));
    if (!list.children.length) list.append(h('p', { class: 'empty' }, S.players.length ? 'No players in this section.' : 'No players yet.'));
  };
  const wrap = h('div', {}, h('h1', {}, 'Players'), sectionTabs(), h('input', { class: 'search', type: 'search', 'aria-label': 'Search players', placeholder: 'Search players…', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }), list,
    isAdmin() ? h('button', { class: 'btn fab', onclick: () => playerModal(null, ui.section) }, '+ Player') : null);
  draw(); return wrap;
};

/* ------- events: several can run side by side (e.g. "CSSL - Season 3" and a kids' cup); closed ones stay read-only ------- */
function seasonCard() {
  const t = S.tournament;
  const ds = S.matches.filter((m) => evOf(m)).map((m) => E.derive(liveMatch(m), evOf(m)).status);
  const done = ds.filter((x) => x === 'completed').length;
  const status = !ds.length || ds.every((x) => x === 'scheduled') ? 'Upcoming' : done === ds.length ? 'Completed' : 'In progress';
  return h('a', { class: 'card season', href: '#/season' },
    h('div', { class: 'season-h' }, h('b', {}, '🏆 ' + curT().name), h('span', { class: 'chip plain' }, curT().status === 'closed' ? 'Closed' : status)),
    h('div', { class: 'muted small' }, [t.dates, t.venue, S.events.length + ' games', ds.length ? done + ' of ' + ds.length + ' matches played' : 'no fixtures yet'].filter(Boolean).join(' • ')),
    h('div', { class: 'muted small' }, 'Tap for games, organizers and referees ›'));
}
Views.seasons = () => {
  const fmt = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const ts = realTours().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), past = (SA.seasons || []).slice().reverse();
  return h('div', {}, h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/' }, '‹'), h('h1', {}, 'All events')),
    ts.map((t) => h('a', { class: 'card', href: '#/season', onclick: () => { ui.tid = t.id; store.set('tid', t.id); scope(); } },
      h('div', { class: 'season-h' }, h('b', {}, t.name), h('span', { class: 'chip ' + (t.status === 'closed' ? 'plain' : 'live') }, t.status === 'closed' ? 'Closed' : 'Open')),
      h('div', { class: 'muted small' }, [t.dates, SA.events.filter((e) => e.tid === t.id).length + ' games', (t.playerIds || []).length + ' players', 'started ' + fmt(t.createdAt)].filter(Boolean).join(' • ')))),
    past.length ? h('h2', {}, 'Archived seasons') : null,
    past.map((x) => h('div', { class: 'card' }, h('b', {}, x.name), h('div', { class: 'muted small' }, fmt(x.startedAt) + ' – ' + fmt(x.endedAt) + ' • ' + x.matches + ' matches'),
      x.champions.length ? h('div', { class: 'list' }, x.champions.map((c) => h('div', { class: 'small' }, h('b', {}, c.event + (c.section === 'kids' ? ' (kids)' : '') + ': '), '🥇 ' + c.first + (c.second ? ' • 🥈 ' + c.second : '') + (c.third ? ' • 🥉 ' + c.third : '')))) : null)));
};

/* ------- the Event (season) page: games with their organizer and referees, referees, organizers ------- */
const KIND_LABEL = (ev) => (ev.sideType === 'team' ? 'Team event' : ev.sideSize === 2 ? 'Individual – doubles' : 'Individual – singles');
function staffLine(ev) {
  const miss = staffMissing(ev);
  const orgs = (ev.organizerIds || []).map(orgName).filter(Boolean), refs = (ev.refereeIds || []).map(refName).filter(Boolean);
  return h('div', { class: 'card staff' + (miss.length ? ' warnbox' : '') },
    h('div', { class: 'small' }, '👔 Organizer: ', h('b', {}, [...new Set(orgs.concat(((tourById(ev.tid) || {}).organizerIds || []).map(orgName).filter(Boolean)))].join(', ') || '—'), ' • 🧑‍⚖️ Referees: ', h('b', {}, refs.join(', ') || '— not set —')),
    miss.length && canManage(ev) ? h('div', { class: 'small' }, '⚠ This game needs ' + miss.join(' and ') + ' before fixtures can be made.') : null,
    canManage(ev) && !isFriendlyEv(ev) ? h('button', { class: 'btn ghost sm', onclick: () => staffModal(ev) }, miss.length ? 'Assign referee' : 'Change referees') : null);
}
const needStaff = (ev, go) => { const miss = staffMissing(ev); if (!miss.length) return go(); toast('First assign ' + miss.join(' and ') + ' to ' + ev.name, true); staffModal(ev); };
Views.season = (sub) => {
  const T = curT(), tab = sub || ui.seasonTab || 'games', mine = canManageTour(T), closed = T.status === 'closed';
  const setTab = (k) => { ui.seasonTab = k; location.hash = '#/season/' + k; };
  const roster = new Set(T.playerIds || []);
  const tabs = [['games', 'Games'], ['matches', 'Matches'], ['teams', 'Teams'], ['players', 'Players (' + roster.size + ')'], ['referees', 'Referees'], ['organizers', 'Organizers']];
  const games = (sec) => eventsOf(sec).map((ev) => {
    const miss = staffMissing(ev), waiting = ev.sideType === 'team' ? (ev.interestedIds || []).filter((id) => !(ev.participantIds || []).some((tid) => ((byId('teams', tid) || {}).memberIds || []).includes(id))).length : 0;
    return h('a', { class: 'card ev', href: '#/event/' + ev.id },
      h('div', { class: 'season-h' }, h('b', {}, (SPORT_ICON[ev.sport] || '🏅') + ' ' + ev.name), h('span', { class: 'chip plain' }, KIND_LABEL(ev))),
      h('div', { class: 'muted small' }, [(ev.participantIds || []).length + (ev.sideType === 'team' ? ' teams' : ' players'), waiting ? waiting + ' waiting for a team' : '', S.matches.filter((m) => m.eventId === ev.id).length + ' matches'].filter(Boolean).join(' • ')),
      h('div', { class: 'small' }, '🧑‍⚖️ ' + ((ev.refereeIds || []).map(refName).filter(Boolean).join(', ') || '—')),
      miss.length && isAdmin() ? h('div', { class: 'small bad' }, '⚠ needs ' + miss.join(' and ')) : null);
  });
  const names = (ids, f) => (ids || []).map(f).filter(Boolean);
  const body = tab === 'matches' ? eventMatches()
    : tab === 'teams' ? eventTeams(T)
    : tab === 'players' ? eventPlayers(T)
    : tab === 'referees' ? h('div', {},
      h('div', { class: 'card' }, h('b', {}, '🧑‍⚖️ Referees of ' + T.name), h('div', { class: 'chips' }, names(T.refereeIds, refName).map((n) => h('span', { class: 'chip plain' }, n))),
        mine ? h('button', { class: 'btn ghost sm', onclick: () => tourStaffModal(T, 'referees') }, '+ Add / change referees') : null),
      isOrganizer() ? h('details', {}, h('summary', {}, 'All referee accounts, PINs and referee sign-up'), Views.referees(true)) : null)
    : tab === 'organizers' ? h('div', {},
      h('div', { class: 'card' }, h('b', {}, '👔 Organizers of ' + T.name), h('p', { class: 'muted small' }, 'The person who created the event and anyone added here manage everything in it: games, teams, players, fixtures and referees.' + (T.createdBy ? ' Created by ' + T.createdBy + '.' : '')),
        h('div', { class: 'chips' }, names(T.organizerIds, orgName).map((n) => h('span', { class: 'chip plain' }, n))),
        mine ? h('button', { class: 'btn ghost sm', onclick: () => tourStaffModal(T, 'organizers') }, '+ Add / change organizers') : null),
      isOrganizer() ? h('details', {}, h('summary', {}, 'All organizer accounts and PINs'), adminsCard()) : null)
    : h('div', {},
      mine && !closed ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => newGameModal() }, '+ New game'), isOrganizer() ? h('button', { class: 'btn ghost', onclick: () => shiftModal() }, '⏱ Running late?') : null) : null,
      ['adults', 'kids'].map((sec) => eventsOf(sec).length ? h('section', {}, h('h2', {}, SEC[sec]), h('div', { class: 'grid' }, games(sec))) : null),
      !S.events.length ? h('p', { class: 'empty' }, 'No games yet.' + (mine ? ' Tap “+ New game” – badminton, table tennis, carrom, chess…, individual or team.' : '')) : null);
  return h('div', {},
    eventSwitcher(),
    h('div', { class: 'season-h' }, h('h1', {}, '🏆 ' + T.name), closed ? h('span', { class: 'chip' }, 'Closed') : null, mine ? h('button', { class: 'btn ghost sm', onclick: () => tourDetailsModal(T) }, '⚙ Details') : null),
    h('p', { class: 'muted small' }, [T.dates, T.venue, S.events.length + ' games', roster.size + ' players', '👔 ' + (names(T.organizerIds, orgName).join(', ') || '—')].filter(Boolean).join(' • ')),
    h('div', { class: 'seg scroll' }, tabs.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => setTab(k) }, l))),
    body);
};
/* Which event you are looking at; anyone with a PIN can start a new one. */
function eventSwitcher() {
  const ts = realTours().slice().sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || (b.createdAt || 0) - (a.createdAt || 0));
  return h('div', { class: 'evswitch' },
    ts.length > 1 ? h('select', { 'aria-label': 'Event', onchange: (e) => pickEvent(e.target.value) }, ts.map((t) => h('option', { value: t.id, selected: t.id === curTid() }, t.name + (t.status === 'closed' ? ' (closed)' : '')))) : null,
    isStaff() ? h('button', { class: 'btn ghost sm', onclick: () => newEventModal() }, '+ New event') : null,
    ts.length && ts.every((t) => t.status === 'closed') ? h('div', { class: 'card tip small' }, 'No event is running right now – the ones below are closed and kept for results and rankings.' + (isStaff() ? ' Start one with “+ New event” when you need it.' : '')) : null);
}

/* ------- rankings: points for wins/draws plus medals, per sport or overall, this season or all-time ------- */
let rankCache = {};
function seasonRec() {
  if (rankCache.S !== S || rankCache.p !== pending.length) rankCache = { S, p: pending.length, cur: E.seasonRecords(S, S.matches.map(liveMatch)) };
  return rankCache.cur;
}
let allCache = {};
function allRec() { if (allCache.S !== SA || allCache.p !== pending.length) allCache = { S: SA, p: pending.length, rec: E.seasonRecords(SA, SA.matches.map(liveMatch)) }; return allCache.rec; }
const rankPts = () => ({ ...E.RANK_POINTS, ...(S.tournament.rankPts || {}) });
function rankRows(section, sport, period) {
  const sets = period === 'all' ? [allRec()].concat((SA.seasons || []).map((x) => x.records)) : [seasonRec()];
  return E.rankings(sets, { sport, players: S.players.filter((p) => (p.section || 'adults') === section), pts: rankPts() });
}
const medalText = (x) => [x.gold ? '🥇' + (x.gold > 1 ? x.gold : '') : '', x.silver ? '🥈' + (x.silver > 1 ? x.silver : '') : '', x.bronze ? '🥉' + (x.bronze > 1 ? x.bronze : '') : ''].filter(Boolean).join(' ');
Views.rankings = () => {
  const r = (ui.rank = ui.rank || { sport: '', period: 'season' });
  const present = [...new Set(S.events.map((e) => e.sport))].filter((k) => SPORT_LABEL[k]);
  const rows = rankRows(ui.section, r.sport, r.period), P = rankPts();
  const seg = (opts, cur, set) => h('div', { class: 'seg' }, opts.map(([k, l]) => h('button', { class: cur === k ? 'on' : '', onclick: () => { set(k); render(); } }, l)));
  return h('div', {}, h('h1', {}, 'Player rankings'),
    h('p', { class: 'muted small' }, (r.period === 'all' ? 'All events, friendlies included' : curT().name) + ' • updates live as referees record scores'),
    sectionTabs(),
    seg([['season', 'This event'], ['all', 'All-time (every event)']], r.period, (k) => { r.period = k; }),
    present.length > 1 ? h('div', { class: 'sportchips', role: 'group', 'aria-label': 'Sport' }, [['', '🏆', 'Overall']].concat(present.map((k) => [k, SPORT_ICON[k], SPORT_LABEL[k]])).map(([k, i, l]) => h('button', { type: 'button', class: 'pill sp' + (r.sport === k ? ' on' : ''), 'aria-pressed': r.sport === k ? 'true' : 'false', onclick: () => { r.sport = k; render(); } }, i + ' ' + l))) : null,
    rows.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl rank' },
      h('thead', {}, h('tr', {}, ['#', 'Player', 'P', 'W', 'D', 'L', 'Win %', 'Medals', 'Pts'].map((x, i) => h('th', { class: i === 1 ? 'l' : '' }, x)))),
      h('tbody', {}, rows.map((x) => h('tr', {}, h('td', {}, x.rank <= 3 ? ['🥇', '🥈', '🥉'][x.rank - 1] : String(x.rank)), h('td', { class: 'l' }, h('a', { href: '#/player/' + x.id }, (byId('players', x.id) || { name: '?' }).name)),
        h('td', {}, x.played), h('td', {}, x.won), h('td', {}, x.drawn), h('td', {}, x.lost), h('td', {}, x.winPct + '%'), h('td', {}, medalText(x) || '–'), h('td', {}, h('b', {}, x.points)))))))
      : h('p', { class: 'empty' }, 'No completed matches yet' + (r.sport ? ' in ' + SPORT_LABEL[r.sport] : '') + '. Rankings appear as soon as referees finish matches.'),
    h('p', { class: 'muted small' }, 'Points: win ' + P.win + ' • draw ' + P.draw + (P.loss ? ' • loss ' + P.loss : '') + ' • champion +' + P.gold + ' • runner-up +' + P.silver + ' • third place +' + P.bronze + '. Ties: more wins, then win %, then point difference. Team events count for the players in the line-up.'),
    isOrganizer() ? h('button', { class: 'btn ghost sm', onclick: () => rankPtsModal() }, '⚙ Change points') : null);
};
function playerRankCard(p) {
  const sec = p.section || 'adults';
  const one = (sport, period) => { const rows = rankRows(sec, sport, period), x = rows.find((y) => y.id === p.id); return x ? { rank: x.rank, of: rows.length, pts: x.points } : null; };
  const items = [];
  const o = one('', 'season'); if (o) items.push(['Overall', o]);
  Object.keys(seasonRec()[p.id] || {}).filter((k) => SPORT_LABEL[k]).forEach((k) => { const x = one(k, 'season'); if (x) items.push([SPORT_ICON[k] + ' ' + SPORT_LABEL[k], x]); });
  { const a = one('', 'all'); if (a && realTours().length + (SA.seasons || []).length > 1) items.push(['All-time', a]); }
  if (!items.length) return null;
  return h('div', { class: 'card' }, h('b', {}, '🏅 Standings – ' + curT().name),
    h('div', { class: 'chips' }, items.map(([l, x]) => h('a', { class: 'chip plain', href: '#/rankings' }, l + ': #' + x.rank + ' of ' + x.of + ' • ' + x.pts + ' pts'))));
}

/* ------- referees: public list, organizer management, sign-up ------- */
/* A referee is offered for a game only when mapped to its sport (or that game). Chief referees cover every sport. */
const refFor = (r, ev) => !!(r && ev) && (r.kind === 'chief' || (r.sports || []).includes(ev.sport) || (r.eventIds || []).includes(ev.id));
const refSportsTxt = (r) => (r.kind === 'chief' ? 'all sports' : (r.sports || []).filter((k) => SPORT_LABEL[k]).map((k) => SPORT_ICON[k]).join(' ') || '⚠ no sport');
const REF_KIND_LABEL = { referee: 'Referee', chief: 'Chief referee', volunteer: 'Volunteer' };
Views.referees = (embedded) => {
  if (embedded !== true) { location.replace('#/season/referees'); return h('p', { class: 'empty' }, 'Loading…'); }
  const refs = S.referees.filter((r) => r.status !== 'pending');
  const organizer = isOrganizer();
  const assigned = (id) => { const ms = S.matches.filter((m) => (m.refereeIds || []).includes(id) && evOf(m)); return { n: ms.length, done: ms.filter((m) => E.derive(liveMatch(m), evOf(m)).status === 'completed').length }; };
  const scope = (r) => [...(r.sports || []).filter((k) => SPORT_LABEL[k]).map((k) => SPORT_ICON[k] + ' ' + SPORT_LABEL[k]), ...(r.eventIds || []).map((id) => (byId('events', id) || {}).name).filter(Boolean)];
  return h('div', {},
    S.tournament.refSignupOpen && !me.role ? h('a', { class: 'card tip', href: '#/refsignup' }, '🙋 Want to referee? Tap here to sign up – the organizers approve every referee.') : null,
    organizer ? refereesAdmin() : null,
    refs.length ? h('div', { class: 'list' }, refs.map((r) => { const c = assigned(r.id), sc = scope(r);
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, r.name),
        h('div', { class: 'muted small' }, [REF_KIND_LABEL[r.kind] || 'Referee', r.kind === 'chief' ? 'All sports' : sc.length ? sc.join(', ') : '⚠ No sport mapped – not offered for any game' + (organizer ? ' (tap Edit)' : ''), c.n ? c.done + ' of ' + c.n + ' assigned matches done' : ''].filter(Boolean).join(' • '))),
        organizer ? h('button', { class: 'btn ghost sm', onclick: () => refereeModal(r) }, 'Edit') : null); }))
      : h('p', { class: 'empty' }, 'No referees yet.' + (organizer ? '' : ' The organizers add them.')));
};
Views.refsignup = () => {
  const head = h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/season/referees' }, '‹'), h('h1', {}, 'Referee sign-up'));
  if (!S.tournament.refSignupOpen) return h('div', {}, head, h('p', { class: 'empty' }, 'Referee sign-up is closed. Please contact the organizers.'));
  const v = { website: '' };
  const name = h('input', { autocomplete: 'name', maxlength: 60 }), phone = h('input', { type: 'tel', autocomplete: 'tel', maxlength: 30 });
  const note = h('textarea', { rows: 2, maxlength: 200, placeholder: 'Experience, which days you are free (optional)' });
  const sports = [...new Set(S.events.map((e) => e.sport))].filter((k) => SPORT_LABEL[k]).map((k) => ({ k, cb: h('input', { type: 'checkbox' }) }));
  const box = h('div', { class: 'card' },
    h('p', { class: 'muted small' }, 'Sign up to referee at ' + curT().name + '. The organizers review every sign-up and give you a personal PIN to sign in.'),
    field('Your name', name), field('Phone', phone, 'Only the organizers see this.'),
    h('div', { class: 'field' }, h('span', {}, 'Sports you can referee'), h('div', { class: 'checks' }, sports.map((x) => h('label', { class: 'chk' }, x.cb, SPORT_ICON[x.k] + ' ' + SPORT_LABEL[x.k])))),
    field('Note', note),
    h('input', { class: 'hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', name: 'website', oninput: (e) => { v.website = e.target.value; } }),
    h('button', { class: 'btn full', onclick: guard(async () => {
      await api('POST', '/api/referee-signup', { name: name.value, phone: phone.value, note: note.value, sports: sports.filter((x) => x.cb.checked).map((x) => x.k), website: v.website });
      box.replaceChildren(h('p', {}, '✅ Thanks, ' + name.value.trim() + '! The organizers will review your sign-up and give you a PIN. Then sign in from Menu → Sign in → Referee.'));
    }) }, 'Sign up'));
  return h('div', {}, head, box);
};

const SPORT_LABEL = { badminton: 'Badminton', tt: 'Table tennis', carrom: 'Carrom', chess: 'Chess', other: 'Other' };
const SPORT_ICON = { badminton: '🏸', tt: '🏓', carrom: '🎯', chess: '♟️', other: '🏅' };
const HAND = { R: 'Right-handed', L: 'Left-handed', B: 'Ambidextrous' };

Views.player = (id) => {
  const p = byId('players', id); if (!p) return notFound();
  const st = playerStats(id), T = st.totals;
  const stat = (v, l) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
  const games = T.gw + T.gl;
  const sports = p.sports || {};
  const entered = S.events.filter((e) => (e.participantIds || []).includes(id) || (e.sideType === 'team' && e.participantIds.some((t) => ((byId('teams', t) || { memberIds: [] }).memberIds).includes(id))));
  const sportKeys = ['badminton', 'tt', 'carrom', 'chess', 'other'].filter((k) => sports[k] || st.bySport[k] || entered.some((e) => e.sport === k));
  const cur = st.streak.current;
  const manual = p.achievements || [];
  const tbl = (head, rows) => h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map((x, i) => h('th', { class: i === 0 ? 'l' : '' }, x)))), h('tbody', {}, rows)));
  return h('div', {},
    h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/players' }, '‹'), h('h1', {}, p.name)),
    h('div', { class: 'profile' }, avatar(p, 88), h('div', { class: 'grow' },
      h('div', { class: 'chips' }, [p.playerNo, SEC[p.section || 'adults'], p.ageGroup, p.gender === 'F' ? 'Female' : p.gender === 'M' ? 'Male' : '', HAND[p.hand], p.affiliation].filter(Boolean).map((x) => h('span', { class: 'chip plain' }, x))),
      p.bio ? h('p', { class: 'bio' }, p.bio) : null,
      p.extHidden && !isAdmin() ? h('p', { class: 'muted small' }, 'Extended profile is private.') : null,
      isAdmin() ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost sm', onclick: () => playerModal(p) }, 'Edit profile')) : null)),
    playerRankCard(p),
    h('div', { class: 'stats' }, stat(T.played, 'Matches'), stat(T.won, 'Won'), stat(T.lost, 'Lost'), stat(T.played ? Math.round((T.won / T.played) * 100) + '%' : '–', 'Win rate'),
      stat(r2(T.pf), 'Tally'), stat((T.pf - T.pa > 0 ? '+' : '') + r2(T.pf - T.pa), 'Point diff'), stat(games ? T.gw + '–' + T.gl : '–', 'Games W–L'), stat(games ? r2(T.pf / games) : '–', 'Avg pts / game'), stat(st.honours.length + manual.length, 'Honours')),
    st.form.length ? h('div', { class: 'card' }, h('b', {}, 'Recent form'), h('div', { class: 'form' }, st.form.map((x) => h('span', { class: 'res ' + x }, x))),
      h('div', { class: 'muted small' }, (cur.count ? 'Current: ' + cur.count + (cur.type === 'W' ? ' win' : ' loss') + (cur.count > 1 ? (cur.type === 'W' ? ' streak' : ' in a row') : '') + ' • ' : '') + 'Best win streak: ' + st.streak.bestWin)) : null,
    sportKeys.length ? h('section', {}, h('h2', {}, 'Sports & style'), sportKeys.map((k) => {
      const sp = sports[k] || {}, rec = st.bySport[k];
      return h('div', { class: 'card sport' }, h('div', { class: 'sport-h' }, h('b', {}, (SPORT_ICON[k] || '') + ' ' + SPORT_LABEL[k]), sp.level ? h('span', { class: 'chip plain' }, sp.level) : null, sp.rating ? h('span', { class: 'chip plain' }, 'Rating ' + sp.rating) : null),
        sp.style ? h('div', {}, 'Style: ', h('b', {}, sp.style)) : null,
        h('div', { class: 'muted small' }, rec ? rec.played + ' played • ' + rec.won + ' won • ' + rec.lost + ' lost' + (rec.drawn ? ' • ' + rec.drawn + ' drawn' : '') : 'No matches yet'),
        entered.filter((e) => e.sport === k).length ? h('div', { class: 'muted small' }, 'Entered: ' + entered.filter((e) => e.sport === k).map((e) => e.name).join(', ')) : null);
    })) : null,
    (st.records.biggestWin || st.records.highestGame || st.streak.bestWin) ? h('section', {}, h('h2', {}, 'Personal records'),
      h('div', { class: 'list' },
        st.records.biggestWin ? h('a', { class: 'row', href: '#/match/' + st.records.biggestWin.matchId }, h('span', {}, '💪'), h('div', { class: 'grow' }, h('b', {}, 'Biggest win: +' + st.records.biggestWin.margin + ' points'), h('div', { class: 'muted small' }, st.records.biggestWin.score + ' vs ' + st.records.biggestWin.vs))) : null,
        st.records.highestGame ? h('a', { class: 'row', href: '#/match/' + st.records.highestGame.matchId }, h('span', {}, '🔥'), h('div', { class: 'grow' }, h('b', {}, 'Highest game score: ' + st.records.highestGame.score), h('div', { class: 'muted small' }, st.records.highestGame.event))) : null,
        st.streak.bestWin ? h('div', { class: 'row' }, h('span', {}, '📈'), h('div', { class: 'grow' }, h('b', {}, 'Longest win streak: ' + st.streak.bestWin))) : null)) : null,
    (st.honours.length || manual.length) ? h('section', {}, h('h2', {}, 'Honours & achievements'), h('div', { class: 'list' },
      st.honours.map((x) => h('div', { class: 'row' }, h('span', {}, x.place.startsWith('Champion') ? '🏆' : '🥈'), h('div', { class: 'grow' }, h('b', {}, x.place), h('div', { class: 'muted small' }, x.event)))),
      manual.map((x) => h('div', { class: 'row' }, h('span', {}, '🎖'), h('div', { class: 'grow' }, x))))) : null,
    st.partners.length ? h('section', {}, h('h2', {}, 'Doubles partners'), tbl(['Partner', 'Played', 'Won', 'Win %'], st.partners.map((x) => h('tr', {}, h('td', { class: 'l' }, h('a', { href: '#/player/' + x.id }, x.name)), h('td', {}, x.played), h('td', {}, x.won), h('td', {}, Math.round((x.won / x.played) * 100) + '%'))))) : null,
    st.h2h.length ? h('section', {}, h('h2', {}, 'Head-to-head'), tbl(['Opponent', 'P', 'W', 'L'], st.h2h.map((x) => h('tr', {}, h('td', { class: 'l' }, h('a', { href: '#/player/' + x.id }, x.name)), h('td', {}, x.played), h('td', {}, x.won), h('td', {}, x.lost))))) : null,
    st.per.length ? h('section', {}, h('h2', {}, 'By event'), tbl(['Event', 'P', 'W', 'L', 'Tally', '+/−'], st.per.map((r) => h('tr', {}, h('td', { class: 'l' }, h('a', { href: '#/event/' + r.ev.id }, r.ev.name)), h('td', {}, r.played), h('td', {}, r.won), h('td', {}, r.lost), h('td', {}, r2(r.pf)), h('td', {}, r2(r.pf - r.pa)))))) : null,
    (p.career || []).length ? h('section', {}, h('h2', {}, 'Past tournaments'), h('div', { class: 'list' }, p.career.slice().reverse().map((c) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, c.tournament + (c.dates ? ' • ' + c.dates : '')), h('div', { class: 'muted small' }, c.played + ' played • ' + c.won + 'W ' + c.lost + 'L' + (c.drawn ? ' ' + c.drawn + 'D' : '') + ' • tally ' + c.tally), (c.honours || []).map((x) => h('div', { class: 'small' }, '🏆 ' + x))))))) : null,
    h('section', {}, h('h2', {}, 'Match history'), st.history.length ? st.history.map((x) => h('a', { class: 'row hist', href: '#/match/' + x.m.id },
      h('span', { class: 'res ' + (x.res || 'none') }, x.res || '·'),
      h('div', { class: 'grow' }, h('b', {}, (x.partner ? 'with ' + x.partner + ' • ' : '') + 'vs ' + x.vs), h('div', { class: 'muted small' }, [x.ev.name, x.m.stage !== 'League' ? x.m.stage : '', x.via ? 'via ' + x.via : ''].filter(Boolean).join(' • '))),
      h('span', { class: 'muted small' }, x.score))) : h('p', { class: 'empty' }, 'No matches yet.')));
};

/* ------- gallery ------- */
/* Gallery: anyone with the link adds photos or videos and downloads them. Organizers remove anything; uploaders remove their own (key kept on this phone). */
const galKeys = () => store.get('galKeys', {});
function saveFile(url, name) { const a = h('a', { href: url, download: name || '' }); document.body.append(a); a.click(); a.remove(); }
const galName = (g, i) => 'photo-' + (i + 1) + (g.url.match(/\.\w+$/) || [''])[0];
Views.gallery = () => {
  const cap = h('input', { placeholder: 'Caption (optional)', 'aria-label': 'Caption', maxlength: 120 });
  const by = h('input', { placeholder: 'Your name (optional)', 'aria-label': 'Your name', maxlength: 40, value: me.role ? me.name : store.get('galBy', '') });
  const minors = h('input', { type: 'checkbox' }), ok = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'muted small' });
  const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true, onchange: guard(async (e) => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    if (!ok.checked) throw new Error('Please tick that you took these or may share them.');
    store.set('galBy', by.value.trim());
    let done = 0; const keys = galKeys(), failed = [];
    for (const f of files) {
      status.textContent = 'Uploading ' + (done + 1) + ' of ' + files.length + '…';
      try {
        const video = /^video\//.test(f.type);
        if (video && f.size > 200e6) throw new Error(f.name + ' is larger than 200 MB');
        const body = video ? f : await resizeImage(f, 1600, 'image/jpeg');
        const type = video ? (f.type === 'video/quicktime' || /\.mov$/i.test(f.name) ? 'video/quicktime' : f.type || 'video/mp4') : 'image/jpeg';
        const q = new URLSearchParams({ caption: cap.value, by: by.value.trim(), minors: minors.checked ? '1' : '' });
        const r = await fetch('/api/gallery/media?' + q, { method: 'POST', headers: { 'Content-Type': type, 'x-token': me.token || '' }, body });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed');
        keys[j.id] = j.deleteKey; done++;
      } catch (err) { failed.push(err.message); }
    }
    store.set('galKeys', keys); status.textContent = '';
    toast(done + ' added' + (failed.length ? ' • ' + failed.length + ' failed: ' + failed[0] : ''), !!failed.length); await refresh();
  }) });
  const picked = new Set(); let selecting = false;
  const grid = h('div', { class: 'gal' });
  const bar = h('div', { class: 'actions' });
  const drawBar = () => bar.replaceChildren(...(S.gallery.length ? [
    h('button', { class: 'btn ghost sm', onclick: () => { selecting = !selecting; picked.clear(); drawGrid(); drawBar(); } }, selecting ? 'Cancel' : '☑ Select to download'),
    selecting ? h('button', { class: 'btn ghost sm', onclick: () => { S.gallery.forEach((g) => picked.add(g.id)); drawGrid(); drawBar(); } }, 'Select all') : null,
    selecting ? h('button', { class: 'btn sm', onclick: () => { const list = S.gallery.filter((g) => picked.has(g.id)); list.forEach((g, i) => setTimeout(() => saveFile(g.url, galName(g, S.gallery.indexOf(g))), i * 600)); toast('Downloading ' + list.length + '…'); } }, '⬇ Download ' + picked.size) : null,
  ].filter(Boolean) : []));
  const open = (g, i) => {
    const mine = galKeys()[g.id];
    modal(g.caption || (g.type === 'video' ? 'Video' : 'Photo'), h('div', {},
      g.type === 'video' ? h('video', { src: g.url, controls: true, autoplay: true, playsinline: true, class: 'full' }) : h('img', { src: g.url, class: 'full', alt: g.caption || 'Photo' }),
      h('div', { class: 'muted small' }, [g.by ? 'by ' + g.by : '', g.ts ? new Date(g.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' • '))),
    [{ label: '⬇ Download', cls: 'ghost', close: false, fn: () => saveFile(g.url, galName(g, i)) },
      isAdmin() || mine ? { label: 'Remove', cls: 'danger', fn: async () => { const r = await fetch('/api/gallery/' + g.id, { method: 'DELETE', headers: { 'x-token': me.token || '', 'x-delete-key': mine || '' } }); if (!r.ok) throw new Error((await r.json()).error); toast('Removed'); await refresh(); } } : null].filter(Boolean));
  };
  const drawGrid = () => grid.replaceChildren(...S.gallery.map((g, i) => h('div', { class: 'gal-i' + (picked.has(g.id) ? ' picked' : ''), onclick: () => { if (selecting) { picked.has(g.id) ? picked.delete(g.id) : picked.add(g.id); drawGrid(); drawBar(); } else open(g, i); } },
    g.type === 'video' ? h('video', { src: g.url + '#t=0.5', preload: 'metadata', muted: true, playsinline: true }) : h('img', { src: g.url, loading: 'lazy', alt: g.caption || 'Tournament photo' }),
    g.type === 'video' ? h('span', { class: 'gal-play' }, '▶') : null,
    selecting ? h('span', { class: 'gal-check' }, picked.has(g.id) ? '✓' : '') : null)));
  drawGrid(); drawBar();
  return h('div', {}, h('h1', {}, 'Gallery'),
    h('div', { class: 'card' }, h('b', {}, '📷 Add photos or videos'), h('p', { class: 'muted small' }, 'Anyone can add pictures and videos of ' + (curT().name || 'the event') + '. Pick several at once. Videos up to 200 MB.'),
      by, cap, h('label', { class: 'chk' }, ok, 'I took these, or the people in them are happy for them to be shared'),
      h('label', { class: 'chk' }, minors, 'They show children (hidden from the public unless the organizers allow kids’ photos)'),
      h('div', { class: 'actions' }, input, h('button', { class: 'btn', onclick: () => input.click() }, '⬆ Choose photos / videos')), status),
    bar,
    S.gallery.length ? grid : h('p', { class: 'empty' }, 'No photos or videos yet – be the first!'));
};

/* ------- menu, login, notifications, theme ------- */
const urlB64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...b].map((c) => c.charCodeAt(0))); };

async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  return reg && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
async function enablePush(follow) {
  if (!window.isSecureContext) throw new Error('Notifications need a secure (https) link. Use the public link, not the Wi-Fi address.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Not supported here. On iPhone: Share → Add to Home Screen, then open the app from the Home Screen.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(S.vapidPublicKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), follow });
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
}

function langPicker() {
  const I = window.I18N; if (!I) return null;
  return h('label', { class: 'field langpick' }, h('span', {}, 'Language'), h('select', { 'aria-label': 'Language', onchange: (e) => { I.set(e.target.value); } }, I.langs.map((l) => h('option', { value: l, selected: I.lang === l }, I.names[l]))));
}
const isPrivateHost = () => /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

Views.menu = () => {
  const paperUp = h('input', { type: 'file', accept: '.xlsx', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (!f) return; const buf = await f.arrayBuffer(); e.target.value = ''; const r = await fetch('/api/staff/paper-upload', { method: 'POST', headers: { 'x-token': me.token, 'Content-Type': 'application/octet-stream' }, body: buf }).then((x) => x.json()); toast(r.applied + ' score' + (r.applied === 1 ? '' : 's') + ' saved' + (r.errors && r.errors.length ? ', ' + r.errors.length + ' rows skipped (first: row ' + r.errors[0].row + ' ' + r.errors[0].error + ')' : ''), !!(r.errors && r.errors.length)); await refresh(); }) });
  const theme = store.get('theme', 'auto');
  const link = BASE() + '/';
  const pushBox = h('div', { class: 'card' }, h('b', {}, '🔔 Notifications'), h('p', { class: 'muted small' }, 'Get alerts when matches start, finish or are called to court.'));
  const sel = h('select', { 'aria-label': 'What to follow' }, h('option', { value: '' }, 'All matches'),
    S.players.map((p) => h('option', { value: p.id }, 'Only ' + p.name + (p.section === 'kids' ? ' (kids)' : ''))), S.teams.map((t) => h('option', { value: t.id }, 'Only team ' + t.name)));
  pushState().then((st) => {
    if (st === 'unsupported') { pushBox.append(h('p', { class: 'muted small' }, 'Not supported in this browser. On iPhone, add the app to the Home Screen first.')); return; }
    pushBox.append(sel, h('div', { class: 'actions' }, st === 'on'
      ? [h('button', { class: 'btn ghost', onclick: guard(async () => { await disablePush(); toast('Notifications off'); render(); }) }, 'Turn off'),
        isAdmin() ? h('button', { class: 'btn ghost', onclick: guard(async () => { const r = await api('POST', '/api/admin/test-push'); toast('Test sent to ' + r.sent + ' of ' + r.subscribers + ' device(s)'); }) }, 'Send test') : null]
      : h('button', { class: 'btn', onclick: guard(async () => { await enablePush(sel.value ? [sel.value] : []); toast('Notifications on'); render(); }) }, 'Turn on')));
  });
  return h('div', {}, h('h1', {}, 'Menu'), h('div', { class: 'card' }, langPicker()),
    h('div', { class: 'card' }, me.role ? h('div', {}, h('b', {}, 'Signed in as ' + me.name), h('div', { class: 'muted small' }, me.role === 'captain' ? 'Team captain – set your line-ups' : me.role === 'admin' ? (me.sports && me.sports.length ? 'Sport lead' : 'Organizer') + ' – referees change scores, not organizers' : me.kind === 'chief' ? 'Chief referee – you can score and correct any match' : me.kind === 'volunteer' ? 'Volunteer – check-in and schedule' : 'Referee – you can score any match'),
      h('div', { class: 'actions' }, me.personId ? h('a', { class: 'btn ghost', href: '#/me' }, '👤 My profile') : null, isAdmin() ? h('a', { class: 'btn', href: '#/admin' }, 'Admin') : null, me.kind === 'chief' ? h('a', { class: 'btn', href: '#/flags' }, '⚑ Score reports') : null, canScore() ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: guard(() => downloadWith('/api/staff/paper-template.xlsx', 'paper-scores-template.xlsx')) }, '⬇ Paper-score Excel'), h('button', { class: 'btn ghost', onclick: () => paperUp.click() }, '⬆ Upload filled Excel')) : null, me.role === 'captain' ? h('a', { class: 'btn', href: '#/captain' }, '👥 My line-ups') : null, isAdmin() ? h('a', { class: 'btn ghost', href: '#/certs' }, 'Certificates') : null, h('button', { class: 'btn ghost', onclick: guard(async () => { await api('POST', '/api/logout').catch(() => {}); me = { role: null }; store.set('me', me); await load(); location.hash = '#/'; render(); }) }, 'Sign out')))
      : h('div', {}, h('b', {}, 'Referee or admin?'), h('p', { class: 'muted small' }, 'Sign in to score matches or manage the tournament.'), h('a', { class: 'btn', href: '#/login' }, 'Sign in'))),
    h('div', { class: 'card center' }, h('b', {}, '📲 Share this app'),
      isPrivateHost() ? h('p', { class: 'warnbox small' }, 'This address only works on this computer / Wi-Fi. Start the app with the public link so everyone can join from anywhere.') : null,
      h('img', { class: 'qr', src: '/api/qr.svg?text=' + encodeURIComponent(link), alt: 'QR code for ' + link }), h('div', { class: 'muted small wrap' }, link),
      h('div', { class: 'actions', style: 'justify-content:center' }, h('button', { class: 'btn ghost', onclick: guard(async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }) }, 'Copy link'),
        h('a', { class: 'btn ghost', href: 'https://wa.me/?text=' + encodeURIComponent((S.tournament.name || 'Tournament') + ' – live scores: ' + link), target: '_blank', rel: 'noopener' }, 'WhatsApp'))),
    S.registration && S.registration.open ? h('div', { class: 'card' }, h('b', {}, '📝 Register as a player'), h('p', { class: 'muted small' }, 'Playing in the tournament? Sign up here – the organisers approve every registration.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/register' }, 'Register'),
        isAdmin() ? h('button', { class: 'btn ghost', onclick: () => modal('Registration link', h('div', { class: 'center' }, h('img', { class: 'qr', src: '/api/qr.svg?text=' + encodeURIComponent(BASE() + '/#/register'), alt: 'Registration QR' }), h('div', { class: 'muted small wrap' }, BASE() + '/#/register'), h('p', { class: 'muted small' }, 'Share the join code separately (Admin → Registration).')), [{ label: 'Copy link', fn: async () => { await navigator.clipboard.writeText(BASE() + '/#/register'); toast('Link copied'); } }]) }, 'QR / link') : null)) : null,
    store.get('myProfile', null) ? h('div', { class: 'card' }, h('b', {}, 'My profile'), h('p', { class: 'muted small' }, 'You registered on this phone. Update your details any time.'), h('a', { class: 'btn ghost', href: '#/me/' + store.get('myProfile').id + '/' + store.get('myProfile').token }, 'Open my profile page')) : null,
    pushBox,
    h('div', { class: 'card' }, h('b', {}, 'Appearance'), h('div', { class: 'seg' }, ['auto', 'light', 'dark'].map((t) => h('button', { class: theme === t ? 'on' : '', onclick: () => { store.set('theme', t); applyTheme(); render(); } }, t[0].toUpperCase() + t.slice(1))))),
    h('div', { class: 'card' }, h('b', {}, 'Results & display'), h('div', { class: 'actions' }, isStaff() ? h('a', { class: 'btn ghost', href: '#/report' }, '🖨 Printable report (PDF)') : null,
      isAdmin() ? h('button', { class: 'btn ghost', onclick: guard(async () => { const r = await api('POST', '/api/admin/export-link'); location.href = r.url; }) }, '📊 Excel export (with contacts)') : isStaff() ? h('button', { class: 'btn ghost', onclick: guard(() => downloadWith('/api/export.xlsx', 'tournament-results.xlsx')) }, '📊 Excel export') : null,
      h('a', { class: 'btn ghost', href: '#/gallery' }, '📷 Gallery'), h('a', { class: 'btn ghost', href: '#/seasons' }, '📜 All events'), h('a', { class: 'btn ghost', href: '#/feed' }, '🔔 Updates'), h('a', { class: 'btn ghost', href: '#/tv' }, '📺 Big-screen mode'), isStaff() ? h('a', { class: 'btn ghost', href: '#/print' }, '🖨 Fixture & score sheets') : null)),
    h('div', { class: 'card muted small' }, h('b', {}, 'Install on your phone'), h('p', {}, 'Android (Chrome): menu ⋮ → Install app. iPhone (Safari): Share → Add to Home Screen. Works only on the https public link.')),
    h('p', { class: 'muted small center' }, offline ? 'Offline – showing last saved data' : 'Online'));
};

Views.flags = () => {
  if (me.kind !== 'chief' && !isAdmin()) return h('p', { class: 'empty' }, 'Chief referee only.');
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const draw = (rows) => box.replaceChildren(...(rows.length ? rows.map((f) => { const m = byId('matches', f.matchId), ev = m && byId('events', m.eventId);
    return h('div', { class: 'card' }, h('b', {}, ev ? ev.name + ' – ' + sideLabel(ev, m.sideA) + ' vs ' + sideLabel(ev, m.sideB) : 'Match'), h('p', {}, f.text), h('div', { class: 'muted small' }, new Date(f.at).toLocaleString() + (f.name ? ' • ' + f.name : '') + (f.contact ? ' • ' + f.contact : '')),
      f.resolved ? h('div', { class: 'chip ok' }, 'Resolved by ' + (f.by || '') + (f.note ? ': ' + f.note : '')) : h('div', { class: 'actions' }, m ? h('a', { class: 'btn ghost sm', href: '#/match/' + m.id }, 'Open match') : null, h('button', { class: 'btn sm', onclick: () => { const note = h('input', { placeholder: 'What was decided? (optional)', maxlength: 140 }); modal('Resolve report', field('Note', note), [{ label: 'Cancel', cls: 'ghost', fn: () => {} }, { label: 'Resolve', fn: async () => { await api('POST', '/api/staff/flags/' + f.id + '/resolve', { note: note.value }); load2(); await refresh(); } }]); } }, 'Resolve'))); }) : [h('p', { class: 'empty' }, 'No score reports.')]));
  const load2 = () => api('GET', '/api/staff/flags').then(draw).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  load2();
  return h('div', {}, h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/menu' }, '‹'), h('h1', {}, 'Score reports')), h('p', { class: 'muted small' }, 'Players flag a score they think is wrong. Review with the referee; correct it from the match page.'), box);
};
/* Captain: choose / shuffle the line-up of their own ties until a tie starts. The opposing line-up stays hidden until both are set. */
Views.feed = () => {
  const items = S.feed || [];
  const ICON = { result: '🏁', upcoming: '⏰', announcement: '📣', match: '🏸' };
  return h('div', {}, h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/menu' }, '‹'), h('h1', {}, 'Updates')),
    items.length ? items.map((f) => h(f.matchId ? 'a' : 'div', { class: 'card feed', href: f.matchId ? '#/match/' + f.matchId : undefined }, h('div', {}, h('b', {}, (ICON[f.kind] || '') + ' ' + f.title), h('div', {}, f.body), h('div', { class: 'muted small' }, new Date(f.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))))) : h('p', { class: 'empty' }, 'Nothing yet. Scores, results, reminders and announcements show up here.'));
};
Views.captain = () => {
  const sel = (opts, val, attrs) => h('select', attrs || {}, opts.map(([v, l]) => h('option', { value: v, selected: String(val) === String(v) }, l)));
  if (me.role !== 'captain') return h('p', { class: 'empty' }, h('a', { href: '#/login' }, 'Sign in as a captain'));
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const load3 = async () => {
    let d; try { d = await api('GET', '/api/captain/ties'); } catch (e) { box.replaceChildren(h('p', { class: 'empty' }, e.message)); return; }
    const nm = (id) => (d.members.find((x) => x.id === id) || {}).name || (byId('players', id) || {}).name || '?';
    box.replaceChildren(d.ties.length ? h('div', {}, d.ties.map((t) => {
      const own = t.mine === 'A' ? 'sideA' : 'sideB', other = t.mine === 'A' ? 'B' : 'A', opp = t.mine === 'A' ? t.sideB[0] : t.sideA[0];
      const sels = t.rubbers.map((r) => { const size = r.size === 2 ? 2 : 1, cur = r[own] || [];
        const elig = d.members.filter((x) => !x.suspended && (!r.gender || !x.gender || x.gender === r.gender));
        const ss = Array.from({ length: size }, (_, i) => sel([['', '— choose —']].concat(elig.map((x) => [x.id, x.name])), cur[i] || '', { disabled: t.locked }));
        return { r, ss }; });
      const body = () => sels.map((o) => ({ id: o.r.id, [own]: o.ss.map((s) => s.value).filter(Boolean) }));
      const shuffle = () => { const used = new Map(); sels.forEach((o) => { const pool = d.members.filter((x) => !x.suspended && (!o.r.gender || !x.gender || x.gender === o.r.gender) && (used.get(x.id) || 0) < t.maxPerPlayer).sort(() => Math.random() - .5); o.ss.forEach((s, i) => { const pick = pool.filter((x) => !o.ss.some((q, j) => j !== i && q.value === x.id))[0]; if (pick) { s.value = pick.id; used.set(pick.id, (used.get(pick.id) || 0) + 1); pool.splice(pool.indexOf(pick), 1); } }); }); };
      return h('div', { class: 'card' }, h('b', {}, t.eventName), h('div', { class: 'muted small' }, ['vs ' + nameFor(opp), t.round ? 'Round ' + t.round + (t.totalRounds ? ' of ' + t.totalRounds : '') : null, fmtSlot(t), t.court].filter(Boolean).join(' • ')),
        t.locked ? h('div', { class: 'chip' }, 'Tie started – line-up locked') : null,
        sels.map((o) => h('div', { class: 'field' }, h('span', {}, o.r.name), o.ss)),
        t.lineupHidden ? h('p', { class: 'muted small' }, 'The opposing line-up is hidden until both captains have set theirs.') : null,
        t.locked ? null : h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: shuffle }, '🔀 Shuffle'), h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/matches/' + t.id + '/lineup', { rubbers: body() }); toast('Line-up saved'); await load3(); }) }, 'Save line-up')));
    })) : h('p', { class: 'empty' }, 'No ties for your team yet.'));
  };
  const nameFor = (tid) => (byId('teams', tid) || {}).name || 'opponent';
  load3();
  return h('div', {}, h('h1', {}, me.name + ' – captain'), h('p', { class: 'muted small' }, 'Choose who plays each rubber. You can change it until the tie starts. Suspended players are not available.'), box);
};
Views.login = () => {
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'Your PIN', class: 'pin', 'aria-label': 'Your PIN' });
  const go = guard(async () => {
    const r = await api('POST', '/api/login', { pin: pin.value });
    me = { role: r.role, name: r.name, token: r.token, kind: r.kind || '', sports: r.sports || [], limited: !!r.limited, adminId: r.adminId || '', refId: r.refId || '', personId: r.personId || '', teamId: r.teamId || '' };
    store.set('me', me); toast('Welcome, ' + r.name); await load();
    location.hash = r.adminId ? '#/season' : r.refId ? '#/season/matches' : r.role === 'captain' ? '#/captain' : r.personId ? '#/me' : '#/'; render();
  });
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return h('div', {}, h('h1', {}, 'Sign in'),
    h('div', { class: 'card' }, h('p', { class: 'muted small' }, 'One PIN for everything – as a player, referee, organizer or admin. The app knows your roles. Forgot it? Ask an organizer for a new one.'),
      field('PIN', pin), h('button', { class: 'btn big full', onclick: go }, 'Sign in')));
};

/* My profile: the signed-in person – photo, PIN, and their own details (contact details are visible only to them and the organizers). */
Views.me = (id, token) => (id && token ? Views.selfEdit(id, token) : myProfile());
function myProfile() {
  if (!me.personId) return h('div', {}, h('h1', {}, 'My profile'), h('p', { class: 'empty' }, me.role ? 'This sign-in is not linked to a player profile yet. Ask an admin (People & roles).' : 'Sign in with your PIN to see your profile.'), me.role ? null : h('a', { class: 'btn', href: '#/login' }, 'Sign in'));
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  api('GET', '/api/me').then((r) => {
    const P = r.profile || {};
    const photoIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (!f) return; const blob = await resizeImage(f, 600, 'image/jpeg'); await api('POST', '/api/me/photo', blob, 'image/jpeg'); toast('Photo updated'); await refresh(); }) });
    const np = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'New PIN (6–10 digits)' }), np2 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'Repeat new PIN' });
    const roles = [r.adminId ? (r.limited || (r.sports || []).length ? '👔 Organizer' : '🛡 Admin') : '', r.refId ? '🧑‍⚖️ ' + (r.kind === 'chief' ? 'Chief referee' : r.kind === 'volunteer' ? 'Volunteer' : 'Referee') : '', r.teamId ? '🧢 Team captain' : '', '🏸 Player'].filter(Boolean);
    box.replaceChildren(
      h('div', { class: 'profile' }, avatar(P, 88), h('div', { class: 'grow' }, h('h2', {}, P.name || me.name), h('div', { class: 'chips' }, roles.map((x) => h('span', { class: 'chip plain' }, x))),
        h('div', { class: 'actions' }, photoIn, h('button', { class: 'btn ghost sm', onclick: () => photoIn.click() }, '📷 ' + (P.photo ? 'Change photo' : 'Add my photo')), h('a', { class: 'btn ghost sm', href: '#/player/' + P.id }, 'My stats')))),
      h('div', { class: 'card' }, h('b', {}, 'My details (only you and the organizers see these)'), h('div', { class: 'small' }, [P.phone ? '📞 ' + P.phone : '', P.email ? '✉️ ' + P.email : '', P.affiliation, P.ageGroup].filter(Boolean).join(' • ') || 'No contact details yet.')),
      h('div', { class: 'card' }, h('b', {}, '🔑 Change my PIN'), h('p', { class: 'muted small' }, 'Choose 6–10 digits that are easy for you to remember and hard to guess.'), np, np2,
        h('button', { class: 'btn', onclick: guard(async () => { if (np.value !== np2.value) throw new Error('The two PINs do not match'); await api('POST', '/api/me/pin', { pin: np.value }); np.value = np2.value = ''; toast('PIN changed – use it next time you sign in'); }) }, 'Save new PIN')));
  }).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return h('div', {}, h('h1', {}, 'My profile'), box);
}

Views.report = () => !isStaff() ? h('div', {}, h('h1', {}, 'Report'), h('p', { class: 'empty' }, 'Reports are available to organizers and referees only.')) : h('div', {},
  h('div', { class: 'page-h noprint' }, h('a', { class: 'back', href: '#/menu' }, '‹'), h('h1', {}, 'Report'), h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print / Save PDF')),
  h('div', { class: 'report-h' }, h('h1', {}, S.tournament.name), h('div', { class: 'muted' }, [S.tournament.venue, S.tournament.dates].filter(Boolean).join(' • '))),
  ['adults', 'kids'].map((sec) => eventsOf(sec).length ? h('div', {}, h('h2', { class: 'sec-h' }, SEC[sec] + ' section'),
    eventsOf(sec).map((ev) => h('section', { class: 'rep-sec' }, h('h2', {}, ev.name), championBanner(ev), standingsTable(ev)))) : null));

/* ------- big-screen (TV / projector) mode: #/tv  or  #/tv/kids  #/tv/adults ------- */
let tvTimer = null;
function tvPanels(only) {
  const out = [];
  const secs = only ? [only] : ['adults', 'kids'];
  const ms = S.matches.map((m) => ({ m, ev: evOf(m), d: E.derive(liveMatch(m), evOf(m)) })).filter((x) => x.ev && secs.includes(secOf(x.ev)));
  const live = ms.filter((x) => x.d.status === 'live');
  if (live.length) out.push(h('div', { class: 'tv-panel' }, h('h2', {}, h('span', { class: 'dot' }), 'LIVE NOW'), live.slice(0, 4).map((x) => tvMatch(x))));
  secs.forEach((sec) => eventsOf(sec).forEach((ev) => {
    const rows = E.standings(ev, S.matches.map(liveMatch));
    if (!rows.some((r) => r.played > 0)) return;
    out.push(h('div', { class: 'tv-panel' }, h('h2', {}, ev.name + (sec === 'kids' ? ' 🧒' : '')), championBanner(ev),
      h('table', { class: 'tv-tbl' }, h('tbody', {}, rows.slice(0, 8).map((r) => h('tr', { class: r.qualified ? 'q' : '' }, h('td', {}, r.rank), h('td', { class: 'l' }, nameOf(ev, r.id)), h('td', {}, ev.config.rankBy === 'tally' ? r.pf : r.mp), h('td', { class: 'muted' }, 'W' + r.won + ' L' + r.lost)))))));
  }));
  const done = ms.filter((x) => x.d.status === 'completed').sort((a, b) => (b.m.startedAt || 0) - (a.m.startedAt || 0)).slice(0, 4);
  if (done.length) out.push(h('div', { class: 'tv-panel' }, h('h2', {}, 'RECENT RESULTS'), done.map((x) => tvMatch(x))));
  const next = ms.filter((x) => x.d.status === 'scheduled').sort((a, b) => (a.m.startsAt || 'z').localeCompare(b.m.startsAt || 'z')).slice(0, 4);
  if (next.length) out.push(h('div', { class: 'tv-panel' }, h('h2', {}, 'UP NEXT'), next.map((x) => tvMatch(x))));
  return out;
}
function tvMatch(x) {
  const { m, ev, d } = x;
  const live = d.current && d.status === 'live' && ev.scoring === 'points';
  return h('div', { class: 'tv-m' },
    h('div', { class: 'tv-meta' }, [ev.name, m.stage !== 'League' ? m.stage : '', m.court, fmtSlot(m)].filter(Boolean).join(' • ')),
    h('div', { class: 'tv-row' }, h('div', { class: 'tv-s' + (d.winner === 'A' ? ' w' : '') }, sideLabel(ev, m.sideA)),
      h('div', { class: 'tv-sc' }, ev.scoring === 'points' ? (live ? d.current.a + ' – ' + d.current.b : d.gamesA + ' – ' + d.gamesB) : (d.status === 'completed' ? (d.draw ? '½ – ½' : d.winner === 'A' ? '1 – 0' : '0 – 1') : 'vs')),
      h('div', { class: 'tv-s right' + (d.winner === 'B' ? ' w' : '') }, sideLabel(ev, m.sideB))),
    ev.scoring === 'points' && (d.games.length || live) ? h('div', { class: 'tv-games' }, (live ? 'Games ' + d.gamesA + '–' + d.gamesB + ' • ' : '') + E.scoreText(d)) : null);
}
Views.tv = (only) => {
  clearInterval(tvTimer);
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  const panels = tvPanels(['adults', 'kids'].includes(only) ? only : '');
  const i = panels.length ? ui.tvIdx % panels.length : 0;
  tvTimer = setInterval(() => { if (!/^#\/tv/.test(location.hash)) { clearInterval(tvTimer); return; } ui.tvIdx++; render(); }, 10000);
  const t = S.tournament;
  return h('div', { class: 'tv' },
    h('div', { class: 'tv-head' }, h('a', { href: '#/menu', class: 'tv-title' }, (t.logo ? h('img', { src: t.logo, class: 'logo' }) : '🏆 '), ' ' + t.name), h('div', { class: 'tv-clock' }, new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }))),
    panels.length ? panels[i] : h('div', { class: 'tv-panel' }, h('h2', {}, 'Waiting for the first match…')),
    h('div', { class: 'tv-dots' }, panels.map((_, k) => h('span', { class: k === i ? 'on' : '' }))),
    (() => { const sp = S.sponsors.filter((x) => x.image); if (!sp.length) return null; const k = sponsorPage(sp.length); return h('div', { class: 'tv-foot', 'data-n': sp.length, 'data-i': k }, h('span', {}, 'Thank you to our sponsors'), h('img', { src: sp[k].image, alt: sp[k].name })); })());
}

/* Address used in every shared link: the organizer's 'Public web address' if set, else the address this page is on. */
function BASE() { return ((window.S || S || {}).registration || {}).publicUrl || location.origin; }

/* ------- self-registration ------- */
const regLevels = [['', 'Level (optional)'], ['Beginner', 'Beginner'], ['Intermediate', 'Intermediate'], ['Advanced', 'Advanced'], ['Pro', 'Pro']];
const HINTS = { badminton: ['Attacking', 'Defensive', 'All-round', 'Net player'], tt: ['Attacker', 'Defender', 'All-round'], carrom: ['Striker', 'Defender', 'Queen specialist'], chess: ['Aggressive', 'Positional', 'Tactical'] };

function copyBtn(text, label) { return h('button', { class: 'btn ghost', onclick: guard(async () => { await navigator.clipboard.writeText(text); toast('Copied'); }) }, label || 'Copy'); }

Views.register = (tid) => {
  if (tid && tourById(tid) && tid !== ui.tid) { ui.tid = tid; store.set('tid', tid); scope(); }
  const R = S.registration || {};
  const mine = store.get('myProfile', null);
  const head = h('div', {}, h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/' }, '‹'), h('h1', {}, 'Register as a player')), R.open ? h('p', { class: 'muted' }, 'for ' + curT().name) : null, langPicker());
  const openElse = ((SA.registration || {}).tours || []).filter((x) => x.open && x.tid !== curTid());
  if (!R.open && openElse.length) return h('div', {}, head, h('div', { class: 'card' }, h('b', {}, 'Choose the event to register for'), openElse.map((x) => h('button', { class: 'btn full', style: 'margin-top:8px', onclick: () => pickEvent(x.tid) }, x.name))));
  if (!R.open) return h('div', {}, head, h('div', { class: 'card warnbox' }, 'Registration is closed right now.' + (R.deadline ? ' (It closed on ' + R.deadline + '.)' : '')), mine ? h('a', { class: 'btn', href: '#/me/' + mine.id + '/' + mine.token }, 'Open my profile') : null);
  const v = { section: ui.regSection || 'adults', consent: false, eventIds: [] };
  const box = h('div', {});
  const draw = () => {
    const kids = v.section === 'kids';
    const text = (key, label, o) => field(label, h('input', { value: v[key] || '', oninput: (e) => { v[key] = e.target.value; }, ...(o || {}) }));
    const evs = (R.events || []).filter((e) => e.section === v.section);
    v.eventIds = v.eventIds.filter((id) => evs.some((e) => e.id === id && !e.full));
    box.replaceChildren(
      h('div', { class: 'seg sections' }, ['adults', 'kids'].map((k) => h('button', { type: 'button', class: v.section === k ? 'on' : '', onclick: () => { v.section = k; ui.regSection = k; draw(); } }, (k === 'kids' ? '🧒 ' : '🧑 ') + (k === 'kids' ? 'Child (under 18)' : 'Adult')))),
      text('name', kids ? 'Child’s full name' : 'Full name', { autocomplete: 'name', maxlength: 60 }),
      h('div', { class: 'two' }, field('Gender (optional)', h('select', { onchange: (e) => { v.gender = e.target.value; } }, [['', '—'], ['F', 'Female'], ['M', 'Male']].map(([x, l]) => h('option', { value: x, selected: v.gender === x }, l)))),
        kids ? text('ageGroup', 'Age / age group', { placeholder: 'e.g. 9 or Under-10' }) : text('affiliation', 'Department / company', { maxlength: 60 })),
      kids ? text('affiliation', 'School', { maxlength: 60 }) : null,
      text('dob', kids ? 'Child’s date of birth (optional)' : 'Date of birth (optional)', { type: 'date' }),
      h('div', { class: 'two' }, text('phone', kids ? 'Child’s phone (optional)' : 'Phone', { type: 'tel', autocomplete: 'tel' }), text('email', 'Email', { type: 'email', autocomplete: 'email' })),
      kids ? h('div', { class: 'card' }, h('b', {}, 'Parent / guardian'), text('guardianName', 'Parent or guardian name', { maxlength: 60 }), text('guardianPhone', 'Parent or guardian phone', { type: 'tel' })) : null,
      h('div', { class: 'card' }, h('b', {}, 'Events you want to play'),
        evs.length ? evs.map((e) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', disabled: e.full, checked: v.eventIds.includes(e.id), onchange: (ev) => { v.eventIds = ev.target.checked ? v.eventIds.concat(e.id) : v.eventIds.filter((x) => x !== e.id); } }), e.name + (e.ageMin || e.ageMax ? ' (' + (e.ageMin && e.ageMax ? 'ages ' + e.ageMin + '–' + e.ageMax : e.ageMax ? 'age ' + e.ageMax + ' and under' : 'age ' + e.ageMin + '+') + ')' : '') + (e.team ? ' – team event' : '') + (e.full ? ' (full)' : '')))
          : h('p', { class: 'muted small' }, 'No events are open for registration in this section.'),
        h('p', { class: 'muted small' }, 'For a team event, tick it to tell the organisers you want to play. They will place you in a team.')),
      R.codeRequired ? text('code', 'Join code', { placeholder: 'Given to you by the organisers', autocomplete: 'off', autocapitalize: 'off' }) : null,
      h('input', { class: 'hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', name: 'website', oninput: (e) => { v.website = e.target.value; } }),
      h('label', { class: 'chk consent' }, h('input', { type: 'checkbox', checked: v.consent, onchange: (e) => { v.consent = e.target.checked; } }), kids ? R.kidsNotice : R.notice),
      h('button', { class: 'btn big full', onclick: guard(async () => {
        const r = await api('POST', '/api/register', { ...v, tid: curTid() });
        if (!r.id) { toast('Thanks!'); return; }   /* honeypot answer */
        store.set('myProfile', { id: r.id, token: r.editToken, name: v.name });
        showRegistered(box, r, v);
      }) }, 'Submit registration'),
      h('p', { class: 'muted small center' }, 'The organisers will review your registration. You will appear in the player list once approved.'));
  };
  draw();
  return h('div', {}, head, mine ? h('div', { class: 'card tip' }, 'You already registered on this phone. ', h('a', { href: '#/me/' + mine.id + '/' + mine.token }, 'Open my profile'), ' – or register someone else below (for example a family member).') : null, box);
};

/* Step after registering: are notifications on, off or impossible on this phone? Reported to the organizers so nobody finds out on match day. */
async function reportPush(id, token, status) { try { await fetch('/api/self/' + id + '/push', { method: 'POST', headers: { 'x-edit-token': token, 'x-push-status': status } }); } catch (e) { /* offline */ } }
function notifyCard(id, token) {
  const card = h('div', { class: 'card' }, h('b', {}, '🔔 Match alerts'), h('p', { class: 'muted small' }, 'Checking…'));
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const draw = async () => {
    const st = await pushState();
    if (st === 'on') { reportPush(id, token, 'on'); card.replaceChildren(h('b', {}, '🔔 Match alerts'), h('div', { class: 'chip ok' }, '✅ On for this phone'), h('p', { class: 'muted small' }, 'You will get your match times and scores.')); return; }
    if (st === 'unsupported') {
      reportPush(id, token, 'unsupported');
      card.replaceChildren(h('b', {}, '🔔 Match alerts'), h('div', { class: 'chip warn' }, '📵 Not available in this browser'),
        ios && !standalone ? h('ol', { class: 'small' }, h('li', {}, 'Tap the Share button in Safari'), h('li', {}, 'Choose “Add to Home Screen”'), h('li', {}, 'Open the app from your Home Screen, then come back to your profile and turn on alerts')) : h('p', { class: 'muted small' }, 'You can still follow live scores in the app.'));
      return;
    }
    card.replaceChildren(h('b', {}, '🔔 Match alerts'), h('p', { class: 'muted small' }, 'Get your match time, “you are up next” and the result on this phone.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: guard(async () => {
        if (!window.isSecureContext) throw new Error('Notifications need the https link.');
        if ((await Notification.requestPermission()) !== 'granted') { reportPush(id, token, 'off'); throw new Error('Notification permission was not granted'); }
        const reg = await navigator.serviceWorker.ready; let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(S.vapidPublicKey) });
        await selfApi('POST', id, token, { subscription: sub.toJSON() }, null, '/push'); toast('Alerts are on'); draw();
      }) }, 'Turn on alerts'), h('button', { class: 'btn ghost', onclick: () => { reportPush(id, token, 'later'); toast('OK – you can turn them on later from your profile'); } }, 'Not now')));
  };
  draw().catch(() => {});
  return card;
}

function showRegistered(box, r, v) {
  const link = BASE() + '/#/me/' + r.id + '/' + r.editToken;
  box.replaceChildren(h('div', { class: 'card center' }, h('div', { class: 'big-emoji' }, '🎉'), h('h2', {}, 'You are registered!'),
    h('p', {}, h('b', {}, v.name), ' • ID ', h('b', {}, r.playerNo)), h('p', { class: 'muted' }, 'Status: waiting for organiser approval.'),
    r.pin ? h('div', { class: 'card' }, h('b', {}, '🔑 Your PIN'), h('div', { class: 'bigpin' }, r.pin), h('p', { class: 'small' }, 'Use it to sign in (Menu → Sign in) – to add your photo, change this PIN to one you like, and later to referee or organize if you are given those roles. It is shown only now, so save it.')) : null,
    h('div', { class: 'warnbox small' }, 'Keep this private link – it lets you add a photo, playing style and update your details. Anyone who has it can edit your profile.'),
    h('div', { class: 'muted small wrap' }, link),
    notifyCard(r.id, r.editToken),
    h('div', { class: 'actions', style: 'justify-content:center' }, copyBtn(link, 'Copy my link'), h('a', { class: 'btn', href: '#/me/' + r.id + '/' + r.editToken }, 'Complete my profile'),
      h('a', { class: 'btn ghost', href: 'https://wa.me/?text=' + encodeURIComponent('My ' + S.tournament.name + ' profile link: ' + link), target: '_blank', rel: 'noopener' }, 'Send to myself on WhatsApp'))));
}

async function selfApi(method, id, token, body, raw, sub) {
  const res = await fetch('/api/self/' + id + (sub || ''), { method, headers: { 'x-edit-token': token, ...(raw ? { 'Content-Type': raw } : body ? { 'Content-Type': 'application/json' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch (e) { /* none */ }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

Views.selfEdit = (id, token) => {
  const saved = store.get('myProfile', null);
  if (!id && saved) { id = saved.id; token = saved.token; }
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const head = h('div', { class: 'page-h' }, h('a', { class: 'back', href: '#/' }, '‹'), h('h1', {}, 'My profile'));
  if (!id || !token) return h('div', {}, head, h('p', { class: 'empty' }, 'Open the private link you received when you registered.'));
  selfApi('GET', id, token).then((P) => {
    store.set('myProfile', { id, token, name: P.name });
    const kids = P.section === 'kids';
    const f = {
      name: h('input', { value: P.name, maxlength: 60, disabled: P.status !== 'pending' }), ageGroup: h('input', { value: P.ageGroup || '', maxlength: 20 }),
      affiliation: h('input', { value: P.affiliation || '', maxlength: 60 }), bio: h('textarea', { rows: 3, maxlength: 300, placeholder: 'A line or two about you' }, P.bio || ''),
      hand: h('select', {}, [['', '—'], ['R', 'Right-handed'], ['L', 'Left-handed'], ['B', 'Ambidextrous']].map(([x, l]) => h('option', { value: x, selected: P.hand === x }, l))),
      achievements: h('textarea', { rows: 3, placeholder: 'One per line, e.g. 2025 – Carrom runner-up' }, (P.achievements || []).join('\n')),
      phone: h('input', { value: P.phone || '', type: 'tel' }), email: h('input', { value: P.email || '', type: 'email' }), emergency: h('input', { value: P.emergency || '', placeholder: 'Name and phone' }), tshirt: h('input', { value: P.tshirt || '', maxlength: 6, placeholder: 'e.g. M' }),
      guardianName: h('input', { value: P.guardianName || '' }), guardianPhone: h('input', { value: P.guardianPhone || '', type: 'tel' }),
      pub: h('input', { type: 'checkbox', checked: P.profilePublic !== false }),
    };
    const sports = ['badminton', 'tt', 'carrom', 'chess'].map((k) => {
      const sp = (P.sports || {})[k] || {};
      return { k, level: h('select', {}, regLevels.map(([x, l]) => h('option', { value: x, selected: sp.level === x }, l))), style: h('input', { value: sp.style || '', maxlength: 60, placeholder: 'Style, e.g. ' + HINTS[k][0], list: 'hl-' + k }), rating: k === 'chess' ? h('input', { value: sp.rating || '', type: 'number', min: 0, max: 3500, placeholder: 'Chess rating (optional)' }) : null, dl: h('datalist', { id: 'hl-' + k }, HINTS[k].map((x) => h('option', { value: x }))) };
    });
    let photo = P.photo || '';
    const prev = h('div', {}, avatar({ name: P.name, photo }, 72));
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => {
      if (!e.target.files[0]) return; const blob = await resizeImage(e.target.files[0], 500, 'image/jpeg');
      photo = (await selfApi('POST', id, token, blob, 'image/jpeg', '/photo')).url; prev.replaceChildren(avatar({ name: P.name, photo }, 72)); toast('Photo added – tap Save');
    }) });
    const st = P.status === 'pending'
      ? h('div', { class: 'card warnbox' }, '⏳ Waiting for approval.' + ((P.requestedEvents || []).length ? ' You asked to play: ' + P.requestedEvents.join(', ') + '.' : ''), ' You will appear in the player list once an organiser approves you.')
      : h('div', { class: 'card tip' }, '✓ You are registered' + ((P.enrolled || []).length ? ' for: ' + P.enrolled.join(', ') : '') + '. ID ' + P.playerNo + '.');
    const notifyBtn = P.status === 'pending' && 'serviceWorker' in navigator && 'PushManager' in window ? h('button', { class: 'btn ghost sm', onclick: guard(async () => {
      if (!window.isSecureContext) throw new Error('Notifications need the https link.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted');
      const reg = await navigator.serviceWorker.ready; let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(S.vapidPublicKey) });
      await selfApi('POST', id, token, { subscription: sub.toJSON() }, null, '/push'); toast('We will notify you when you are approved');
    }) }, '🔔 Tell me when I am approved') : null;
    const gset = new Set(P.gameIds || []);
    const regOn = S.registration && S.registration.open;
    const gevs = ((S.registration || {}).events || []).filter((e) => e.section === P.section);
    const gamesCard = h('div', { class: 'card' }, h('b', {}, 'Games I want to play'),
      P.status !== 'pending' && !regOn ? h('p', { class: 'muted small' }, 'Registration is closed. Ask the organisers if you want to change your games.') : null,
      ...gevs.map((e) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: gset.has(e.id), disabled: P.status !== 'pending' && !regOn, onchange: (ev) => { ev.target.checked ? gset.add(e.id) : gset.delete(e.id); } }), e.name + (e.team ? ' – team event' : ''))),
      !gevs.length ? h('p', { class: 'muted small' }, 'No games are open for self-registration.') : null,
      P.status !== 'pending' && !regOn ? null : h('button', { class: 'btn', onclick: guard(async () => {
        const r = await selfApi('PUT', id, token, { eventIds: [...gset] }, null, '/games');
        toast(r.skipped && r.skipped.length ? 'Saved. Not changed: ' + r.skipped.join('; ') : 'Games updated'); await refresh();
      }) }, 'Save my games'),
      h('p', { class: 'muted small' }, 'Organisers can also add you to games. Team events put you on the interested list; the organisers place you in a team.'));
    box.replaceChildren(st, notifyCard(id, token), gamesCard,
      h('div', { class: 'card' }, h('div', { class: 'actions' }, prev, file, h('button', { class: 'btn ghost', onclick: () => file.click() }, '📷 ' + (photo ? 'Change photo' : 'Add photo'))),
        kids ? h('p', { class: 'muted small' }, 'Children’s photos are not shown publicly unless the organisers switch that on.') : null,
        field('Name', f.name), kids ? field('Age / age group', f.ageGroup) : null, field(kids ? 'School' : 'Department / company', f.affiliation), field('About me', f.bio), field('Playing hand', f.hand)),
      h('div', { class: 'card' }, h('b', {}, 'Sports & playing style'), sports.map((r) => h('div', { class: 'sport-edit' }, h('div', { class: 'muted small' }, SPORT_ICON[r.k] + ' ' + SPORT_LABEL[r.k]), h('div', { class: 'two' }, r.level, r.style), r.rating, r.dl)),
        field('Past achievements', f.achievements)),
      h('div', { class: 'card' }, h('b', {}, 'Private – only organisers see these'), field('Phone', f.phone), field('Email', f.email), field('Emergency contact', f.emergency), field('T-shirt size', f.tshirt),
        kids ? [field('Parent / guardian name', f.guardianName), field('Parent / guardian phone', f.guardianPhone)] : null),
      h('label', { class: 'chk' }, f.pub, 'Show my extended profile publicly (about me, style, achievements)'),
      h('button', { class: 'btn big full', onclick: guard(async () => {
        const sp = {}; sports.forEach((r) => { sp[r.k] = { level: r.level.value, style: r.style.value, rating: r.rating ? r.rating.value : '' }; });
        await selfApi('PUT', id, token, { name: f.name.value, ageGroup: f.ageGroup.value, affiliation: f.affiliation.value, bio: f.bio.value, hand: f.hand.value, sports: sp, achievements: f.achievements.value.split('\n'), phone: f.phone.value, email: f.email.value, emergency: f.emergency.value, tshirt: f.tshirt.value, guardianName: f.guardianName.value, guardianPhone: f.guardianPhone.value, profilePublic: f.pub.checked, photo });
        toast('Saved'); await load();
      }) }, 'Save'),
      h('p', { class: 'muted small center' }, 'Keep your link private: ' + BASE() + '/#/me/' + id + '/…'));
  }).catch((e) => box.replaceChildren(h('p', { class: 'empty' }, e.status === 403 ? 'This link is not valid any more. Ask the organisers for help.' : e.message)));
  return h('div', {}, head, box);
};

/* ------- printable fixture list and referee score sheets: #/print ------- */
Views.print = () => {
  if (!isStaff()) return h('div', {}, h('p', { class: 'empty' }, 'Staff only.'), h('a', { class: 'btn', href: '#/login' }, 'Sign in'));
  const mode = ui.printMode || 'sheets';
  const all = S.matches.map((m) => ({ m, ev: evOf(m) })).filter((x) => x.ev).map((x) => ({ ...x, d: E.derive(x.m, x.ev) }));
  const rows = all.filter((x) => mode === 'fixtures' || x.d.status !== 'completed').sort((a, b) => (a.m.startsAt || 'z').localeCompare(b.m.startsAt || 'z') || (a.m.court || '').localeCompare(b.m.court || ''));
  const body = mode === 'fixtures'
    ? h('div', {}, h('div', { class: 'report-h' }, h('h1', {}, S.tournament.name + ' – fixtures'), h('div', { class: 'muted' }, [S.tournament.venue, S.tournament.dates].filter(Boolean).join(' • '))),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Time', 'Court', 'Event', 'Match', 'Result'].map((x, i) => h('th', { class: i > 1 ? 'l' : '' }, x)))),
        h('tbody', {}, rows.map((x) => h('tr', {}, h('td', {}, fmtSlot(x.m) || '–'), h('td', {}, x.m.court || '–'), h('td', { class: 'l' }, x.ev.name + (x.m.stage !== 'League' ? ' (' + x.m.stage + ')' : '')), h('td', { class: 'l' }, sideLabel(x.ev, x.m.sideA) + '  vs  ' + sideLabel(x.ev, x.m.sideB)), h('td', { class: 'l' }, x.d.status === 'completed' ? E.scoreText(x.d) || (OUT[x.d.outcome] || '').trim() : '')))))))
    : h('div', {}, rows.map((x) => {
      const ref = refsOf(x.m);
      return h('div', { class: 'ss' },
        h('div', { class: 'ss-h' }, h('b', {}, x.ev.name), h('span', {}, [x.m.stage !== 'League' ? x.m.stage : x.m.round ? 'Round ' + x.m.round : '', x.m.court, fmtSlot(x.m)].filter(Boolean).join(' • '))),
        h('div', { class: 'ss-names' }, h('div', {}, sideLabel(x.ev, x.m.sideA)), h('div', { class: 'vs' }, 'vs'), h('div', {}, sideLabel(x.ev, x.m.sideB))),
        x.ev.scoring === 'points'
          ? h('table', { class: 'ss-t' }, h('thead', {}, h('tr', {}, h('th', {}, 'Game'), h('th', {}, 'Side A'), h('th', {}, 'Side B'))), h('tbody', {}, Array.from({ length: x.ev.config.bestOf }, (_, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}), h('td', {})))))
          : h('div', { class: 'ss-res' }, 'Result:  ☐ Side A won   ☐ Draw   ☐ Side B won'),
        h('div', { class: 'ss-f' }, h('span', {}, 'Winner: ____________________'), h('span', {}, 'Referee: ' + (ref ? ref.name : '____________________')), h('span', {}, 'Signature: ______________')));
    }), !rows.length ? h('p', { class: 'empty' }, 'Nothing to print.') : null);
  return h('div', {}, h('div', { class: 'page-h noprint' }, h('a', { class: 'back', href: '#/menu' }, '‹'), h('h1', {}, 'Print'), h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print / Save PDF')),
    h('div', { class: 'seg noprint' }, [['sheets', 'Score sheets (unplayed matches)'], ['fixtures', 'Fixture list']].map(([k, l]) => h('button', { class: mode === k ? 'on' : '', onclick: () => { ui.printMode = k; render(); } }, l))), body);
};

function notFound() { return h('div', {}, h('p', { class: 'empty' }, 'Not found.'), h('a', { class: 'btn', href: '#/' }, 'Home')); }

/* -------------------------------------------------------- shell & routing */
function applyTheme() {
  const t = store.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

function renderHeader() {
  const t = S.tournament;
  const logo = t.logo ? h('img', { src: t.logo, class: 'logo', alt: '' }) : h('span', { class: 'logo ph' }, '🏆');
  $('#top').replaceChildren(
    h('a', { class: 'brand', href: '#/' }, logo, h('div', {}, h('b', {}, t.name), t.tagline ? h('small', {}, t.tagline) : null)),
    h('div', { class: 'status' },
      offline ? h('span', { class: 'pill off' }, 'Offline') : null,
      pending.length ? h('span', { class: 'pill warn' }, pending.length + ' to sync') : null,
      me.role ? h('a', { class: 'pill ok', href: '#/menu' }, me.role === 'admin' ? 'Admin' : me.role === 'captain' ? '👥 ' + me.name : '🏸 ' + me.name) : h('a', { class: 'pill', href: '#/login' }, 'Sign in'),
      h('a', { class: 'menu-btn', href: '#/menu', 'aria-label': 'Menu' }, '☰')));
  document.title = t.name;
}

/* Outline icons drawn in the text colour: grey on the menu bar, white on the highlighted tab. */
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  event: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  matches: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  rankings: '<path d="M4 20v-8h5v8M9.5 20V6h5v14M15 20v-5h5v5M3 20h18"/>',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',
  contact: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
};
function icon(k) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ic'); s.innerHTML = ICON_PATHS[k] || ''; return s; }
/* Which menu tab a page belongs to: a match or game opened from Event keeps Event lit; a friendly match keeps Matches lit. */
function navKey(name, arg) {
  if (name === 'home' || name === '') return '';
  if (name === 'match' || name === 'event') { const ev = name === 'event' ? byId('events', arg) : evOf(byId('matches', arg) || {}); return ev && isFriendlyEv(ev) ? 'matches' : 'season'; }
  return { season: 'season', seasons: 'season', matches: 'matches', rankings: 'rankings', players: 'players', player: 'players', gallery: 'gallery', contact: 'contact' }[name] || null;
}
function renderNav(name) {
  const items = [['', 'home', 'Home'], ['season', 'event', 'Event'], ['matches', 'matches', 'Matches'], ['rankings', 'rankings', 'Rankings'], ['players', 'players', 'Players'], ['gallery', 'gallery', 'Gallery'], ['contact', 'contact', 'Contact us']];
  const key = navKey(name, location.hash.replace(/^#\/?/, '').split('/')[1]);
  $('#nav').replaceChildren(...items.map(([r, i, l]) => h('a', { href: '#/' + r, class: key === r ? 'on' : '', 'aria-current': key === r ? 'page' : null }, icon(i), h('span', { class: 'lbl' }, l))));
  const bar = $('#bar'); if (bar) document.documentElement.style.setProperty('--barh', bar.offsetHeight + 'px');
}
/* Contact us: who runs each event (names only – no phone numbers are shown publicly). */
Views.contact = () => {
  const orgs = SA.organizers || [], nm = (id) => (orgs.find((a) => a.id === id) || {}).name;
  const open = realTours().filter((t) => t.status !== 'closed'), main = orgs.filter((a) => a.main || (!a.limited && !(a.sports || []).length));
  return h('div', {}, h('h1', {}, 'Contact us'),
    h('p', { class: 'muted small' }, 'For questions about an event – registration, fixtures, timings or scores – speak to its organizers.'),
    open.length ? open.map((t) => { const names = (t.organizerIds || []).map(nm).filter(Boolean);
      return h('div', { class: 'card' }, h('b', {}, '🏆 ' + t.name), t.dates || t.venue ? h('div', { class: 'muted small' }, [t.dates, t.venue].filter(Boolean).join(' • ')) : null,
        names.length ? h('div', { class: 'list' }, names.map((n) => h('div', { class: 'row' }, icon('players'), h('b', { class: 'grow' }, n)))) : h('p', { class: 'muted small' }, 'Organizers not named yet.')); })
      : h('p', { class: 'empty' }, 'No event is running right now.'),
    main.length ? h('div', { class: 'card' }, h('b', {}, 'App administrators'), h('div', { class: 'list' }, main.map((a) => h('div', { class: 'row' }, icon('players'), h('b', { class: 'grow' }, a.name))))) : null,
    h('p', { class: 'muted small' }, 'Found a wrong score? Open the match and tap ⚑ Report a score problem.'));
};

function render() {
  if (SA && S === SA) scope();
  if (!S) { $('#app').replaceChildren(h('p', { class: 'empty' }, offline ? 'Cannot reach the server.' : 'Loading…')); return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || 'home';
  const view = Views[name] || notFound;
  const y = window.scrollY;
  renderHeader(); renderNav(parts[0]);
  let el;
  try { el = view(parts[1], parts[2]); } catch (e) { console.error(e); el = h('p', { class: 'empty' }, 'Something went wrong: ' + e.message); }
  const pc = S.panic || {};
  const banner = pc.hideScoreboard && !me.role ? h('div', { class: 'warnbox center', role: 'status' }, '⏸ Scores are temporarily hidden by the organisers. They will be back shortly.')
    : pc.freezeScoring && me.role ? h('div', { class: 'warnbox center', role: 'status' }, '⏸ Scoring is paused by the organiser. Do not enter scores until it is announced.')
    : (pc.lockedEvents || []).length && me.role ? h('div', { class: 'warnbox center small', role: 'status' }, '🔒 Locked: ' + pc.lockedEvents.map((id) => (byId('events', id) || {}).name).filter(Boolean).join(', ')) : null;
  $('#app').replaceChildren(...(banner ? [banner, el] : [el]));
  document.body.dataset.view = name;
  if (render.last === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
  render.last = location.hash;
}

function busy() {
  if (/^#\/(register|me|refsignup)\b/.test(location.hash)) return true;
  return document.querySelector('.modal') || (/^#\/(admin|login|certs|gallery|season)/.test(location.hash) && document.activeElement && document.activeElement.matches('input,select,textarea'));
}

window.addEventListener('hashchange', () => { ui.pick = null; ui.pickP = null; });
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
  await load(); render();
  flush();
  if (me.role) api('GET', '/api/me').then((r) => { if (!r.role) { me = { role: null }; store.set('me', me); render(); } }).catch(() => {});
  const es = new EventSource('/api/stream');
  let sseT = null;
  es.onmessage = () => { if (sseT) return; sseT = setTimeout(async () => { sseT = null; await load(); if (!busy()) render(); }, 150 + Math.random() * 600); };
  let sseUp = false, tick = 0;
  es.onerror = () => { sseUp = false; };
  es.onopen = () => { sseUp = true; offline = false; };
  setInterval(() => { if (!document.hidden && (!sseUp || ++tick % 4 === 0)) load().then(() => { if (!busy()) render(); }); }, 5000);
});
