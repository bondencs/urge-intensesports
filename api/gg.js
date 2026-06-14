/* =========================================================
   Secure proxy for the Good Game Arena API.
   Runs ONLY on Vercel's servers — never in the browser.

   The Bearer token lives in the GGARENA_TOKEN environment
   variable (set in the Vercel dashboard) and is never sent
   to the client. The browser calls:

     /api/gg?path=club
     /api/gg?path=matchup&club=123&limit=20
     /api/gg?path=team/abc/players
     /api/gg?path=matchup/abc/stats

   Only the allow-listed paths below can be requested, so this
   can't be abused as an open proxy.
   ========================================================= */

const BASE = (process.env.GGARENA_BASE || 'https://www.ggarena.no/api/paradise/v2').replace(/\/+$/, '');
const TOKEN = process.env.GGARENA_TOKEN;

// Paths permitted through the proxy (the part after the API base URL).
const ALLOW = [
  /^club$/,
  /^club\/[\w-]+$/,
  /^club\/[\w-]+\/members$/,
  /^matchup$/,
  /^matchup\/[\w-]+$/,
  /^matchup\/uuid\/[\w-]+$/,
  /^matchup\/[\w-]+\/veto$/,
  /^matchup\/[\w-]+\/stats$/,
  /^team\/[\w-]+$/,
  /^team\/[\w-]+\/players$/,
  /^user\/[\w-]+$/,
  /^user\/uuid\/[\w-]+$/,
  /^user\/by-steam-id\/[\w-]+$/,
  /^user\/by-riot-id\/.+$/,
];

module.exports = async (req, res) => {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');

  const { path = '', ...rest } = req.query || {};
  const clean = String(Array.isArray(path) ? path[0] : path).replace(/^\/+|\/+$/g, '');

  if (!TOKEN) return fail(res, 503, 'Server is missing the GGARENA_TOKEN environment variable.');
  if (!clean) return fail(res, 400, 'Provide a ?path= parameter, e.g. /api/gg?path=club');
  if (!ALLOW.some((rx) => rx.test(clean))) return fail(res, 400, `Path "${clean}" is not allowed.`);

  // Forward any extra query params (limit, club, etc.) to the upstream API.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== '') qs.append(k, String(Array.isArray(v) ? v[0] : v));
  }
  const url = `${BASE}/${clean}${qs.toString() ? `?${qs}` : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
    const body = await upstream.text();

    if (!upstream.ok) {
      // Hide auth failures from the client; surface everything else as-is.
      const code = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      return fail(res, code, `Good Game Arena API returned ${upstream.status}.`);
    }

    res.setHeader('Content-Type', 'application/json');
    // Cache at the CDN so we don't call the API on every single visit.
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).send(body);
  } catch (e) {
    return fail(res, 502, 'Could not reach the Good Game Arena API.');
  }
};

function fail(res, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: message });
}
