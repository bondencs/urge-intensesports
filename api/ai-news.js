/* =========================================================
   /api/ai-news  —  AI sports writer (drafts only).

   Triggered by Vercel Cron (daily) or manually from the admin
   page. It pulls the team's matchups and the current division,
   then uses Claude to draft, as a DRAFT for the admin to review:

     - match recaps    (results from the last RECAP_DAYS days)
     - match previews  (fixtures within the next PREVIEW_DAYS days)
     - a season preview (once, when the division's first fixture
       is close and nothing has been played yet)
     - a season review  (once, when every fixture is finished)

   The day windows matter: without them the writer walks backwards
   through the team's whole history, drafting recaps of matches from
   seasons ago. It never auto-publishes.

   Required env: ANTHROPIC_API_KEY, GGARENA_TOKEN, KV_REST_API_*.
   Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>";
   the admin "Generate" button sends "x-admin-key: <ADMIN_PASSWORD>".
   ========================================================= */

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK.Anthropic || AnthropicSDK;

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const GG_BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const GG_TOKEN = (process.env.GGARENA_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
// Current team first, then legacy team ids the same squad played under.
const TEAM_IDS = String(process.env.GGARENA_TEAM_IDS || process.env.GGARENA_TEAM_ID || '205067,162570')
  .split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
const isUs = (id) => id != null && TEAM_IDS.indexOf(Number(id)) !== -1;
const TEAM_NAME = 'Urge Intensesports';
const PER_PAGE = 50; // the API's page-size param is "limit"

// Current season, so the writer can do season previews/reviews.
// Fallback only: the season is normally detected from our own fixture list,
// so a new division doesn't need anyone to remember to change a setting.
const DIVISION_ID = Number(process.env.GGARENA_DIVISION_ID || 18870);

// How far back/forward the writer looks. Without these it would march
// backwards through the team's ENTIRE history, drafting recaps of matches
// from seasons ago, and preview games that are still months away.
const RECAP_DAYS = Number(process.env.AI_RECAP_DAYS || 14);
const PREVIEW_DAYS = Number(process.env.AI_PREVIEW_DAYS || 7);
const SEASON_PREVIEW_DAYS = Number(process.env.AI_SEASON_PREVIEW_DAYS || 21);
const DAY = 86400000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-opus-4-8'; // override to e.g. claude-haiku-4-5 to cut cost
const ADMIN = process.env.ADMIN_PASSWORD;
const CRON_SECRET = process.env.CRON_SECRET;
const MAX_NEW = Number(process.env.AI_MAX_PER_RUN || 3);
const KEY = 'articles';
const MAX_PAGES = 12;

module.exports = async (req, res) => {
  const isCron = CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const isAdmin = ADMIN && req.headers['x-admin-key'] === ADMIN;
  if (!isCron && !isAdmin) return fail(res, 401, 'Unauthorized.');

  if (!ANTHROPIC_KEY) return fail(res, 503, 'AI writer not configured (missing ANTHROPIC_API_KEY).');
  if (!KV_URL || !KV_TOKEN) return fail(res, 503, 'News storage not configured (missing Vercel KV).');
  if (!GG_TOKEN) return fail(res, 503, 'Match data not configured (missing GGARENA_TOKEN).');

  try {
    const existing = await getArticles();
    const covered = new Set(existing.filter((a) => a.matchId != null).map((a) => String(a.matchId)));
    const coveredSeasons = new Set(existing.filter((a) => a.seasonKey).map((a) => a.seasonKey));

    const matches = (await teamMatchups()).map(normalizeMatch).filter(Boolean);
    const now = Date.now();

    // Only recent results and imminent fixtures - see RECAP_DAYS/PREVIEW_DAYS.
    const recaps = matches
      .filter((m) => m.finished && m.result && !covered.has(String(m.id)))
      .filter((m) => now - m.ts <= RECAP_DAYS * DAY)
      .sort((a, b) => b.ts - a.ts);
    const previews = matches
      .filter((m) => !m.finished && !m.cancelled && m.ts > now && !covered.has(String(m.id)))
      .filter((m) => m.ts - now <= PREVIEW_DAYS * DAY)
      .sort((a, b) => a.ts - b.ts);

    // Season pieces come first: they are the big set-piece articles.
    const jobs = [];
    const season = await seasonState(matches).catch(() => null);
    if (season) {
      if (season.played === 0 && season.first && season.first.ts - now <= SEASON_PREVIEW_DAYS * DAY &&
          !coveredSeasons.has(season.previewKey)) {
        jobs.push({ kind: 'season-preview', season });
      }
      if (season.total > 0 && season.played === season.total && !coveredSeasons.has(season.reviewKey)) {
        jobs.push({ kind: 'season-review', season });
      }
    }
    for (const m of recaps) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'recap', match: m }); }
    for (const m of previews) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'preview', match: m }); }

    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const created = [];
    for (const job of jobs) {
      try {
        const stats = job.kind === 'recap' ? await fetchOurStats(job.match).catch(() => null) : null;
        if (job.kind === 'season-review') job.season.top = await seasonPlayers(job.season).catch(() => null);
        const draft = await writeArticle(client, job, stats);
        if (!draft) continue;
        const article = toArticle(draft, job);
        existing.push(article);
        created.push({ id: article.id, title: article.title, kind: job.kind });
      } catch (e) { /* skip this one, continue */ }
    }
    if (created.length) await saveArticles(existing);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      created,
      candidates: {
        recaps: recaps.length,
        previews: previews.length,
        season: jobs.filter((j) => j.kind.startsWith('season')).map((j) => j.kind),
      },
    });
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message || 'AI writer error.');
  }
};

