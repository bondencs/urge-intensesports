/* =========================================================
   URGE INTENSESPORTS — live data (Good Game Arena)

   - /api/matches  → real fixtures, results, and a career summary
                     (feeds the "About" stat counters).
   - Click a result → /api/gg match detail + stats: per-map
     scores + BOTH teams' scoreboards (lazy, cached).
   - Click a player → /api/player-stats: that player's aggregated
     recent form (lazy, cached).

   Everything degrades gracefully to the static placeholders if
   the API is unreachable (local preview, no token, etc.).
   ========================================================= */
(function () {
  'use strict';

  const $ = (s, c = document) => c.querySelector(s);
  const TEAM = 'Urge Intensesports';
  const RESULTS = {};          // match id -> normalized match
  const STATS_CACHE = {};      // match id -> players[]
  const MATCH_CACHE = {};      // match id -> detail (matchupmaps)
  let PLAYER_STATS = null;     // [] aggregated player form

  /* ---------------- matches + summary ---------------- */
  async function loadMatches() {
    let data;
    try {
      const r = await fetch('/api/matches', { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      data = await r.json();
    } catch (e) { return; }
    if (!data || data.error) return;

    if (data.summary) applySummary(data.summary);

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

  /* ---------------- league table ---------------- */
  async function loadStandings() {
    let d;
    try {
      const r = await fetch('/api/standings', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('standings ' + r.status);
      d = await r.json();
    } catch (e) {
      setPanel('standings', emptyCard('The league table isn\'t available right now.'));
      return;
    }
    const table = (d && d.table) || [];
    if (!table.length) { setPanel('standings', emptyCard('No league table for this season yet.')); return; }

    const started = d.rounds && d.rounds.played > 0;
    const rows = table.map((t, i) =>
      '<tr' + (t.isUs ? ' class="ltbl__us"' : '') + '>' +
        '<td class="ltbl__pos">' + (started ? i + 1 : '–') + '</td>' +
        '<td><span class="ltbl__team">' +
          (t.logo ? '<img class="match__logo" src="' + esc(t.logo) + '" alt="" loading="lazy">' : '') +
          '<span class="ltbl__name">' + esc(t.name) + '</span>' +
        '</span></td>' +
        '<td>' + t.played + '</td>' +
        '<td class="ltbl__w">' + t.wins + '</td>' +
        '<td class="ltbl__l">' + t.losses + '</td>' +
        '<td class="col-opt">' + t.mapsWon + '–' + t.mapsLost + '</td>' +
        '<td class="col-opt' + (t.mapDiff > 0 ? ' is-good' : t.mapDiff < 0 ? ' is-bad' : '') + '">' +
          (t.mapDiff > 0 ? '+' : '') + t.mapDiff + '</td>' +
      '</tr>'
    ).join('');

    const comp = (d.competition && d.competition.name) || '';
    const div = (d.division && d.division.name) || '';
    const caption = [div, shortEvent(comp)].filter(Boolean).join(' · ');
    const foot = started
      ? (d.rounds.played + ' of ' + d.rounds.total + ' matches played')
      : 'Season hasn\'t started yet — the table updates automatically after every round.';

    setPanel('standings',
      '<div class="ltbl-wrap">' +
        (caption ? '<div class="ltbl__cap">' + esc(caption) + '</div>' : '') +
        '<table class="ltbl">' +
          '<thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th>' +
            '<th class="col-opt">Maps</th><th class="col-opt">+/-</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div class="ltbl__foot">' + esc(foot) + '</div>' +
      '</div>');
  }

  function applySummary(s) {
    const map = { played: s.played, winRate: s.winRate, mapsPlayed: s.mapsPlayed, mapsWon: s.mapsWon };
    Object.keys(map).forEach((k) => {
      const el = document.querySelector('[data-stat="' + k + '"]');
      if (!el || map[k] == null) return;
      el.dataset.count = map[k];                       // animated counter will target this
      el.textContent = map[k] + (el.dataset.suffix || ''); // and a correct value if it already ran
    });
  }

  function setPanel(name, html) { const p = $('[data-panel="' + name + '"]'); if (p) p.innerHTML = html; }

  const logoImg = (m) => m.opponentLogo
    ? '<img class="match__logo" src="' + esc(m.opponentLogo) + '" alt="" loading="lazy">' : '';

  const matchCard = (m) =>
    '<a class="match" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener">' +
      '<span class="match__event">' + esc(eventLabel(m)) + '</span>' +
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

  /* ---------------- shared modal shell ---------------- */
  let modal, lastFocus = null;
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'smodal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="smodal__backdrop" data-close></div>' +
      '<div class="smodal__panel" role="dialog" aria-modal="true" aria-label="Statistics">' +
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

  /* ---------------- match stats modal ---------------- */
  async function openStats(id) {
    const m = RESULTS[id];
    if (!m) return;
    ensureModal();
    $('.smodal__head', modal).innerHTML = matchHead(m);
    $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">Loading stats…</div>';
    openModal();

    let detail, players;
    try {
      [detail, players] = await Promise.all([fetchMatch(id), fetchStats(id)]);
    } catch (e) {
      $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">Stats aren\'t available for this match.</div>';
      return;
    }
    const ours = players.filter((p) => p.side === m.ourSide).sort(byRating);
    const theirs = players.filter((p) => p.side !== m.ourSide).sort(byRating);

    let html = mapsRow(detail, m.ourSide);
    if (ours.length) html += teamBlock(TEAM, ours);
    if (theirs.length) html += teamBlock(m.opponent, theirs);
    $('.smodal__body', modal).innerHTML = html || '<div class="smodal__loading">No player stats recorded.</div>';
  }

  function matchHead(m) {
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

  function mapsRow(detail, ourSide) {
    const maps = (detail && detail.matchupmaps) || [];
    if (!maps.length) return '';
    const chips = maps.map((mp, i) => {
      const our = ourSide === 'home' ? mp.home_score : mp.away_score;
      const their = ourSide === 'home' ? mp.away_score : mp.home_score;
      const name = (mp.resource && mp.resource.name) || ('Map ' + (i + 1));
      const cls = our > their ? 'is-good' : our < their ? 'is-bad' : '';
      return '<div class="map-chip"><span class="map-chip__name">' + esc(name) + '</span>' +
        '<span class="map-chip__score ' + cls + '">' + sc(our) + '–' + sc(their) + '</span></div>';
    }).join('');
    return '<div class="maps-row">' + chips + '</div>';
  }

  const teamBlock = (label, players) =>
    '<div class="team-stats"><div class="team-stats__label">' + esc(label) + '</div>' + statsTable(players) + '</div>';

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

  /* ---------------- player form modal ---------------- */
  async function openPlayer(userId, displayName) {
    ensureModal();
    $('.smodal__head', modal).innerHTML = '';
    $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">Loading player stats…</div>';
    openModal();

    if (!PLAYER_STATS) {
      try {
        const r = await fetch('/api/player-stats', { headers: { Accept: 'application/json' } });
        PLAYER_STATS = r.ok ? ((await r.json()).players || []) : [];
      } catch (e) { PLAYER_STATS = []; }
    }
    const p = PLAYER_STATS.find((x) => String(x.id) === String(userId));
    if (!p) {
      $('.smodal__body', modal).innerHTML = '<div class="smodal__loading">No recent match stats for ' + esc(displayName || 'this player') + ' yet.</div>';
      return;
    }
    $('.smodal__head', modal).innerHTML = playerHead(p, displayName);
    $('.smodal__body', modal).innerHTML = playerBody(p);
  }

  function playerHead(p, displayName) {
    const name = displayName || p.name;
    return '<div class="phead">' +
        (p.avatar ? '<img class="phead__ava" src="' + esc(p.avatar) + '" alt="">' : '') +
        '<div><h3 class="phead__name">' + esc(name) + flagSpan(p.country) + '</h3>' +
        '<span class="phead__sub">Recent form · ' + p.matches + ' matches · ' + p.maps + ' maps</span></div>' +
      '</div>';
  }

  function playerBody(p) {
    const rc = p.rating >= 1.1 ? ' is-good' : p.rating != null && p.rating < 0.95 ? ' is-bad' : '';
    const cells = [
      ['Rating', fix2(p.rating), rc],
      ['K/D', fix2(p.kd), p.kd >= 1 ? ' is-good' : ' is-bad'],
      ['ADR', p.adr, ''],
      ['HS%', p.hsPct + '%', ''],
      ['KAST', p.kastPct + '%', ''],
      ['Opening', p.openingPct + '%', ''],
      ['Clutches', p.clutches, ''],
      ['Kills', p.kills, ''],
      ['Deaths', p.deaths, ''],
    ];
    const grid = cells.map((c) =>
      '<div class="pstat"><span class="pstat__val' + c[2] + '">' + c[1] + '</span><span class="pstat__lab">' + c[0] + '</span></div>'
    ).join('');
    const steam = p.steam
      ? '<a class="smodal__link" href="https://steamcommunity.com/profiles/' + esc(p.steam) + '" target="_blank" rel="noopener">Steam profile ↗</a>'
      : '';
    return '<div class="pstat-grid">' + grid + '</div>' + steam;
  }

  /* ---------------- click delegation ---------------- */
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    const result = e.target.closest('.match[data-id]');
    if (result) { e.preventDefault(); openStats(result.getAttribute('data-id')); return; }
    if (e.target.closest('.player a')) return;     // let social/Steam links work
    const card = e.target.closest('.player[data-user]');
    if (card) {
      const nameEl = card.querySelector('.player__name');
      openPlayer(card.getAttribute('data-user'), nameEl ? nameEl.textContent : '');
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  /* ---------------- fetch helpers ---------------- */
  async function fetchStats(id) {
    if (STATS_CACHE[id]) return STATS_CACHE[id];
    const r = await fetch('/api/gg?path=matchup/' + encodeURIComponent(id) + '/stats', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('stats ' + r.status);
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data && data.data) || [];
    STATS_CACHE[id] = arr;
    return arr;
  }
  async function fetchMatch(id) {
    if (MATCH_CACHE[id]) return MATCH_CACHE[id];
    try {
      const r = await fetch('/api/gg?path=matchup/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
      MATCH_CACHE[id] = r.ok ? await r.json() : {};
    } catch (e) { MATCH_CACHE[id] = {}; }
    return MATCH_CACHE[id];
  }

  /* ---------------- small helpers ---------------- */
  const byRating = (a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
  const sc = (n) => (n == null ? '–' : n);
  const numOr = (n) => (n == null ? '–' : n);
  const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? '–' : n.toFixed(2); };
  const pct = (v) => { const n = parseFloat(v); return isNaN(n) ? '–' : Math.round(n * 100) + '%'; };
  function shortEvent(e) { return e ? String(e).split(':')[0].trim() : 'Match'; }
  function eventLabel(m) {
    return shortEvent(m.event) + (m.round ? ' · ' + m.round : '');
  }
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
  function start() {
    loadMatches();
    // The table is only fetched the first time someone opens that tab.
    const tab = document.querySelector('.matches__tab[data-tab="standings"]');
    if (tab) tab.addEventListener('click', function once() {
      tab.removeEventListener('click', once);
      loadStandings();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
