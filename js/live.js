/* =========================================================
   URGE INTENSESPORTS — live matches (Good Game Arena)

   Calls our own /api/matches endpoint (token stays server-side)
   and swaps the placeholder fixtures for real data. If the API
   isn't reachable (e.g. local preview, not deployed, no token),
   the page keeps its static placeholders — it never breaks.

   Roster is intentionally kept curated/static: the API roster
   endpoint returns all members with no "active" flag, so it
   can't tell the starting five from subs/staff.
   ========================================================= */
(function () {
  'use strict';

  const $ = (s, c = document) => c.querySelector(s);
  const TEAM = 'Urge Intensesports';

  async function loadMatches() {
    let data;
    try {
      const r = await fetch('/api/matches', { headers: { Accept: 'application/json' } });
      if (!r.ok) return;                 // keep placeholders
      data = await r.json();
    } catch (e) {
      return;                            // keep placeholders
    }
    if (!data || data.error) return;

    const upcoming = Array.isArray(data.upcoming) ? data.upcoming : [];
    const results = Array.isArray(data.results) ? data.results : [];

    // Data loaded successfully → replace placeholders with the truth
    // (including empty states, so no fake fixtures linger).
    setPanel('upcoming', upcoming.length
      ? upcoming.map(matchCard).join('')
      : emptyCard('No upcoming matches scheduled right now.'));

    setPanel('results', results.length
      ? results.map(resultCard).join('')
      : emptyCard('No results to show yet.'));
  }

  function setPanel(name, html) {
    const panel = $('[data-panel="' + name + '"]');
    if (panel) panel.innerHTML = html;
  }

  const logoImg = (m) => m.opponentLogo
    ? '<img class="match__logo" src="' + esc(m.opponentLogo) + '" alt="" loading="lazy">'
    : '';

  const matchCard = (m) =>
    '<a class="match" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener">' +
      '<span class="match__event">' + esc(shortEvent(m.event)) + '</span>' +
      '<div class="match__teams">' +
        '<span class="match__team">' + TEAM + '</span>' +
        '<span class="match__vs">VS</span>' +
        '<span class="match__team match__team--opp">' + logoImg(m) + esc(m.opponent) + '</span>' +
      '</div>' +
      '<span class="match__date">' + fmtDate(m.date) + '</span>' +
    '</a>';

  const resultCard = (m) => {
    const cls = m.result === 'win' ? ' match--win' : m.result === 'loss' ? ' match--loss' : '';
    const tail = m.result
      ? '<span class="match__result match__result--' + m.result + '">' +
          m.result.toUpperCase() + (m.walkover ? ' · WO' : '') + '</span>'
      : '<span class="match__date">' + fmtDate(m.date) + '</span>';
    return '<a class="match' + cls + '" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener">' +
      '<span class="match__event">' + esc(shortEvent(m.event)) + '</span>' +
      '<div class="match__teams">' +
        '<span class="match__team">' + TEAM + '</span>' +
        '<span class="match__score">' + sc(m.ourScore) + ' : ' + sc(m.theirScore) + '</span>' +
        '<span class="match__team match__team--opp">' + logoImg(m) + esc(m.opponent) + '</span>' +
      '</div>' + tail +
    '</a>';
  };

  const emptyCard = (msg) => '<div class="match__empty">' + esc(msg) + '</div>';

  /* helpers */
  const sc = (n) => (n == null ? '–' : n);
  function shortEvent(e) {
    if (!e) return 'Match';
    return String(e).split(':')[0].trim();   // "Komplettligaen: ..." -> "Komplettligaen"
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
