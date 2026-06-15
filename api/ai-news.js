/* =========================================================
   /api/ai-news  —  AI sports writer (drafts only).

   Triggered by Vercel Cron (daily) or manually from the admin
   page. It pulls the team's matchups, finds results/upcoming
   games not yet written about, and uses Claude to draft a
   recap or preview for each — saved to KV as a DRAFT for the
   admin to review and publish. It never auto-publishes.

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
const TEAM_ID = Number(process.env.GGARENA_TEAM_ID || 162570);
const TEAM_NAME = 'Urge Intensesports';

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

    const matches = (await teamMatchups()).map(normalizeMatch).filter(Boolean);
    const now = Date.now();

    const recaps = matches
      .filter((m) => m.finished && m.result && !covered.has(String(m.id)))
      .sort((a, b) => b.ts - a.ts);
    const previews = matches
      .filter((m) => !m.finished && !m.cancelled && m.ts > now && !covered.has(String(m.id)))
      .sort((a, b) => a.ts - b.ts);

    const jobs = [];
    for (const m of recaps) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'recap', match: m }); }
    for (const m of previews) { if (jobs.length >= MAX_NEW) break; jobs.push({ kind: 'preview', match: m }); }

    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const created = [];
    for (const job of jobs) {
      try {
        const stats = job.kind === 'recap' ? await fetchOurStats(job.match).catch(() => null) : null;
        const draft = await writeArticle(client, job, stats);
        if (!draft) continue;
        const article = toArticle(draft, job);
        existing.push(article);
        created.push({ id: article.id, title: article.title, kind: job.kind });
      } catch (e) { /* skip this one, continue */ }
    }
    if (created.length) await saveArticles(existing);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ created, candidates: { recaps: recaps.length, previews: previews.length } });
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message || 'AI writer error.');
  }
};

/* ---------- article generation ---------- */
async function writeArticle(client, job, stats) {
  const m = job.match;
  const facts = {
    team: TEAM_NAME,
    opponent: m.opponent,
    competition: m.event,
    division: m.division,
    date_utc: m.date,
  };
  if (job.kind === 'recap') {
    facts.result = m.result; // "win" | "loss"
    facts.score_maps = m.ourScore != null && m.theirScore != null ? `${m.ourScore}-${m.theirScore}` : null;
    if (stats && stats.length) {
      facts.our_players = stats.slice(0, 5).map((p) => ({
        name: p.player_name, rating: p.rating, kills: p.kills, deaths: p.deaths,
      }));
    }
  }

  const system =
    `You are the staff writer for the professional Counter-Strike 2 (CS2) esports team "Urge Intensesports". ` +
    `You write short, punchy, professional match ${job.kind === 'recap' ? 'recaps' : 'previews'} for the team's website. ` +
    `Voice: confident and energetic, but factual and never arrogant; third person ("Urge", "the squad"). ` +
    `Hard rule: use ONLY the facts in the provided data — never invent scores, players, dates, maps, or results. ` +
    `Keep it 130-220 words.`;

  const user =
    `Write a match ${job.kind} as a JSON object with exactly these keys: "title", "excerpt", "body".\n` +
    `- title: short, catchy headline.\n` +
    `- excerpt: one-sentence summary, max ~160 characters.\n` +
    `- body: Markdown, two or three short paragraphs (optionally one "## " subheading). Name the opponent and competition. ` +
    (job.kind === 'recap'
      ? `Reflect the result and map score; if player stats are provided, highlight the top performer by rating.\n`
      : `Build anticipation; do NOT state or imply a result.\n`) +
    `\nRespond with ONLY the JSON object — no code fences, no commentary, no text before or after it.\n\n` +
    `DATA:\n${JSON.stringify(facts, null, 2)}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseJson(text);
}

function toArticle(draft, job) {
  const now = new Date().toISOString();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    slug: slugify(draft.title) + '-' + Math.random().toString(36).slice(2, 6),
    title: String(draft.title).slice(0, 160),
    category: job.kind === 'recap' ? 'Match Recap' : 'Match Preview',
    excerpt: String(draft.excerpt || '').slice(0, 200),
    body: String(draft.body || ''),
    image: '',
    author: 'Urge AI',
    status: 'draft',          // always a draft — the admin approves before it goes live
    matchId: job.match.id,
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

/* ---------- Good Game Arena ---------- */
async function teamMatchups() {
  const out = [];
  let page = 1, last = 1;
  do {
    const data = await gg(`matchup?team_id=${TEAM_ID}&per_page=50&page=${page}`);
    const list = Array.isArray(data) ? data : (data && data.data) || [];
    for (const m of list) {
      const h = m.home_signup && m.home_signup.team && m.home_signup.team.id;
      const a = m.away_signup && m.away_signup.team && m.away_signup.team.id;
      if (h === TEAM_ID || a === TEAM_ID) out.push(m);
    }
    last = (data && data.meta && data.meta.last_page) || 1;
    page++;
  } while (page <= last && page <= MAX_PAGES);
  return out;
}

async function fetchOurStats(m) {
  const data = await gg(`matchup/${encodeURIComponent(m.id)}/stats`);
  const arr = Array.isArray(data) ? data : (data && data.data) || [];
  return arr.filter((p) => p.side === m.ourSide).sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
}

function normalizeMatch(m) {
  const isHome = m.home_signup && m.home_signup.team && m.home_signup.team.id === TEAM_ID;
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
