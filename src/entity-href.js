// Shared "which entity does this link/URL point at" parsing for
// badge-injector.js and scene-tooltips.js, both of which now need to
// distinguish /performers/:id from /scenes/:id rather than assume
// performers. Scene links can carry a query string (queue params, ?t=) or
// a trailing subpath, so a plain `href.split("/").pop()` isn't safe on the
// scenes side the way it was when performers were the only case.

/** @param {string} pathname */
function matchEntityPath(pathname) {
  const match = pathname.match(/^\/(performers|scenes)\/(\d+)(?:\/|$)/);
  if (!match) return null;
  return { battleType: /** @type {"performers" | "scenes"} */(match[1]), id: match[2] };
}

/** @param {string} href */
export function parseEntityHref(href) {
  const { pathname } = new URL(href, "http://x");
  return matchEntityPath(pathname);
}

/** @param {string} pathname */
export function parseEntityPath(pathname) {
  return matchEntityPath(pathname);
}
