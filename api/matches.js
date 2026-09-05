/* =========================================================
   /api/matches  —  real fixtures & results for the team.

   Fetches the Good Game Arena matchup list (server-side, token
   hidden), keeps only matches involving OUR team, normalizes
   them, and returns a clean shape the front-end can render:

     { upcoming: [...], results: [...] }

   Each item: { id, url, opponent, opponentLogo, event, division,
                date, finished, ourScore, theirScore, result,
                walkover, twitch }
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');

// Our GG Arena team ids (not secret). The CURRENT team comes first; older ids
// are legacy teams the same squad played under — their matches still count as
// our history. Override with a comma-separated env var if this ever changes.
const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;

// Current season (Komplettligaen). Used to tag this season's fixtures.
const COMPETITION_ID = Number(process.env.GGARENA_COMPETITION_ID || 13908);
const DIVISION_ID = Number(process.env.GGARENA_DIVISION_ID || 18870);

const PER_PAGE = 50;  // the API's page-size param is "limit" (per_page is ignored)
const MAX_PAGES = 12; // safety cap on pagination

module.exports = async (req, res) => {
  if (!TOKEN) return fail(res, 503, 'Server is missing the GGARENA_TOKEN environment variable.');

  try {
    const raw = await fetchTeamMatchups();
    const matches = raw.map(normalize).filter(Boolean);

    const upcoming = matches
      .filter((m) => !m.finished && !m.cancelled)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 10); // a full Komplettligaen season is 9 fixtures
    const results = matches
      .filter((m) => m.finished)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 12); // most recent dozen — the team has 100+ historical matches

    // Real career summary, computed over ALL finished matches (not just the shown 12).
    const finishedAll = matches.filter((m) => m.finished);
    let wins = 0, losses = 0, mapsPlayed = 0, mapsWon = 0;
    for (const m of finishedAll) {
      if (m.result === 'win') wins++;
      else if (m.result === 'loss') losses++;
      if (m.ourScore != null && m.theirScore != null) {
        mapsPlayed += m.ourScore + m.theirScore;
        mapsWon += m.ourScore;
      }
    }
    const summary = {
      played: finishedAll.length,
      wins, losses,
      winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0,
      mapsPlayed, mapsWon,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json({ upcoming, results, summary, count: matches.length });
  } catch (err) {
    return fail(res, err.statusCode || 502, err.message || 'Failed to load matches.');
  }
};

// Page through /matchup for every team id we've played under, and keep only
// matches that actually involve us.
async function fetchTeamMatchups() {
  const seen = new Set();
  const collected = [];
  for (const teamId of TEAM_IDS) {
    let page = 1;
    let lastPage = 1;
    do {
      // team_id is the real upstream filter; we still filter client-side as a safety net.
      const data = await gg(`matchup?team_id=${teamId}&limit=${PER_PAGE}&page=${page}`);
      const list = Array.isArray(data) ? data : (data && data.data) || [];
      for (const m of list) {
        const home = m.home_signup && m.home_signup.team && m.home_signup.team.id;
        const away = m.away_signup && m.away_signup.team && m.away_signup.team.id;
        if ((isUs(home) || isUs(away)) && !seen.has(m.id)) { seen.add(m.id); collected.push(m); }
      }
      lastPage = (data && data.meta && data.meta.last_page) || 1;
      page++;
    } while (page <= lastPage && page <= MAX_PAGES);
  }
  return collected;
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

function normalize(m) {
  const isHome = !!(m.home_signup && m.home_signup.team && isUs(m.home_signup.team.id));
  const them = isHome ? m.away_signup : m.home_signup;
  if (!them || !them.team) return null;

  const ourScore = isHome ? m.home_score : m.away_score;
  const theirScore = isHome ? m.away_score : m.home_score;
  const finished = m.finished_at != null;
  const won = m.winning_side ? m.winning_side === (isHome ? 'home' : 'away') : null;

  return {
    id: m.id,
    url: m.url || null,
    ourSide: isHome ? 'home' : 'away',
    opponent: them.team.name || them.name || 'TBD',
    opponentLogo: (them.team.logo && them.team.logo.url) || null,
    event: (m.competition && m.competition.name) || 'Match',
    division: (m.division && m.division.name) || null,
    round: m.round_number ? `Round ${m.round_number}` : (m.round_identifier_text || null),
    // true for fixtures in the season we're currently playing
    thisSeason: !!(m.division && m.division.id === DIVISION_ID) ||
                !!(m.competition && m.competition.id === COMPETITION_ID),
    date: m.start_time || null,
    ts: m.start_time ? new Date(String(m.start_time).replace(/\.\d+Z$/, 'Z')).getTime() : 0,
    finished,
    cancelled: !!m.cancelled,
    walkover: !!m.walkover,
    ourScore: numOrNull(ourScore),
    theirScore: numOrNull(theirScore),
    result: finished && won != null ? (won ? 'win' : 'loss') : null,
    twitch: (m.videos || []).map((v) => v.source === 'twitch' && v.url).find(Boolean) || null,
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
