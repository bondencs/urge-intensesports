/* =========================================================
   Admin newsroom — talks to /api/news with the admin password.
   The password is kept in sessionStorage (cleared on log out).
   ========================================================= */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'urge_admin_key';
  let KEY = sessionStorage.getItem(STORE) || '';
  let editingId = null;

  const loginView = $('loginView');
  const appView = $('appView');

  /* ---- api ---- */
  async function api(method, qs, body) {
    return fetch('/api/news' + (qs || ''), {
      method,
      headers: Object.assign(
        { Accept: 'application/json' },
        KEY ? { 'x-admin-key': KEY } : {},
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /* ---- auth flow ---- */
  async function boot() {
    if (!KEY) return showLogin();
    const r = await api('GET', '?all=1');
    if (r.ok) { showApp(); renderList(await r.json()); }
    else showLogin();
  }
  function showLogin() { loginView.hidden = false; appView.hidden = true; $('logoutBtn').hidden = true; }
  function showApp() { loginView.hidden = true; appView.hidden = false; $('logoutBtn').hidden = false; }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    KEY = $('pw').value;
    const r = await api('GET', '?all=1');
    if (r.ok) {
      sessionStorage.setItem(STORE, KEY);
      showApp(); renderList(await r.json());
    } else {
      const j = await r.json().catch(() => ({}));
      note('loginNote', j.error || 'Login failed.', true);
      KEY = '';
    }
  });
  $('logoutBtn').addEventListener('click', () => { sessionStorage.removeItem(STORE); KEY = ''; showLogin(); });

  /* ---- list ---- */
  $('refreshBtn').addEventListener('click', async () => { const r = await api('GET', '?all=1'); if (r.ok) renderList(await r.json()); });

  $('aiBtn').addEventListener('click', async () => {
    note('aiNote', 'Generating drafts with AI… this can take ~30s.');
    try {
      const r = await fetch('/api/ai-news', { method: 'POST', headers: { 'x-admin-key': KEY, Accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { note('aiNote', j.error || 'AI generation failed.', true); return; }
      const n = (j.created || []).length;
      note('aiNote', n
        ? 'Created ' + n + ' draft' + (n > 1 ? 's' : '') + ' — review and publish them below.'
        : 'No new matches to write about right now.');
      const l = await api('GET', '?all=1'); if (l.ok) renderList(await l.json());
    } catch (e) { note('aiNote', 'AI generation failed (network).', true); }
  });

  function renderList(items) {
    const list = $('list');
    if (!Array.isArray(items) || !items.length) { list.innerHTML = '<div class="news-empty">No articles yet. Hit “New article”.</div>'; return; }
    list.innerHTML = items.map((a) =>
      '<div class="arow">' +
        '<div class="arow__main">' +
          '<span class="arow__status arow__status--' + a.status + '">' + a.status + '</span>' +
          '<div><div class="arow__title">' + esc(a.title) + '</div>' +
          '<div class="arow__meta">' + esc(a.category) + ' · ' + fmtDate(a.date) + ' · ' + esc(a.author || 'Staff') + '</div></div>' +
        '</div>' +
        '<div class="arow__actions">' +
          '<button class="abtn" data-edit="' + a.id + '">Edit</button>' +
          '<button class="abtn" data-toggle="' + a.id + '">' + (a.status === 'published' ? 'Unpublish' : 'Publish') + '</button>' +
          '<button class="abtn abtn--danger" data-del="' + a.id + '">Delete</button>' +
        '</div>' +
      '</div>'
    ).join('');
    window.__articles = items;
  }

  $('list').addEventListener('click', async (e) => {
    const editId = e.target.getAttribute('data-edit');
    const togId = e.target.getAttribute('data-toggle');
    const delId = e.target.getAttribute('data-del');
    if (editId) return openEditor((window.__articles || []).find((a) => a.id === editId));
    if (togId) {
      const a = (window.__articles || []).find((x) => x.id === togId);
      await api('PUT', '?id=' + togId, { status: a.status === 'published' ? 'draft' : 'published' });
      const r = await api('GET', '?all=1'); if (r.ok) renderList(await r.json());
    }
    if (delId) {
      if (!confirm('Delete this article permanently?')) return;
      await api('DELETE', '?id=' + delId);
      const r = await api('GET', '?all=1'); if (r.ok) renderList(await r.json());
    }
  });

  /* ---- editor ---- */
  $('newBtn').addEventListener('click', () => openEditor(null));
  document.querySelectorAll('[data-eclose]').forEach((el) => el.addEventListener('click', closeEditor));

  function openEditor(a) {
    editingId = a ? a.id : null;
    $('editorTitle').textContent = a ? 'Edit article' : 'New article';
    $('f-title').value = a ? a.title : '';
    $('f-category').value = a ? a.category : 'News';
    $('f-status').value = a ? a.status : 'draft';
    $('f-image').value = a ? (a.image || '') : '';
    $('f-excerpt').value = a ? (a.excerpt || '') : '';
    $('f-body').value = a ? (a.body || '') : '';
    note('editorNote', '');
    $('editor').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeEditor() { $('editor').hidden = true; document.body.style.overflow = ''; }

  $('editorForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: $('f-title').value.trim(),
      category: $('f-category').value,
      status: $('f-status').value,
      image: $('f-image').value.trim(),
      excerpt: $('f-excerpt').value.trim(),
      body: $('f-body').value,
    };
    if (!payload.title) return note('editorNote', 'Title is required.', true);
    note('editorNote', 'Saving…');
    const r = editingId ? await api('PUT', '?id=' + editingId, payload) : await api('POST', '', payload);
    if (r.ok) {
      closeEditor();
      const l = await api('GET', '?all=1'); if (l.ok) renderList(await l.json());
    } else {
      const j = await r.json().catch(() => ({}));
      note('editorNote', j.error || 'Save failed.', true);
    }
  });

  /* ---- helpers ---- */
  function note(id, msg, err) { const el = $(id); el.textContent = msg; el.className = 'admin__note' + (err ? ' is-err' : msg ? ' is-ok' : ''); }
  function fmtDate(d) { const t = new Date(d); return isNaN(t) ? '' : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  boot();
})();
