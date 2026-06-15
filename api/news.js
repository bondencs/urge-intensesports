/* =========================================================
   /api/news  —  article store (Vercel KV / Upstash REST).

   GET    /api/news            → published articles (public)
   GET    /api/news?slug=x     → one published article (public)
   GET    /api/news?all=1      → ALL articles incl. drafts (admin)
   POST   /api/news            → create        (admin)
   PUT    /api/news?id=x       → update/publish (admin)
   DELETE /api/news?id=x       → delete         (admin)

   Admin calls must send header  x-admin-key: <ADMIN_PASSWORD>.
   Articles live in a single KV key ("articles") as a JSON array.
   ========================================================= */

// (rebuild to pick up KV env vars)
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_PASSWORD;
const KEY = 'articles';

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return fail(res, 503, 'News storage is not configured yet (missing Vercel KV).');

  try {
    const method = req.method;
    if (method === 'GET') return getHandler(req, res);
    if (method === 'POST') return requireAdmin(req, res, createHandler);
    if (method === 'PUT') return requireAdmin(req, res, updateHandler);
    if (method === 'DELETE') return requireAdmin(req, res, deleteHandler);
    return fail(res, 405, 'Method not allowed.');
  } catch (err) {
    return fail(res, 500, err.message || 'News error.');
  }
};

/* ---------- handlers ---------- */
async function getHandler(req, res) {
  const all = await getAll();
  if (req.query.all) {
    if (!isAdmin(req)) return fail(res, 401, 'Unauthorized.');
    return ok(res, sortNew(all), 0);
  }
  if (req.query.slug) {
    const a = all.find((x) => x.slug === req.query.slug && x.status === 'published');
    return a ? ok(res, a, 60) : fail(res, 404, 'Article not found.');
  }
  return ok(res, sortNew(all.filter((x) => x.status === 'published')), 60);
}

async function createHandler(req, res) {
  const b = req.body || {};
  if (!b.title) return fail(res, 400, 'Title is required.');
  const all = await getAll();
  const now = new Date().toISOString();
  const article = {
    id: uid(),
    slug: slugify(b.title) + '-' + Math.random().toString(36).slice(2, 6),
    title: String(b.title),
    category: b.category || 'News',
    excerpt: b.excerpt || '',
    body: b.body || '',
    image: b.image || '',
    author: b.author || 'Staff',
    status: b.status === 'published' ? 'published' : 'draft',
    matchId: b.matchId || null,           // used by the AI writer to avoid duplicates
    date: b.date || now,
    createdAt: now,
  };
  all.push(article);
  await saveAll(all);
  return ok(res, article, 0);
}

async function updateHandler(req, res) {
  const id = req.query.id;
  const b = req.body || {};
  const all = await getAll();
  const i = all.findIndex((x) => x.id === id);
  if (i === -1) return fail(res, 404, 'Article not found.');
  const allowed = ['title', 'category', 'excerpt', 'body', 'image', 'author', 'status', 'date'];
  allowed.forEach((k) => { if (k in b) all[i][k] = b[k]; });
  all[i].updatedAt = new Date().toISOString();
  await saveAll(all);
  return ok(res, all[i], 0);
}

async function deleteHandler(req, res) {
  const id = req.query.id;
  const all = await getAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return fail(res, 404, 'Article not found.');
  await saveAll(next);
  return ok(res, { deleted: id }, 0);
}

/* ---------- auth ---------- */
const isAdmin = (req) => ADMIN && req.headers['x-admin-key'] === ADMIN;
function requireAdmin(req, res, fn) {
  if (!ADMIN) return fail(res, 503, 'Admin is not configured yet (missing ADMIN_PASSWORD).');
  if (!isAdmin(req)) return fail(res, 401, 'Wrong or missing admin password.');
  return fn(req, res);
}

/* ---------- KV helpers (Upstash REST) ---------- */
async function kv(command) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('KV request failed (' + r.status + ').');
  const j = await r.json();
  return j.result;
}
async function getAll() {
  const raw = await kv(['GET', KEY]);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
const saveAll = (arr) => kv(['SET', KEY, JSON.stringify(arr)]);

/* ---------- utils ---------- */
const sortNew = (a) => a.slice().sort((x, y) => new Date(y.date) - new Date(x.date));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o').replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'article';
}
function ok(res, data, cache) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cache ? `public, s-maxage=${cache}, stale-while-revalidate=${cache * 5}` : 'no-store');
  return res.status(200).json(data);
}
function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
