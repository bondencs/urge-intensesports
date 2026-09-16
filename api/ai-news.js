/* =========================================================
   /api/ai-news  —  AI sports writer.

   Triggered by Vercel Cron (daily) or manually from the admin
   page. It pulls the team's matchups and the current division,
   then uses Claude to write:

     - match recaps    (results from the last RECAP_DAYS days)
     - match previews  (the day after the previous match's recap, so
       there is maximum time to prepare; never while a match is in
       progress; carrying a scouting dossier from /api/scout)
     - a season preview (once, when the division's first fixture
       is close and nothing has been played yet)
     - a season review  (once, when every fixture is finished)

   The day windows matter: without them the writer walks backwards
   through the team's whole history, drafting recaps of matches from
   seasons ago.

   Every draft goes through a second "sub-editor" pass that checks it
   against the facts it was written from and fixes contradictions.
   Checked articles are PUBLISHED immediately by default
   (AI_AUTOPUBLISH=0 turns that off); one the check could not
   confirm is saved as a draft for a human instead.

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
// Previews follow the recap: once the last result is written up, the next
// opponent's scouting report goes out this many days later, which leaves the
// most time to prepare with it. Only used when there is a recap to follow.
const PREVIEW_AFTER_RECAP_DAYS = Number(process.env.AI_PREVIEW_AFTER_RECAP_DAYS || 1);
// Fallback for the season opener, when no previous match exists to react to:
// how long before kickoff the preview appears instead.
const PREVIEW_LEAD_DAYS = Number(process.env.AI_PREVIEW_DAYS || 2);
// A match already under way must never trigger its own or the next preview.
const IN_PROGRESS_HOURS = Number(process.env.AI_IN_PROGRESS_HOURS || 4);
const SEASON_PREVIEW_DAYS = Number(process.env.AI_SEASON_PREVIEW_DAYS || 21);
const DAY = 86400000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-opus-4-8'; // override to e.g. claude-haiku-4-5 to cut cost
const ADMIN = process.env.ADMIN_PASSWORD;
const CRON_SECRET = process.env.CRON_SECRET;
const MAX_NEW = Number(process.env.AI_MAX_PER_RUN || 3);
// Articles go live as soon as they are written. Set AI_AUTOPUBLISH=0 to go
// back to drafts that wait for approval in the admin.
const AUTOPUBLISH = (process.env.AI_AUTOPUBLISH || '1') !== '0';
const KEY = 'articles';
const MAX_PAGES = 12;

module.exports = async (req, res) => {
  const isCron = CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const isAdmin = ADMIN && req.headers['x-admin-key'] === ADMIN;
  if (!isCron && !isAdmin) return fail(res, 401, 'Unauthorized.');

  if (!ANTHROPIC_KEY) return fail(res, 503, 'AI writer not configured (missing ANTHROPIC_API_KEY).');
  if (!KV_URL || !KV_TOKEN) return fail(res, 503, 'News storage not configured (missing Vercel KV).');
  if (!GG_TOKEN) return fail(res, 503, 'Match data not configured (missing GGARENA_TOKEN).');

  // ?force=1 (admin only) writes the next fixture's preview immediately instead
  // of waiting for the lead time. Deliberate human action, so the timing rules
  // that keep the cron from posting mid-game don't apply.
  const force = isAdmin && String((req.query && req.query.force) || '') === '1';

  try {
    const existing = await getArticles();
    // Dedupe per match AND per kind: a fixture gets a preview before it is
    // played and a recap after, so one article about it must not block the other.
    const covered = { recap: new Set(), preview: new Set() };
    for (const a of existing) {
      if (a.matchId == null) continue;
      const kind = articleKind(a);
      if (kind) covered[kind].add(String(a.matchId));
    }
    const coveredSeasons = new Set(existing.filter((a) => a.seasonKey).map((a) => a.seasonKey));

    const matches = (await teamMatchups()).map(normalizeMatch).filter(Boolean);
    const now = Date.now();

    // Only recent results and imminent fixtures - see RECAP_DAYS/PREVIEW_DAYS.
    const recaps = matches
      .filter((m) => m.finished && m.result && !covered.recap.has(String(m.id)))
      .filter((m) => now - m.ts <= RECAP_DAYS * DAY)
      .sort((a, b) => b.ts - a.ts);
    // Don't preview the next fixture while we're still playing the current one.
    const playingNow = matches.some(
      (m) => !m.finished && !m.cancelled && m.ts <= now && now - m.ts <= IN_PROGRESS_HOURS * 3600000
    );
    // The very next fixture, coverage NOT considered: if we skipped the ones
    // that already have a preview, every published preview would promote the
    // following fixture to "next" and the cron would write the whole season.
    const nextUp = matches
      .filter((m) => !m.finished && !m.cancelled && m.ts > now)
      .sort((a, b) => a.ts - b.ts)[0] || null;
    const nextCovered = !!nextUp && covered.preview.has(String(nextUp.id));
    const previewDue = !!nextUp && !nextCovered &&
      (force || previewIsDue(nextUp, matches, existing, now));
    const previews = (playingNow && !force) || !previewDue ? [] : [nextUp];

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
    // Match articles carry the season context too, so the writer knows whether
    // this is the opener or the middle of a campaign.
    for (const m of recaps) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'recap', match: m, context: season }); }
    for (const m of previews) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'preview', match: m, context: season }); }

    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    // Each job is a write plus a fact-check; one after another, a busy run would
    // outlast the function time limit, and the jobs don't depend on each other.
    const outcomes = await Promise.all(jobs.map((job) => runJob(client, job)));

    const created = [];
    const skipped = [];   // never fail silently: the admin needs to see why
    for (const o of outcomes) {
      if (!o.article) { skipped.push({ kind: o.job.kind, reason: o.error }); continue; }
      existing.push(o.article);
      created.push({
        id: o.article.id, title: o.article.title, kind: o.job.kind,
        status: o.article.status, verified: o.verified,
      });
    }
    if (created.length) await saveArticles(existing);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      created,
      skipped,
      published: AUTOPUBLISH,
      forced: force,
      heldForMatchInProgress: playingNow && !force,
      candidates: {
        recaps: recaps.length,
        previews: previews.length,
        nextFixtureAlreadyPreviewed: nextCovered,
        season: jobs.filter((j) => j.kind.startsWith('season')).map((j) => j.kind),
      },
    });
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message || 'AI writer error.');
  }
};

async function runJob(client, job) {
  try {
    const stats = job.kind === 'recap' ? await fetchOurStats(job.match).catch(() => null) : null;
    if (job.kind === 'recap') job.maps = await fetchMaps(job.match).catch(() => null);
    if (job.kind === 'preview') job.scout = await scoutOpponent(job.match).catch(() => null);
    if (job.kind === 'season-review') job.season.top = await seasonPlayers(job.season).catch(() => null);
    const out = await writeArticle(client, job, stats);
    if (!out) return { job, error: 'The model did not return usable JSON.' };
    return { job, verified: out.verified, article: toArticle(out.draft, job, out.verified) };
  } catch (e) {
    return { job, error: (e && e.message) || 'Unknown error.' };
  }
}

/* ---------- when a preview is due ---------- */
// The day after the previous match's recap went out. That gives the squad the
// longest run at the scouting report, and guarantees the recap lands first.
function previewIsDue(next, matches, existing, now) {
  const lastPlayed = matches
    .filter((m) => m.finished && m.result)
    .sort((a, b) => b.ts - a.ts)[0];

  // Season opener, or the last result is too old to be recapped: fall back to
  // a fixed lead time before kickoff.
  if (!lastPlayed || now - lastPlayed.ts > RECAP_DAYS * DAY) {
    return next.ts - now <= (PREVIEW_LEAD_DAYS + 1) * DAY;
  }

  const recap = existing.find(
    (a) => String(a.matchId) === String(lastPlayed.id) && articleKind(a) === 'recap'
  );
  if (!recap) return false;   // the recap goes first

  const published = Date.parse(recap.date || '') || 0;
  if (!published) return true;
  return now - published >= PREVIEW_AFTER_RECAP_DAYS * DAY;
}

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
  const draft = parseJson(text);
  if (!draft) return null;

  // Nothing is published unchecked: a second pass reads the draft against the
  // facts it was written from and corrects anything that does not match.
  const checked = await factCheck(client, draft, spec.facts).catch(() => null);
  return checked ? { draft: checked, verified: true } : { draft, verified: false };
}