/* ---------- article generation ---------- */
async function writeArticle(client, job, stats) {
  const spec = job.kind.startsWith('season') ? seasonPrompt(job) : matchPrompt(job, stats);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1600,
    system: spec.system,
    messages: [{ role: 'user', content: spec.user }],
  });

  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseJson(text);
}

function matchPrompt(job, stats) {
  const m = job.match;
  const facts = {
    team: TEAM_NAME,
    opponent: m.opponent,
    competition: m.event,
    division: m.division,
    round: m.round,
    date_utc: m.date,
  };
  if (job.kind === 'recap') {
    facts.result = m.result; // "win" | "loss"
    facts.score_maps = m.ourScore != null && m.theirScore != null ? m.ourScore + '-' + m.theirScore : null;
    if (stats && stats.length) {
      facts.our_players = stats.slice(0, 5).map((p) => ({
        name: p.player_name, rating: p.rating, kills: p.kills, deaths: p.deaths,
      }));
    }
  }

  const system = voice(`match ${job.kind === 'recap' ? 'recaps' : 'previews'}`) + ' Keep it 130-220 words.';

  const angle = job.kind === 'recap'
    ? 'Reflect the result and map score; if player stats are provided, highlight the top performer by rating.'
    : 'Build anticipation; do NOT state or imply a result.';

  const user = `Write a match ${job.kind} as a JSON object with exactly these keys: "title", "excerpt", "body".
- title: short, catchy headline.
- excerpt: one-sentence summary, max ~160 characters.
- body: Markdown, two or three short paragraphs (optionally one "## " subheading). Name the opponent and competition. ${angle}
${JSON_ONLY}${JSON.stringify(facts, null, 2)}`;

  return { system, user };
}

