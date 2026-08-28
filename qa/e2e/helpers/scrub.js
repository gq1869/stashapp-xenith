// @ts-check
import { portraitSvg, stillSvg, svgDataUri } from "../fixtures/placeholder-art.js";
import { nameFor, titleFor } from "../fixtures/promo.js";

/**
 * DOM-level obfuscation pass for promo screenshots of native Stash pages
 * (performer detail, performer grid, scene grid) — used only by the
 * Stash-integration shots in promo.spec.js (rank-badge, rank-badges-grid,
 * and promo-mobile's scene-card variant of the grid capture).
 *
 * Those pages are rendered by Stash core, which issues its own GraphQL
 * queries — fixtures/graphql.js's mockGraphQL deliberately passes those
 * through untouched (see its header comment on operation-name collisions),
 * so real library names/images would otherwise appear verbatim. Rather
 * than adding a second, version-sensitive mock of Stash core's detail-page
 * query shape, this rewrites the rendered DOM directly: swaps every
 * performer/scene image for generated placeholder art, and every real name
 * for a stable invented one from the same word list promo.js's fixture
 * data uses.
 *
 * Deliberately last-mile only — run this immediately before a screenshot,
 * not as a general page setup step, since it doesn't survive further
 * client-side re-renders (route changes, React state updates).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function scrubNativePage(page) {
  const nameMap = /** @type {Record<string, string>} */ ({});
  // Build a stable id -> invented-name map by scanning /performers/:id and
  // /scenes/:id links first, so every occurrence of the same entity's real
  // name/title (heading, card caption) resolves to the same fake one. A
  // scene grid card links to itself twice (thumbnail + title), so this
  // covers the title without any scene-specific special-casing.
  for (const [pattern, idRe, fn] of /** @type {const} */ ([
    ['a[href*="/performers/"]', /\/performers\/(\d+)/, nameFor],
    ['a[href*="/scenes/"]', /\/scenes\/(\d+)/, titleFor],
  ])) {
    const links = await page.locator(pattern).all();
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => null);
      const match = href && href.match(idRe);
      if (!match) continue;
      const id = match[1];
      if (!nameMap[id]) nameMap[id] = fn(Number(id));
    }
  }

  // A performer's own detail page never links to itself, so the scan above
  // never picks up its own id — handled separately via the current URL and
  // .performer-name's known selector (Stash core's own heading class).
  const pageEntityMatch = page.url().match(/\/performers\/(\d+)/);
  const ownName = pageEntityMatch ? nameFor(Number(pageEntityMatch[1])) : null;

  await page.evaluate(
    ({ nameMap, ownName, portraitSrc, stillSrc }) => {
      const ownNameEl = document.querySelector(".performer-name");
      if (ownNameEl && ownName) ownNameEl.textContent = ownName;

      // Swap performer/scene <img> thumbnails for placeholder art.
      document.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (src.includes("/performer/")) {
          img.setAttribute("src", portraitSrc);
          img.removeAttribute("srcset");
        } else if (src.includes("/scene/")) {
          img.setAttribute("src", stillSrc);
          img.removeAttribute("srcset");
        }
      });

      // Scene cards render their hover preview as a <video poster="...
      // scene/.../screenshot"> (detail page) or <video src="...scene/.../
      // preview"> (grid cards, no poster attr) — neither is touched by the
      // <img> swap above. poster gets replaced with placeholder art; a bare
      // src is just removed outright, along with any <source> children —
      // a static screenshot never plays it, so there's nothing to swap in.
      document.querySelectorAll("video[poster]").forEach((video) => {
        video.setAttribute("poster", stillSrc);
        video.querySelectorAll("source").forEach((s) => s.removeAttribute("src"));
      });
      document.querySelectorAll("video[src]").forEach((video) => {
        video.removeAttribute("src");
        video.querySelectorAll("source").forEach((s) => s.removeAttribute("src"));
      });

      // Studio logos (/studio/:id/image) are real trademarked branding, not
      // something to regenerate placeholder art for — remove outright.
      document.querySelectorAll('img[src*="/studio/"], .studio-overlay').forEach((el) => el.remove());

      // Real, unobfuscatable per-library content with no promo value: a
      // performer's real social handles/aliases (.alias-head), the
      // social-platform link buttons (twitter/instagram/website, all share
      // "link"+"dropdown-toggle" classes), the whole Scenes/Galleries/
      // Images/Groups tab panel below the fold on a performer detail page
      // (real titles, runtimes, thumbnails, file sizes), and — on scene
      // grid cards — the real explicit description text, the real absolute
      // local filesystem path (.file-path, the single most sensitive thing
      // a scene card renders), and the real filesize/resolution/duration
      // readout (.scene-specs-overlay).
      document
        .querySelectorAll(
          ".alias-head, a.link.dropdown-toggle, .nav-tabs, .tab-content, .scene-card__description, .file-path, .scene-specs-overlay"
        )
        .forEach((el) => el.remove());

      // Native star-rating widget (.rating-number, the star icon + numeric
      // value) shows the real rating100 value — remove just that piece,
      // not its wrapper (.quality-group): badge-injector.js's
      // detailHostSelector appends Xenith's own .hon-rank-badge-detail as a
      // CHILD of that same .quality-group (it's the detail-page injection
      // host), so removing the wrapper itself would take Xenith's badge
      // down with it.
      document.querySelectorAll(".rating-number, .edit-rating-button").forEach((el) => el.remove());

      // Stash's own native RatingBanner (.rating-banner, grid cards) shows
      // the real rating100 value straight from the live library.
      // badge-injector.js only hides it via CSS once Xenith's own
      // .hon-compact-badge has actually injected onto that specific card
      // (.hon-processed) — which depends on the mocked pool's ids
      // coincidentally matching whatever real ids are on screen. Strip it
      // outright rather than depend on that coincidence.
      document.querySelectorAll(".rating-banner").forEach((el) => el.remove());

      // Replace real names/titles with their mapped invented one wherever a
      // /performers/:id or /scenes/:id link's own text (or an ancestor
      // heading/caption that visibly contains it) appears.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      /** @type {Text[]} */
      const nodes = [];
      let n;
      // eslint-disable-next-line no-cond-assign
      while ((n = walker.nextNode())) nodes.push(/** @type {Text} */ (n));

      document.querySelectorAll('a[href*="/performers/"], a[href*="/scenes/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        const match = href.match(/\/performers\/(\d+)/) || href.match(/\/scenes\/(\d+)/);
        if (!match) return;
        const fake = nameMap[match[1]];
        if (!fake) return;
        const real = (a.textContent || "").trim();
        if (!real) return;
        for (const node of nodes) {
          if (node.nodeValue && node.nodeValue.includes(real)) {
            node.nodeValue = node.nodeValue.split(real).join(fake);
          }
        }
      });
    },
    {
      nameMap,
      ownName,
      portraitSrc: svgDataUri(portraitSvg("scrub-performer")),
      stillSrc: svgDataUri(stillSvg("scrub-scene")),
    }
  );
}
