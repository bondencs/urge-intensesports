/* =========================================================
   /api/matches  —  real fixtures & results for the team.

   Fetches the Good Game Arena matchup list (server-side, token
   hidden), keeps only matches involving OUR team, normalizes
   them, and returns a clean shape the front-end can render:

     { upcoming: [...], results: [...], summary: {...} }

   Each item: { id, url, opponent, opponentLogo, event, division,
                divisionId, round, date, finished, ourScore,
                theirScore, result, walkover, twitch }

   The summary feeds the About counters and covers the current
   season plus the previous one - not all time, which would mix in
   seasons played by an older roster under a different team id.
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');

// Our GG Arena team ids (not secret). The CURRENT team comes first; older ids
// are legacy teams the same squad played under — their matches still count as
// our history. Override with a comma-separated env var if this ever changes.
const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;

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

    // Summary for the About counters. The squad re-registered under a new team
    // id, so an all-time total mixes in seasons this roster never played. Scope
    // it to the current season plus the one before it.
    const summary = seasonSummary(matches);

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

// The seasons the counters cover: the one we're in now, plus the previous one.
function seasonSummary(matches) {
  const now = Date.now();
  const withDivision = matches.filter((m) => m.divisionId);

  const next = withDivision
    .filter((m) => !m.finished && !m.cancelled && m.ts > now)
    .sort((a, b) => a.ts - b.ts)[0];
  const lastPlayed = withDivision.filter((m) => m.finished).sort((a, b) => b.ts - a.ts);

  const currentId = next ? next.divisionId : (lastPlayed[0] && lastPlayed[0].divisionId) || null;
  const previous = lastPlayed.find((m) => m.divisionId !== currentId);
  const ids = [currentId, previous && previous.divisionId].filter((x) => x != null);

  // No division data at all (very old fixtures): fall back to every result.
  const counted = ids.length
    ? matches.filter((m) => m.finished && ids.indexOf(m.divisionId) !== -1)
    : matches.filter((m) => m.finished);

  let wins = 0, losses = 0, mapsPlayed = 0, mapsWon = 0;
  for (const m of counted) {
    if (m.result === 'win') wins++;
    else if (m.result === 'loss') losses++;
    if (m.ourScore != null && m.theirScore != null) {
      mapsPlayed += m.ourScore + m.theirScore;
      mapsWon += m.ourScore;
    }
  }

  const season = (id) => {
    const m = matches.find((x) => x.divisionId === id);
    return m ? { id, division: m.division, competition: m.event, label: seasonLabel(m.event) } : null;
  };

  return {
    played: counted.length,
    wins, losses,
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0,
    mapsPlayed, mapsWon,
    seasons: ids.map(season).filter(Boolean),
  };
}

// "Komplettligaen: Counter-strike - Hosten 2026" -> "Hosten 2026"
function seasonLabel(competition) {
  if (!competition) return null;
  const parts = String(competition).split(' - ');
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
}

/* ---------- Norwegian division names, in English ----------
   Good Game Arena names divisions in Norwegian ("3. divisjon avd. D"),
   which reads badly in English copy. The competition name itself
   (Komplettligaen) is a proper noun and stays as it is. */
function enDivision(name) {
  if (!name) return name || null;
  return String(name).trim()
    .replace(/(\d+)\.\s*divisjon/gi, (_, n) => ordinal(n) + ' Division')
    .replace(/\s*\bavd\.?\s*/gi, ', Group ')
    .replace(/\bsluttspill\b/gi, 'Playoffs')
    .trim();
}
function ordinal(n) {
  const i = Number(n);
  if (isNaN(i)) return n;
  const rest = i % 100;
  const suffix = ['th', 'st', 'nd', 'rd'][(rest - 20) % 10] || ['th', 'st', 'nd', 'rd'][rest] || 'th';
  return i + suffix;
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
    division: enDivision((m.division && m.division.name) || null),
    divisionId: (m.division && m.division.id) || null,
    round: m.round_number ? `Round ${m.round_number}` : (m.round_identifier_text || null),
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
