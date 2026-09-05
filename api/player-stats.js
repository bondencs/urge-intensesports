/* =========================================================
   /api/player-stats  —  per-player aggregated form.

   The user/profile endpoint carries no stats, so we aggregate
   each of OUR players across recent finished matches: fetch the
   team's matchups, pull /stats for the most recent ones (in
   parallel), and sum/average per player (our side only).

   Returns: { players: [ { id, name, country, avatar, steam,
     matches, maps, kills, deaths, assists, kd, adr, hsPct,
     kastPct, rating, openingPct, clutches } ], sampled }
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
// Current team first, then legacy team ids the same squad played under.
const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;
const PER_PAGE = 50; // the API's page-size param is "limit"
const MAX_PAGES = 12;
const SAMPLE = 20; // aggregate over the most recent N finished matches

module.exports = async (req, res) => {
  if (!TOKEN) return fail(res, 503, 'Server is missing the GGARENA_TOKEN environment variable.');

  try {
    const matchups = await teamMatchups();
    const recent = matchups
      .filter((m) => m.finished_at != null)
      .sort((a, b) => ts(b.start_time) - ts(a.start_time))
      .slice(0, SAMPLE);

    // Pull all stat sheets in parallel; tolerate individual failures.
    const sheets = await Promise.all(
      recent.map((m) => gg(`matchup/${m.id}/stats`).catch(() => null))
    );

    const agg = {};
    recent.forEach((m, i) => {
      const sheet = sheets[i];
      if (!Array.isArray(sheet)) return;
      const ourSide = m.home_signup && m.home_signup.team && isUs(m.home_signup.team.id) ? 'home' : 'away';
      sheet.filter((p) => p.side === ourSide).forEach((p) => addPlayer(agg, p));
    });

    const players = Object.values(agg).map(finalize).sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ players, sampled: recent.length });
  } catch (err) {
    return fail(res, err.statusCode || 502, err.message || 'Failed to load player stats.');
  }
};

function addPlayer(agg, p) {
  const id = p.paradise_user_id;
  const a = agg[id] || (agg[id] = {
    id, name: p.player_name,
    country: (p.user && p.user.nationality) || '',
    avatar: (p.user && p.user.image && p.user.image.url) || '',
    steam: steamOf(p.user),
    matches: 0, maps: 0, rounds: 0, kills: 0, deaths: 0, assists: 0,
    hs: 0, dmg: 0, kast: 0, openW: 0, openT: 0, clutch: 0,
    ratingSum: 0, ratingW: 0,
  });
  const maps = num(p.maps_played);
  a.matches += 1;
  a.maps += maps;
  a.rounds += num(p.rounds_played);
  a.kills += num(p.kills);
  a.deaths += num(p.deaths);
  a.assists += num(p.assists);
  a.hs += num(p.headshots);
  a.dmg += num(p.damage_given);
  a.kast += num(p.kast_rounds);
  a.openW += num(p.opening_duels_won);
  a.openT += num(p.opening_duels_total);
  a.clutch += num(p.clutches_won);
  const r = parseFloat(p.rating);
  if (!isNaN(r) && maps > 0) { a.ratingSum += r * maps; a.ratingW += maps; }
}

function finalize(a) {
  return {
    id: a.id,
    name: a.name,
    country: a.country,
    avatar: a.avatar,
    steam: a.steam,
    matches: a.matches,
    maps: a.maps,
    kills: a.kills,
    deaths: a.deaths,
    assists: a.assists,
    kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills,
    adr: a.rounds ? Math.round(a.dmg / a.rounds) : 0,
    hsPct: a.kills ? Math.round((a.hs / a.kills) * 100) : 0,
    kastPct: a.rounds ? Math.round((a.kast / a.rounds) * 100) : 0,
    rating: a.ratingW ? +(a.ratingSum / a.ratingW).toFixed(2) : null,
    openingPct: a.openT ? Math.round((a.openW / a.openT) * 100) : 0,
    clutches: a.clutch,
  };
}

async function teamMatchups() {
  const out = [];
  const seen = new Set();
  for (const teamId of TEAM_IDS) {
    let page = 1, last = 1;
    do {
      const data = await gg(`matchup?team_id=${teamId}&limit=${PER_PAGE}&page=${page}`);
      const list = Array.isArray(data) ? data : (data && data.data) || [];
      for (const m of list) {
        const h = m.home_signup && m.home_signup.team && m.home_signup.team.id;
        const a = m.away_signup && m.away_signup.team && m.away_signup.team.id;
        if ((isUs(h) || isUs(a)) && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
      }
      last = (data && data.meta && data.meta.last_page) || 1;
      page++;
    } while (page <= last && page <= MAX_PAGES);
  }
  return out;
}

async function gg(path) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const e = new Error(`Good Game Arena API returned ${r.status}.`);
    e.statusCode = r.status === 401 || r.status === 403 ? 502 : r.status;
    throw e;
  }
  return r.json();
}

function steamOf(user) {
  const accs = (user && user.accounts) || [];
  const s = accs.find((x) => x.provider === 'STEAM');
  return s ? s.account_id : null;
}
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const ts = (d) => { const t = new Date(String(d).replace(/\.\d+Z$/, 'Z')).getTime(); return isNaN(t) ? 0 : t; };
function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
