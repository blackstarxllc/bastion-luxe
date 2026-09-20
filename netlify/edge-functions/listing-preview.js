// Listing-specific link previews.
//
// Listing pages fill in their content with JavaScript after they load, but
// iMessage, Instagram, Facebook, X, Slack and Google read the page's HTML
// *before* any JavaScript runs, so every shared listing used to show the
// same generic Bastion card. This runs on Netlify's edge as the page is
// served and swaps in the listing's own photo, title and price.
//
// It only reads public listing fields with the public (publishable) key,
// the same key every Bastion page already ships with. If anything goes
// wrong (bad id, database slow, listing removed) it simply serves the
// normal page, so it can never break a listing.

const SUPABASE_URL = 'https://xokyqobttfhugdponfpg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nb18Wk7poF2HR0ZjpiJFnQ_tvv4wl0o';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function attr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function setMeta(html, attrName, key, value) {
  const tag = '<meta ' + attrName + '="' + key + '" content="' + attr(value) + '">';
  const re = new RegExp('<meta ' + attrName + '="' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" content="[^"]*">');
  return re.test(html) ? html.replace(re, tag) : html.replace('</title>', '</title>\n' + tag);
}

export default async (request, context) => {
  const response = await context.next();
  try {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!UUID.test(id)) return response;
    if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/deals?id=eq.' + id + '&select=item_name,price,image_url,description,status,city,state',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!r.ok) return response;
    const rows = await r.json();
    const d = rows && rows[0];
    if (!d || !d.item_name) return response;

    const price = d.price != null ? '$' + Number(d.price).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
    const title = d.item_name + (price ? ' \u2014 ' + price : '');
    const place = [d.city, d.state].filter(Boolean).join(', ');
    let desc = String(d.description || '').replace(/\s+/g, ' ').trim();
    if (desc.length > 150) desc = desc.slice(0, 147).replace(/\s+\S*$/, '') + '\u2026';
    desc = [place ? 'Listed in ' + place + '.' : '', desc].filter(Boolean).join(' ') || 'View this listing on Bastion.';
    const pageUrl = 'https://bastionmarket.com/bastion-deal-detail.html?id=' + id;

    let html = await response.text();
    html = html.replace(/<title>[^<]*<\/title>/, '<title>' + attr(title) + ' | Bastion</title>');
    html = setMeta(html, 'name', 'description', desc);
    html = setMeta(html, 'property', 'og:title', title);
    html = setMeta(html, 'property', 'og:description', desc);
    html = setMeta(html, 'property', 'og:url', pageUrl);
    html = setMeta(html, 'property', 'og:type', 'product');
    html = setMeta(html, 'name', 'twitter:title', title);
    html = setMeta(html, 'name', 'twitter:description', desc);
    if (d.image_url && /^https:\/\//.test(d.image_url)) {
      html = setMeta(html, 'property', 'og:image', d.image_url);
      html = setMeta(html, 'name', 'twitter:image', d.image_url);
      // The brand card's size no longer applies to a listing photo.
      html = html.replace(/<meta property="og:image:(width|height)" content="\d+">\n?/g, '');
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(html, { status: response.status, headers });
  } catch (e) {
    return response;
  }
};

export const config = { path: ['/bastion-deal-detail.html', '/bastion-deal-detail'] };