const SUB_EDITOR = `You are the sub-editor for the website of Urge Intensesports, a semi-professional Counter-Strike 2 team. You get a draft article and the FACTS it was written from, and you correct the draft before it is published.

Fix, and only fix:
- anything that contradicts the facts: who won a map or the series, any score, dates and times, home or away, round numbers, league position, the season record, player numbers;
- any sentence that contradicts itself or the rest of the article, such as describing a lost map as won;
- any number, name or claim the facts do not support.

Scores from Urge matches are written with Urge first. Records inside opponent_scouting belong to the opponent, not to Urge. Keep everything else as it is: the voice, the headings, the structure and roughly the length. Do not add new claims, and do not rewrite sentences that are already correct.

Reply with only the corrected article as a JSON object with the keys "title", "excerpt" and "body" - no code fences, no commentary.`;

async function factCheck(client, draft, facts) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    // Checking a draft against facts is reasoning work, so let it think first.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: SUB_EDITOR,
    messages: [{
      role: 'user',
      content: `FACTS:
${JSON.stringify(facts, null, 2)}

DRAFT:
${JSON.stringify(draft, null, 2)}`,
    }],
  });
  // Cut off or declined: count it as unchecked rather than trust half a pass.
  if (message.stop_reason !== 'end_turn') return null;
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseJson(text);
}

