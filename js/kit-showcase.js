/* =========================================================
   URGE INTENSESPORTS — KIT SHOWCASE
   Animated 2D mockup graphic: 3D front<->back flip,
   cursor parallax tilt, shine sweep, glow + float.
   No WebGL — drives a CSS 3D transform via rAF.
   ========================================================= */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.kitfx').forEach(setup);

  function setup(root) {
    const card = root.querySelector('.kitfx__card');
    const btns = Array.from(root.querySelectorAll('.kitfx__toggle button'));
    if (!card) return;

    let flipTarget = 0, curFlip = 0;
    let tiltX = 0, tiltY = 0, tTiltX = 0, tTiltY = 0;
    let lastInteract = -1e9;
    const start = performance.now();

    const setFace = (face) => {
      flipTarget = face === 'back' ? 180 : 0;
      btns.forEach((b) => b.classList.toggle('is-active', b.dataset.face === face));
    };
    btns.forEach((b) =>
      b.addEventListener('click', () => { setFace(b.dataset.face); lastInteract = performance.now(); }));
    card.addEventListener('click', () => {
      setFace(flipTarget === 0 ? 'back' : 'front'); lastInteract = performance.now();
    });

    if (!reduce) {
      root.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        tTiltY = clamp(nx, -1, 1) * 13;
        tTiltX = -clamp(ny, -1, 1) * 8;
      });
      root.addEventListener('pointerleave', () => { tTiltX = 0; tTiltY = 0; });
      root.classList.add('is-animating');
    }

    let raf = 0, running = true;
    function tick(now) {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const t = (now - start) / 1000;
      curFlip += (flipTarget - curFlip) * 0.1;
      tiltX += (tTiltX - tiltX) * 0.12;
      tiltY += (tTiltY - tiltY) * 0.12;
      const floatY = reduce ? 0 : Math.sin(t * 1.1) * 8;
      card.style.transform =
        'translateY(' + floatY.toFixed(2) + 'px) rotateY(' + (curFlip + tiltY).toFixed(2) +
        'deg) rotateX(' + tiltX.toFixed(2) + 'deg)';
    }
    raf = requestAnimationFrame(tick);

    if (!reduce) {
      setInterval(() => {
        if (performance.now() - lastInteract > 6500) setFace(flipTarget === 0 ? 'back' : 'front');
      }, 6000);
    }

    // pause when off-screen / tab hidden
    const io = new IntersectionObserver((es) => {
      const vis = es[0].isIntersecting;
      if (vis && !running) { running = true; raf = requestAnimationFrame(tick); }
      else if (!vis) running = false;
    }, { threshold: 0.01 });
    io.observe(root);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) running = false;
      else if (!running) { running = true; raf = requestAnimationFrame(tick); }
    });
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
})();
