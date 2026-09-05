/* =========================================================
   /api/standings  —  live league table for the current season.

   Good Game Arena has no standings endpoint, so we build the
   table ourselves from every matchup in our division:

     GET /matchup?division_id=<id>&limit=50   (paged)

   Returns:
     { competition: {id, name, url}, division: {id, name},
       rounds: {played, total},
       table: [ { teamId, name, logo, url, played, wins, losses,
                  mapsWon, mapsLost, mapDiff, isUs } ] }
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');

const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;

// Fallbacks only — the live division is detected from our own fixture list,
// so a new season shows up without anyone changing a setting.
const COMPETITION_ID = Number(process.env.GGARENA_COMPETITION_ID || 13908);
const DIVISION_ID = Number(process.env.GGARENA_DIVISION_ID || 18870);

const PER_PAGE = 50;
const MAX_PAGES = 10;

module.exports = async (req, res) => {
  if (!TOKEN) return fail(res, 503, 'Server is missing the GGARENA_TOKEN environment variable.');

  try {
    const divisionId = await currentDivisionId();
    const matches = await divisionMatchups(divisionId);
    if (!matches.length) return fail(res, 404, 'No matches found for this division.');

    const rows = {};
    let played = 0;

    for (const m of matches) {
      const home = side(m.home_signup);
      const away = side(m.away_signup);
      if (!home || !away) continue;

      const h = row(rows, home);
      const a = row(rows, away);

      if (m.finished_at == null || m.cancelled) continue;
      played++;

      const hs = num(m.home_score);
      const as = num(m.away_score);
      h.mapsWon += hs; h.mapsLost += as;
      a.mapsWon += as; a.mapsLost += hs;
      h.played++; a.played++;

      const homeWon = m.winning_side ? m.winning_side === 'home' : hs > as;
      if (homeWon) { h.wins++; a.losses++; h.form.push('W'); a.form.push('L'); }
      else { a.wins++; h.losses++; a.form.push('W'); h.form.push('L'); }
    }

    const first = matches[0] || {};
    const table = Object.values(rows)
      .map((r) => ({
        teamId: r.teamId,
        name: r.name,
        logo: r.logo,
        url: r.url,
        played: r.played,
        wins: r.wins,
        losses: r.losses,
        mapsWon: r.mapsWon,
        mapsLost: r.mapsLost,
        mapDiff: r.mapsWon - r.mapsLost,
        form: r.form.slice(-5),
        isUs: r.isUs,
      }))
      .sort((x, y) =>
        y.wins - x.wins ||
        y.mapDiff - x.mapDiff ||
        y.mapsWon - x.mapsWon ||
        x.name.localeCompare(y.name)
      );

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({
      competition: {
        id: (first.competition && first.competition.id) || COMPETITION_ID,
        name: (first.competition && first.competition.name) || null,
        url: (first.competition && first.competition.url) || null,
      },
      division: {
        id: (first.division && first.division.id) || divisionId,
        name: (first.division && first.division.name) || null,
      },
      rounds: { played, total: matches.filter((m) => !m.cancelled).length },
      table,
    });
  } catch (err) {
    return fail(res, err.statusCode || 502, err.message || 'Failed to load the league table.');
  }
};

function side(signup) {
  const t = signup && signup.team;
  if (!t || t.id == null) return null;
  return {
    id: t.id,
    name: t.name || (signup && signup.name) || 'TBD',
    logo: (t.logo && t.logo.url) || null,
    url: t.url || null,
  };
}

function row(rows, t) {
  return rows[t.id] || (rows[t.id] = {
    teamId: t.id, name: t.name, logo: t.logo, url: t.url,
    played: 0, wins: 0, losses: 0, mapsWon: 0, mapsLost: 0,
    form: [], isUs: isUs(t.id),
  });
}

// The division we're actually playing in: the one our next fixture belongs to,
// else the one our last result came from. One cheap request against the
// current team; falls back to GGARENA_DIVISION_ID if anything is missing.
async function currentDivisionId() {
  try {
    const data = await gg(`matchup?team_id=${TEAM_IDS[0]}&limit=${PER_PAGE}`);
    const list = (Array.isArray(data) ? data : (data && data.data) || [])
      .filter((m) => !m.cancelled && m.division && m.division.id);
    const now = Date.now();
    const ts = (m) => new Date(String(m.start_time || '').replace(/\.\d+Z$/, 'Z')).getTime() || 0;

    const next = list.filter((m) => m.finished_at == null && ts(m) > now).sort((a, b) => ts(a) - ts(b))[0];
    if (next) return next.division.id;
    const last = list.filter((m) => m.finished_at != null).sort((a, b) => ts(b) - ts(a))[0];
    if (last) return last.division.id;
  } catch (e) { /* fall through to the configured default */ }
  return DIVISION_ID;
}

async function divisionMatchups(divisionId) {
  const out = [];
  let page = 1, last = 1;
  do {
    const data = await gg(`matchup?division_id=${divisionId}&limit=${PER_PAGE}&page=${page}`);
    const list = Array.isArray(data) ? data : (data && data.data) || [];
    for (const m of list) {
      // Safety net: the upstream filter is trusted, but never mix divisions.
      if (!m.division || m.division.id === divisionId) out.push(m);
    }
    last = (data && data.meta && data.meta.last_page) || 1;
    page++;
  } while (page <= last && page <= MAX_PAGES);
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

const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
