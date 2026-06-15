/* =========================================================
   News page — fetches /api/news and renders the list, or a
   single article when ?article=<slug> is present.
   ========================================================= */
(function () {
  'use strict';
  const root = document.getElementById('newsRoot');
  if (!root) return;

  const params = new URLSearchParams(location.search);
  const slug = params.get('article');

  (slug ? loadArticle(slug) : loadList());

  async function loadList() {
    let items;
    try {
      const r = await fetch('/api/news', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('news ' + r.status);
      items = await r.json();
    } catch (e) {
      root.innerHTML = state('Couldn’t load news right now. Please check back soon.');
      return;
    }
    if (!Array.isArray(items) || !items.length) {
      root.innerHTML = state('No articles published yet — check back soon. 🟢');
      return;
    }
    root.innerHTML = '<div class="news-grid">' + items.map(card).join('') + '</div>';
  }

  async function loadArticle(slug) {
    let a;
    try {
      const r = await fetch('/api/news?slug=' + encodeURIComponent(slug), { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('article ' + r.status);
      a = await r.json();
    } catch (e) {
      root.innerHTML = state('Article not found.') + backLink();
      return;
    }
    document.title = a.title + ' — Urge Intensesports';
    root.innerHTML =
      '<article class="article">' +
        backLink() +
        '<div class="article__meta"><span class="news-tag">' + esc(a.category) + '</span>' +
          '<span class="news-date">' + fmtDate(a.date) + '</span></div>' +
        '<h1 class="article__title">' + esc(a.title) + '</h1>' +
        (a.image ? '<img class="article__img" src="' + esc(a.image) + '" alt="">' : '') +
        '<div class="article__body">' + md(a.body || '') + '</div>' +
        '<p class="article__author">— ' + esc(a.author || 'Staff') + '</p>' +
      '</article>';
  }

  const card = (a) =>
    '<a class="news-card" href="news.html?article=' + encodeURIComponent(a.slug) + '">' +
      (a.image
        ? '<div class="news-card__media"><img src="' + esc(a.image) + '" alt="" loading="lazy"></div>'
        : '<div class="news-card__media news-card__media--blank"><span>URGE</span></div>') +
      '<div class="news-card__body">' +
        '<div class="news-card__meta"><span class="news-tag">' + esc(a.category) + '</span>' +
          '<span class="news-date">' + fmtDate(a.date) + '</span></div>' +
        '<h2 class="news-card__title">' + esc(a.title) + '</h2>' +
        '<p class="news-card__excerpt">' + esc(a.excerpt || strip(a.body).slice(0, 140)) + '</p>' +
        '<span class="news-card__more">Read more →</span>' +
      '</div>' +
    '</a>';

  const state = (msg) => '<div class="news-empty">' + esc(msg) + '</div>';
  const backLink = () => '<a class="article__back" href="news.html">← All news</a>';

  /* ---- tiny, safe markdown ---- */
  function md(src) {
    let s = esc(src).replace(/\r\n/g, '\n');
    const blocks = s.split(/\n{2,}/).map((b) => {
      b = b.trim();
      if (!b) return '';
      if (/^### /.test(b)) return '<h3>' + inline(b.replace(/^### /, '')) + '</h3>';
      if (/^## /.test(b)) return '<h2>' + inline(b.replace(/^## /, '')) + '</h2>';
      if (/^(\- |\* )/.test(b)) {
        const items = b.split('\n').map((l) => l.replace(/^(\- |\* )/, '').trim()).filter(Boolean);
        return '<ul>' + items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</ul>';
      }
      return '<p>' + inline(b).replace(/\n/g, '<br>') + '</p>';
    });
    return blocks.join('');
  }
  function inline(t) {
    return t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  /* ---- helpers ---- */
  const strip = (s) => String(s || '').replace(/[#*_>\-]/g, ' ').replace(/\s+/g, ' ').trim();
  function fmtDate(d) {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})();
