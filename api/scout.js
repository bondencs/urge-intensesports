/* =========================================================
   /api/scout  —  opponent scouting dossier.

     GET /api/scout             → our next opponent
     GET /api/scout?team=<id>   → any team

   Built from the opponent's recent matches:
     matchup/{id}        → matchupmaps: which maps, what score
     matchup/{id}/veto   → what they ban first, what they pick
     matchup/{id}/stats  → who actually does the damage

   Returns { team, fixture, sample, maps, veto, likelyLineup, players }.
   Everything is derived from finished matches only, and only from
   the recent ones - a 2017 result says nothing about this roster.
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');

const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;

const PER_PAGE = 50;
const SAMPLE = Number(process.env.SCOUT_SAMPLE || 10);      // recent matches to analyse
const MAX_AGE_DAYS = Number(process.env.SCOUT_MAX_AGE || 540); // ignore ancient rosters

module.exports = async (req, res) => {
  if (!TOKEN) return fail(res, 503, 'Server is missing the GGARENA_TOKEN environment variable.');

  try {
    const asked = Number((req.query && req.query.team) || 0);
    const target = asked > 0 ? { id: asked, fixture: null } : await nextOpponent();
    if (!target) return fail(res, 404, 'No upcoming fixture to scout.');

    const dossier = await scout(target.id);
    if (!dossier) return fail(res, 404, 'No recent matches found for that team.');
    dossier.fixture = target.fixture;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json(dossier);
  } catch (err) {
    return fail(res, err.statusCode || 502, err.message || 'Failed to build the scouting report.');
  }
};

/* ---------- who are we playing next ---------- */
async function nextOpponent() {
  const mine = await recentMatchups(TEAM_IDS[0]);
  const now = Date.now();
  const next = mine
    .filter((m) => m.finished_at == null && !m.cancelled && ts(m.start_time) > now)
    .sort((a, b) => ts(a.start_time) - ts(b.start_time))[0];
  if (!next) return null;

  const weAreHome = isUs(teamId(next.home_signup));
  const them = (weAreHome ? next.away_signup : next.home_signup) || {};
  if (!them.team) return null;

  return {
    id: them.team.id,
    fixture: {
      id: next.id,
      date: next.start_time,
      round: next.round_number ? 'Round ' + next.round_number : (next.round_identifier_text || null),
      division: enDivision((next.division && next.division.name) || null),
      bestOf: next.best_of || null,
    },
  };
}