function seasonPrompt(job) {
  const s = job.season;
  const isPreview = job.kind === 'season-preview';

  const facts = {
    team: TEAM_NAME,
    competition: s.competition,
    division: s.division,
    teams_in_division: s.teams,
    fixtures: s.total,
  };

  if (isPreview) {
    facts.first_match = s.first ? { opponent: s.first.opponent, date_utc: s.first.date } : null;
    facts.opponents_this_season = s.opponents;
    facts.last_season = s.lastSeason; // may be null
  } else {
    facts.record = { played: s.played, wins: s.wins, losses: s.losses };
    facts.map_record = { won: s.mapsWon, lost: s.mapsLost };
    facts.final_position = s.position;
    facts.results = s.results;
    if (s.top && s.top.length) {
      facts.top_players = s.top.slice(0, 5).map((p) => ({
        name: p.name, rating: p.rating, kd: p.kd, maps: p.maps,
      }));
    }
  }

  const system = voice(isPreview ? 'season previews' : 'season reviews') +
    ' This is a set-piece article about a whole season, not a single match, so give it more room:' +
    ' 220-350 words with a clear arc.';

  const angle = isPreview
    ? `Set the scene for the campaign ahead: the division, how many fixtures, who Urge open against and when, and the challenge the field represents. If last_season is provided, use it for context on where the squad is coming from. Do NOT predict results, standings or scorelines as if they were facts.`
    : `Tell the story of the campaign: the final record and league position, how the season swung, and who stood out (use top_players ratings if provided). Be honest about defeats - never spin a losing season as a triumph.`;

  const user = `Write a ${isPreview ? 'season preview' : 'season review'} as a JSON object with exactly these keys: "title", "excerpt", "body".
- title: short, catchy headline naming the season or division.
- excerpt: one-sentence summary, max ~160 characters.
- body: Markdown, three or four paragraphs with two "## " subheadings. ${angle}
${JSON_ONLY}${JSON.stringify(facts, null, 2)}`;

  return { system, user };
}

const voice = (what) =>
  'You are the staff writer for the professional Counter-Strike 2 (CS2) esports team "Urge Intensesports". ' +
  `You write ${what} for the team's website. ` +
  'Voice: confident and energetic, but factual and never arrogant; third person ("Urge", "the squad"). ' +
  'Hard rule: use ONLY the facts in the provided data - never invent scores, players, dates, maps, or results.';

const JSON_ONLY = `
Respond with ONLY the JSON object - no code fences, no commentary, no text before or after it.

DATA:
`;

const CATEGORY = {
  'recap': 'Match Recap',
  'preview': 'Match Preview',
  'season-preview': 'Season Preview',
  'season-review': 'Season Review',
};

function toArticle(draft, job) {
  const now = new Date().toISOString();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    slug: slugify(draft.title) + '-' + Math.random().toString(36).slice(2, 6),
    title: String(draft.title).slice(0, 160),
    category: CATEGORY[job.kind] || 'News',
    excerpt: String(draft.excerpt || '').slice(0, 200),
    body: String(draft.body || ''),
    image: '',
    author: 'Urge AI',
    status: 'draft',          // always a draft — the admin approves before it goes live
    matchId: job.match ? job.match.id : null,
    // one season preview and one season review per division, ever
    seasonKey: job.season ? (job.kind === 'season-preview' ? job.season.previewKey : job.season.reviewKey) : null,
    date: now,
    createdAt: now,
  };
}

function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { const o = JSON.parse(t); if (o && o.title && o.body) return o; } catch (e) {}
  return null;
}

