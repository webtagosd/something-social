// Live-canvas editor bridge. Shipped on every page, but entirely inert unless
// BOTH: the page is loaded with ?wt-edit=1 (or ?wt-preview=1) AND it is embedded
// in an iframe (window.self !== window.top). Normal visitors never pay for this
// beyond a tiny deferred, no-op script load.
//
// Changelog:
//   2026-09-12: wt-highlight / wt-focus / wt-outline, sections in wt-ready, preview-deploy origins.
//   2026-09-12i: a ring hides itself when its element is off screen or painted over, so a
//               pinned hero's background stops marking whatever scrolled on top of it.
//   2026-09-12h: focus mode un-pins sticky sections, so a hero stops sitting behind the rest
//               of the page while the client steps through it.
//   2026-09-12g: a sticky section (a pinned hero) is scrolled to by its layout position,
//               since a stuck element reports itself as already in view.
//   2026-09-12f: data-wt-attr="background" paints a CSS background-image, so band images
//               and empty photo slots are editable and clickable like any other picture.
//   2026-09-12e: wt-outline can scroll its element into view, so touching a field in the
//               dashboard brings that part of the page to the client.
//   2026-09-12d: rings follow the page while it scrolls; wt-inview reports the section on
//               screen; the highlighted section carries a name tag.
//   2026-09-12c: resolve the editable element by hit-testing descendants, so text inside a
//               clipping wrapper (a headline reveal mask) is still selectable.
//   2026-09-12b: rings drawn in an overlay layer (outlines were clipped by overflow:hidden
//               ancestors), full-viewport fixed overlays parked while editing, and every
//               link/button/form click neutralised so the canvas can't navigate away.
//
// Two modes:
//   ?wt-edit=1    full editing surface — hover outlines, click-to-select,
//                 wt-select messages, content/patch painting.
//   ?wt-preview=1 read-only draft preview (the dashboard's own-domain preview
//                 page) — paints wt-content/wt-patch same as edit mode, but no
//                 hover/click affordances and never posts wt-select.
//
// Message protocol (postMessage, JSON-serializable payloads only):
//   → parent  { type: "wt-ready",  keys: string[], sections: string[] }  on first paint; sections = distinct
//                                                          first segments of every data-wt key, DOM order
//   → parent  { type: "wt-select", key: string }           edit mode only — click of a [data-wt] element
//   → parent  { type: "wt-navigate", path: string }        edit mode only — click of an internal link;
//                                                          the dashboard switches its page state and
//                                                          re-points the iframe (keeps wt-edit intact)
//   ← parent  { type: "wt-content", content: object }      paint the dashboard's full draft over the page
//   ← parent  { type: "wt-patch",  key: string, value: any } live-patch a single key
//   ← parent  { type: "wt-highlight", prefix: string | null } outline + scroll to the section owning
//                                                          the first key matching prefix; null clears
//   ← parent  { type: "wt-focus", prefix: string | null }  dim every other section (no scroll); null clears
//   ← parent  { type: "wt-outline", key: string | null, scroll?: boolean }  ring every [data-wt=key]
//                                                        element, optionally scrolling it into view; null clears
//   → parent  { type: "wt-select", key, sectionKey }   sectionKey is a key from the surrounding
//                                                        section, so the dashboard can stay on this page
//   → parent  { type: "wt-inview", key: string }         a section scrolled into view, carrying one of
//                                                        its keys so the dashboard can resolve it
//
// Allowed origins — the dashboard(s) permitted to talk to this bridge, both
// directions. Add future custom domains here as they come online. Vercel
// preview deploys of the dashboard are matched by PREVIEW_ORIGIN.
const ALLOWED_ORIGINS = [
  "https://webtag-live.vercel.app", // production dashboard
  "http://localhost:3020", // local dashboard dev
  "http://localhost:3000", // local dashboard dev (alt port)
];
const PREVIEW_ORIGIN = /^https:\/\/webtag-live(-[a-z0-9-]+)?(-webtagosd)?\.vercel\.app$/;
const isAllowedOrigin = (origin: string) => ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin);