/* ---------- the dossier ---------- */
async function scout(teamId_) {
  const all = await recentMatchups(teamId_);
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;

  const recent = all
    .filter((m) => m.finished_at != null && !m.cancelled && ts(m.start_time) >= cutoff)
    .sort((a, b) => ts(b.start_time) - ts(a.start_time))
    .slice(0, SAMPLE);
  if (!recent.length) return null;

  const identity = teamOf(recent[0], teamId_);

  // Three calls per match, all in flight at once; tolerate individual failures.
  const details = await Promise.all(recent.map((m) => gg('matchup/' + m.id).catch(() => null)));
  const vetoes = await Promise.all(recent.map((m) => gg('matchup/' + m.id + '/veto').catch(() => null)));
  const sheets = await Promise.all(recent.map((m) => gg('matchup/' + m.id + '/stats').catch(() => null)));

  const maps = {};
  const bans = {}, firstBans = {}, picks = {}, seenMaps = {};
  const players = {};
  let wins = 0, losses = 0;

  recent.forEach((m, i) => {
    const theirSide = teamId(m.home_signup) === teamId_ ? 'home' : 'away';
    const theirScore = theirSide === 'home' ? num(m.home_score) : num(m.away_score);
    const oppScore = theirSide === 'home' ? num(m.away_score) : num(m.home_score);
    if (theirScore > oppScore) wins++; else if (oppScore > theirScore) losses++;

    /* --- maps played --- */
    const played = ((details[i] && details[i].matchupmaps) || [])
      .filter((mm) => mm.home_score != null && mm.away_score != null);
    for (const mm of played) {
      const name = (mm.resource && mm.resource.name) || 'Unknown';
      const forRounds = theirSide === 'home' ? num(mm.home_score) : num(mm.away_score);
      const agstRounds = theirSide === 'home' ? num(mm.away_score) : num(mm.home_score);
      const row = maps[name] || (maps[name] = { map: name, played: 0, wins: 0, losses: 0, roundsFor: 0, roundsAgainst: 0 });
      row.played++;
      row.roundsFor += forRounds;
      row.roundsAgainst += agstRounds;
      if (forRounds > agstRounds) row.wins++; else row.losses++;
    }

    /* --- veto behaviour --- */
    const actions = (vetoes[i] && vetoes[i].data && vetoes[i].data.actions) || [];
    let first = true;
    for (const a of actions) {
      const map = a.map && a.map.name;
      if (!map) continue;
      seenMaps[map] = true;
      if (!a.team || a.team.id !== teamId_) continue;
      if (a.action === 'ban') {
        bans[map] = (bans[map] || 0) + 1;
        if (first) { firstBans[map] = (firstBans[map] || 0) + 1; first = false; }
      } else if (a.action === 'pick') {
        picks[map] = (picks[map] || 0) + 1;
      }
    }

    /* --- players --- */
    const sheet = Array.isArray(sheets[i]) ? sheets[i] : (sheets[i] && sheets[i].data) || [];
    for (const p of sheet.filter((x) => x.side === theirSide)) {
      const a = players[p.paradise_user_id] || (players[p.paradise_user_id] = {
        name: p.player_name, matches: 0, maps: 0, rounds: 0, kills: 0, deaths: 0,
        dmg: 0, hs: 0, openW: 0, openT: 0, ratingSum: 0, ratingW: 0,
      });
      const mp = num(p.maps_played);
      a.matches++;
      a.maps += mp;
      a.rounds += num(p.rounds_played);
      a.kills += num(p.kills);
      a.deaths += num(p.deaths);
      a.dmg += num(p.damage_given);
      a.hs += num(p.headshots);
      a.openW += num(p.opening_duels_won);
      a.openT += num(p.opening_duels_total);
      const r = parseFloat(p.rating);
      if (!isNaN(r) && mp > 0) { a.ratingSum += r * mp; a.ratingW += mp; }
    }
  });

  const mapRows = Object.values(maps)
    .map((r) => Object.assign(r, {
      winRate: r.played ? Math.round((r.wins / r.played) * 100) : 0,
      roundDiff: r.roundsFor - r.roundsAgainst,
    }))
    .sort((a, b) => b.played - a.played || b.winRate - a.winRate);

  // Maps in the pool they never banned: the ones they are happy to play.
  const pool = Object.keys(seenMaps);
  const comfortable = pool.filter((m) => !bans[m]).sort();

  const roster = Object.values(players)
    .filter((p) => p.ratingW > 0)
    .map((p) => ({
      name: p.name,
      matches: p.matches,
      maps: p.maps,
      rating: +(p.ratingSum / p.ratingW).toFixed(2),
      kd: p.deaths ? +(p.kills / p.deaths).toFixed(2) : p.kills,
      adr: p.rounds ? Math.round(p.dmg / p.rounds) : 0,
      hsPct: p.kills ? Math.round((p.hs / p.kills) * 100) : 0,
      openingPct: p.openT ? Math.round((p.openW / p.openT) * 100) : 0,
    }));

  // Who actually turns up: the five with the most maps in the sample. Rating
  // alone would crown someone who stood in for two maps a year ago.
  const likelyLineup = roster.slice().sort((a, b) => b.maps - a.maps).slice(0, 5)
    .sort((a, b) => b.rating - a.rating);

  return {
    team: identity,
    sample: {
      matches: recent.length,
      wins,
      losses,
      from: recent[recent.length - 1].start_time,
      to: recent[0].start_time,
    },
    maps: mapRows,
    veto: {
      firstBans: rank(firstBans),
      bans: rank(bans),
      picks: rank(picks),
      neverBanned: comfortable,
    },
    likelyLineup,
    players: roster.slice().sort((a, b) => b.rating - a.rating),
  };
}

/* ---------- helpers ---------- */
// The list endpoint returns oldest first, so recent matches live on the LAST page.
async function recentMatchups(teamId_) {
  const first = await gg('matchup?team_id=' + teamId_ + '&limit=' + PER_PAGE);
  const meta = (first && first.meta) || {};
  const lastPage = meta.last_page || 1;
  let list = (first && first.data) || [];
  if (lastPage > 1) {
    const pages = await Promise.all(
      [lastPage, lastPage - 1].filter((p) => p > 1).map(
        (p) => gg('matchup?team_id=' + teamId_ + '&limit=' + PER_PAGE + '&page=' + p).catch(() => null)
      )
    );
    for (const p of pages) if (p && p.data) list = list.concat(p.data);
  }
  const seen = new Set();
  return list.filter((m) => {
    if (!m || seen.has(m.id)) return false;
    seen.add(m.id);
    return teamId(m.home_signup) === teamId_ || teamId(m.away_signup) === teamId_;
  });
}

function teamOf(m, id) {
  const sg = teamId(m.home_signup) === id ? m.home_signup : m.away_signup;
  const t = (sg && sg.team) || {};
  return { id, name: t.name || 'Unknown', logo: (t.logo && t.logo.url) || null, url: t.url || null };
}

const rank = (counts) =>
  Object.keys(counts).map((map) => ({ map, count: counts[map] })).sort((a, b) => b.count - a.count);

const teamId = (signup) => (signup && signup.team && signup.team.id) || null;
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const ts = (d) => { const t = new Date(String(d || '')).getTime(); return isNaN(t) ? 0 : t; };

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
  const r = await fetch(BASE + '/' + path, {
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
  });
  if (!r.ok) {
    const e = new Error('Good Game Arena API returned ' + r.status + '.');
    e.statusCode = r.status === 401 || r.status === 403 ? 502 : r.status;
    throw e;
  }
  return r.json();
}

function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
