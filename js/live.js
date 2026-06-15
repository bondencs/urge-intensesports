/* =========================================================
   URGE INTENSESPORTS — live matches + on-demand stats
   (Good Game Arena)

   - /api/matches gives real fixtures & results (token hidden).
   - Clicking a result lazy-loads THAT match's stats via the
     /api/gg proxy (one call, cached) and shows a scoreboard.
   - If anything is unreachable, the page keeps its static
     placeholders — it never breaks.

   Roster stays curated/static on purpose: the API roster has
   no "active" flag, so it can't tell starters from subs/staff.
   ========================================================= */
(function () {
  'use strict';

  const $ = (s, c = document) => c.querySelector(s);
  const TEAM = 'Urge Intensesports';
  const RESULTS = {};       // match id -> normalized match
  const STATS_CACHE = {};   // match id -> players[]

  /* ---------------- matches ---------------- */
  async function loadMatches() {
    let data;
    try {
      const r = await fetch('/api/matches', { headers: { Accept: 'application/json' } });
      if (!r.ok) return;                 // keep placeholders
      data = await r.json();
    } catch (e) { return; }              // keep placeholders
    if (!data || data.error) return;

    const upcoming = Array.isArray(data.upcoming) ? data.upcoming : [];
    const results = Array.isArray(data.results) ? data.results : [];

    setPanel('upcoming', upcoming.length
      ? upcoming.map(matchCard).join('')
      : emptyCard('No upcoming matches scheduled right now.'));

    results.forEach((m) => { if (m && m.id != null) RESULTS[m.id] = m; });
    setPanel('results', results.length
      ? results.map(resultCard).join('')
      : emptyCard('No results to show yet.'));
  }

  function setPanel(name, html) { const p = $('[data-panel="' + name + '"]'); if (p) p.innerHTML = html; }

  const logoImg = (m) => m.opponentLogo
    ? '<img class="match__logo" src="' + esc(m.opponentLogo) + '" alt="" loading="lazy">' : '';

  const matchCard = (m) =>
    '<a class="match" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener">' +
      '<span class="match__event">' + esc(shortEvent(m.event)) + '</span>' +
      '<div class="match__teams"><span class="match__team">' + TEAM + '</span>' +
        '<span class="match__vs">VS</span>' +
        '<span class="match__team match__team--opp">' + logoImg(m) + esc(m.opponent) + '</span></div>' +
      '<span class="match__date">' + fmtDate(m.date) + '</span>' +
    '</a>';

  const resultCard = (m) => {
    const cls = m.result === 'win' ? ' match--win' : m.result === 'loss' ? ' match--loss' : '';
    const tail = m.result
      ? '<span class="match__result match__result--' + m.result + '">' + m.result.toUpperCase() + (m.walkover ? ' · WO' : '') + '</span>'
      : '<span class="match__date">' + fmtDate(m.date) + '</span>';
    return '<button type="button" class="match' + cls + '" data-id="' + esc(m.id) + '" title="View match stats">' +
      '<span class="match__event">' + esc(shortEvent(m.event)) + '</span>' +
      '<div class="match__teams"><span class="match__team">' + TEAM + '</span>' +
        '<span class="match__score">' + sc(m.ourScore) + ' : ' + sc(m.theirScore) + '</span>' +
        '<span class="match__team match__team--opp">' + logoImg(m) + esc(m.opponent) + '</span></div>' +
      tail +
    '</button>';
  };

  const emptyCard = (msg) => '<div class="match__empty">' + esc(msg) + '</div>';

  /* ---------------- stats modal ---------------- */
  let modal, lastFocus = null;

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'smodal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="smodal__backdrop" data-close></div>' +
      '<div class="smodal__panel" role="dialog" aria-modal="true" aria-label="Match statistics">' +
        '<button class="smodal__close" data-close aria-label="Close">&times;</button>' +
        '<div class="smodal__head"></div>' +
        '<div class="smodal__body"></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
    return modal;
  }
  function openModal() {
    ensureModal();
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const c = modal.querySelector('.smodal__close');
    if (c) c.focus();
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function openStats(id) {
    const m = RESULTS[id];
    if (!m) return;
    ensureModal();
    $('.smodal__head', modal).innerHTML = statsHead(m);
    $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">Loading stats…</div>';
    openModal();

    let players;
    try { players = await fetchStats(id); }
    catch (e) {
      $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">Stats aren\'t available for this match.</div>';
      return;
    }
    let ours = players.filter((p) => p.side === m.ourSide);
    if (!ours.length) ours = players;
    ours.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
    $('.smodal__body', modal).innerHTML = ours.length ? statsTable(ours) : '<div class="smodal__loading">No player stats recorded.</div>';
  }

  async function fetchStats(id) {
    if (STATS_CACHE[id]) return STATS_CACHE[id];
    const r = await fetch('/api/gg?path=matchup/' + encodeURIComponent(id) + '/stats', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('stats ' + r.status);
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data && data.data) || [];
    STATS_CACHE[id] = arr;
    return arr;
  }

  function statsHead(m) {
    const scCls = m.result === 'win' ? ' is-good' : m.result === 'loss' ? ' is-bad' : '';
    const meta = [m.event, m.division, fmtDate(m.date)].filter(Boolean).join(' · ');
    return '<div class="smodal__score">' +
        '<span class="smodal__team">' + TEAM + '</span>' +
        '<span class="smodal__sc' + scCls + '">' + sc(m.ourScore) + ' : ' + sc(m.theirScore) + '</span>' +
        '<span class="smodal__team smodal__team--opp">' +
          (m.opponentLogo ? '<img class="match__logo" src="' + esc(m.opponentLogo) + '" alt="">' : '') + esc(m.opponent) +
        '</span>' +
      '</div>' +
      '<div class="smodal__meta">' + esc(meta) + '</div>' +
      (m.url ? '<a class="smodal__link" href="' + esc(m.url) + '" target="_blank" rel="noopener">View full match on GG Arena ↗</a>' : '');
  }

  function statsTable(players) {
    const rows = players.map((p) => {
      const rating = parseFloat(p.rating);
      const rc = rating >= 1.1 ? ' is-good' : rating < 0.95 ? ' is-bad' : '';
      const diff = Number(p.kd_diff);
      const dc = diff > 0 ? ' is-good' : diff < 0 ? ' is-bad' : '';
      const ava = (p.user && p.user.image && p.user.image.url) || '';
      const name = p.player_name || (p.user && p.user.user_name) || '?';
      return '<tr>' +
        '<td><span class="stt__player">' +
          (ava ? '<img class="stt__ava" src="' + esc(ava) + '" alt="" loading="lazy">' : '') +
          '<span class="stt__name">' + esc(name) + '</span>' + flagSpan(p.user && p.user.nationality) +
        '</span></td>' +
        '<td class="stt__rating' + rc + '">' + fix2(p.rating) + '</td>' +
        '<td>' + numOr(p.kills) + '</td>' +
        '<td>' + numOr(p.deaths) + '</td>' +
        '<td class="col-opt' + dc + '">' + (diff > 0 ? '+' : '') + (isNaN(diff) ? '–' : diff) + '</td>' +
        '<td>' + Math.round(parseFloat(p.damage_per_round) || 0) + '</td>' +
        '<td>' + pct(p.headshot_ratio) + '</td>' +
        '<td class="col-opt">' + pct(p.kast_ratio) + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="stt-wrap"><table class="stt">' +
      '<thead><tr><th>Player</th><th>Rating</th><th>K</th><th>D</th>' +
      '<th class="col-opt">+/-</th><th>ADR</th><th>HS%</th><th class="col-opt">KAST</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  /* open stats on result click; let upcoming <a> cards navigate normally */
  document.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('.match[data-id]');
    if (card) { e.preventDefault(); openStats(card.getAttribute('data-id')); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  /* ---------------- helpers ---------------- */
  const sc = (n) => (n == null ? '–' : n);
  const numOr = (n) => (n == null ? '–' : n);
  const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? '–' : n.toFixed(2); };
  const pct = (v) => { const n = parseFloat(v); return isNaN(n) ? '–' : Math.round(n * 100) + '%'; };
  function shortEvent(e) { return e ? String(e).split(':')[0].trim() : 'Match'; }
  function flagSpan(c) {
    c = String(c || '').toLowerCase();
    const cl = /^(no|nor)/.test(c) ? 'flag-no' : /^(de|ger)/.test(c) ? 'flag-de' : '';
    return cl ? '<span class="' + cl + ' stt__flag" aria-hidden="true"></span>' : '';
  }
  function fmtDate(d) {
    if (!d) return 'TBD';
    const dt = new Date(String(d).replace(/\.\d+Z$/, 'Z'));
    if (isNaN(dt.getTime())) return String(d);
    const date = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Europe/Oslo' }).toUpperCase();
    const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
    return date + ' · ' + time;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* run */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadMatches);
  else loadMatches();
})();