(function initEditorBridge() {
  let mode: "edit" | "preview" | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const iframed = window.self !== window.top;
    if (iframed && params.get("wt-edit") === "1") mode = "edit";
    else if (iframed && params.get("wt-preview") === "1") mode = "preview";
  } catch {
    mode = null;
  }
  if (!mode) return;
  const editable = mode === "edit";
  // Support marker: `document.documentElement.dataset.wtMode` says which mode the bridge armed.
  document.documentElement.setAttribute("data-wt-mode", mode);

  // Origin that sent us the first valid inbound message. Until then, replies
  // fan out to every allowed origin (harmless — postMessage with an explicit
  // targetOrigin only delivers if it matches the actual recipient's origin).
  // Preview-deploy origins can't be fanned out to (regex), so they're only
  // reached once they've messaged us first.
  let activeOrigin: string | null = null;

  const post = (msg: unknown) => {
    const targets = activeOrigin ? [activeOrigin] : ALLOWED_ORIGINS;
    for (const origin of targets) {
      try {
        window.parent.postMessage(msg, origin);
      } catch {
        // never throw into the page
      }
    }
  };

  // Resolve a dot-path (with numeric indices, e.g. "services.list.0.name")
  // against a plain object/array tree.
  const resolvePath = (obj: unknown, path: string): unknown => {
    let cur: unknown = obj;
    for (const segment of path.split(".")) {
      if (cur == null) return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
  };

  const applyValue = (el: Element, value: unknown) => {
    const attr = el.getAttribute("data-wt-attr");
    const str = value == null ? "" : String(value);
    if (attr === "background") {
      // A picture painted as a CSS background: a parallax band, or the placeholder shown
      // where a person has no photo yet. Clearing it puts the placeholder back.
      (el as HTMLElement).style.backgroundImage = str ? `url("${str.replace(/"/g, '\\"')}")` : "";
      if (str) {
        (el as HTMLElement).style.backgroundSize = (el as HTMLElement).style.backgroundSize || "cover";
        (el as HTMLElement).style.backgroundPosition = (el as HTMLElement).style.backgroundPosition || "center";
      }
      return;
    }
    if (attr) {
      // Never clobber an attribute with an empty value — an unset image/link in the
      // draft means "keep what the build shipped", not src=""/href="" (broken image).
      if (str === "") return;
      el.setAttribute(attr, str);
      // Astro's <Image> emits srcset+sizes, and browsers prefer srcset over a patched
      // src — strip them so the swapped image actually shows in the canvas.
      if (attr === "src" && (el.tagName === "IMG" || el.tagName === "SOURCE")) {
        el.removeAttribute("srcset");
        el.removeAttribute("sizes");
      }
    } else {
      el.textContent = str;
    }
  };

  const allWtElements = (): Element[] => Array.from(document.querySelectorAll("[data-wt]"));
  const cssEscape = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s);

  const applyContent = (content: unknown) => {
    for (const el of allWtElements()) {
      const key = el.getAttribute("data-wt");
      if (!key) continue;
      const value = resolvePath(content, key);
      if (value === undefined) continue; // don't clobber with missing data
      applyValue(el, value);
    }
  };

  const applyPatch = (key: string, value: unknown) => {
    document.querySelectorAll(`[data-wt="${cssEscape(key)}"]`).forEach((el) => applyValue(el, value));
  };

  // --- Section highlight / focus / outline (dashboard → site) ---------------

  // The section that "owns" a schema group: closest sectioning ancestor of the
  // first element whose key is `prefix` or lives under `prefix.`.
  const sectionFor = (prefix: string): HTMLElement | null => {
    const el = allWtElements().find((e) => {
      const key = e.getAttribute("data-wt") || "";
      return key === prefix || key.startsWith(prefix + ".");
    });
    if (!el) return null;
    return (el.closest("section, header, footer, main > *, [data-wt-section]") ?? el) as HTMLElement;
  };

  const clearClass = (cls: string) => {
    document.querySelectorAll("." + cls).forEach((el) => el.classList.remove(cls));
  };

  const highlight = (prefix: string | null, name?: string, scroll = true) => {
    const target = prefix === null ? null : sectionFor(prefix);
    if (prefix !== null && !target) return; // unknown prefix — leave the page alone
    // Undo the inline position we set for a previous highlight before clearing it.
    document.querySelectorAll<HTMLElement>(".wt-section-on[data-wt-pos]").forEach((el) => {
      el.style.position = "";
      el.removeAttribute("data-wt-pos");
    });
    clearClass("wt-section-on");
    if (!target) return;
    // ::after overlay is absolutely positioned — needs a positioned ancestor.
    if (getComputedStyle(target).position === "static") {
      target.style.position = "relative";
      target.setAttribute("data-wt-pos", "");
    }
    target.setAttribute("data-wt-name", name || "Editing");
    target.classList.add("wt-section-on");
    // Editing the popup? Bring it back on screen; otherwise keep every modal parked.
    unparkFor(target);
    parkOverlays(target);
    // Don't move the page when the client picked this section by clicking it — they are
    // already looking at it, and yanking the canvas to the section top loses their place.
    const pos = getComputedStyle(target).position;
    if (!scroll || pos === "fixed") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
    if (pos === "sticky") {
      // A pinned hero already sits at the top of the viewport, so scrollIntoView decides it
      // has nothing to do. Go to where the element actually lives in the document.
      let top = 0;
      let node: HTMLElement | null = target;
      while (node) {
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      window.scrollTo({ top: Math.max(0, top), behavior });
    } else {
      target.scrollIntoView({ block: "start", behavior });
    }
    settleRings();
  };

  // No scroll here — the dashboard sends wt-highlight first.
  // A pinned section stays put while everything scrolls over it, which in focus mode leaves a
  // hero showing through the section being edited. Let them scroll normally while focused, and
  // put each one back exactly as it was on the way out.
  const setPinning = (on: boolean) => {
    if (on) {
      document.querySelectorAll<HTMLElement>("section, header, footer, [data-wt-section]").forEach((el) => {
        if (el.hasAttribute("data-wt-unpinned") || getComputedStyle(el).position !== "sticky") return;
        el.setAttribute("data-wt-unpinned", el.style.position);
        el.style.position = "static";
      });
    } else {
      document.querySelectorAll<HTMLElement>("[data-wt-unpinned]").forEach((el) => {
        el.style.position = el.getAttribute("data-wt-unpinned") || "";
        el.removeAttribute("data-wt-unpinned");
      });
    }
  };

  const focus = (prefix: string | null) => {
    const target = prefix === null ? null : sectionFor(prefix);
    if (prefix !== null && !target) return;
    clearClass("wt-focus-on");
    document.documentElement.classList.toggle("wt-focusmode", !!target);
    setPinning(!!target);
    if (target) target.classList.add("wt-focus-on");
  };

  const outline = (key: string | null, scroll?: boolean) => {
    const el = key === null ? null : document.querySelector(`[data-wt="${cssEscape(key)}"]`);
    setRing("outline", el);
    // Only move the page when the element is actually out of sight — scrolling on every
    // keystroke or hover would yank the canvas around while the client is working.
    if (!el || !scroll) return;
    const r = el.getBoundingClientRect();
    if (r.top >= 64 && r.bottom <= innerHeight - 48) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    settleRings();
  };

  // --- Rings: hover / selected / outline, drawn in a fixed layer -------------
  const ringTargets: Record<string, Element | null> = { hover: null, selected: null, outline: null };
  let ringLayer: HTMLElement | null = null;
  let ringFrame = 0;

  const ringEl = (name: string): HTMLElement => {
    if (!ringLayer) {
      ringLayer = document.createElement("div");
      ringLayer.id = "wt-rings";
      document.body.appendChild(ringLayer);
    }
    let el = document.getElementById("wt-ring-" + name);
    if (!el) {
      el = document.createElement("i");
      el.id = "wt-ring-" + name;
      ringLayer.appendChild(el);
    }
    return el;
  };

  // Has something from elsewhere on the page been drawn over this element? Sampled at a few
  // points. A scrim, caption or overlay from inside the same section still counts as showing,
  // since those belong to it; a later section scrolling over a pinned hero does not.
  const isShowing = (target: Element, r: DOMRect): boolean => {
    const own = sectionOf(target);
    const xs = [r.left + r.width * 0.5, r.left + r.width * 0.15, r.right - r.width * 0.15];
    const ys = [r.top + r.height * 0.5, r.top + r.height * 0.15, r.bottom - r.height * 0.15];
    for (let i = 0; i < xs.length; i++) {
      const x = Math.max(1, Math.min(innerWidth - 1, xs[i]));
      const y = Math.max(1, Math.min(innerHeight - 1, ys[i]));
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === target || target.contains(hit) || hit.contains(target) || own.contains(hit)) return true;
    }
    return false;
  };

  const paintRings = () => {
    ringFrame = 0;
    (Object.keys(ringTargets) as string[]).forEach((name) => {
      const target = ringTargets[name];
      const el = ringEl(name);
      if (!target || !target.isConnected) {
        el.classList.remove("on");
        return;
      }
      const r = target.getBoundingClientRect();
      if (!r.width && !r.height) {
        el.classList.remove("on");
        return;
      }
      // Off screen, or covered by something else? Rings are painted in a layer above the page,
      // so without this a pinned hero's background image keeps marking whatever has scrolled
      // over the top of it.
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || !isShowing(target, r)) {
        el.classList.remove("on");
        return;
      }
      // 2px of breathing room so the ring sits just outside the text it marks.
      el.style.left = r.left - 2 + "px";
      el.style.top = r.top - 2 + "px";
      el.style.width = r.width + 4 + "px";
      el.style.height = r.height + 4 + "px";
      el.classList.add("on");
    });
  };
  const queueRings = () => {
    if (!ringFrame) ringFrame = requestAnimationFrame(paintRings);
  };
  // Paint straight away rather than on the next animation frame: an iframe that is briefly
  // occluded (or driven by automation) has rAF throttled, and a selection ring that arrives a
  // second after the click reads as "clicking does nothing". rAF still coalesces scroll/resize.
  const setRing = (name: string, target: Element | null) => {
    ringTargets[name] = target;
    paintRings();
  };
  // Paint synchronously while scrolling: rAF is throttled in an occluded iframe, and a ring
  // left behind by the page looks like it is marking the wrong thing. Three rect reads is cheap.
  const anyRing = () => Object.keys(ringTargets).some((k) => ringTargets[k]);
  // A smooth scroll finishes over several hundred ms and its scroll events can be throttled,
  // which would leave a ring behind at the old position. Repaint across the whole glide.
  const settleRings = () => [60, 180, 320, 500, 750].forEach((t) => setTimeout(() => anyRing() && paintRings(), t));
  addEventListener("scroll", () => {
    // A hover mark is about where the pointer is, and the pointer has not moved with the page.
    // Dropping it on scroll is what stops one trailing down the screen after you scroll away.
    if (ringTargets.hover) setRing("hover", null);
    if (anyRing()) paintRings();
  }, true);
  addEventListener("resize", () => { if (anyRing()) paintRings(); });

  // --- Parked overlays -------------------------------------------------------
  // Anything fixed-position that covers most of the viewport (a registration popup, a cookie
  // wall, a nav drawer) is a modal: while editing it hides the page and eats every click.
  const isBlockingOverlay = (el: Element): boolean => {
    const st = getComputedStyle(el);
    if (st.position !== "fixed" || st.display === "none" || st.visibility === "hidden") return false;
    if (parseFloat(st.opacity || "1") < 0.05) return false;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.6) return false;
    // Guard: a scroll-hijack layout can pin the whole page. If this element holds most of the
    // editable content it is the page, not a modal, and parking it would blank the canvas.
    const total = document.querySelectorAll("[data-wt]").length;
    return !total || el.querySelectorAll("[data-wt]").length < total * 0.4;
  };
  const parkOverlays = (keep?: Element | null) => {
    if (!editable) return;
    Array.from(document.body.querySelectorAll("*")).forEach((el) => {
      if (el.closest("#wt-rings")) return;
      if (el.classList.contains("wt-parked")) return;
      if (keep && (el === keep || el.contains(keep))) return; // the modal being edited
      if (isBlockingOverlay(el)) el.classList.add("wt-parked");
    });
  };

  // Which editable element does a point belong to? `closest` alone is not enough: a template
  // can wrap the bound element in a clipping or animating wrapper (a headline reveal mask),
  // and the browser then hit-tests the wrapper, which carries no data-wt. So when the direct
  // lookup misses, walk up and take the nearest bound descendant sitting under the pointer.
  const resolveWt = (target: Element | null, x: number, y: number): Element | null => {
    const direct = target?.closest("[data-wt]");
    if (direct) return direct;
    let node: Element | null = target;
    for (let hops = 0; node && hops < 4; hops++, node = node.parentElement) {
      const found = Array.from(node.querySelectorAll("[data-wt]")).find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (found) return found;
      if (node.tagName === "SECTION" || node.tagName === "BODY") break;
    }
    return null;
  };
  // Show a parked overlay again (it is the thing being edited), and park the rest.
  const unparkFor = (target: Element | null) => {
    document.querySelectorAll(".wt-parked").forEach((el) => {
      if (target && (el === target || el.contains(target))) el.classList.remove("wt-parked");
    });
  };

  // --- Scroll tracking ------------------------------------------------------
  // Tell the dashboard which section is on screen so its section list follows the page instead
  // of sitting on whatever was last clicked.
  const sectionOf = (el: Element): HTMLElement =>
    (el.closest("section, header, footer, main > *, [data-wt-section]") ?? el) as HTMLElement;
  let lastInView: string | null = null;
  const reportInView = () => {
    if (!editable) return;
    // Ask what is actually painted a third of the way down, rather than which boxes overlap
    // that line: a sticky hero stays behind the whole page and would otherwise always win.
    const line = innerHeight * 0.34;
    let key: string | null = null;
    for (const x of [innerWidth * 0.5, innerWidth * 0.25, innerWidth * 0.75]) {
      const el = document.elementFromPoint(x, line);
      if (!el || el.closest("#wt-rings")) continue;
      const direct = el.closest("[data-wt]");
      if (direct) { key = direct.getAttribute("data-wt"); break; }
      const inner = sectionOf(el).querySelector("[data-wt]");
      if (inner) { key = inner.getAttribute("data-wt"); break; }
    }
    if (!key || key === lastInView) return;
    lastInView = key;
    post({ type: "wt-inview", key });
  };
  let inViewTimer: ReturnType<typeof setTimeout> | null = null;
  addEventListener(
    "scroll",
    () => {
      if (inViewTimer) return;
      inViewTimer = setTimeout(() => { inViewTimer = null; reportInView(); }, 120);
    },
    true
  );

  window.addEventListener("message", (event: MessageEvent) => {
    try {
      if (!isAllowedOrigin(event.origin)) return;
      if (!activeOrigin) activeOrigin = event.origin;
      const data = event.data as {
        type?: string;
        content?: unknown;
        key?: string | null;
        value?: unknown;
        prefix?: string | null;
        name?: string;
        scroll?: boolean;
      } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "wt-content" && data.content && typeof data.content === "object") {
        applyContent(data.content);
      } else if (data.type === "wt-patch" && typeof data.key === "string") {
        applyPatch(data.key, data.value);
      } else if (data.type === "wt-highlight" && (data.prefix === null || typeof data.prefix === "string")) {
        highlight(data.prefix, typeof data.name === "string" ? data.name : undefined, data.scroll !== false);
      } else if (data.type === "wt-focus" && (data.prefix === null || typeof data.prefix === "string")) {
        focus(data.prefix);
      } else if (data.type === "wt-outline" && (data.key === null || typeof data.key === "string")) {
        outline(data.key, data.scroll === true);
      }
    } catch {
      // never throw into the page
    }
  });

  // Resolve a clicked <a> to a same-site path ("/menu"), or null for external/hash links.
  const internalPath = (a: Element): string | null => {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return null;
    try {
      const u = new URL(href, window.location.href);
      if (u.origin !== window.location.origin) return null;
      return u.pathname + u.search.replace(/[?&]wt-(edit|preview)=1/g, "");
    } catch {
      return null;
    }
  };

  // Preview mode: internal links navigate WITHIN preview (self-navigate, re-appending the
  // wt-preview param so the next page's bridge stays active and repaints the draft on its
  // own wt-ready). External links are inert — the canvas must never leave the site.
  if (mode === "preview") {
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest("a");
        if (!a) return;
        e.preventDefault();
        const path = internalPath(a);
        if (path) {
          window.location.href = path + (path.includes("?") ? "&" : "?") + "wt-preview=1";
        }
      },
      true
    );
  }

  // Bridge styles, injected once. Hover/selected rules only ever match in edit mode
  // (nothing adds those classes in preview); the section/outline rules serve both.
  if (!document.getElementById("wt-bridge-css")) {
    const style = document.createElement("style");
    style.id = "wt-bridge-css";
    style.textContent = `
      [data-wt] { cursor: default; }
      .wt-section-on { outline: 3px solid #4A90E2; outline-offset: -3px; transition: outline-color .25s; }
      .wt-section-on::after { content:""; position:absolute; inset:0; pointer-events:none; background:rgba(74,144,226,.10); animation: wtflash 1.2s ease; }
      /* Corner tag naming the section, so it is obvious which block is being edited. */
      .wt-section-on::before { content: attr(data-wt-name); position:absolute; z-index:2147482000; left:0; top:0; pointer-events:none;
        background:#4A90E2; color:#fff; font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.08em; text-transform:uppercase;
        padding:6px 10px; border-radius:0 0 8px 0; }
      @keyframes wtflash { from { background: rgba(74,144,226,.28); } }
      html.wt-focusmode section:not(.wt-focus-on), html.wt-focusmode header:not(.wt-focus-on), html.wt-focusmode footer:not(.wt-focus-on) { opacity:.28; filter:saturate(.4); transition: opacity .35s, filter .35s; }
      /* Rings live in their own fixed layer: an outline or box-shadow on the element itself is
         clipped by any overflow:hidden ancestor (e.g. a headline's reveal mask) and can be
         painted over by a later stacking context. */
      #wt-rings { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
      #wt-rings > i { position: fixed; display: none; border-radius: 5px; pointer-events: none; box-sizing: border-box; }
      #wt-rings > i.on { display: block; }
      #wt-ring-hover { border: 1px dashed rgba(30,64,175,.85); }
      #wt-ring-outline { border: 2px solid #4A90E2; box-shadow: 0 0 0 4px rgba(74,144,226,.22); }
      #wt-ring-selected { border: 2px solid #1E40AF; box-shadow: 0 0 0 4px rgba(30,64,175,.18); }
      /* A modal/popup that covers the page is parked while editing, so it can never swallow a
         click meant for the page underneath. wt-highlight on its own keys brings it back. */
      .wt-parked { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  // Hover/selection affordances — edit mode only. Preview mode paints content but never
  // wires up hover outlines, click interception, or wt-select (it's a read-only draft view).
  if (editable) {
    parkOverlays();
    // Templates open their popup a beat after load, and content patches can re-render one.
    setTimeout(parkOverlays, 400);
    setTimeout(parkOverlays, 1500);

    const pointer = (e: Event) => e as MouseEvent;
    document.addEventListener(
      "mouseover",
      (e) => {
        const m = pointer(e);
        setRing("hover", resolveWt(m.target as Element | null, m.clientX, m.clientY));
      },
      true
    );

    // Nothing on the page may act on a click while editing: a link would navigate the canvas
    // away (losing wt-edit), a button would fire the site's own JS, a form would submit. The
    // dashboard's page list is how you move between pages now.
    const INTERACTIVE = "a, button, [role='button'], input, select, textarea, label, summary, [onclick]";
    const swallow = (e: Event) => {
      const t = e.target as Element | null;
      if (t?.closest(INTERACTIVE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("auxclick", swallow, true);
    document.addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
    document.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if ((k === "Enter" || k === " ") && (e.target as Element | null)?.closest(INTERACTIVE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener(
      "click",
      (e) => {
        const m = pointer(e);
        const t = m.target as Element | null;
        const target = resolveWt(t, m.clientX, m.clientY);
        // Always kill the default: no navigation, no form post, no site handler.
        e.preventDefault();
        if (t?.closest(INTERACTIVE) || target) e.stopPropagation();
        if (!target) return;
        const key = target.getAttribute("data-wt");
        if (!key) return;
        setRing("selected", target);
        // Also say which section it sits in on THIS page. Content shown on two pages (a sponsor
        // logo appears on the home page and the sponsors page) would otherwise send the client
        // to the other page the moment they clicked it.
        const sectionKey = sectionOf(target).querySelector("[data-wt]")?.getAttribute("data-wt") ?? null;
        post({ type: "wt-select", key, sectionKey });
      },
      true
    );
  }

  const ready = () => {
    try {
      const keys = Array.from(
        new Set(allWtElements().map((el) => el.getAttribute("data-wt")).filter((k): k is string => !!k))
      );
      const sections = Array.from(new Set(keys.map((k) => k.split(".")[0])));
      post({ type: "wt-ready", keys, sections });
    } catch {
      // never throw into the page
    }
  };

  if (document.readyState === "complete" || document.readyState === "interactive") {
    ready();
  } else {
    document.addEventListener("DOMContentLoaded", ready);
  }
})();