/* ---------- the season (current competition/division) ---------- */
// Builds everything a season preview or review needs out of the division's
// own fixture list: the field, our record, and where we finished.
async function seasonState(allMatches) {
  const divisionId = currentDivisionId(allMatches);
  const fixtures = (await divisionMatchups(divisionId)).filter((m) => !m.cancelled);
  if (!fixtures.length) return null;

  const ours = fixtures.filter(
    (m) => isUs(signupTeamId(m.home_signup)) || isUs(signupTeamId(m.away_signup))
  ).map(normalizeMatch).filter(Boolean).sort((a, b) => a.ts - b.ts);
  if (!ours.length) return null;

  const done = ours.filter((m) => m.finished);
  let wins = 0, losses = 0, mapsWon = 0, mapsLost = 0;
  for (const m of done) {
    if (m.result === 'win') wins++; else if (m.result === 'loss') losses++;
    if (m.ourScore != null) mapsWon += m.ourScore;
    if (m.theirScore != null) mapsLost += m.theirScore;
  }

  const first = fixtures[0] || null;
  const teams = new Set();
  fixtures.forEach((m) => { [m.home_signup, m.away_signup].forEach((sg) => { const id = signupTeamId(sg); if (id) teams.add(id); }); });

  return {
    competition: (first.competition && first.competition.name) || null,
    division: (first.division && first.division.name) || null,
    divisionId,
    previewKey: 'season-preview:' + divisionId,
    reviewKey: 'season-review:' + divisionId,
    teams: teams.size,
    total: ours.length,
    played: done.length,
    wins, losses, mapsWon, mapsLost,
    first: ours[0] || null,
    opponents: ours.map((m) => m.opponent),
    results: done.map((m) => ({
      opponent: m.opponent,
      result: m.result,
      score_maps: m.ourScore != null && m.theirScore != null ? m.ourScore + '-' + m.theirScore : null,
      date_utc: m.date,
    })),
    position: done.length ? tablePosition(fixtures) : null,
    lastSeason: previousSeason(allMatches || [], divisionId),
    ourMatches: done.map((m) => ({ id: m.id, ourSide: m.ourSide })),
  };
}

// Which season are we in? The division of our next fixture, or of the last one
// we played. GGARENA_DIVISION_ID is only a fallback.
function currentDivisionId(matches) {
  const now = Date.now();
  const next = matches
    .filter((m) => !m.finished && !m.cancelled && m.ts > now && m.divisionId)
    .sort((a, b) => a.ts - b.ts)[0];
  if (next) return next.divisionId;
  const last = matches
    .filter((m) => m.finished && m.divisionId)
    .sort((a, b) => b.ts - a.ts)[0];
  return last ? last.divisionId : DIVISION_ID;
}

// The most recently completed division before this one, for context in a preview.
function previousSeason(allMatches, divisionId) {
  const past = allMatches
    .filter((m) => m.finished && m.divisionId && m.divisionId !== divisionId)
    .sort((a, b) => b.ts - a.ts);
  if (!past.length) return null;

  const prevId = past[0].divisionId;
  const run = past.filter((m) => m.divisionId === prevId);
  let wins = 0, losses = 0;
  for (const m of run) { if (m.result === 'win') wins++; else if (m.result === 'loss') losses++; }
  return {
    division: past[0].division,
    competition: past[0].event,
    played: run.length,
    wins,
    losses,
  };
}

// Our spot in the division table, computed the same way /api/standings does it.
function tablePosition(fixtures) {
  const rows = {};
  const row = (id, name) => rows[id] || (rows[id] = { id, name, wins: 0, diff: 0, won: 0 });
  for (const m of fixtures) {
    const h = signupTeamId(m.home_signup), a = signupTeamId(m.away_signup);
    if (!h || !a) continue;
    const hr = row(h), ar = row(a);
    if (m.finished_at == null) continue;
    const hs = num(m.home_score) || 0, as = num(m.away_score) || 0;
    hr.won += hs; hr.diff += hs - as;
    ar.won += as; ar.diff += as - hs;
    const homeWon = m.winning_side ? m.winning_side === 'home' : hs > as;
    if (homeWon) hr.wins++; else ar.wins++;
  }
  const table = Object.values(rows).sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.won - x.won);
  const i = table.findIndex((t) => isUs(t.id));
  return i === -1 ? null : i + 1;
}