function matchPrompt(job, stats) {
  const m = job.match;
  const scout = job.scout || null;
  const ctx = job.context || null;
  const facts = {
    team: TEAM_NAME,
    opponent: m.opponent,
    competition: m.event,
    division: m.division,
    round: m.round,
    date: osloDate(m.date),
    start_time: osloTime(m.date),
    // Nominal in an online league, but it is home/away on the schedule.
    urge_are: m.ourSide === 'home' ? 'the home team' : 'the away team',
  };

  if (ctx) {
    const done = ctx.results || [];
    const last = done.length ? done[done.length - 1] : null;
    facts.our_season_so_far = {
      fixtures_in_season: ctx.total,
      matches_played: ctx.played,
      record: ctx.wins + 'W-' + ctx.losses + 'L',
      league_position: ctx.position,
      is_season_opener: ctx.played === 0,
      last_result: last
        ? { opponent: last.opponent, urge_maps: last.urge_maps, opponent_maps: last.opponent_maps, won_by: last.won_by }
        : null,
    };
  }
  if (job.kind === 'recap') {
    facts.result = m.result; // "win" | "loss"
    facts.series = seriesFacts(m);
    if (job.maps && job.maps.length) facts.maps_played = job.maps;   // per map, in order
    if (stats && stats.length) {
      facts.our_players = stats.slice(0, 5).map((p) => ({
        name: p.player_name, rating: p.rating, kills: p.kills, deaths: p.deaths,
      }));
    }
  } else if (scout) {
    facts.opponent_scouting = {
      based_on: {
        matches: scout.sample.matches,
        record: scout.sample.wins + 'W-' + scout.sample.losses + 'L',
        from: (scout.sample.from || '').slice(0, 10),
        to: (scout.sample.to || '').slice(0, 10),
      },
      active_map_pool: (scout.pool && scout.pool.active) || null,
      // Maps in their history that can no longer be played - context only.
      retired_maps_in_sample: (scout.pool && scout.pool.retiredInSample) || [],
      // Active maps with no record at all: unknowns for both sides.
      active_maps_with_no_data: (scout.pool && scout.pool.activeWithoutData) || [],
      map_record: scout.maps.map((x) => ({
        map: x.map, played: x.played, record: x.wins + '-' + x.losses,
        win_pct: x.winRate, round_diff: x.roundDiff, in_active_pool: x.inPool,
      })),
      veto: {
        usual_first_ban: scout.veto.firstBans.slice(0, 3),
        all_bans: scout.veto.bans,
        maps_they_pick: scout.veto.picks,
        never_banned: scout.veto.neverBanned,
      },
      likely_lineup: scout.likelyLineup,
    };
  }

  const isScoutedPreview = job.kind === 'preview' && !!scout;

  const system = voice(`match ${job.kind === 'recap' ? 'recaps' : 'previews'}`) +
    (isScoutedPreview
      ? ' A preview doubles as a prep sheet for the squad, so be concrete and useful rather than hype.' +
        ' Numbers come straight from the data - never round them into something they are not.' +
        ' Respect the sample size: a player with only a couple of maps recorded is a stand-in, not a star,' +
        ' and a map played once proves nothing. Say so where it matters.' +
        ' Place the fixture correctly in the season: our_season_so_far says how many matches Urge have' +
        ' already played and how they went, so only call it an opener or a start when is_season_opener' +
        ' is true. Use urge_are for home or away and never guess who hosts.' +
        ' Keep it 300-450 words.'
      : ' Keep it 160-260 words.');

  const angle = job.kind === 'recap'
    ? 'Reflect the result and the series score from series. If maps_played is provided, name every ' +
      'map with its round score written Urge first (urge_rounds-opponent_rounds) - a bulleted list is ' +
      'fine - and describe each map the way won_by says it went. If player stats are provided, ' +
      'highlight the top performer by rating.'
    : 'Build anticipation; do NOT state or imply a result.';

  const scoutBrief = `- body: Markdown. Open with a short paragraph on the fixture, then use these "## " sections:
  "## The opponent" - their recent record and what the sample covers.
  "## Map read" - ONLY draw conclusions about maps in active_map_pool. Maps flagged
    in_active_pool: false (and anything in retired_maps_in_sample) can no longer be played -
    mention them at most in passing, never as something to plan around. Use a bulleted list of
    their strongest and weakest ACTIVE maps with the numbers (map, W-L, win %), then a sentence
    on their veto habits: what they almost always ban first, what they pick, and which maps they
    never ban. If active_maps_with_no_data is not empty, note that those are unknowns for both
    sides.
  "## Danger men" - a bulleted list of 2-4 of their likely starters with rating, K/D and ADR,
    noting who wins opening duels. Use likely_lineup, not whoever has the highest rating on a
    tiny sample.
  "## What it means for us" - two or three concrete sentences on where the map veto and the
    matchups point. Do NOT predict a scoreline or state a result.
Write about Urge in the third person. Never invent a number that is not in the data.`;

  const user = `Write a match ${job.kind} as a JSON object with exactly these keys: "title", "excerpt", "body".
- title: short, catchy headline.
- excerpt: one-sentence summary, max ~160 characters.
${isScoutedPreview ? scoutBrief : `- body: Markdown, two or three short paragraphs (optionally one "## " subheading). Name the opponent and competition. ${angle}`}
${JSON_ONLY}${JSON.stringify(facts, null, 2)}`;

  return { system, user, facts };
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
    facts.first_match = s.first
      ? { opponent: s.first.opponent, date: osloDate(s.first.date), start_time: osloTime(s.first.date) }
      : null;
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

  return { system, user, facts };
}

