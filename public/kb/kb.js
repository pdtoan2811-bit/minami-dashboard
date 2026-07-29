/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   Minami Bento — knowledge base shared runtime.

   Everything every KB page needs: SVG drawing helpers, the sticky rail + scroll-spy, the theme
   toggle, and a step-theatre driver. Page-specific diagram code goes in the page, and calls into
   `KB.*` for the primitives.

   Zero dependencies. ES5-flavoured on purpose so a page opened straight off disk in any browser
   works without a transpile step.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
window.KB = (function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;

  /* CSS custom properties do NOT resolve in SVG *presentation attributes* — `fill="var(--disk)"`
     silently paints black. They must be set as CSS properties on the node instead. Every helper
     below routes through el(), which detects a var() string and does the right thing. This is the
     single most important trick in the whole stack; don't "simplify" it away. */
  function el(t, a) {
    var n = document.createElementNS(SVGNS, t);
    for (var k in a) {
      var v = a[k];
      if (typeof v === "string" && v.indexOf("var(") > -1) n.style.setProperty(k, v);
      else n.setAttribute(k, v);
    }
    return n;
  }
  function txt(x, y, s, o) {
    o = o || {};
    var n = el("text", {
      x: x, y: y, fill: o.fill || "var(--text)",
      "font-family": o.sans ? "var(--body)" : "var(--mono)",
      "font-size": o.size || 12, "text-anchor": o.anchor || "start",
      "font-weight": o.weight || 400, "letter-spacing": o.ls || 0,
    });
    n.textContent = s;
    return n;
  }
  function rr(x, y, w, h, r, a) {
    var o = { x: x, y: y, width: w, height: h, rx: r };
    for (var k in a) o[k] = a[k];
    return el("rect", o);
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  /* A box with a coloured left flag, a title and a subtitle — the atom of nearly every diagram. */
  function box(svg, o) {
    svg.appendChild(rr(o.x, o.y, o.w, o.h, 9, {
      fill: o.fill || "var(--surface)", stroke: o.stroke || "var(--rule)",
      "stroke-width": o.sw || 1, "stroke-dasharray": o.dash || "none",
    }));
    if (o.c) svg.appendChild(rr(o.x, o.y, 4, o.h, 2, { fill: "var(--" + o.c + ")" }));
    if (o.t) svg.appendChild(txt(o.x + 16, o.y + (o.s ? 24 : o.h / 2 + 4), o.t, { size: 12.5, weight: 600 }));
    if (o.s) svg.appendChild(txt(o.x + 16, o.y + 42, o.s, { size: 10.5, fill: "var(--text3)" }));
  }

  function head(svg, x1, y1, x2, y2, c) {
    var a = Math.atan2(y2 - y1, x2 - x1);
    svg.appendChild(el("path", {
      d: "M" + x2 + "," + y2 +
         " L" + (x2 - 7 * Math.cos(a - 0.42)) + "," + (y2 - 7 * Math.sin(a - 0.42)) +
         " L" + (x2 - 7 * Math.cos(a + 0.42)) + "," + (y2 - 7 * Math.sin(a + 0.42)) + " Z",
      fill: c || "var(--rule)",
    }));
  }
  function arrow(svg, x1, y1, x2, y2, c) {
    svg.appendChild(el("path", { d: "M" + x1 + "," + y1 + " L" + x2 + "," + y2, fill: "none",
      stroke: c || "var(--rule)", "stroke-width": 1.5 }));
    head(svg, x1, y1, x2, y2, c);
  }

  /* Clip an edge to a box's RECTANGLE border. A fixed radial pad is wrong in both directions: it
     starts the line inside a wide box, and leaves a floating stub on a tall one. */
  function clipBox(cx, cy, hw, hh, ux, uy, gap) {
    var tx = ux !== 0 ? hw / Math.abs(ux) : Infinity;
    var ty = uy !== 0 ? hh / Math.abs(uy) : Infinity;
    var t = Math.min(tx, ty) + (gap || 0);
    return [cx + ux * t, cy + uy * t];
  }

  /* Direction-aware S-curve between two box edges; a straight drop when they share a column. */
  function sPath(a, b, W, H) {
    if (a.x === b.x) { var x = a.x + W / 2; return "M" + x + "," + (a.y + H) + " L" + x + "," + b.y; }
    var right = b.x > a.x, x1 = right ? a.x + W : a.x, x2 = right ? b.x : b.x + W;
    var y1 = a.y + H / 2, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    return "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
  }

  /* Packets travelling along every edge. Returns stop(). Honours reduced-motion by not starting. */
  function playFlow(svg, edges, pathFor, colorFor, ms) {
    var t0 = null, anim = null;
    var pk = edges.map(function (e, i) {
      var p = el("path", { d: pathFor(e), fill: "none", stroke: "none" }); svg.appendChild(p);
      var c = el("circle", { r: 3.6, fill: colorFor(e), "class": "pkt" }); svg.appendChild(c);
      return { p: p, c: c, off: i * 0.12 };
    });
    function frame(ts) {
      if (!t0) t0 = ts;
      var e = (ts - t0) / (ms || 2600);
      pk.forEach(function (k) {
        var u = (e - k.off) % 1; if (u < 0) u += 1;
        var L = k.p.getTotalLength(), pt = k.p.getPointAtLength(u * L);
        k.c.setAttribute("cx", pt.x); k.c.setAttribute("cy", pt.y);
        k.c.setAttribute("opacity", u < 0.06 || u > 0.94 ? 0 : 0.95);
      });
      anim = requestAnimationFrame(frame);
    }
    if (!reduce) anim = requestAnimationFrame(frame);
    return function stop() {
      if (anim) cancelAnimationFrame(anim);
      Array.prototype.forEach.call(svg.querySelectorAll(".pkt"), function (p) { p.remove(); });
    };
  }

  /* Step theatre — the highest-value device in the stack. Wire prev/next/dots/narration once.
     opts: {prev,next,label,dots,narr} element ids, `steps` (narration HTML array), `draw(i)`. */
  function theatre(opts) {
    var i = 0, n = opts.steps.length;
    function render() {
      opts.draw(i);
      var lab = document.getElementById(opts.label);
      if (lab) lab.textContent = "step " + (i + 1) + " / " + n;
      var na = document.getElementById(opts.narr);
      if (na) na.innerHTML = opts.steps[i];
      var d = document.getElementById(opts.dots);
      if (d) {
        clear(d);
        for (var k = 0; k < n; k++) {
          var b = document.createElement("i");
          if (k === i) b.className = "on";
          d.appendChild(b);
        }
      }
    }
    var nx = document.getElementById(opts.next), pv = document.getElementById(opts.prev);
    if (nx) nx.onclick = function () { i = (i + 1) % n; render(); };
    if (pv) pv.onclick = function () { i = (i + n - 1) % n; render(); };
    render();
    return { go: function (k) { i = k % n; render(); } };
  }

  /* Sticky rail + scroll-spy. `items` = [id, label, colorToken][]. */
  function rail(items, hostId) {
    var host = document.getElementById(hostId || "rail");
    if (!host) return;
    items.forEach(function (it, i) {
      var li = document.createElement("li"), a = document.createElement("a");
      a.href = "#" + it[0]; a.id = "r-" + it[0];
      a.style.setProperty("--dot", "var(--" + it[2] + ")");
      a.innerHTML = '<span class="n">' + String(i + 1).padStart(2, "0") + "</span><span></span>";
      a.lastChild.textContent = it[1];
      li.appendChild(a); host.appendChild(li);
    });
    /* rootMargin shrinks the viewport to a thin band near the top — that band is what "current
       section" means. Far more stable than computing scroll offsets by hand. */
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var a = document.getElementById("r-" + e.target.id);
        if (a && e.isIntersecting) {
          Array.prototype.forEach.call(document.querySelectorAll(".rail a"), function (x) {
            x.classList.remove("on");
          });
          a.classList.add("on");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    items.forEach(function (it) {
      var s = document.getElementById(it[0]);
      if (s) io.observe(s);
    });
  }

  /* Theme. Light is the default (see kb.css) — the OS preference is deliberately NOT consulted, so
     the KB looks identical everywhere. Dark is opt-in and remembered across pages and sessions. */
  function theme(btnId) {
    var root = document.documentElement, KEY = "minami-kb-theme";
    function apply(t) { if (t === "dark") root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme"); }
    try { apply(localStorage.getItem(KEY)); } catch (e) { /* storage blocked on file:// */ }
    var b = document.getElementById(btnId || "themeBtn");
    if (!b) return;
    function label() { b.textContent = root.getAttribute("data-theme") === "dark" ? "☀" : "◐"; }
    label();
    b.onclick = function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next); label();
      try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
    };
  }

  /* The KB's page set, in reading order. One source of truth for the top nav — adding a page here
     puts it in the nav on every existing page automatically. `pending: true` renders it as a
     visible-but-unclickable placeholder rather than hiding it, so the shape of the set is always
     legible even while it's incomplete. */
  var PAGES = [
    { href: "./", label: "hub" },
    { href: "./architecture.html", label: "architecture" },
    { href: "./transcripts.html", label: "transcripts" },
    { href: "./live-sessions.html", label: "live sessions" },
    { href: "./metrics.html", label: "metrics", pending: true },
    { href: "./operations.html", label: "operations", pending: true },
  ];

  /* Render the shared top nav. `current` = the href of this page, for the active pill. */
  function nav(current) {
    var host = document.getElementById("topnav");
    if (!host) return;
    var inner = document.createElement("div");
    inner.className = "inner";

    var brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "./";
    brand.innerHTML = '<span class="m">🌸</span><span>Minami Bento KB</span>';
    inner.appendChild(brand);

    var links = document.createElement("div");
    links.className = "links";
    PAGES.forEach(function (p) {
      if (p.href === "./") return; // the brand mark already goes home
      var a = document.createElement("a");
      a.href = p.pending ? "#" : p.href;
      a.textContent = p.label;
      if (p.pending) { a.className = "pending"; a.title = "not written yet"; }
      else if (p.href === current) a.className = "on";
      links.appendChild(a);
    });
    inner.appendChild(links);

    var btn = document.createElement("button");
    btn.className = "themeBtn";
    btn.id = "themeBtn";
    btn.title = "Toggle theme";
    btn.setAttribute("aria-label", "Toggle theme");
    inner.appendChild(btn);

    host.appendChild(inner);
    theme("themeBtn");
  }

  return {
    NS: SVGNS, reduce: reduce,
    el: el, txt: txt, rr: rr, clear: clear, box: box,
    head: head, arrow: arrow, clipBox: clipBox, sPath: sPath,
    playFlow: playFlow, theatre: theatre, rail: rail, theme: theme,
    nav: nav, PAGES: PAGES,
  };
})();
