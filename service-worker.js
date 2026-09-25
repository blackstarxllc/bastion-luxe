// Bastion service worker — enables offline access and app-like install behavior
const CACHE_NAME = 'bastion-v9';
const PRECACHE_URLS = [
  '/index.html',
  '/bastion-auth.html',
  '/bastion-marketplace.html',
  '/bastion-deal-detail.html',
  '/bastion-create-listing.html',
  '/bastion-transaction.html',
  '/bastion-my-account.html',
  '/bastion-seller-profile.html',
  '/bastion-terms.html',
  '/bastion-privacy.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ------------------------------------------------------------------
// CACHE POLICY
//
// This previously did `cache.put(event.request, clone)` on EVERY successful
// GET. On a money platform that is badly wrong:
//
//   * It cached cross-origin responses, including Supabase REST and auth
//     replies \u2014 transactions, messages, addresses, session material.
//   * Cached entries survive sign-out, so on a shared or family device the
//     next person could be served the previous person's data straight from
//     the cache, with no network call and no auth check.
//   * A stale transaction state is not a cosmetic bug here. "Funded" served
//     from cache after a dispute was filed is a wrong answer about money.
//
// Now: only same-origin static assets and pages on an explicit allowlist are
// cached, and anything touching the API or private data is never stored.
// ------------------------------------------------------------------
const CACHEABLE_EXTENSIONS = ['.html', '.css', '.js', '.png', '.jpg', '.jpeg',
  '.webp', '.svg', '.ico', '.woff', '.woff2', '.json'];

function isCacheable(request){
  let url;
  try { url = new URL(request.url); } catch (e) { return false; }

  // Same origin only. Never Supabase, never Netlify functions, never a CDN.
  if(url.origin !== self.location.origin) return false;
  if(url.pathname.startsWith('/.netlify/')) return false;

  // Anything carrying credentials or a query string is a live request.
  if(url.search) return false;

  const path = url.pathname.toLowerCase();
  if(path === '/' ) return true;
  return CACHEABLE_EXTENSIONS.some(function(ext){ return path.endsWith(ext); });
}

self.addEventListener('fetch', (event) => {
  if(event.request.method !== 'GET') return;

  // Not cacheable: go straight to the network and never store the result.
  if(!isCacheable(event.request)){
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only store a clean, complete, same-origin response.
        if(response && response.status === 200 && response.type === 'basic'){
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