const voice = (what) =>
  'You are the staff writer for "Urge Intensesports", a semi-professional Counter-Strike 2 (CS2) team from Norway ' +
  'playing in 3. divisjon of Komplettligaen. Write like a grounded club reporter, not a hype account: no talk of ' +
  'grand finals, world stages or dominance the team has not earned. ' +
  `You write ${what} for the team's website. ` +
  'Voice: confident and energetic, but factual and never arrogant; third person ("Urge", "the squad"). ' +
  'Hard rule: use ONLY the facts in the provided data - never invent scores, players, dates, maps, or results. ' +
  'All dates and times in the data are already Norwegian local time (Europe/Oslo, CET/CEST) - quote them exactly as given and never convert or re-label them.';

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

function toArticle(draft, job, verified) {
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
    // Unchecked drafts never auto-publish: if the fact-check failed, a human decides.
    status: AUTOPUBLISH && verified ? 'published' : 'draft',
    kind: job.kind,
    matchId: job.match ? job.match.id : null,
    // one season preview and one season review per division, ever
    seasonKey: job.kind === 'season-preview' ? job.season.previewKey
      : job.kind === 'season-review' ? job.season.reviewKey
      : null,
    date: now,
    createdAt: now,
  };
}

// What an article covers. New ones say so; older ones only have a category.
function articleKind(a) {
  if (a.kind === 'recap' || a.kind === 'preview') return a.kind;
  if (a.category === 'Match Recap') return 'recap';
  if (a.category === 'Match Preview') return 'preview';
  return null;
}

