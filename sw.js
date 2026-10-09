// OpenFrance — Service Worker : cache disque persistant (Cache API)
// Stratégie « stale-while-revalidate » sur les requêtes proxifiées :
//  - réponse immédiate depuis le cache disque (même après reboot)
//  - mise à jour en tâche de fond si l'entrée est plus vieille que sa TTL
// Les données restent à jour automatiquement : au pire le visiteur voit
// la version en cache, le refresh part derrière.

var CACHE_NAME = 'openfrance-v1';
var META_CACHE = 'openfrance-meta-v1';

// TTL par type de ressource (en secondes)
var TTL = {
  '/api/': 7 * 24 * 3600,   // résultats paginés API tabulaire (élections historisées, délinquance annuelle)
  '/data/': 24 * 3600,      // CSV statiques data.gouv (revalidés chaque jour)
  '/geo/': 30 * 24 * 3600   // contours GeoJSON (franchement stables)
};

function ttlFor(pathname) {
  for (var prefix in TTL) if (pathname.indexOf(prefix) === 0) return TTL[prefix];
  return null; // non concerné
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        if (n !== CACHE_NAME && n !== META_CACHE) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function getMeta(url) {
  return caches.open(META_CACHE).then(function (c) {
    return c.match(url).then(function (m) {
      if (!m) return 0;
      return m.json().then(function (j) { return j.t || 0; }, function () { return 0; });
    });
  });
}
function setMeta(url) {
  return caches.open(META_CACHE).then(function (c) {
    return c.put(url, new Response(JSON.stringify({ t: Date.now() })));
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tuiles OSM etc. : pas touchées

  var ttl = ttlFor(url.pathname);
  if (ttl === null) return; // HTML/CSS/JS/etc. : comportement normal du navigateur

  event.respondWith(staleWhileRevalidate(req, url, ttl));
});

function staleWhileRevalidate(req, url, ttl) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(req).then(function (cached) {
      var now = Date.now();
      var refresh = getMeta(url.href).then(function (storedAt) {
        // Pas de ré-entrante si une validation récente ; évite le storm de F5
        var fresh = now - storedAt < ttl;
        if (fresh) return null;
        return setMeta(url.href).then(function () {
          return fetch(req).then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          }).catch(function () { /* offline : on garde le stale */ });
        });
      }).catch(function () { /* jamais bloquant */ });

      if (cached) {
        // On sert le cache immédiatement, la maj continue derrière
        refresh.catch(function () {});
        return cached;
      }
      // Pas encore en cache : on attend le réseau
      return refresh.then(function (res) {
        return res && res.ok ? res : Response.error();
      });
    });
  });
}
