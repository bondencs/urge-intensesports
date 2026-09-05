/* =========================================================
   URGE INTENSESPORTS — interactions
   ========================================================= */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $  = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  /* ---------- Social icons (inline SVG, color via currentColor) ---------- */
  const ICONS = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.24 2H21.5l-7.5 8.57L22.5 22h-6.6l-5.17-6.76L4.8 22H1.54l8.02-9.17L1.5 2h6.77l4.67 6.18L18.24 2Zm-1.16 18h1.8L7.02 3.9H5.1L17.08 20Z"/></svg>',
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 2 2.5 6v13H7v3h3l3-3h4l4.5-4.5V2H4Zm16.5 9.5L18 14h-4l-3 3v-3H7V4h13.5v7.5ZM16 6h-1.5v4.5H16V6Zm-4 0h-1.5v4.5H12V6Z"/></svg>',
    steam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="15" cy="9" r="2.4" fill="currentColor" stroke="none"/><circle cx="8.6" cy="14.4" r="2" fill="currentColor" stroke="none"/><path d="M10.2 13 14 10.2" stroke-width="1.6"/></svg>',
    ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1.3" fill="currentColor" stroke="none"/></svg>',
    discord: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.5 5.3A16 16 0 0 0 15.5 4l-.25.5a13 13 0 0 1 3.4 1.6 13 13 0 0 0-11.3 0A13 13 0 0 1 10.75 4.5L10.5 4a16 16 0 0 0-4 1.3C3.9 9.1 3.2 12.8 3.5 16.4A16 16 0 0 0 8.4 19l.6-1a10 10 0 0 1-1.6-.8l.4-.3a11 11 0 0 0 9.4 0l.4.3a10 10 0 0 1-1.6.8l.6 1a16 16 0 0 0 4.9-2.6c.4-4.3-.7-8-3.5-11.1ZM9.5 14.2c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9 1.7.9 1.7 1.9-.8 1.9-1.7 1.9Zm5 0c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9 1.7.9 1.7 1.9-.8 1.9-1.7 1.9Z"/></svg>',
    yt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 7.5a3 3 0 0 0-2.1-2.1C19 4.9 12 4.9 12 4.9s-7 0-8.9.5A3 3 0 0 0 1 7.5 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.5a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23.5 12 31 31 0 0 0 23 7.5ZM9.8 15.3V8.7l5.7 3.3-5.7 3.3Z"/></svg>'
  };
  $$('[data-social]').forEach(a => { a.innerHTML = ICONS[a.dataset.social] || ICONS.x; });
  window.URGE_ICONS = ICONS; // shared with live.js so re-rendered cards keep their icons

  /* ---------- Preloader ---------- */
  const preloader = $('#preloader');
  window.addEventListener('load', () => {
    setTimeout(() => preloader && preloader.classList.add('is-done'), reduceMotion ? 0 : 700);
  });
  // safety: never trap the user behind the loader
  setTimeout(() => preloader && preloader.classList.add('is-done'), 3500);

  /* ---------- Year ---------- */
  const yearEl = $('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Navbar scroll state + scroll progress ---------- */
  const nav = $('#nav');
  const progress = $('#scrollProgress');
  const onScroll = () => {
    const y = window.scrollY;
    if (nav) nav.classList.toggle('is-scrolled', y > 30);
    if (progress) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile nav ---------- */
  const toggle = $('#navToggle');
  const links = $('#navLinks');
  const closeMenu = () => {
    if (!links) return;
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    $$('a', links).forEach(a => a.addEventListener('click', closeMenu));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  }

  /* ---------- Reveal on scroll ---------- */
  const revealEls = $$('[data-reveal]');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const delay = parseInt(el.dataset.delay || '0', 10) * 90;
          el.style.transitionDelay = delay + 'ms';
          el.classList.add('in-view');
          io.unobserve(el);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in-view'));
  }

  /* ---------- Animated counters ---------- */
  const counters = $$('[data-count]');
  const runCounter = (el) => {
    const target = parseFloat(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const dur = 1600;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = target + suffix;
    };
    requestAnimationFrame(step);
  };
  if ('IntersectionObserver' in window && !reduceMotion) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { runCounter(entry.target); cio.unobserve(entry.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach(el => cio.observe(el));
  } else {
    counters.forEach(el => el.textContent = el.dataset.count + (el.dataset.suffix || ''));
  }

  /* ---------- Matches tabs ---------- */
  const tabs = $$('.matches__tab');
  const panels = $$('.matches__panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('is-active'));
      panels.forEach(p => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      const panel = $('[data-panel="' + tab.dataset.tab + '"]');
      if (panel) panel.classList.add('is-active');
    });
  });

  /* ---------- Site-wide particle network backdrop ---------- */
  const canvas = $('#bgCanvas');
  if (canvas && !reduceMotion) {
    const ctx = canvas.getContext('2d');
    let w, h, dpr, particles, raf;
    const LINK = 150;
    const count = () => Math.max(36, Math.min(120, Math.round((window.innerWidth * window.innerHeight) / 16000)));

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width = window.innerWidth * dpr;
      h = canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    };
    const make = () => {
      particles = Array.from({ length: count() }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.32 * dpr,
        vy: (Math.random() - 0.5) * 0.32 * dpr,
        r: (Math.random() * 1.5 + 0.5) * dpr
      }));
    };
    const link = LINK;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const maxD = link * dpr;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(166, 255, 26, 0.55)';
        ctx.fill();
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const dx = p.x - q.x, dy = p.y - q.y;
          const d = Math.hypot(dx, dy);
          if (d < maxD) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = 'rgba(166, 255, 26, ' + (0.14 * (1 - d / maxD)) + ')';
            ctx.lineWidth = dpr;
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    const init = () => { resize(); make(); cancelAnimationFrame(raf); draw(); };
    init();
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(init, 200); });
    // pause when the tab is hidden (saves battery/CPU)
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) draw();
    });
  }
})();
