/*
 * Minami inspect hook (§21 preview comments) — the half of the channel that lives inside the app.
 *
 * A target app includes this in DEVELOPMENT ONLY (`{process.env.NODE_ENV === "development" && <script
 * src="http://localhost:3000/inspect.js" />}`); the dashboard's `/inspect.js` route prepends the
 * html-to-image UMD build and serves this file after it. Nothing here runs in production and nothing
 * here is bundled — plain ES2019, no modules, one IIFE, so it loads in Next.js, Vite, or a static
 * studio page without a build step.
 *
 * What it does: when the page is framed by the dashboard's pop-out preview (a cross-origin iframe),
 * it lets the wrapper ask about the DOM it cannot see — the element under the cursor, its React
 * owner chain, a crop of a region rendered in-page, and the app's own errors — over postMessage.
 * When not framed it defines `window.__minamiInspect` and does nothing else.
 *
 * Handshake: the script posts `hello` to `window.parent` with targetOrigin "*" (URL, title, viewport
 * — nothing secret). The wrapper answers `connect`; the origin that reply came from is pinned and
 * every later message targets it. The pin is only accepted from a loopback origin, so a page that
 * happens to be framed by something else gets nothing but the hello. `hello` is re-sent on every
 * navigation (hard or soft) because that is what tells the wrapper to re-anchor its pins.
 *
 * The protocol is typed in `lib/preview-comments.ts` — that file is the twin of the message shapes
 * used here. Change one, change the other.
 *
 * Everything is wrapped: an exception in this file must never reach the host app. It is a guest.
 */
