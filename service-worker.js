// Bastion service worker — enables offline access and app-like install behavior
const CACHE_NAME = 'bastion-v2';
const PRECACHE_URLS = [
  '/index.html',
  '/bastion-auth.html',
  '/bastion-marketplace.html',
  '/bastion-deal-detail.html',
  '/bastion-create-listing.html',
  '/bastion-transaction.html',
  '/bastion-my-account.html',
  '/bastion-seller-profile.html',
  '/bastion-listing-preview.html',
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

// Network-first for everything (so live Supabase data always wins),
// falling back to cache only when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
