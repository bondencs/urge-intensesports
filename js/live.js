/* =========================================================
   URGE INTENSESPORTS — live data (Good Game Arena API)

   Talks ONLY to our own /api/gg proxy, so no token ever
   touches the browser. If the API isn't set up yet, is
   unreachable, or the data can't be read, the page silently
   keeps its static placeholder content — it never breaks.

   To turn it on: set your club / team id in index.html:
     <meta name="gg-club" content="YOUR_CLUB_ID" />
     <meta name="gg-team" content="YOUR_TEAM_ID" />
   (Find your club id after deploying: /api/gg?path=club)
   ========================================================= */
(function () {
  'use strict';

  const $  = (s, c = document) => c.querySelector(s);
  const meta = (n) => (document.querySelector('meta[name="' + n + '"]') || {}).content || '';

  const CFG = {
    proxy: '/api/gg',
    club: meta('gg-club').trim(),
    team: meta('gg-team').trim(),
  };

  // No config → do nothing at all (zero network calls).
  if (!CFG.club && !CFG.team) return;

  async function ggGet(path, params = {}) {
    const qs = new URLSearchParams(Object.assign({ path }, params));
    const r = await fetch(CFG.proxy + '?' + qs.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('proxy ' + r.status);
    return r.json();
  }

  // GG responses might be a bare array or wrapped in a common key.
  const asArray = (d) =>
    Array.isArray(d) ? d : (d && (d.data || d.items || d.results || d.matchups || d.players || d.members)) || [];

  /* ---------------- MATCHES ---------------- */
  async function loadMatches() {
    if (!CFG.club) return;
    let raw;
    try { raw = await ggGet('matchup', { club: CFG.club, limit: 25 }); }
    catch (e) { return; }                                   // keep placeholders

    const matches = asArray(raw).map(mapMatch).filter((m) => m && m.opponent);
    if (!matches.length) return;                            // mapping off → keep placeholders

    const upcoming = matches.filter((m) => m.status !== 'finished').sort((a, b) => ts(a.date) - ts(b.date));
    const results  = matches.filter((m) => m.status === 'finished').sort((a, b) => ts(b.date) - ts(a.date));

    if (upcoming.length) setPanel('upcoming', upcoming.map(matchCard).join(''));
    if (results.length)  setPanel('results',  results.map(resultCard).join(''));
  }

  function setPanel(name, html) {
    const panel = $('[data-panel="' + name + '"]');
    if (panel && html) panel.innerHTML = html;
  }

  /* >>> FIELD MAPPING — tweak to match a real /matchup response <<< */
  function mapMatch(m) {
    if (!m || typeof m !== 'object') return null;
    const opponent = pick(m, ['opponent.name', 'away.name', 'teamB.name', 'opponentName', 'opponent']) || 'TBD';
    const date  = pick(m, ['scheduledAt', 'startsAt', 'startTime', 'date', 'playedAt', 'time']);
    const event = pick(m, ['event.name', 'tournament.name', 'competition.name', 'league.name', 'event']) || 'Match';
    const status = String(pick(m, ['status', 'state', 'phase']) || '').toLowerCase();

    const home = num(pick(m, ['score.home', 'homeScore', 'result.home', 'scoreHome']));
    const away = num(pick(m, ['score.away', 'awayScore', 'result.away', 'scoreAway']));
    const hasScore = home != null && away != null;

    const finished =
      m.finished === true ||
      /fin|complete|ended|over|played|result/.test(status) ||
      (hasScore && /win|won|loss|lost|defeat/.test(status));

    const score = hasScore ? home + ' : ' + away : pick(m, ['score.display', 'result.score']);
    let result = null;
    if (finished && hasScore) result = home > away ? 'win' : home < away ? 'loss' : 'draw';

    return {
      id: pick(m, ['uuid', 'id']),
      event, opponent, date, score,
      status: finished ? 'finished' : 'upcoming',
      result,
    };
  }

  const matchCard = (m) =>
    '<div class="match">' +
      '<span class="match__event">' + esc(m.event) + '</span>' +
      '<div class="match__teams">' +
        '<span class="match__team">Urge Intensesports</span>' +
        '<span class="match__vs">VS</span>' +
        '<span class="match__team match__team--opp">' + esc(m.opponent) + '</span>' +
      '</div>' +
      '<span class="match__date">' + fmtDate(m.date) + '</span>' +
    '</div>';

  const resultCard = (m) => {
    const cls = m.result === 'win' ? ' match--win' : m.result === 'loss' ? ' match--loss' : '';
    const tail = m.result
      ? '<span class="match__result match__result--' + (m.result === 'win' ? 'win' : 'loss') + '">' + m.result.toUpperCase() + '</span>'
      : '<span class="match__date">' + fmtDate(m.date) + '</span>';
    return '<div class="match' + cls + '">' +
      '<span class="match__event">' + esc(m.event) + '</span>' +
      '<div class="match__teams">' +
        '<span class="match__team">Urge Intensesports</span>' +
        '<span class="match__score">' + esc(m.score || '–') + '</span>' +
        '<span class="match__team match__team--opp">' + esc(m.opponent) + '</span>' +
      '</div>' + tail +
    '</div>';
  };

  /* ---------------- ROSTER ---------------- */
  async function loadRoster() {
    if (!CFG.team) return;
    let raw;
    try { raw = await ggGet('team/' + encodeURIComponent(CFG.team) + '/players'); }
    catch (e) { return; }

    const players = asArray(raw).map(mapPlayer).filter((p) => p && p.name);
    if (!players.length) return;

    const grid = $('.roster__grid');
    if (grid) {
      grid.innerHTML = players.map(playerCard).join('') + staffCard();
      reinjectIcons();
    }
  }

  /* >>> FIELD MAPPING — tweak to match a real /team/{team}/players response <<< */
  function mapPlayer(p) {
    if (!p || typeof p !== 'object') return null;
    return {
      name: pick(p, ['ign', 'nickname', 'name', 'username', 'displayName']),
      country: String(pick(p, ['country', 'nationality', 'countryCode', 'country.code']) || '').toLowerCase(),
    };
  }

  const flagClass = (c) =>
    /^(no|nor|norway)/.test(c) ? 'flag-no' : /^(de|ger|germany)/.test(c) ? 'flag-de' : '';

  function playerCard(p, i) {
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const num2 = String(i + 1).padStart(2, '0');
    const fc = flagClass(p.country);
    const flag = fc ? '<span class="' + fc + '" aria-hidden="true"></span>' : '';
    const country = fc === 'flag-no' ? 'Norway' : fc === 'flag-de' ? 'Germany' : (p.country || '').toUpperCase();
    return '<article class="player">' +
        '<div class="player__media"><span class="player__ghost">' + esc(initial) + '</span>' +
        '<span class="player__num">' + num2 + '</span></div>' +
        '<div class="player__body">' +
          '<div class="player__top"><h3 class="player__name">' + esc(p.name) + '</h3>' + flag + '</div>' +
          '<p class="player__role">' + esc(country) + '</p>' +
          '<div class="player__socials">' +
            soc(p.name, 'twitch') + soc(p.name, 'x') + soc(p.name, 'steam') + soc(p.name, 'ig') +
          '</div>' +
        '</div>' +
      '</article>';
  }
  const soc = (name, key) => '<a href="#" aria-label="' + esc(name) + ' ' + key + '" data-social="' + key + '"></a>';
  const staffCard = () =>
    '<article class="player player--join"><div class="player__join-inner">' +
      '<span class="player__join-plus">+</span><h3>STAFF &amp; SUBS</h3>' +
      '<p>Coach, analyst and content slots open.</p>' +
      '<a href="#contact" class="link-arrow">Get in touch</a>' +
    '</div></article>';

  // main.js exposes its icon set so re-rendered cards keep their icons.
  function reinjectIcons() {
    if (!window.URGE_ICONS) return;
    document.querySelectorAll('.roster__grid [data-social]').forEach((a) => {
      a.innerHTML = window.URGE_ICONS[a.dataset.social] || '';
    });
  }

  /* ---------------- helpers ---------------- */
  function pick(obj, paths) {
    for (const path of paths) {
      const val = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
      if (val != null && val !== '') return val;
    }
    return undefined;
  }
  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  const ts = (d) => { const t = new Date(d).getTime(); return isNaN(t) ? 0 : t; };
  function fmtDate(d) {
    if (!d) return 'TBD';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toUpperCase() +
      ' · ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' CET';
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- run ---------------- */
  function start() { Promise.allSettled([loadMatches(), loadRoster()]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
