(function(){
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =========================================================
     SPRING ENGINE
     Apple-style "damping ratio + response" springs (WWDC18 —
     Designing Fluid Interfaces). Every value here is velocity-
     aware and interruptible: calling springTo() on a spring that
     is already moving just changes its target — it keeps the
     current position/velocity and re-targets smoothly, instead
     of restarting from a fixed keyframe. That's what lets a
     panel be grabbed and reversed mid-flight.
  ========================================================= */
  function makeSpring({ zeta = 1, response = 0.32 } = {}){
    const omega = 2 * Math.PI / response;
    return {
      value:0, velocity:0, target:0,
      k: omega * omega,
      c: 2 * zeta * omega,
      step(dt){
        const force = -this.k * (this.value - this.target) - this.c * this.velocity;
        this.velocity += force * dt;
        this.value += this.velocity * dt;
      },
      atRest(eps = 0.0015){
        return Math.abs(this.target - this.value) < eps && Math.abs(this.velocity) < eps;
      }
    };
  }

  const activeSprings = new Set();
  let ticking = false, lastT = null;
  function tick(t){
    if(lastT == null) lastT = t;
    const dt = Math.min((t - lastT) / 1000, 0.032);
    lastT = t;
    activeSprings.forEach(s => {
      s.step(dt);
      s._onUpdate(s.value);
      if(s.atRest()){
        s.value = s.target; s._onUpdate(s.value);
        activeSprings.delete(s);
        if(s._onSettle) s._onSettle();
      }
    });
    if(activeSprings.size){ requestAnimationFrame(tick); } else { ticking = false; lastT = null; }
  }
  function springTo(spring, target, { onUpdate, onSettle } = {}){
    spring.target = target;
    if(onUpdate) spring._onUpdate = onUpdate;
    if(onSettle) spring._onSettle = onSettle;
    activeSprings.add(spring);
    if(!ticking){ ticking = true; requestAnimationFrame(tick); }
  }

  /* =========================================================
     HEADER — translucent glass chrome + scroll progress
  ========================================================= */
  const header = document.getElementById('header');
  const progress = document.getElementById('progress');
  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 40);
    const h = document.documentElement;
    const pct = (h.scrollTop) / (h.scrollHeight - h.clientHeight) * 100;
    progress.style.width = pct + '%';
  }, { passive:true });

  /* =========================================================
     REVEAL ON SCROLL — spring fade + rise instead of a fixed-
     duration CSS transition, critically damped (no overshoot).
  ========================================================= */
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if(!e.isIntersecting) return;
      io.unobserve(e.target);
      const el = e.target;
      if(reduceMotion){ el.classList.add('in'); return; }
      const s = makeSpring({ zeta:1, response:0.55 });
      springTo(s, 1, {
        onUpdate(v){
          el.style.opacity = v;
          el.style.transform = `translateY(${(1 - v) * 36}px)`;
        },
        onSettle(){ el.classList.add('in'); }
      });
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* =========================================================
     IMAGE LOAD / ERROR STATES — every gallery image is lazy-loaded
     (see CSS), so it needs a visible loading→loaded transition and
     a graceful fallback if a file genuinely fails to fetch, instead
     of silently popping in or showing a bare browser broken-icon.
  ========================================================= */
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    const markLoaded = () => img.classList.add('is-loaded');
    if(img.complete && img.naturalWidth > 0){ markLoaded(); return; }
    img.addEventListener('load', markLoaded, { once:true });
    img.addEventListener('error', () => {
      img.classList.add('is-loaded', 'img-error');
    }, { once:true });
  });

  /* =========================================================
     CURSOR-FOLLOW "VER PROYECTO / VER MÁS" TAG
     Two independent springs (x/y) so momentum on one axis never
     desyncs the other. Continuously retargeted on mousemove —
     the tag can change direction mid-flight without a stutter.
  ========================================================= */
  const hoverTag = document.getElementById('hoverTag');
  const hoverable = document.querySelectorAll('.work-media, .more-item');
  const tagX = makeSpring({ zeta:1, response:0.22 });
  const tagY = makeSpring({ zeta:1, response:0.22 });
  function applyTag(){ hoverTag.style.left = tagX.value + 'px'; hoverTag.style.top = tagY.value + 'px'; }
  hoverable.forEach(el => {
    const label = el.closest('.more-item') ? 'Ver más' : 'Ver proyecto';
    el.addEventListener('mouseenter', (e) => {
      hoverTag.textContent = label;
      tagX.value = tagX.target = e.clientX; tagX.velocity = 0;
      tagY.value = tagY.target = e.clientY; tagY.velocity = 0;
      applyTag();
      hoverTag.classList.add('show');
    });
    el.addEventListener('mousemove', (e) => {
      springTo(tagX, e.clientX, { onUpdate: applyTag });
      springTo(tagY, e.clientY, { onUpdate: applyTag });
    });
    el.addEventListener('mouseleave', () => hoverTag.classList.remove('show'));
  });

  /* =========================================================
     IMAGE HOVER SCALE — spring instead of a CSS transition, so
     a quick in-out-in mouse pass reverses fluidly from wherever
     the scale currently is, rather than restarting a keyframe.
  ========================================================= */
  document.querySelectorAll('.work-media img, .more-item img').forEach(img => {
    const s = makeSpring({ zeta:1, response:0.5 });
    s.value = s.target = 1.01;
    const apply = (v) => { img.style.transform = `scale(${v})`; };
    const host = img.closest('.work-media, .more-item');
    host.addEventListener('mouseenter', () => springTo(s, 1.06, { onUpdate: apply }));
    host.addEventListener('mouseleave', () => springTo(s, 1.01, { onUpdate: apply }));
  });

  /* =========================================================
     DRAG GALLERY — mouse drag-to-scroll with momentum on release.
     Touch/pen are left untouched: overflow-x:auto plus
     -webkit-overflow-scrolling:touch already gives native inertia
     there, so this only engages for pointerType === 'mouse' to
     avoid fighting the browser's own touch momentum.

     The gallery's items are real links (Grupo Mitre, Mekano, etc.),
     so a plain click still has to navigate. setPointerCapture()
     retargets the mouseup/click that follows to the captured
     element instead of the link underneath the cursor — calling it
     unconditionally on every pointerdown silently broke every card.
     Fix: don't decide it's a drag (and don't capture the pointer)
     until the cursor has actually moved past a small threshold. A
     genuine click never crosses that threshold, so it reaches the
     link untouched; a real drag is still captured and gets momentum.
  ========================================================= */
  (function initDragGallery(){
    const gallery = document.getElementById('dragGallery');
    if(!gallery) return;
    let isDown = false, isDragging = false, startX = 0, startScroll = 0, lastX = 0, lastT = 0, velocity = 0;
    let momentumId = null;
    const friction = 0.94;
    const DRAG_THRESHOLD = 6; // px of movement before a pointerdown counts as a drag, not a click

    function stopMomentum(){
      if(momentumId){ cancelAnimationFrame(momentumId); momentumId = null; }
    }

    gallery.addEventListener('pointerdown', (e) => {
      if(e.pointerType !== 'mouse') return;
      isDown = true; isDragging = false;
      stopMomentum();
      startX = e.clientX; startScroll = gallery.scrollLeft;
      lastX = e.clientX; lastT = performance.now(); velocity = 0;
    });

    gallery.addEventListener('pointermove', (e) => {
      if(!isDown) return;
      const dx = e.clientX - startX;
      if(!isDragging){
        if(Math.abs(dx) < DRAG_THRESHOLD) return;
        isDragging = true;
        gallery.classList.add('dragging');
        try { gallery.setPointerCapture(e.pointerId); } catch(err) { /* pointer already released — safe to ignore */ }
      }
      gallery.scrollLeft = startScroll - dx;
      const now = performance.now();
      const dt = now - lastT;
      if(dt > 0) velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX; lastT = now;
    });

    function endDrag(){
      if(!isDown) return;
      isDown = false;
      gallery.classList.remove('dragging');
      if(!isDragging || reduceMotion) return;
      let v = -velocity * 16;
      (function step(){
        if(Math.abs(v) < 0.5){ momentumId = null; return; }
        gallery.scrollLeft += v;
        v *= friction;
        momentumId = requestAnimationFrame(step);
      })();
    }
    gallery.addEventListener('pointerup', endDrag);
    gallery.addEventListener('pointercancel', endDrag);
    gallery.addEventListener('pointerleave', () => { if(isDown) endDrag(); });
    gallery.addEventListener('dragstart', (e) => e.preventDefault());
    // safety net: if a real drag's click still lands on a link (browser-
    // dependent), stop it from navigating away mid-scroll
    gallery.addEventListener('click', (e) => { if(isDragging) e.preventDefault(); }, true);

    gallery.addEventListener('keydown', (e) => {
      if(e.key === 'ArrowRight'){ e.preventDefault(); gallery.scrollBy({ left:320, behavior: reduceMotion ? 'auto' : 'smooth' }); }
      if(e.key === 'ArrowLeft'){ e.preventDefault(); gallery.scrollBy({ left:-320, behavior: reduceMotion ? 'auto' : 'smooth' }); }
    });
  })();

  /* =========================================================
     HERO IMAGE TRAIL — a small recycled pool of thumbnails that
     pop in at the cursor as it crosses the hero and fade out behind
     it, cycling through a curated set of project images. Desktop
     mouse only: gated on hover-capable pointers, and off entirely
     under prefers-reduced-motion. Pool size (concurrent thumbnails
     on screen) is intentionally decoupled from the image count —
     a handful of recycled DOM nodes cycle through the whole set.
  ========================================================= */
  (function initHeroTrail(){
    const hero = document.querySelector('.hero');
    const layer = document.getElementById('heroTrail');
    if(!hero || !layer || reduceMotion) return;
    if(matchMedia('(hover:none), (pointer:coarse)').matches) return;

    // Each entry keeps the source file's real aspect ratio (w/h) and a
    // hand-tuned display width, so the trail visibly mixes tall story
    // crops, square-ish displays and wide landscape shots instead of
    // forcing every format into the same box.
    const images = [
      { src:'images/trail/trail-01.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-02.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-03.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-04.jpg', ar:0.721, w:145 },
      { src:'images/trail/trail-05.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-06.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-07.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-08.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-09.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-10.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-11.jpg', ar:0.722, w:145 },
      { src:'images/trail/trail-12.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-13.jpg', ar:0.721, w:145 },
      { src:'images/trail/trail-14.jpg', ar:1.333, w:205 },
      { src:'images/trail/trail-15.jpg', ar:1.196, w:185 },
      { src:'images/trail/trail-16.jpg', ar:1.196, w:185 },
      { src:'images/trail/trail-17.jpg', ar:1.196, w:185 },
      { src:'images/trail/trail-18.jpg', ar:0.272, w:85  },
      { src:'images/trail/trail-19.jpg', ar:1.333, w:205 },
      { src:'images/trail/trail-20.jpg', ar:1.333, w:205 },
      { src:'images/trail/trail-21.jpg', ar:0.563, w:120 },
      { src:'images/trail/trail-22.jpg', ar:1.333, w:205 },
      { src:'images/trail/trail-23.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-24.jpg', ar:0.758, w:150 },
      { src:'images/trail/trail-25.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-26.jpg', ar:0.800, w:160 },
      { src:'images/trail/trail-27.jpg', ar:0.806, w:160 }
    ];
    // shuffle once so the fixed source order doesn't repeat the same
    // shape pattern every lap through the array
    for(let i = images.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [images[i], images[j]] = [images[j], images[i]];
    }

    const POOL_SIZE = 10;  // concurrent recycled DOM nodes — independent of images.length
    const MIN_DIST = 90;   // px the cursor must travel before the next thumbnail spawns
    const HOLD_MS = 260;   // how long a thumbnail stays fully visible before fading

    const pool = Array.from({ length: POOL_SIZE }, () => {
      const el = document.createElement('div');
      el.className = 'trail-img';
      const img = document.createElement('img');
      img.alt = ''; img.decoding = 'async';
      el.appendChild(img);
      layer.appendChild(el);
      return { el, img, timer:null };
    });

    let poolIndex = 0, imgIndex = 0, lastX = null, lastY = null;

    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if(lastX !== null && Math.hypot(x - lastX, y - lastY) < MIN_DIST) return;
      lastX = x; lastY = y;

      const slot = pool[poolIndex];
      poolIndex = (poolIndex + 1) % pool.length;
      imgIndex = (imgIndex + 1) % images.length;
      const meta = images[imgIndex];
      const h = meta.w / meta.ar;

      clearTimeout(slot.timer);
      slot.img.src = meta.src;
      slot.el.style.width = meta.w + 'px';
      slot.el.style.aspectRatio = String(meta.ar);
      slot.el.style.marginLeft = (-meta.w / 2) + 'px';
      slot.el.style.marginTop = (-h / 2) + 'px';
      slot.el.style.left = x + 'px';
      slot.el.style.top = y + 'px';
      slot.el.style.setProperty('--r', (Math.random() * 14 - 7).toFixed(1) + 'deg');
      slot.el.classList.remove('is-active');
      void slot.el.offsetWidth; // force reflow so the enter transition restarts
      slot.el.classList.add('is-active');
      slot.timer = setTimeout(() => slot.el.classList.remove('is-active'), HOLD_MS);
    });
    hero.addEventListener('mouseleave', () => { lastX = null; lastY = null; });
  })();

  /* =========================================================
     PRESS FEEDBACK — react on pointerdown, not on release/click.
  ========================================================= */
  document.querySelectorAll('[data-press]').forEach(el => {
    const press = () => el.classList.add('is-pressed');
    const release = () => el.classList.remove('is-pressed');
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  });

  /* =========================================================
     MOBILE MENU — spring-driven glass sheet. Retargeting the
     same spring on every click (instead of replaying a CSS
     animation) means the panel can be grabbed mid-slide and
     reversed instantly: click open, click closed again before
     it settles, and it reverses smoothly from its live position.
  ========================================================= */
  const menuToggle = document.getElementById('menuToggle');
  const mobileMenu = document.getElementById('mobileMenu');
  const menuScrim = document.getElementById('menuScrim');
  let menuOpen = false;
  const menuSpring = makeSpring({ zeta:1, response:0.34 });
  function applyMenu(v){
    mobileMenu.style.transform = `translateX(${(1 - v) * 100}%)`;
    menuScrim.style.opacity = v;
    menuScrim.style.pointerEvents = v > 0.02 ? 'auto' : 'none';
    mobileMenu.style.pointerEvents = v > 0.5 ? 'auto' : 'none';
  }
  const menuFocusables = Array.from(mobileMenu.querySelectorAll('a'));
  function setMenu(open){
    menuOpen = open;
    menuToggle.classList.toggle('open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    mobileMenu.setAttribute('aria-hidden', String(!open));
    // lock background scroll while the sheet is open — the scrim covers
    // the page visually, this stops it from also scrolling underneath
    document.documentElement.style.overflow = open ? 'hidden' : '';
    if(open){ menuFocusables[0] && menuFocusables[0].focus(); }
    else if(document.activeElement && mobileMenu.contains(document.activeElement)){ menuToggle.focus(); }
    if(reduceMotion){ menuSpring.value = menuSpring.target = open ? 1 : 0; applyMenu(menuSpring.value); return; }
    springTo(menuSpring, open ? 1 : 0, { onUpdate: applyMenu });
  }
  menuToggle.addEventListener('click', () => setMenu(!menuOpen));
  menuScrim.addEventListener('click', () => setMenu(false));
  mobileMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
  window.addEventListener('keydown', (e) => { if(e.key === 'Escape' && menuOpen) setMenu(false); });
  // focus trap — while the sheet is open, Tab/Shift+Tab cycles only
  // through its own links instead of escaping into hidden page content
  mobileMenu.addEventListener('keydown', (e) => {
    if(e.key !== 'Tab' || !menuOpen || !menuFocusables.length) return;
    const first = menuFocusables[0], last = menuFocusables[menuFocusables.length - 1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  });

  /* =========================================================
     RUBBER-BANDING — soft resistance at the scroll boundaries
     instead of a hard stop, springing back once the gesture ends.
     overscroll-behavior-y:none (see CSS) hands us a clean slate
     so this is the only bounce that runs, consistently across browsers.
  ========================================================= */
  if(!reduceMotion){
    const mainEl = document.getElementById('top');
    const rb = makeSpring({ zeta:1, response:0.32 });
    function applyRB(v){ mainEl.style.transform = v ? `translateY(${v}px)` : ''; }
    function rubberband(x, d, c = 0.55){ return (x * d * c) / (d + c * Math.abs(x)); }
    function atBoundaries(){
      const atTop = window.scrollY <= 0;
      const scrollMax = document.documentElement.scrollHeight - window.innerHeight;
      const atBottom = window.scrollY >= scrollMax - 1;
      return { atTop, atBottom };
    }

    let overscroll = 0, wheelEndTimer = null;
    window.addEventListener('wheel', (e) => {
      const { atTop, atBottom } = atBoundaries();
      if((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)){
        e.preventDefault();
        overscroll += -e.deltaY * 0.6;
        overscroll = atTop ? Math.max(0, overscroll) : Math.min(0, overscroll);
        const bounded = rubberband(overscroll, window.innerHeight);
        rb.value = rb.target = bounded; rb.velocity = 0;
        applyRB(bounded);
        clearTimeout(wheelEndTimer);
        wheelEndTimer = setTimeout(() => { overscroll = 0; springTo(rb, 0, { onUpdate: applyRB }); }, 100);
      }
    }, { passive:false });

    let touchStartY = null;
    window.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive:true });
    window.addEventListener('touchmove', (e) => {
      if(touchStartY == null) return;
      const dy = e.touches[0].clientY - touchStartY;
      const { atTop, atBottom } = atBoundaries();
      if((atTop && dy > 0) || (atBottom && dy < 0)){
        e.preventDefault();
        const bounded = rubberband(dy * 0.6, window.innerHeight);
        rb.value = rb.target = bounded; rb.velocity = 0;
        applyRB(bounded);
      }
    }, { passive:false });
    window.addEventListener('touchend', () => {
      touchStartY = null;
      springTo(rb, 0, { onUpdate: applyRB });
    }, { passive:true });
  }
})();
