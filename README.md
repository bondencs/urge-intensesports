# URGE INTENSESPORTS — Team Website

A fast, animated, single-page website for the CS2 team **Urge Intensesports**.
No build step, no dependencies — pure HTML / CSS / JS. Just open it.

## Run it

Double-click `index.html`, or serve the folder for best results:

```powershell
# from this folder
python -m http.server 8000
# then open http://localhost:8000
```

## ⚠️ Add your logo (1 step)

Save your team logo as:

```
assets/images/logo.png
```

It's used in the navbar, footer, favicon, and social share preview.
The site still works without it (it falls back to a text mark), but it looks
best with the real logo dropped in.

## Customise

Everything below is placeholder content — search and replace freely:

| What | Where |
|------|-------|
| Player photos | `index.html` → `.player__media` (swap the `<span class="player__ghost">` for an `<img>`) |
| Social links | `index.html` → the `href="#"` on every `[data-social]` and player social link |
| Match fixtures / results | `index.html` → `#matches` section |
| Trophies | `index.html` → `#achievements` section |
| Stats numbers | `index.html` → `data-count="…"` attributes in `#about` |
| Sponsor names | `index.html` → `.sponsors__track` |
| Twitch/YouTube embed | `index.html` → `.stream__placeholder` (replace with your embed `<iframe>`) |
| Contact emails | `index.html` → `.contact__list` |
| Colours / fonts | `css/styles.css` → `:root` tokens at the top |

### Adding a player photo
Replace this:
```html
<span class="player__ghost">B</span>
```
with:
```html
<img src="assets/images/bonden.jpg" alt="bondeN" class="player__photo" />
```
(then add `.player__photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}` to the CSS).

### Make the contact form actually send
It's a front-end demo right now. Easiest real option: create a free
[Formspree](https://formspree.io) form and set
`<form action="https://formspree.io/f/XXXX" method="POST">` in `index.html`.

## Deploy (free)

- **Netlify Drop** — drag this whole folder onto https://app.netlify.com/drop
- **GitHub Pages** — push the folder to a repo, enable Pages
- **Cloudflare Pages / Vercel** — point them at the folder

## Roster

bondeN 🇳🇴 · Zutch 🇳🇴 · tob1 🇩🇪 · Hamruz 🇳🇴 · Jaybee 🇳🇴

#URGEUP

---

# Live data — Good Game Arena API (Vercel)

The site can pull **real matches, results, stats and roster** from the Good Game
Arena API. Because every GG Arena endpoint needs a secret Bearer token, the
browser never calls it directly. Instead a tiny serverless function
(`api/gg.js`) holds the token and proxies the requests:

```
browser → /api/gg (your domain, token hidden) → ggarena.no API
```

Until it's set up, the site just shows the built-in placeholder content — it
never breaks.

## One-time setup

**1. Put the site in a Git repo** (GitHub is easiest). The repo's root should be
this `urge-intensesports` folder (so `index.html` and the `api/` folder are at
the top level).

**2. Import it into Vercel** → https://vercel.com/new
- Framework preset: **Other**
- Build command: *(leave empty)* · Output directory: *(leave empty)*

**3. Add your token as an environment variable** (Vercel → Project → Settings →
Environment Variables):

| Name | Value |
|------|-------|
| `GGARENA_TOKEN` | your Bearer token (the value from Swagger's *Authorize* box, without "Bearer ") |

Then **redeploy** so the variable takes effect. The token lives only here — never
in the code, never in the browser.

**4. Confirm it works.** Visit:

```
https://YOUR-SITE.vercel.app/api/gg?path=club
```

You should see JSON of your clubs. Find **Urge Intensesports** and copy its `id`
(or `uuid`).

**5. Switch the site to live data.** In `index.html`, fill in the ids:

```html
<meta name="gg-club" content="YOUR_CLUB_ID" />
<meta name="gg-team" content="YOUR_TEAM_ID" />
```

Commit & push → Vercel auto-redeploys → matches and roster go live. 🎉

## What's wired up

| Section | Endpoint used |
|---------|---------------|
| Matches & results | `/api/gg?path=matchup&club=…` |
| Match stats | `/api/gg?path=matchup/{id}/stats` |
| Roster | `/api/gg?path=team/{team}/players` |

The proxy is **allow-listed** — only the documented GG Arena paths can pass
through it, so it can't be abused.

## Finishing the field mapping

The functions that turn API responses into on-page cards live in
`js/live.js`, marked with `>>> FIELD MAPPING <<<`. They try the most likely
field names and **fall back to placeholders** if they don't match. To lock them
in exactly, grab one real response each from:

```
/api/gg?path=matchup&club=YOUR_CLUB_ID
/api/gg?path=team/YOUR_TEAM_ID/players
```

…and adjust the field names (or send them over and they can be finalized for you).
No token appears in those responses, so they're safe to share.

## Local note

`/api/gg` only runs on Vercel, not when you double-click `index.html` or use
`python -m http.server`. Locally the site shows placeholders, which is expected.