function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { const o = JSON.parse(t); if (o && o.title && o.body) return o; } catch (e) {}
  return null;
}

/* ---------- dates, in the team's own timezone ---------- */
// GG Arena reports kickoff in UTC; the team, the league and the site all work
// in Oslo time (an hour or two ahead), so convert before the model ever sees it.
const OSLO = 'Europe/Oslo';

function osloParts(iso, opts) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(/\.\d+Z$/, 'Z'));
  if (isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: OSLO }, opts)).format(d);
  } catch (e) {
    return null;
  }
}

// "Tuesday 8 September 2026"
const osloDate = (iso) =>
  osloParts(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// "19:00 (Oslo time)"
function osloTime(iso) {
  const t = osloParts(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
  return t ? t + ' (Oslo time)' : null;
}

/* ---------- opponent scouting ---------- */
// Same dossier /api/scout serves: map record, veto habits, likely lineup.
async function scoutOpponent(match) {
  const oppId = match.opponentId;
  if (!oppId) return null;
  const url = (process.env.SITE_ORIGIN || 'https://urgeintensesports.org') + '/api/scout?team=' + oppId;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.maps ? d : null;
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
    division: enDivision((first.division && first.division.name) || null),
    divisionId,
    previewKey: 'season-preview:' + divisionId,
    reviewKey: 'season-review:' + divisionId,
    teams: teams.size,
    total: ours.length,
    played: done.length,
    wins, losses, mapsWon, mapsLost,
    first: ours[0] || null,
    opponents: ours.map((m) => m.opponent),
    results: done.map((m) => Object.assign({ opponent: m.opponent, date: osloDate(m.date) }, seriesFacts(m))),
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

// A series result with nothing left to interpret. A bare "1-2" invites the
// model to guess which number is ours; named fields and a winner do not.
function seriesFacts(m) {
  if (m.ourScore == null || m.theirScore == null) return { won_by: null };
  return {
    urge_maps: m.ourScore,
    opponent_maps: m.theirScore,
    won_by: m.result === 'win' ? TEAM_NAME : m.opponent,
  };
}

// Per-map scoreline for a finished match, from our point of view.
async function fetchMaps(m) {
  const d = await gg('matchup/' + encodeURIComponent(m.id));
  const list = (d && d.matchupmaps) || [];
  return list
    .filter((x) => x.home_score != null && x.away_score != null)
    .map((x) => {
      const ours = Number(m.ourSide === 'home' ? x.home_score : x.away_score);
      const theirs = Number(m.ourSide === 'home' ? x.away_score : x.home_score);
      return {
        map: (x.resource && x.resource.name) || 'Unknown',
        urge_rounds: ours,
        opponent_rounds: theirs,
        won_by: ours > theirs ? TEAM_NAME : m.opponent,
      };
    });
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
    opponentId: them.team.id || null,
    opponentLogo: (them.team.logo && them.team.logo.url) || null,
    event: (m.competition && m.competition.name) || 'Match',
    division: enDivision((m.division && m.division.name) || null),
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