// Aggregate our players over the season's finished matches (for the review).
async function seasonPlayers(season) {
  const games = season.ourMatches.slice(0, 12);
  const sheets = await Promise.all(
    games.map((g) => gg(`matchup/${encodeURIComponent(g.id)}/stats`).catch(() => null))
  );
  const agg = {};
  games.forEach((game, i) => {
    const sheet = sheets[i];
    const arr = Array.isArray(sheet) ? sheet : (sheet && sheet.data) || [];
    // The stats sheet identifies teams by side only, so use the side we played on.
    for (const p of arr.filter((x) => x.side === game.ourSide)) {
      const a = agg[p.paradise_user_id] || (agg[p.paradise_user_id] = {
        name: p.player_name, maps: 0, kills: 0, deaths: 0, ratingSum: 0, ratingW: 0,
      });
      const maps = num(p.maps_played) || 0;
      a.maps += maps;
      a.kills += num(p.kills) || 0;
      a.deaths += num(p.deaths) || 0;
      const r = parseFloat(p.rating);
      if (!isNaN(r) && maps > 0) { a.ratingSum += r * maps; a.ratingW += maps; }
    }
  });
  return Object.values(agg)
    .filter((a) => a.ratingW > 0)
    .map((a) => ({
      name: a.name,
      maps: a.maps,
      kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills,
      rating: +(a.ratingSum / a.ratingW).toFixed(2),
    }))
    .sort((x, y) => y.rating - x.rating);
}

const signupTeamId = (signup) => (signup && signup.team && signup.team.id) || null;

async function divisionMatchups(divisionId) {
  const out = [];
  let page = 1, last = 1;
  do {
    const data = await gg(`matchup?division_id=${divisionId}&limit=${PER_PAGE}&page=${page}`);
    const list = Array.isArray(data) ? data : (data && data.data) || [];
    for (const m of list) if (!m.division || m.division.id === divisionId) out.push(m);
    last = (data && data.meta && data.meta.last_page) || 1;
    page++;
  } while (page <= last && page <= MAX_PAGES);
  return out.sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
}

/* ---------- Good Game Arena ---------- */
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

async function fetchOurStats(m) {
  const data = await gg(`matchup/${encodeURIComponent(m.id)}/stats`);
  const arr = Array.isArray(data) ? data : (data && data.data) || [];
  return arr.filter((p) => p.side === m.ourSide).sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
}

function normalizeMatch(m) {
  const isHome = !!(m.home_signup && m.home_signup.team && isUs(m.home_signup.team.id));
  const them = isHome ? m.away_signup : m.home_signup;
  if (!them || !them.team) return null;
  const ourScore = isHome ? m.home_score : m.away_score;
  const theirScore = isHome ? m.away_score : m.home_score;
  const finished = m.finished_at != null;
  const won = m.winning_side ? m.winning_side === (isHome ? 'home' : 'away') : null;
  return {
    id: m.id,
    ourSide: isHome ? 'home' : 'away',
    opponent: them.team.name || them.name || 'TBD',
    opponentLogo: (them.team.logo && them.team.logo.url) || null,
    event: (m.competition && m.competition.name) || 'Match',
    division: (m.division && m.division.name) || null,
    divisionId: (m.division && m.division.id) || null,
    round: m.round_number ? `Round ${m.round_number}` : (m.round_identifier_text || null),
    date: m.start_time || null,
    ts: m.start_time ? new Date(String(m.start_time).replace(/\.\d+Z$/, 'Z')).getTime() : 0,
    finished,
    cancelled: !!m.cancelled,
    ourScore: num(ourScore),
    theirScore: num(theirScore),
    result: finished && won != null ? (won ? 'win' : 'loss') : null,
  };
}

async function gg(path) {
  const r = await fetch(`${GG_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${GG_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) { const e = new Error(`GG Arena ${r.status}`); e.statusCode = 502; throw e; }
  return r.json();
}

/* ---------- KV ---------- */
async function kv(command) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('KV request failed (' + r.status + ').');
  return (await r.json()).result;
}
async function getArticles() {
  const raw = await kv(['GET', KEY]);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
const saveArticles = (arr) => kv(['SET', KEY, JSON.stringify(arr)]);

/* ---------- utils ---------- */
function num(v) { if (v == null || v === '') return null; const n = Number(v); return isNaN(n) ? null : n; }
function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o').replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'article';
}
function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
