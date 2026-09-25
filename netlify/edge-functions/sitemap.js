// netlify/edge-functions/sitemap.js
//
// Serves /sitemap.xml dynamically: the public pages plus EVERY active
// listing, so search engines can discover each item. The previous sitemap
// was a fixed file listing 8 static pages and none of the listings.
//
// Reads only public listing fields with the public (publishable) key, the
// same key every page already ships. If Supabase is slow or down, it falls
// back to the static sitemap.xml file rather than serving an error.
const SUPABASE_URL = 'https://xokyqobttfhugdponfpg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nb18Wk7poF2HR0ZjpiJFnQ_tvv4wl0o';
const SITE = 'https://bastionmarket.com';
const STATIC_PAGES = [
  ['/', '1.0'], ['/bastion-marketplace.html', '0.9'], ['/bastion-about.html', '0.6'],
  ['/bastion-faq.html', '0.6'], ['/bastion-safety.html', '0.6'], ['/bastion-shipping.html', '0.5'],
  ['/bastion-support.html', '0.4'], ['/bastion-terms.html', '0.3'], ['/bastion-privacy.html', '0.3'],
];

function xmlEscape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async (request, context) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/deals?status=eq.active&select=id,created_at&order=created_at.desc&limit=5000',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!r.ok) return context.next();
    const deals = await r.json();
    const urls = STATIC_PAGES.map(([p, pr]) =>
      '  <url><loc>' + SITE + p + '</loc><priority>' + pr + '</priority></url>');
    for (const d of deals) {
      const lastmod = d.created_at ? '<lastmod>' + String(d.created_at).slice(0, 10) + '</lastmod>' : '';
      urls.push('  <url><loc>' + xmlEscape(SITE + '/bastion-deal-detail.html?id=' + d.id) + '</loc>' + lastmod + '<priority>0.8</priority></url>');
    }
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join('\n') + '\n</urlset>\n';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  } catch (e) {
    return context.next();
  }
};

export const config = { path: '/sitemap.xml' };