(function () {
  'use strict';

  if (window.__minamiInspect) return;
  window.__minamiInspect = { version: 1 };
  if (window.parent === window) return;

  var TAG = 'minami-inspect';
  var ATTR = 'data-minami-inspect';
  var COLOR = '#e8859b';
  var FILL = 'rgba(232, 133, 155, 0.14)';
  var Z_OVERLAY = 2147483000;
  var Z_MARKERS = 2147482999;
  var ERROR_CAP = 50;
  var CROP_PAD = 24;
  var CROP_TIMEOUT_MS = 6000;
  var CROP_MAX_W = 640;      // thumbnail width cap — it lands in a 320px note

  var dashboardOrigin = null;
  var tool = null;            // "pin" | "rect" | null
  var overlay = null;
  var highlight = null;
  var rubber = null;
  var markerLayer = null;
  var markers = [];
  var errors = [];
  var capturing = 0;          // >0 while html-to-image is rendering; its own failed fetches are not the app's
  var lastHello = '';

  // Every listener goes through this so a bug in the guest never surfaces as an app error — which
  // would be doubly wrong here, because our own error hook would then report it to the wrapper.
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { /* swallowed on purpose */ }
    };
  }

  function isLoopbackOrigin(origin) {
    try {
      var host = new URL(origin).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    } catch (e) { return false; }
  }

  // Only `hello` may go out before the wrapper has identified itself; everything else would be a
  // broadcast of the page's DOM to whoever framed it.
  function post(msg) {
    try {
      msg.tag = TAG;
      if (msg.t !== 'hello' && !dashboardOrigin) return;
      window.parent.postMessage(msg, dashboardOrigin || '*');
    } catch (e) { /* parent gone or message unclonable */ }
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute(ATTR)) return true;
    return !!(node.closest && node.closest('[' + ATTR + ']'));
  }

  function el(tag, style) {
    var d = document.createElement(tag);
    d.setAttribute(ATTR, '1');
    d.style.cssText = style;
    return d;
  }

  function rid() { return Math.random().toString(36).slice(2, 10); }
  function round(n) { return Math.round(n); }
  function boxOf(node) {
    var r = node.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
  }

  // ── hello ─────────────────────────────────────────────────────────────────────────────────────
  function hello(force) {
    var key = location.href + '\n' + document.title;
    if (!force && key === lastHello) return;
    lastHello = key;
    post({ t: 'hello', url: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight } });
  }
  var sayHello = safe(function () { hello(true); });
  var helloIfChanged = safe(function () { hello(false); });

  // ── selectors ─────────────────────────────────────────────────────────────────────────────────
  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
  }
  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }
  // React useId (`:r1:`, `«r1»`, `_R_`), Radix, Headless UI and MUI ids change between renders, so a
  // selector built on them would fail to re-anchor after the very reload it exists to survive.
  function goodId(id) {
    return !!id && !/^\d/.test(id) && !/^(:|«|_R_|r[0-9a-z]+:|radix-|headlessui-|mui-|react-aria)/.test(id);
  }
  // Tailwind arbitrary values, variants, CSS-module hashes and styled-components classes are either
  // unstable or need escaping into something no human would type into a grep.
  function goodClass(c) {
    if (!c || c.length > 40) return false;
    if (/[\[\]:\/!.%@#&*~]/.test(c) || c.indexOf('__') !== -1) return false;
    if (/^[-\d]/.test(c)) return false;
    if (/^(sc|css|jsx|emotion|chakra|mantine)-/.test(c)) return false;
    return true;
  }
  function piece(node) {
    var tag = node.localName;
    var classes = [];
    for (var i = 0; i < node.classList.length && classes.length < 2; i++) {
      if (goodClass(node.classList[i])) classes.push('.' + cssEscape(node.classList[i]));
    }
    var p = tag + classes.join('');
    var parent = node.parentElement;
    if (!parent) return p;
    var hits = 0;
    try { hits = parent.querySelectorAll(':scope > ' + p).length; } catch (e) { hits = 2; }
    if (hits === 1) return p;
    var n = 0;
    for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === tag) { n++; if (c === node) break; }
    }
    return p + ':nth-of-type(' + n + ')';
  }
  function selectorFor(node) {
    var s;
    if (goodId(node.id)) { s = '#' + cssEscape(node.id); if (unique(s)) return s; }
    var tid = node.getAttribute && node.getAttribute('data-testid');
    if (tid) { s = '[data-testid="' + tid.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; if (unique(s)) return s; }
    var parts = [];
    var cur = node;
    // > 🐛 The walk stopped at depth 8 and returned whatever it had, unrooted. Ten wrappers deep —
    // ordinary in a Tailwind/React tree — two different spans produced the SAME selector, matching
    // two elements; `resolve()` then anchored the marker on the wrong one and Claude was handed a
    // selector pointing somewhere else. The walk now goes as far as it needs, and anything still
    // ambiguous is rooted at `body` and admits it (see `ambiguous` below) rather than lying.
    for (var depth = 0; cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 20; depth++) {
      parts.unshift(piece(cur));
      s = parts.join(' > ');
      if (unique(s)) return s;
      cur = cur.parentElement;
      // An ancestor with a real id is a better root than three more nth-of-type hops.
      if (cur && goodId(cur.id)) {
        var anchored = '#' + cssEscape(cur.id) + ' > ' + s;
        if (unique(anchored)) return anchored;
      }
    }
    var rooted = 'body > ' + parts.join(' > ');
    return unique(rooted) ? rooted : parts.join(' > ');
  }

  /** How many elements a selector matches — 1 is the contract, anything else is worth saying. */
  function matchCount(sel) {
    try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
  }

  // ── React owner chain ─────────────────────────────────────────────────────────────────────────
  function fiberOf(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0) return node[keys[i]];
    }
    return null;
  }
  // Framework plumbing between the user's components — Next's router/segment/boundary wrappers, any
  // Provider/Context, the `RootLayout` boilerplate — has no visual footprint to point at. Matched by
  // prefix, suffix and exact name rather than a bare prefix list, because `Head` would otherwise eat
  // `Header` and `App` would eat `AppShell`. A bare `Page`/`Layout` is kept: it is the user's file.
  // Heuristic on purpose; a wrong keep costs one word.
  var INTERNAL_PREFIX = /^(Next|Http|HTTP|ReactDev|DevRoot|Hot|Segment|InnerLayout|OuterLayout|ScrollAndFocus|Redirect|NotFound|RenderFromTemplate|ClientPage|ClientSegment|AppRouter|Pathname)/;
  var INTERNAL_SUFFIX = /(Boundary|Router|Handler|Provider|Context|Overlay|Reload|Reloader|Adapter|Announcer)$/;
  var INTERNAL_EXACT = /^(Head|RootLayout|Template|Suspense|App|Root|ServerRoot|Metadata|AsyncMetadata|Outlet)$/;
  function isInternal(name) {
    return INTERNAL_PREFIX.test(name) || INTERNAL_SUFFIX.test(name) || INTERNAL_EXACT.test(name);
  }
  function fnName(fn) { return fn.displayName || fn.name || null; }
  function nameOf(fiber) {
    var t = fiber.type;
    if (!t) return null;
    if (typeof t === 'function') return fnName(t);
    if (typeof t === 'object') {
      if (t.displayName) return t.displayName;
      var inner = t.render || t.type;            // forwardRef / memo
      if (inner && typeof inner === 'object') inner = inner.render || inner.type;   // memo(forwardRef(..))
      if (typeof inner === 'function') return fnName(inner);
    }
    return null;
  }
  function componentsOf(node) {
    var out = [];
    var f = fiberOf(node);
    // Innermost six, reversed: the leaf names are what locate the code; the outer ones are the page.
    while (f && out.length < 6) {
      var name = nameOf(f);
      // A minified name (`J`, `V`, `Kx`) locates nothing — a production-ish dev build or a bundled
      // library gives plenty of them, and they made the chain read as line noise. Dropped rather
      // than shown: the names that survive are the ones a grep can actually find.
      if (name && /^[A-Z]/.test(name) && name.length > 2 && !isInternal(name) && out[out.length - 1] !== name) out.push(name);
      f = f.return;
    }
    return out.reverse();
  }

  function textOf(node) {
    var t = '';
    try { t = node.innerText || node.textContent || ''; } catch (e) { t = ''; }
    return t.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  function infoOf(node) {
    var sel = selectorFor(node);
    var n = matchCount(sel);
    var info = { selector: sel, components: componentsOf(node), tag: node.localName, text: textOf(node), box: boxOf(node) };
    if (n !== 1) info.ambiguous = n;   // the wrapper says so in the message rather than pretending
    return info;
  }

  function targetAt(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      if (!isOurs(stack[i])) return stack[i];
    }
    return null;
  }

  // ── crop ──────────────────────────────────────────────────────────────────────────────────────
  //
  // > 🐛 v1 rendered `document.body` and cut the box out of it, so the thumbnail kept the real
  // background and neighbours. On a real page that is unaffordable: ecvision's home page is
  // 1280×4363, and one body render measured **19.4s** — five times the 4s timeout. So every crop
  // came back null AND the host app stayed janky for ~20s afterwards, because a timeout cannot
  // cancel html-to-image; the work runs to completion either way. Compounding per pin, that is
  // most of what "buggy as hell" meant.
  //
  // Now the SUBJECT is rendered, not the page: the picked element, or the nearest ancestor that
  // still fits comfortably on screen when the element itself is a sliver (a 2px divider or a bare
  // <span> is a useless thumbnail). Cost tracks the subject's own size instead of the document's.
  function cropSubject(node) {
    if (!node || node.nodeType !== 1) return null;
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = node.getBoundingClientRect();
    // Big enough to read on its own — take it as is.
    if (r.width >= vw * 0.25 && r.height >= 40) return node;
    var cur = node, best = node;
    for (var i = 0; i < 4 && cur.parentElement; i++) {
      cur = cur.parentElement;
      if (cur === document.body || cur === document.documentElement) break;
      var cr = cur.getBoundingClientRect();
      if (cr.width > vw * 1.05 || cr.height > vh * 0.9) break;
      best = cur;
      if (cr.width >= vw * 0.25 && cr.height >= 40) break;
    }
    return best;
  }

  function crop(node) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; if (capturing > 0) capturing--; resolve(v); } }
      setTimeout(function () { finish(null); }, CROP_TIMEOUT_MS);
      try {
        var h2i = window.htmlToImage;
        if (!h2i || typeof h2i.toCanvas !== 'function') return finish(null);
        var subject = cropSubject(node);
        if (!subject) return finish(null);
        var sr = subject.getBoundingClientRect();
        if (sr.width < 1 || sr.height < 1) return finish(null);
        // A transparent subject reads as a black rectangle; inherit the page's own ground.
        var bg = getComputedStyle(subject).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.body).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = undefined;
        // Cap the pixels: a full-width hero at DPR 1 is already 1280px wide, and this is a
        // thumbnail in a 320px note.
        var scale = Math.min(1, CROP_MAX_W / Math.max(1, sr.width));
        capturing++;
        h2i.toCanvas(subject, {
          pixelRatio: scale, backgroundColor: bg, cacheBust: false,
          filter: function (n) { return !(n && n.nodeType === 1 && n.hasAttribute(ATTR)); },
        }).then(function (canvas) {
          if (done) return;
          try { finish(canvas.toDataURL('image/png')); } catch (e) { finish(null); }
        }, function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }

  // A region drag has no single node, so it keeps the old body-cut path — but only for the region
  // case, which is rarer and where the whole point is the space BETWEEN elements. Same timeout.
  function cropRegion(box) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; if (capturing > 0) capturing--; resolve(v); } }
      setTimeout(function () { finish(null); }, CROP_TIMEOUT_MS);
      try {
        var h2i = window.htmlToImage;
        if (!h2i || typeof h2i.toCanvas !== 'function') return finish(null);
        var x0 = Math.max(0, box.x - CROP_PAD);
        var y0 = Math.max(0, box.y - CROP_PAD);
        var x1 = Math.min(window.innerWidth, box.x + box.w + CROP_PAD);
        var y1 = Math.min(window.innerHeight, box.y + box.h + CROP_PAD);
        var w = round(x1 - x0), h = round(y1 - y0);
        if (w <= 0 || h <= 0) return finish(null);
        // Render the smallest common ancestor of the region rather than the body — same reason as
        // above, and on most pages that is a section, not the whole document.
        var host = commonAncestorIn(box) || document.body;
        var hostRect = host.getBoundingClientRect();
        var bg = getComputedStyle(document.body).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = undefined;
        capturing++;
        h2i.toCanvas(host, { pixelRatio: 1, backgroundColor: bg, cacheBust: false, filter: function (n) { return !(n && n.nodeType === 1 && n.hasAttribute(ATTR)); } })
          .then(function (canvas) {
            if (done) return;
            try {
              var out = document.createElement('canvas');
              out.width = w; out.height = h;
              var ctx = out.getContext('2d');
              ctx.drawImage(canvas, x0 - hostRect.left, y0 - hostRect.top, w, h, 0, 0, w, h);
              finish(out.toDataURL('image/png'));
            } catch (e) { finish(null); }
          }, function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }

  // The deepest element that contains the whole box — the region's natural backdrop.
  function commonAncestorIn(box) {
    var a = targetAt(box.x + 1, box.y + 1);
    var b = targetAt(box.x + box.w - 1, box.y + box.h - 1);
    var node = a || b;
    if (!node) return null;
    while (node && node !== document.body) {
      var r = node.getBoundingClientRect();
      if (r.left <= box.x && r.top <= box.y && r.right >= box.x + box.w && r.bottom >= box.y + box.h) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  // ── picking: highlight + capture listeners, NOT a blocking overlay ────────────────────────────
  //
  // > 🐛 v1 armed a full-viewport `position:fixed` overlay that swallowed every pointer event. It
  // worked for picking and broke everything else in the app: a wheel over a modal, a sidebar or any
  // `overflow:auto` panel chained to the ROOT scroller instead (measured: inner 0 / window 150),
  // and `:hover` never fired, so hover-revealed menus, tooltips and row actions could not be made
  // to appear — an entire class of UI was un-commentable. Since Comment mode is the default, that
  // was the app's normal state, and it is most of what "buggy as hell" meant.
  //
  // Now nothing blocks the page. The highlight is `pointer-events:none`, and picking listens on the
  // document in the CAPTURE phase: hover and scroll behave exactly as they do without the script,
  // and only the click itself is intercepted (`preventDefault` + `stopPropagation` before the app's
  // own handlers see it). The cursor becomes a crosshair through a stylesheet rather than a layer.
  var cursorStyle = null;
  function setCursor(on) {
    if (on && !cursorStyle) {
      cursorStyle = el('style', '');
      cursorStyle.textContent = '*{cursor:crosshair !important;}';
      document.documentElement.appendChild(cursorStyle);
    } else if (!on && cursorStyle) { remove(cursorStyle); cursorStyle = null; }
  }
  // The rubber band DOES need a blocker — a drag selection over live content would select text and
  // start native drags — but only while `rect` is armed, which is a deliberate, momentary mode.
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = el('div', 'position:fixed;inset:0;z-index:' + Z_OVERLAY + ';cursor:crosshair;background:transparent;user-select:none;-webkit-user-select:none;');
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mousedown', onDown);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.documentElement.appendChild(overlay);
    return overlay;
  }
  function ensureHighlight() {
    if (highlight) return highlight;
    highlight = el('div', 'position:fixed;pointer-events:none;z-index:' + Z_OVERLAY + ';outline:2px solid ' + COLOR + ';outline-offset:-1px;background:' + FILL + ';border-radius:2px;display:none;');
    document.documentElement.appendChild(highlight);
    return highlight;
  }
  function placeHighlight(node) {
    var h = ensureHighlight();
    if (!node) { h.style.display = 'none'; return; }
    var b = node.getBoundingClientRect();
    h.style.display = 'block';
    h.style.left = b.left + 'px'; h.style.top = b.top + 'px';
    h.style.width = b.width + 'px'; h.style.height = b.height + 'px';
  }
  function ensureRubber() {
    if (rubber) return rubber;
    rubber = el('div', 'position:fixed;pointer-events:none;z-index:' + Z_OVERLAY + ';border:1px dashed ' + COLOR + ';background:' + FILL + ';display:none;');
    document.documentElement.appendChild(rubber);
    return rubber;
  }
  function placeRubber(box) {
    var r = ensureRubber();
    if (!box) { r.style.display = 'none'; return; }
    r.style.display = 'block';
    r.style.left = box.x + 'px'; r.style.top = box.y + 'px';
    r.style.width = box.w + 'px'; r.style.height = box.h + 'px';
  }
  function remove(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  var docListening = false;
  function listenDoc(on) {
    if (on === docListening) return;
    docListening = on;
    var m = on ? 'addEventListener' : 'removeEventListener';
    document[m]('mousemove', onMove, true);
    document[m]('click', onClick, true);
    document[m]('mousedown', onSwallow, true);
    document[m]('mouseup', onSwallow, true);
  }
  // Swallow the press/release that belong to an intercepted click, so the app never starts a drag,
  // opens a menu or focuses a field from the click that was meant for us.
  var onSwallow = safe(function (e) {
    if (tool !== 'pin' || e.button !== 0) return;
    if (isOurs(e.target)) return;
    e.preventDefault(); e.stopPropagation();
  });

  function disarm() {
    tool = null;
    drag = null;
    hovered = null;
    listenDoc(false);
    setCursor(false);
    remove(overlay); overlay = null;
    remove(highlight); highlight = null;
    remove(rubber); rubber = null;
  }
  function arm(next) {
    disarm();
    if (next !== 'pin' && next !== 'rect') return;
    tool = next;
    if (tool === 'rect') { ensureOverlay(); return; }
    ensureHighlight();
    setCursor(true);
    listenDoc(true);
  }

  // ── pointer handling ──────────────────────────────────────────────────────────────────────────
  var hovered = null;
  var mouse = null;
  var moveFrame = 0;
  var drag = null;

  function normBox(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: round(x), y: round(y), w: round(Math.abs(a.x - b.x)), h: round(Math.abs(a.y - b.y)) };
  }

  var onMove = safe(function (e) {
    mouse = { x: e.clientX, y: e.clientY };
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(safe(function () {
      moveFrame = 0;
      if (!mouse || !tool) return;
      if (tool === 'rect') {
        if (drag) placeRubber(normBox(drag, mouse));
        return;
      }
      if (markerAt(mouse.x, mouse.y)) { placeHighlight(null); return; }
      var node = targetAt(mouse.x, mouse.y);
      placeHighlight(node);
      if (node !== hovered) {
        hovered = node;
        post({ t: 'hover', el: node ? infoOf(node) : null });
      }
    }));
  });

  var onDown = safe(function (e) {
    if (tool !== 'rect' || e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY };
    placeRubber({ x: drag.x, y: drag.y, w: 0, h: 0 });
  });

  // On the window, not the overlay: a drag released past the iframe edge never delivers mouseup to
  // the overlay, and a stuck drag would swallow the next click.
  window.addEventListener('mouseup', safe(function (e) {
    if (tool !== 'rect' || !drag) return;
    var box = normBox(drag, { x: e.clientX, y: e.clientY });
    drag = null;
    placeRubber(null);
    if (box.w < 4 || box.h < 4) return;
    var reqId = rid();
    var els = elementsIn(box);
    // The pin lands NOW; the picture catches up. Waiting on the render was up to 6s of nothing
    // happening after a click, which read as the feature being broken.
    post({ t: 'region', reqId: reqId, box: box, els: els, crop: null });
    cropRegion(box).then(function (png) { if (png) post({ t: 'cropped', reqId: reqId, crop: png }); });
  }), true);

  var onClick = safe(function (e) {
    if (tool !== 'pin' && tool !== 'rect') return;
    if (isOurs(e.target)) return;          // our own marker badge handles itself
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    // Clicking an existing marker reopens its note rather than dropping a new pin on top of it.
    var mk = markerAt(e.clientX, e.clientY);
    if (mk) { post({ t: 'marker', n: mk }); return; }
    if (tool !== 'pin') return;
    // composedPath()[0] rather than the event target: inside a web component the target is
    // retargeted to the HOST, which reports the whole widget as one un-pickable blob.
    var node = (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
    if (!node || node.nodeType !== 1 || isOurs(node)) node = targetAt(e.clientX, e.clientY);
    if (!node) return;
    var info = infoOf(node);
    var reqId = rid();
    post({ t: 'picked', reqId: reqId, el: info, crop: null });
    crop(node).then(function (png) { if (png) post({ t: 'cropped', reqId: reqId, crop: png }); });
  });

  // Everything at least half inside the box, biggest first so the containers name the region and the
  // leaves fill in the detail. Bare wrappers that add nothing over their parent are dropped so a
  // region does not read as the same card six times.
  function elementsIn(box) {
    var bx1 = box.x + box.w, by1 = box.y + box.h;
    var all = document.body.querySelectorAll('*');
    var cands = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var ln = n.localName;
      if (ln === 'script' || ln === 'style' || ln === 'noscript' || ln === 'link' || ln === 'meta' || ln === 'nextjs-portal') continue;
      if (isOurs(n)) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var ix = Math.max(0, Math.min(r.right, bx1) - Math.max(r.left, box.x));
      var iy = Math.max(0, Math.min(r.bottom, by1) - Math.max(r.top, box.y));
      var area = r.width * r.height;
      if (ix * iy < area * 0.5) continue;
      var hasComp = !!fiberOf(n);
      var hasText = !!(n.textContent && n.textContent.trim());
      if (!hasComp && !hasText) continue;
      cands.push({ node: n, area: area });
    }
    cands.sort(function (a, b) { return b.area - a.area; });
    var kept = [], seen = {}, byNode = [];
    for (var j = 0; j < cands.length && kept.length < 12; j++) {
      var node = cands[j].node;
      var info = infoOf(node);
      if (!info.components.length && !info.text) continue;
      if (seen[info.selector]) continue;
      var parent = node.parentElement;
      var dup = false;
      for (var k = 0; k < byNode.length; k++) {
        if (byNode[k].node === parent && byNode[k].info.text === info.text && byNode[k].info.components.join('>') === info.components.join('>')) { dup = true; break; }
      }
      if (dup) { byNode.push({ node: node, info: info }); continue; }
      seen[info.selector] = true;
      kept.push(info);
      byNode.push({ node: node, info: info });
    }
    return kept;
  }

  // Hotkeys reach whichever document has focus, and after any click in the app that is THIS one, not
  // the wrapper. So the wrapper's shortcuts are mirrored here and forwarded as `key` — but only when
  // nothing editable has focus and no modifier is held, so typing "p" in the app's own search box
  // never arms a tool. Escape additionally disarms locally, so an armed overlay can always be escaped
  // even if the wrapper is slow to answer.
  function isAbort(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    return /abort/i.test(String(err.message || err));
  }

  // Shadow-aware: `document.activeElement` is the HOST for shadow content, so typing into an input
  // inside a web component read as "not typing" and relayed p/r/m/n to the wrapper as hotkeys while
  // the characters also went into the field.
  function typing() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }
  window.addEventListener('keydown', safe(function (e) {
    if (e.key === 'Escape') {
      if (tool) { disarm(); post({ t: 'hover', el: null }); }
      post({ t: 'key', key: 'Escape' });
      return;
    }
    if (typing() || e.altKey) return;
    var k = e.key.toLowerCase();
    // Relayed, never prevented: the app may bind ⌘↩ itself (a composer, a search box), and taking
    // the key away from it for the whole time a preview is open is not ours to do.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { post({ t: 'key', key: 'Send' }); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (k === 'p' || k === 'r' || k === 'm' || k === 'n') post({ t: 'key', key: k });
  }), true);

  // ── anchoring ─────────────────────────────────────────────────────────────────────────────────
  function resolve(selector) {
    try {
      var node = document.querySelector(selector);
      if (!node) return null;
      var b = boxOf(node);
      // A hidden element (closed tab, collapsed accordion, unopened modal) reports 0×0 at (0,0).
      // Treated as a real box, its marker parked at the top-left corner of the page forever, and
      // several of them stacked there invisibly. Not visible is not located.
      if (b.w < 1 && b.h < 1) return null;
      return b;
    } catch (e) { return null; }
  }
  function anchor(selectors) {
    var boxes = {};
    for (var i = 0; i < selectors.length; i++) boxes[selectors[i]] = resolve(selectors[i]);
    post({ t: 'anchored', boxes: boxes });
  }

  // ── markers ───────────────────────────────────────────────────────────────────────────────────
  // > 🐛 Two bugs lived here. (1) The layer was torn down and rebuilt on EVERY push — and the
  // wrapper pushes on every anchored reply, i.e. ~8× per second of scrolling — so badges were
  // destroyed under the cursor and a click that started on one finished on a detached node: "the
  // number sometimes does nothing". (2) A rect pin's document coordinates were recomputed from the
  // CURRENT scroll on every push, while its viewport box was frozen at pin time, so a rectangle's
  // number re-based itself every frame and slid away from the content it marked.
  //
  // Now the layer is diffed by number, and a rect pin's doc coords are computed ONCE, when that
  // number is first seen.
  function setMarkers(list) {
    var byN = {};
    for (var k = 0; k < markers.length; k++) byN[markers[k].n] = markers[k];
    if (!markerLayer) {
      markerLayer = el('div', 'position:fixed;inset:0;pointer-events:none;z-index:' + Z_MARKERS + ';');
      document.documentElement.appendChild(markerLayer);
    }
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var prev = byN[m.n];
      var open = m.state === 'open';
      var rec = prev || { n: m.n };
      rec.selector = m.selector || null;
      rec.state = m.state;
      // Frozen on first sight — the box in the message is in the viewport of the moment it was
      // pinned, so today's scroll is the only scroll that can convert it.
      if (!rec.doc) rec.doc = m.box ? { x: m.box.x + window.scrollX, y: m.box.y + window.scrollY, w: m.box.w, h: m.box.h } : null;
      if (!rec.badge) {
        rec.badge = el('div', 'position:fixed;width:22px;height:22px;border-radius:11px;color:#fff;font:bold 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer;display:none;');
        rec.badge.textContent = String(m.n);
        rec.badge.setAttribute('data-minami-marker', String(m.n));
        rec.badge.addEventListener('click', markerClick(m.n));
        markerLayer.appendChild(rec.badge);
      }
      rec.badge.style.background = open ? COLOR : '#666';
      if (open && !rec.frame) {
        rec.frame = el('div', 'position:fixed;pointer-events:none;outline:1px dashed ' + COLOR + ';display:none;');
        markerLayer.appendChild(rec.frame);
      } else if (!open && rec.frame) { remove(rec.frame); rec.frame = null; }
      delete byN[m.n];
      next.push(rec);
    }
    for (var gone in byN) { if (Object.prototype.hasOwnProperty.call(byN, gone)) { remove(byN[gone].badge); remove(byN[gone].frame); } }
    markers = next;
    if (!markers.length) { remove(markerLayer); markerLayer = null; return; }
    placeMarkers();
  }
  function markerClick(n) {
    return safe(function (e) { e.preventDefault(); e.stopPropagation(); post({ t: 'marker', n: n }); });
  }
  // A marker under the armed overlay: the overlay is above it, so hit-test through the stack.
  function markerAt(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var n = stack[i].getAttribute && stack[i].getAttribute('data-minami-marker');
      if (n) return parseInt(n, 10);
    }
    return 0;
  }
  function placeMarkers() {
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var b = m.selector ? resolve(m.selector) : null;
      if (!b && m.doc) b = { x: m.doc.x - window.scrollX, y: m.doc.y - window.scrollY, w: m.doc.w, h: m.doc.h };
      if (!b) { m.badge.style.display = 'none'; if (m.frame) m.frame.style.display = 'none'; continue; }
      m.badge.style.display = 'block';
      m.badge.style.left = (b.x - 11) + 'px';
      m.badge.style.top = (b.y - 11) + 'px';
      if (m.frame) {
        m.frame.style.display = 'block';
        m.frame.style.left = b.x + 'px'; m.frame.style.top = b.y + 'px';
        m.frame.style.width = b.w + 'px'; m.frame.style.height = b.h + 'px';
      }
    }
  }

  // ── viewport ──────────────────────────────────────────────────────────────────────────────────
  var viewFrame = 0;
  // Capture phase so inner scroll containers count too: the window's own offset may not change while
  // every pinned element moves.
  var onViewport = safe(function () {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(safe(function () {
      viewFrame = 0;
      if (markers.length) placeMarkers();
      if (hovered && tool === 'pin') placeHighlight(hovered);
      post({ t: 'viewport', scroll: { x: window.scrollX, y: window.scrollY }, size: { w: window.innerWidth, h: window.innerHeight } });
    }));
  });
  window.addEventListener('scroll', onViewport, { passive: true, capture: true });
  window.addEventListener('resize', onViewport, { passive: true });

  // ── errors ────────────────────────────────────────────────────────────────────────────────────
  var errorTimer = 0;
  function pushError(kind, message, frame) {
    if (capturing) return;
    message = String(message || '').replace(/\s+/g, ' ').trim();
    if (!message) return;
    var entry = { ts: Date.now(), kind: kind, message: message.slice(0, 1000) };
    if (frame) entry.frame = frame;
    errors.push(entry);
    if (errors.length > ERROR_CAP) errors.splice(0, errors.length - ERROR_CAP);
    // Coalesced: a render loop can fire hundreds of console.errors a second and the wrapper only
    // needs the buffer, not every tick of it.
    if (!errorTimer) errorTimer = setTimeout(safe(function () { errorTimer = 0; post({ t: 'errors', errors: errors.slice() }); }), 250);
  }
  // `/_next/static/chunks/app/page.js:42:10` or `./components/Card.tsx:42:15` — the origin and the
  // webpack layer prefix say nothing Claude can grep for, and Vite's `?t=` cache-buster changes every save.
  function shortUrl(u) {
    return String(u).replace(/^https?:\/\/[^/]+/, '').replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '').replace(/\?[^:)\s]*/, '');
  }
  // First frame that points at a source file, skipping the framework's own bundles. Handles V8's
  // `at fn (loc)` and WebKit's `fn@loc`; the location is the last token so parentheses inside a
  // webpack-internal path do not matter.
  function frameOf(stack) {
    if (!stack) return undefined;
    var lines = String(stack).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim().replace(/^at\s+/, '').replace(/^async\s+/, '');
      if (!l || !/\.[a-z]+(\?[^:\s]*)?:\d+/.test(l)) continue;
      var last = l.split(/\s+/).pop();
      var fn = l.slice(0, l.length - last.length).replace(/[\s(]+$/, '');
      var tok = last.replace(/^\(/, '').replace(/\)$/, '');
      var at = tok.indexOf('@');
      if (at > 0 && tok.slice(0, at).indexOf('/') === -1) { fn = fn || tok.slice(0, at); tok = tok.slice(at + 1); }
      var loc = shortUrl(tok);
      if (i < lines.length - 1 && /(^|\/)(node_modules\/|_next\/static\/chunks\/(webpack|main|polyfills|framework|react-refresh))/.test(loc)) continue;
      return fn && fn !== '<anonymous>' ? fn + ' (' + loc + ')' : loc;
    }
    return undefined;
  }
  function argText(a) {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error || (typeof a === 'object' && typeof a.message === 'string')) return (a.name && a.name !== 'Error' ? a.name + ': ' : '') + a.message;
    try { return typeof a === 'object' ? JSON.stringify(a).slice(0, 300) : String(a); } catch (e) { return String(a); }
  }

  // > 🐛 `console.error` used to be patched so the badge could count logged errors. Two costs, both
  // paid by the app rather than by us, and the snippet is meant to live in the dev layout forever:
  //
  //   1. DevTools attributed EVERY console.error in the app to inspect-core.js:606 — the real call
  //      site vanished from the console's location column and clicking an error opened our script.
  //      That breaks ordinary debugging for everything except preview comments.
  //   2. React's dev warnings go through console.error. Hydration notes, `key` warnings, act()
  //      warnings and every library's deprecation notice were counted as "errors since last send"
  //      and offered to Claude to "find the cause and fix it".
  //
  // Nothing is patched now. A real uncaught error still arrives via `error`/`unhandledrejection`, a
  // failed request via the fetch/XHR hooks, and a render crash via the Next.js overlay watcher —
  // which is the set that was ever worth sending.

  window.addEventListener('error', safe(function (e) {
    var frame = (e.error && frameOf(e.error.stack)) || (e.filename ? shortUrl(e.filename) + ':' + e.lineno + (e.colno ? ':' + e.colno : '') : undefined);
    pushError('error', e.message || argText(e.error), frame);
  }));
  window.addEventListener('unhandledrejection', safe(function (e) {
    var r = e.reason;
    pushError('rejection', argText(r), r && r.stack ? frameOf(r.stack) : undefined);
  }));

  // Dev-server traffic (HMR pings, RSC prefetches, the overlay's own source lookups) fails routinely
  // and says nothing about the app.
  function isDevTraffic(url) { return /\/_next\/|__nextjs|\/@vite|\/@react-refresh|sockjs-node/.test(String(url)); }
  function methodOf(input, init) {
    return ((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
  }
  function urlOf(input) {
    return typeof input === 'string' ? input : (input && input.url) || String(input);
  }
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var method, url;
      try { method = methodOf(input, init); url = urlOf(input); } catch (e) { method = 'GET'; url = ''; }
      var p = origFetch.apply(this, arguments);
      try {
        if (!isDevTraffic(url)) {
          p.then(function (res) {
            if (res && res.status >= 400) pushError('network', method + ' ' + shortUrl(url) + ' → ' + res.status);
          }, function (err) {
            // An aborted request is a component unmounting, not a fault: React Query, SWR and the
            // App Router cancel constantly, and each one used to land in the badge as a failure.
            if (!isAbort(err)) pushError('network', method + ' ' + shortUrl(url) + ' → ' + argText(err));
          });
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
    var XP = XMLHttpRequest.prototype;
    var origOpen = XP.open, origSend = XP.send;
    XP.open = function (method, url) {
      try { this.__minamiReq = { method: String(method || 'GET').toUpperCase(), url: String(url || '') }; } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XP.send = function () {
      try {
        var req = this.__minamiReq;
        if (req && !isDevTraffic(req.url)) {
          this.addEventListener('load', safe(function () {
            if (this.status >= 400) pushError('network', req.method + ' ' + shortUrl(req.url) + ' → ' + this.status);
          }));
          this.addEventListener('error', safe(function () {
            pushError('network', req.method + ' ' + shortUrl(req.url) + ' → network error');
          }));
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // The Next.js overlay is the one error the developer definitely saw; lift its text as it appeared
  // rather than the console echo, which loses the code frame. Once per appearance, keyed on message.
  var lastOverlay = null;
  function firstText(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var nodes;
      try { nodes = root.querySelectorAll(selectors[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var t = (nodes[j].textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }
    return '';
  }
  var pollOverlay = safe(function () {
    var portal = document.querySelector('nextjs-portal');
    var root = portal && portal.shadowRoot;
    if (!root) { lastOverlay = null; return; }
    var body = root.querySelector('[data-nextjs-dialog-body]') || root.querySelector('[data-nextjs-dialog]') || root.querySelector('[role="dialog"]');
    if (!body) { lastOverlay = null; return; }
    var message = firstText(body, ['.nextjs__container_errors_desc', '[data-nextjs-dialog-body] > p', 'p', 'h1', 'h2', '[class*="error"]', 'pre']);
    if (!message) { lastOverlay = null; return; }
    if (message === lastOverlay) return;
    lastOverlay = message;
    var frame = firstText(body, ['[data-nextjs-call-stack-frame]', '[data-nextjs-codeframe] > div', '[data-nextjs-codeframe] p', '[data-nextjs-codeframe]']);
    var label = firstText(body, ['[data-nextjs-dialog-header] h1', 'h1', '[data-nextjs-dialog-header]']);
    pushError('overlay', (label && label !== message ? label + ': ' : '') + message, frame ? frame.split(' at ')[0].slice(0, 200) : undefined);
  });

  // ── inbound ───────────────────────────────────────────────────────────────────────────────────
  window.addEventListener('message', safe(function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || d.tag !== TAG) return;
    if (d.t === 'connect') {
      if (!dashboardOrigin) {
        if (!isLoopbackOrigin(e.origin)) return;
        dashboardOrigin = e.origin;
        if (errors.length) post({ t: 'errors', errors: errors.slice() });
      }
      return;
    }
    // Only the pinned origin may drive the page; anything else that knows the tag is ignored.
    if (!dashboardOrigin || e.origin !== dashboardOrigin) return;
    switch (d.t) {
      case 'arm': arm(d.tool); break;
      case 'anchor': anchor(Array.isArray(d.selectors) ? d.selectors : []); break;
      case 'markers': setMarkers(Array.isArray(d.markers) ? d.markers : []); break;
      case 'clearErrors': errors = []; break;
      // The wrapper asking "are you there?" after an iframe load — our own hello fired at parse
      // time, possibly long before, so a fresh one is the only proof that survives the gap.
      case 'ping': hello(true); break;
    }
  }));

  // ── navigation ────────────────────────────────────────────────────────────────────────────────
  // App Router soft navigations fire no popstate; polling the href (and watching <title>, which the
  // router updates on every segment change) is how they surface without patching history.pushState.
  sayHello();
  window.addEventListener('load', safe(function () { if (!dashboardOrigin) hello(true); }));
  // Forced only on a bfcache restore — on a normal load `pageshow` follows `load` and would be a
  // third identical hello.
  window.addEventListener('pageshow', safe(function (e) { hello(!!(e && e.persisted)); }));
  window.addEventListener('popstate', helloIfChanged);
  window.addEventListener('hashchange', helloIfChanged);
  setInterval(helloIfChanged, 500);
  setInterval(pollOverlay, 1000);
  try {
    // <head>, not <title>: the router may swap the title node rather than edit it.
    if (document.head && window.MutationObserver) {
      new MutationObserver(helloIfChanged).observe(document.head, { childList: true, subtree: true, characterData: true });
    }
  } catch (e) { /* no observer, the poll covers it */ }
})();
