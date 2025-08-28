// Mayadrop Service Worker: precache + streaming downloads
const CACHE_NAME = 'mayadrop-v6-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try { await cache.addAll(ASSETS); } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Streaming: page posts chunks; SW serves /stream/<token> as a streaming Response.
const streams = new Map(); // token -> { controller, queue: [] }

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const { type, token } = data;
  if (!token) return;
  if (type === 'stream-open') {
    streams.set(token, { controller: null, queue: [] });
  } else if (type === 'stream-chunk') {
    const entry = streams.get(token); if (!entry) return;
    const chunk = data.chunk;
    if (entry.controller) {
      try { entry.controller.enqueue(new Uint8Array(chunk)); } catch {}
    } else {
      entry.queue.push(chunk);
    }
  } else if (type === 'stream-close') {
    const entry = streams.get(token); if (!entry) return;
    try { entry.controller && entry.controller.close(); } catch {}
    streams.delete(token);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/stream/')) {
    const token = url.pathname.split('/').pop();
    const name = url.searchParams.get('name') || 'download.bin';
    const type = url.searchParams.get('type') || 'application/octet-stream';
    event.respondWith(new Response(new ReadableStream({
      start(controller) {
        const entry = streams.get(token);
        if (!entry) { controller.close(); return; }
        entry.controller = controller;
        for (const q of entry.queue) controller.enqueue(new Uint8Array(q));
        entry.queue.length = 0;
      },
      cancel() { streams.delete(token); }
    }), {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store'
      }
    }));
  }
});
