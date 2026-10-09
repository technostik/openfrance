// OpenFrance — Annuaire : associations (RNA/Waldec) + entreprises (API Recherche d'entreprises)
// + Page de gestion globale du cache (IndexedDB + service worker + RAM), tous modes.
//
// Sources (proxifiées via Netlify, même origine) :
//  - Associations : RNA agrégé national (Waldec) via l'API tabulaire data.gouv
//    → chargement par département (communes INSEE du département), cache IndexedDB.
//  - Thèmes : nomenclature WALDEC (objet social code → libellé, thème parent), cache IndexedDB (national)
//  - Entreprises : API Recherche d'entreprises (DINUM) — recherche texte par département
//    → résultats mis en cache IndexedDB (une entrée par requête).
//
// Recherche multi-mots-clés (locale, sur les données du département en cache) :
//   ninjutsu mma          → les deux requis (ET)
//   ninjutsu + mma        → ninjutsu OU mma (dès qu'il y a un +, les mots deviennent des OU)
//   ninjutsu + mma - boxe → ninjutsu OU mma, sans boxe
//   "mma"                 → mot exact (frontières de mot, n'exclut pas HAMMAM... si, il l'exclut)
//   Les espaces autour des + et - sont tolérés : « ninjutsu + mma - boxe » ≡ « ninjutsu +mma -boxe »

var ANN = {
  active: false,
  prevRefresh: null,
  assos: {},          // dep -> [{ i,t,o,c,n,l,p,w }]
  nomen: null,        // { child: { codeNum -> { p, l } } }
  centroids: {},      // dep -> { codeCommune -> [lat, lng] }
  entCache: {},       // "dep|q|section" -> rows
  markers: null,      // featureGroup des marqueurs courants
  markerIndex: {},    // clé marqueur ('a:<id>' / 'e:<siren>') -> marker Leaflet (mise à jour par différence)
  showing: [],        // résultats affichés (assos + entreprises)
  seq: 0              // jeton anti-course pour les recherches asynchrones
};

var ANN_URLS = {
  assos: '/api/assos/',
  nomen: '/api/nomen/',
  entreprises: '/api/entreprises/'
};

// Sections de la NAF (rev. 2) pour la facette « catégorie » des entreprises
var NAF_SECTIONS = {
  'A': 'Agriculture, sylviculture et pêche',
  'B': 'Industries extractives',
  'C': 'Industrie manufacturière',
  'D': 'Électricité, gaz, vapeur et air conditionné',
  'E': 'Eau, assainissement, gestion des déchets',
  'F': 'Construction',
  'G': 'Commerce, réparation automobile et moto',
  'H': 'Transports et entreposage',
  'I': 'Hébergement et restauration',
  'J': 'Information et communication',
  'K': 'Activités financières et d\'assurance',
  'L': 'Activités immobilières',
  'M': 'Activités spécialisées, scientifiques et techniques',
  'N': 'Activités de services administratifs et de soutien',
  'O': 'Administration publique',
  'P': 'Enseignement',
  'Q': 'Santé humaine et action sociale',
  'R': 'Arts, spectacles et activités récréatives',
  'S': 'Autres activités de services',
  'T': 'Activités des ménages (employeurs, biens/services)',
  'U': 'Activités extra-territoriales'
};

// ---------- Utilitaires ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normTxt(s) {
  s = String(s == null ? '' : s).toLowerCase();
  if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}
function fmtSize(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' Mo';
  if (n > 1024) return (n / 1024).toFixed(0) + ' Ko';
  return n + ' o';
}

// Analyse d'une requête « a b +c -d "mot exact" » (espaces tolérés autour de + et -)
// Chaque token : { t: terme normalisé, w: true si « mot complet » (guillemets) }
function parseAnnQuery(str) {
  var req = [], or = [], neg = [];
  var tokens = String(str || '').match(/"[^"]*"|[^\s"]+/g) || [];
  var pendingSign = ''; // +/- orphelin : s'applique au token suivant
  tokens.forEach(function (raw) {
    var sign = pendingSign; pendingSign = '';
    var tok = raw;
    if (tok === '+') { pendingSign = 'or'; return; }
    if (tok === '-') { pendingSign = 'neg'; return; }
    if (tok.charAt(0) === '+') { sign = sign || 'or'; tok = tok.slice(1); }
    else if (tok.charAt(0) === '-') { sign = sign || 'neg'; tok = tok.slice(1); }
    var w = false;
    if (/^"[^"]*"$/.test(tok)) { w = true; tok = tok.slice(1, -1); }
    tok = normTxt(tok);
    if (!tok) return;
    var item = { t: tok, w: w };
    var bucket = sign === 'neg' ? neg : (sign === 'or' ? or : req);
    var already = bucket.some(function (x) { return x.t === tok && x.w === w; });
    if (!already) bucket.push(item);
  });
  return { req: req, or: or, neg: neg };
}

// Explication humaine de la requête (affichée sous la recherche)
function annQueryExplain(q) {
  if (!q.req.length && !q.or.length && !q.neg.length) return '';
  var f = function (x) { return x.w ? '«&nbsp;' + esc(x.t) + '&nbsp;» (mot exact)' : '«&nbsp;' + esc(x.t) + '&nbsp;»'; };
  var parts = [];
  if (q.or.length) parts.push('contient ' + q.req.concat(q.or).map(f).join(' OU '));
  else if (q.req.length) parts.push('contient ' + q.req.map(f).join(' ET '));
  if (q.neg.length) parts.push('sans ' + q.neg.map(f).join(' ni '));
  return '🔎 ' + parts.join(' · ');
}

// Teste un token contre un haystack normalisé
// w=false : simple sous-chaîne · w=true : mot complet (frontières de mot)
function tokMatch(h, tok) {
  if (!tok.w) return h.indexOf(tok.t) !== -1;
  if (!tok.re) tok.re = new RegExp('(^|[^a-z0-9])' + escRe(tok.t) + '($|[^a-z0-9])');
  return tok.re.test(h);
}

// haystack pré-normalisé, mis en cache sur l'enregistrement
function annHaystack(a) {
  if (!a._h) a._h = normTxt(a.t + ' ' + (a.o || '') + ' ' + (a.l || ''));
  return a._h;
}
// Sémantique : mots simples = ET · dès qu'il y a des +mots, req+or forment un OU
// (au moins un doit matcher) · -mots = exclusion
function annMatch(h, q) {
  if (q.or.length) {
    var pool = q.req.concat(q.or), ok = false;
    for (var i = 0; i < pool.length; i++) if (tokMatch(h, pool[i])) { ok = true; break; }
    if (!ok) return false;
  } else {
    for (var j = 0; j < q.req.length; j++) if (!tokMatch(h, q.req[j])) return false;
  }
  for (var k = 0; k < q.neg.length; k++) if (tokMatch(h, q.neg[k])) return false;
  return true;
}

// ---------- IndexedDB (cache persistant : assos par dept + nomenclature + recherches entreprises) ----------
function idbOpen() {
  return new Promise(function (res, rej) {
    var rq = indexedDB.open('openfrance-annuaire', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('assos'); };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var rq = db.transaction('assos').objectStore('assos').get(key);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }).catch(function () { return null; });
}
function idbSet(key, val) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('assos', 'readwrite');
        tx.objectStore('assos').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* cache best-effort */ });
}
function idbDelete(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('assos', 'readwrite');
        tx.objectStore('assos').delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}
function idbKeys() {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var ks = [];
      try {
        var rq = db.transaction('assos').objectStore('assos').openKeyCursor();
        rq.onsuccess = function () {
          var cur = rq.result;
          if (cur) { ks.push(cur.key); cur.continue(); } else res(ks);
        };
        rq.onerror = function () { res(ks); };
      } catch (e) { res(ks); }
    });
  }).catch(function () { return []; });
}

// ---------- Nomenclature WALDEC (thèmes) — cache IndexedDB, portée nationale ----------
function fetchNomen() {
  return Promise.all([1, 2].map(function (p) {
    return fetch(ANN_URLS.nomen + '?page_size=200&page=' + p).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  })).then(function (js) {
    var child = {};
    js.forEach(function (j) {
      (j.data || []).forEach(function (row) {
        var code = parseInt(row['Identifiant objet social'], 10);
        if (!isNaN(code)) {
          child[code] = {
            p: (row['Libellé objet social parent'] || '').trim(),
            l: (row['Libellé objet social'] || '').trim()
          };
        }
      });
    });
    return { child: child };
  });
}
function loadNomen() {
  if (ANN.nomen) return Promise.resolve();
  return idbGet('nomen').then(function (cached) {
    if (cached && cached.child && Object.keys(cached.child).length) {
      ANN.nomen = { child: cached.child };
      return;
    }
    return fetchNomen().then(function (nomen) {
      ANN.nomen = nomen;
      idbSet('nomen', { v: 1, date: Date.now(), child: nomen.child });
    });
  });
}
// Thème d'une asso : objet_social1 (6 chiffres, ex. 011080 → 11080 → parent 11000)
function annTheme(a) {
  if (!ANN.nomen) return null;
  var c = parseInt(a.c, 10);
  if (!c) return null;
  var e = ANN.nomen.child[c];
  if (e) return e;
  return ANN.nomen.child[Math.floor(c / 100) * 100] || null;
}

// ---------- Chargement des associations du département ----------
function loadAssosDept(code) {
  if (ANN.assos[code]) return Promise.resolve(ANN.assos[code]);
  return idbGet('assos-' + code).then(function (cached) {
    if (cached && cached.rows && cached.rows.length) {
      ANN.assos[code] = cached.rows;
      return cached.rows;
    }
    return fetchAssosDept(code);
  });
}

function fetchAssosDept(code) {
  var geo = state.communesGeo[code];
  if (!geo || !geo.features || !geo.features.length) return Promise.reject(new Error('contours communes indisponibles'));
  var codes = geo.features.map(function (f) { return f.properties.code; });
  var base = ANN_URLS.assos + '?page_size=200&date_disso__exact=-infinity&adrs_codeinsee__in=' + encodeURIComponent(codes.join(','));

  function page(p) {
    return fetch(base + '&page=' + p).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' (page ' + p + ')');
      return res.json();
    });
  }
  // Pagination parallèle par lots de 10 (même stratégie que les élections)
  return page(1).then(function (j) {
    var rows = (j.data || []).slice();
    var total = (j.meta && j.meta.total) || rows.length;
    var npages = Math.max(1, Math.ceil(total / 200));
    setStatus('⏳ Associations : ' + npages + ' pages à charger…', 'loading');
    function batch(i) {
      var lo = i * 10 + 2, hi = Math.min((i + 1) * 10 + 1, npages);
      var chunk = [];
      for (var p = lo; p <= hi; p++) chunk.push(p);
      if (!chunk.length) return Promise.resolve();
      return Promise.all(chunk.map(page)).then(function (js) {
        js.forEach(function (j2) { (j2.data || []).forEach(function (r) { rows.push(r); }); });
        setStatus('⏳ Associations : ' + Math.min(rows.length, total).toLocaleString('fr-FR') + ' / ' + total.toLocaleString('fr-FR') + '…', 'loading');
        return batch(i + 1);
      });
    }
    return batch(0).then(function () { return rows; });
  }).then(function (raw) {
    var rows = raw.map(function (r) {
      return {
        i: r.id,
        t: r.titre || '',
        o: (r.objet || '').slice(0, 400),
        c: r.objet_social1 || '',
        n: r.adrs_codeinsee || '',
        l: r.adrs_libcommune || '',
        p: r.adrs_codepostal || '',
        w: r.siteweb && r.siteweb !== 'null' ? r.siteweb : ''
      };
    });
    ANN.assos[code] = rows;
    idbSet('assos-' + code, { v: 1, date: Date.now(), rows: rows });
    return rows;
  });
}

// Recharge un département depuis la source (utilisé par la page cache, même hors dept courant)
function annReloadDept(dep) {
  var geoPromise = state.communesGeo[dep] ? Promise.resolve(state.communesGeo[dep]) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[dep] + '/communes-' + DEP_FOLDERS[dep] + '.geojson')
      .then(function (g) { state.communesGeo[dep] = g; return g; });
  return geoPromise.then(function () { return fetchAssosDept(dep); });
}

// Centroïdes des communes (bbox center) pour placer les marqueurs
function annCentroids(code) {
  if (ANN.centroids[code]) return ANN.centroids[code];
  var geo = state.communesGeo[code], out = {};
  (geo.features || []).forEach(function (f) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (function walk(g) {
      if (typeof g[0] === 'number') {
        if (g[0] < minX) minX = g[0]; if (g[0] > maxX) maxX = g[0];
        if (g[1] < minY) minY = g[1]; if (g[1] > maxY) maxY = g[1];
      } else g.forEach(walk);
    })(f.geometry.coordinates);
    out[f.properties.code] = [(minY + maxY) / 2, (minX + maxX) / 2];
  });
  ANN.centroids[code] = out;
  return out;
}

// ---------- Entreprises (API Recherche d'entreprises, recherche texte) ----------
// L'API ne permet pas de lister toutes les entreprises d'un département :
// seule la recherche texte est disponible. Les résultats sont mis en cache
// IndexedDB (une entrée par requête) pour ne pas re-consommer le quota.
function fetchEntPages(base) {
  function page(p) {
    return fetch(base + '&page=' + p).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j && j.erreur) throw new Error(j.erreur);
      return j;
    });
  }
  return page(1).then(function (j) {
    var rows = (j.results || []).slice();
    var np = Math.min(j.total_pages || 1, 4); // l'API plafonne les résultats
    var ps = [];
    for (var p = 2; p <= np; p++) ps.push(page(p));
    return Promise.all(ps).then(function (js) {
      js.forEach(function (j2) { rows = rows.concat(j2.results || []); });
      return rows;
    });
  });
}

// Copie sérialisable d'une requête (sans les regex compilées)
function annPlainQuery(q) {
  return {
    req: q.req.map(function (x) { return { t: x.t, w: x.w }; }),
    or: q.or.map(function (x) { return { t: x.t, w: x.w }; }),
    neg: q.neg.map(function (x) { return { t: x.t, w: x.w }; })
  };
}

function searchEntreprises(dep, q, section) {
  var terms = q.req.concat(q.or).map(function (x) { return x.t; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (!terms.length) return Promise.resolve([]);
  var key = dep + '|' + terms.join(' ') + '|' + (section || '');
  if (ANN.entCache[key]) return Promise.resolve(ANN.entCache[key]);
  // cache persistant IndexedDB (une entrée par recherche)
  return idbGet('ent-' + key).then(function (cached) {
    if (cached && cached.rows) {
      ANN.entCache[key] = cached.rows;
      return cached.rows;
    }
    return Promise.all(terms.map(function (t) {
      var u = ANN_URLS.entreprises + '?q=' + encodeURIComponent(t) +
        '&departement=' + encodeURIComponent(dep) + '&est_association=false&per_page=25';
      if (section) u += '&section_activite_principale=' + encodeURIComponent(section);
      return fetchEntPages(u);
    })).then(function (arrs) {
      var bySiren = {}, counts = {};
      arrs.forEach(function (arr) {
        arr.forEach(function (e) {
          if (!bySiren[e.siren]) bySiren[e.siren] = e;
          counts[e.siren] = (counts[e.siren] || 0) + 1;
        });
      });
      // Cas ET strict (plusieurs mots requis, aucun +mot) : tous les termes doivent matcher
      // (chaque terme = un appel séparé → l'entreprise doit apparaître dans chaque liste)
      // Cas OU (au moins un +mot) : l'union des listes suffit
      var out = [];
      for (var s in bySiren) {
        if (!q.or.length && q.req.length > 1 && counts[s] < q.req.length) continue;
        var e = bySiren[s];
        var h = normTxt((e.nom_complet || '') + ' ' + ((e.siege && e.siege.adresse) || '') + ' ' + ((e.siege && e.siege.activite_principale) || ''));
        var bad = false;
        for (var k = 0; k < q.neg.length; k++) if (tokMatch(h, q.neg[k])) { bad = true; break; }
        if (!bad) out.push(e);
      }
      ANN.entCache[key] = out;
      idbSet('ent-' + key, {
        v: 1, date: Date.now(), dep: dep, section: section || '',
        terms: terms, q: annPlainQuery(q), rows: out
      });
      return out;
    });
  });
}

// ---------- Rendu carte ----------
function clearAnnMarkers() {
  if (ANN.markers) { map.removeLayer(ANN.markers); ANN.markers = null; }
  ANN.showing = [];
  ANN.markerIndex = {};
}
function assoPopup(a, th) {
  var html = '<b>' + esc(a.t) + '</b>';
  if (th && th.p) html += '<br><i>' + esc(th.p) + (th.l && th.l !== th.p ? ' — ' + esc(th.l) : '') + '</i>';
  if (a.o) html += '<br>' + esc(a.o.slice(0, 250)) + (a.o.length > 250 ? '…' : '');
  html += '<br>' + esc(a.l) + ' (' + esc(a.p) + ')';
  if (a.w) html += '<br>🔗 <a href="' + esc(a.w) + '" target="_blank" rel="noopener">site web</a>';
  if (a.i) html += '<br><a href="https://annuaire-entreprises.data.gouv.fr/associations/' + encodeURIComponent(a.i) + '" target="_blank" rel="noopener">Fiche annuaire</a>';
  return html;
}
function entPopup(e) {
  var s = e.siege || {};
  var html = '<b>' + esc(e.nom_complet) + '</b>';
  if (s.activite_principale) html += '<br><i>NAF : ' + esc(s.activite_principale) + '</i>';
  if (s.adresse) html += '<br>' + esc(s.adresse);
  html += '<br><a href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + encodeURIComponent(e.siren) + '" target="_blank" rel="noopener">Fiche annuaire</a>';
  return html;
}
function entColor(e) {
  var s = (e.siege && e.siege.activite_principale) || '';
  return catColor(s.charAt(0)); // couleur par section NAF
}

// Met à jour les marqueurs PAR DIFFÉRENCE : à chaque recherche, seuls les
// marqueurs nouveaux sont créés et les disparus retirés — les marqueurs
// conservés ne sont pas recréés (pas de scintillement de la carte).
function annEnsureLayer() {
  if (!ANN.markers) ANN.markers = L.featureGroup().addTo(map);
  return ANN.markers;
}
function annSyncMarkers(entries) {
  var group = annEnsureLayer();
  var wanted = {};
  entries.forEach(function (en) { wanted[en.key] = en; });
  // 1. retire les marqueurs qui ne sont plus dans les résultats
  for (var k in ANN.markerIndex) {
    if (!wanted[k]) { group.removeLayer(ANN.markerIndex[k]); delete ANN.markerIndex[k]; }
  }
  // 2. crée uniquement les marqueurs manquants
  entries.forEach(function (en) {
    if (ANN.markerIndex[en.key]) { en.rec._marker = ANN.markerIndex[en.key]; return; }
    var m = L.circleMarker(en.latlng, {
      radius: 5, weight: 1, color: '#0f172a', fillColor: en.color, fillOpacity: 0.85
    });
    m.bindPopup(en.popup);
    m.addTo(group);
    ANN.markerIndex[en.key] = m;
    en.rec._marker = m;
  });
}
// Construit les entrées marqueur des associations (cap 2000)
function assoEntries(list, centroids, cap) {
  var out = [];
  list.slice(0, cap || 2000).forEach(function (a) {
    var c = centroids[a.n];
    if (!c) return; // pas de code INSEE → non localisable
    var th = annTheme(a);
    out.push({
      key: 'a:' + a.i, rec: a, latlng: c,
      color: th && th.p ? catColor(th.p) : '#60a5fa',
      popup: assoPopup(a, th)
    });
  });
  return out;
}
// Construit les entrées marqueur des entreprises (cap 2000)
function entEntries(list, cap) {
  var out = [];
  list.slice(0, cap || 2000).forEach(function (e) {
    var co = e.siege && e.siege.coordonnees;
    if (!co) return;
    var parts = String(co).split(',');
    var lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lon)) return;
    out.push({ key: 'e:' + e.siren, rec: e, latlng: [lat, lon], color: entColor(e), popup: entPopup(e) });
  });
  return out;
}

// ---------- Rendu liste de résultats ----------
function renderAnnList() {
  var box = document.getElementById('annResults');
  box.innerHTML = '';
  var max = 200;
  ANN.showing.slice(0, max).forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'ann-row';
    var head = document.createElement('div');
    var color = r.kind === 'ent' ? entColor(r.e) : (function () {
      var th = annTheme(r.a); return th && th.p ? catColor(th.p) : '#60a5fa';
    })();
    head.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + '"></span> <b>' +
      esc(r.kind === 'ent' ? r.e.nom_complet : r.a.t) + '</b>' +
      ' <span class="ann-type">' + (r.kind === 'ent' ? 'Entreprise' : 'Association') + '</span>';
    var sub = document.createElement('div');
    sub.className = 'ann-obj';
    sub.textContent = r.kind === 'ent'
      ? ((r.e.siege && r.e.siege.adresse) || '')
      : ((r.a.l || '') + (r.a.p ? ' (' + r.a.p + ')' : '') + (r.a.o ? ' — ' + r.a.o : ''));
    row.appendChild(head); row.appendChild(sub);
    row.addEventListener('click', function () {
      var mk = r.kind === 'ent' ? r.e._marker : r.a._marker;
      if (mk) { map.panTo(mk.getLatLng()); mk.openPopup(); }
    });
    box.appendChild(row);
  });
  if (ANN.showing.length > max) {
    var more = document.createElement('p');
    more.className = 'muted';
    more.textContent = '+' + (ANN.showing.length - max) + ' autres résultats (affinez la recherche)';
    box.appendChild(more);
  }
}

// ---------- Facette catégories ----------
function annRebuildCat() {
  var sel = document.getElementById('annCat');
  var type = document.getElementById('annType').value;
  var cur = sel.value;
  var opts = ['<option value="">Toutes catégories</option>'];
  if (type === 'ent') {
    for (var s in NAF_SECTIONS) opts.push('<option value="' + s + '">' + s + ' — ' + NAF_SECTIONS[s] + '</option>');
  } else {
    var counts = {};
    (ANN.assos[state.dep ? state.dep.code : ''] || []).forEach(function (a) {
      var th = annTheme(a);
      if (th && th.p) counts[th.p] = (counts[th.p] || 0) + 1;
    });
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (p) {
      opts.push('<option value="' + esc(p) + '">' + esc(p) + ' (' + counts[p] + ')</option>');
    });
  }
  sel.innerHTML = opts.join('');
  if (cur) sel.value = cur; // conserve le choix si encore présent
}

// ---------- Recherche et affichage ----------
function annApplySearch() {
  if (!ANN.active || state.view !== 'dep' || !state.dep) return;
  var token = ++ANN.seq;
  var q = parseAnnQuery(document.getElementById('annSearch').value);

  // interprétation en direct de la requête (feedback des opérateurs)
  var expEl = document.getElementById('annQueryExp');
  expEl.innerHTML = annQueryExplain(q);
  expEl.style.display = expEl.innerHTML ? '' : 'none';

  var type = document.getElementById('annType').value;
  var cat = document.getElementById('annCat').value;
  var code = state.dep.code;

  // PAS de clearAnnMarkers ici : les marqueurs sont mis à jour par différence
  // (annSyncMarkers) pour éviter le scintillement de la carte à chaque frappe.
  ANN.showing = [];
  var entries = [];
  var assoCount = 0;

  // --- Associations : filtrage local (données en cache) ---
  if (type !== 'ent') {
    var centroids = annCentroids(code);
    var list = (ANN.assos[code] || []).filter(function (a) {
      if (cat) {
        var th = annTheme(a);
        if (!th || th.p !== cat) return false;
      }
      return annMatch(annHaystack(a), q);
    });
    assoCount = list.length;
    list.slice(0, 2000).forEach(function (a) { ANN.showing.push({ kind: 'asso', a: a }); });
    entries = entries.concat(assoEntries(list, centroids, 2000));
  }

  // --- Entreprises : recherche texte via l'API (uniquement si requête) ---
  // res === null → pas de recherche entreprise lancée
  // res = { ents: [...] } | { err: 'message' }
  var entPromise;
  if (type === 'ent' || type === 'both') {
    if (q.req.length + q.or.length > 0) {
      var section = type === 'ent' ? cat : '';
      setStatus('⏳ Recherche entreprises…', 'loading');
      entPromise = searchEntreprises(code, q, section)
        .then(function (ents) { return { ents: ents }; })
        .catch(function (err) {
          console.error('[OpenFrance] Recherche entreprises :', err);
          return { err: err.message || String(err) };
        });
    }
  }

  var entCount = 0;
  (entPromise || Promise.resolve(null)).then(function (res) {
    if (token !== ANN.seq) return; // une recherche plus récente a pris le dessus
    var ents = res && res.ents, entErr = res && res.err;
    if (ents && ents.length) {
      entCount = ents.length;
      ents.slice(0, 2000).forEach(function (e) { ANN.showing.push({ kind: 'ent', e: e }); });
      entries = entries.concat(entEntries(ents, 2000));
    }
    annSyncMarkers(entries);
    renderAnnList();
    var parts = [];
    if (type !== 'ent' && assoCount) parts.push(assoCount.toLocaleString('fr-FR') + ' association(s)');
    if ((type === 'ent' || type === 'both') && res !== null) parts.push(entCount.toLocaleString('fr-FR') + ' entreprise(s)');
    if (entErr) parts.push('<span class="ann-warn">⚠️ Entreprises : ' + esc(entErr) + '</span>');
    var entHint = (res === null && (type === 'both' || type === 'ent'))
      ? ' — <i>saisissez un mot-clé : l\'API ne permet pas de lister tout un département</i>' : '';
    document.getElementById('annStatus').innerHTML = parts.join(' · ') +
      ((assoCount > 2000 || entCount > 2000) ? ' (marqueurs limités à 2000)' : '') + entHint;
    setStatus('Annuaire : ' + (assoCount + entCount).toLocaleString('fr-FR') + ' résultat(s)');
  });
}

// ---------- Vue France (mode annuaire) : sélection du département ----------
function annRenderFrance() {
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  geoLayer = L.geoJSON(state.geo, {
    style: { weight: 1, color: '#0f172a', fillColor: '#1d4ed8', fillOpacity: 0.25 },
    onEachFeature: function (feature, layer) {
      layer.bindTooltip('<b>' + feature.properties.nom + ' (' + feature.properties.code + ')</b><br>Cliquer pour charger l\'annuaire', { sticky: true });
      layer.on('click', function () { openDepartment(feature.properties.code, feature.properties.nom); });
    }
  }).addTo(map);
  document.getElementById('annStatus').textContent = 'Sélectionnez un département sur la carte.';
  document.getElementById('annResults').innerHTML = '';
  document.getElementById('levelTitle').textContent = 'Annuaire — France';
  setStatus('Annuaire — cliquez sur un département');
}

// ---------- refresh() du mode annuaire (remplace celui d'app.js) ----------
function annRefresh() {
  hideError();
  clearAnnMarkers();
  if (state.view === 'france' || !state.dep) { annRenderFrance(); return; }
  var code = state.dep.code;
  document.getElementById('levelTitle').textContent = 'Annuaire — ' + state.dep.nom + ' (' + code + ')';
  var geoPromise = state.communesGeo[code] ? Promise.resolve(state.communesGeo[code]) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[code] + '/communes-' + DEP_FOLDERS[code] + '.geojson')
      .then(function (g) { state.communesGeo[code] = g; return g; });
  setStatus('⏳ Chargement des associations…', 'loading');
  Promise.all([geoPromise, loadNomen()]).then(function (res) {
    return loadAssosDept(code).then(function (rows) {
      annRebuildCat();
      annApplySearch();
      // cadrage sur le département
      var cs = annCentroids(code), xs = [], ys = [];
      for (var k in cs) { xs.push(cs[k][1]); ys.push(cs[k][0]); }
      if (xs.length) map.fitBounds([[Math.min.apply(null, ys), Math.min.apply(null, xs)], [Math.max.apply(null, ys), Math.max.apply(null, xs)]], { padding: [30, 30] });
      var cached = ANN.assos[code] && ANN.assos[code].length;
      setStatus(cached.toLocaleString('fr-FR') + ' associations dans ' + state.dep.nom + ' (en cache)');
      // si la page cache est ouverte, la rafraîchir
      if (document.getElementById('annCacheDlg').style.display !== 'none') renderCachePage();
    });
  }).catch(function (err) {
    console.error('[OpenFrance] Annuaire :', err);
    showError('Impossible de charger les associations de ' + state.dep.nom + '.', err.message);
  });
}

// ============================================================
// PAGE DE GESTION GLOBALE DU CACHE (tous modes, tous départements)
// Réunit en une seule liste :
//  1. IndexedDB : associations par département + nomenclature WALDEC (national)
//     + recherches entreprises (une entrée par requête)
//  2. Cache disque du service worker (Cache API) : données nationales,
//     contours de communes par département, pages API
//  3. Mémoire vive (lecture seule, diagnostic)
// ============================================================

// ---- Inventaire du cache disque (service worker), groupé ----
var SW_FILE_LABELS = {
  'delinquance-dep.csv': 'Délinquance — CSV national',
  'departements.json': 'Contours des départements',
  'revenus.csv': 'Revenus Filosofi — CSV national',
  'dvf-stats.csv': 'Prix immobilier DVF — CSV national',
  'pres2022-t1.txt': 'Présidentielle 2022 T1 — national',
  'pres2022-t2.txt': 'Présidentielle 2022 T2 — national',
  'leg2024-t1.csv': 'Législatives 2024 T1 — national',
  'leg2024-t2.csv': 'Législatives 2024 T2 — national',
  'euro2024-dep.csv': 'Européennes 2024 — national'
};
var SW_API_LABELS = {
  '/api/communes': 'Délinquance communale — pages API',
  '/api/elect-gen': 'Élections — inscrits/abstentions, pages API',
  '/api/elect-cand': 'Élections — voix, pages API',
  '/api/assos': 'Annuaire — associations, pages API',
  '/api/nomen': 'Nomenclature WALDEC — pages API'
};

function swCacheGroups() {
  if (!window.caches) return Promise.resolve([]);
  return caches.open('openfrance-v1').then(function (cache) {
    return cache.keys().then(function (reqs) {
      var groups = {};
      reqs.forEach(function (req) {
        var p = new URL(req.url).pathname;
        var id, label, kind;
        if (p.indexOf('/data/') === 0) {
          var file = p.split('/').pop();
          id = 'data:' + file;
          label = SW_FILE_LABELS[file] || file;
          kind = 'data';
        } else if (p.indexOf('/geo/communes/departements/') === 0) {
          var folder = (p.split('/')[4] || '?');
          var dep = folder.split('-')[0];
          id = 'geo:' + dep;
          label = 'Contours des communes — ' + dep;
          kind = 'geo';
        } else {
          var found = null;
          for (var k in SW_API_LABELS) if (p.indexOf(k) === 0) found = k;
          id = 'api:' + (found || p);
          label = SW_API_LABELS[found] || p;
          kind = 'api';
        }
        if (!groups[id]) groups[id] = { id: id, label: label, kind: kind, reqs: [] };
        groups[id].reqs.push(req);
      });
      // taille réelle (somme des réponses)
      return Promise.all(Object.keys(groups).map(function (id) {
        var g = groups[id];
        return Promise.all(g.reqs.map(function (req) {
          return cache.match(req).then(function (res) {
            if (!res) return 0;
            return res.blob().then(function (b) { return b.size; }, function () { return 0; });
          });
        })).then(function (sizes) {
          var total = 0; sizes.forEach(function (s) { total += s; });
          g.count = g.reqs.length;
          g.size = total;
          return g;
        });
      }));
    });
  }).catch(function () { return []; });
}

function swPurge(group) {
  return caches.open('openfrance-v1').then(function (c) {
    return Promise.all(group.reqs.map(function (req) { return c.delete(req); }));
  });
}
// purge puis re-téléchargement en tâche de fond (le SW re-remplit son cache)
function swRefresh(group) {
  return swPurge(group).then(function () {
    group.reqs.forEach(function (req) { fetch(req.url).catch(function () {}); });
  });
}
// purge mémoire des textes déjà décodés (fetchCache de app.js)
function swPurgeMemory(urls) {
  urls.forEach(function (u) { delete fetchCache[u]; });
}

function memCacheStats() {
  var stats = {
    'Fichiers nationaux décodés (RAM)': Object.keys(fetchCache || {}).length + ' ressource(s)',
    'Contours communes en mémoire': Object.keys((state && state.communesGeo) || {}).length + ' département(s)',
    'Délinquance communale en mémoire': Object.keys((state && state.communesCache) || {}).length + ' dept/année(s)',
    'Élections communales en mémoire': Object.keys((typeof ELECAGR !== 'undefined' && ELECAGR.byDepElection) || {}).length + ' dept/élection(s)',
    'Recherches entreprises en mémoire': Object.keys(ANN.entCache).length + ' requête(s)'
  };
  return Object.keys(stats).map(function (k) { return k + ' : ' + stats[k]; });
}

function renderCachePage() {
  var box = document.getElementById('annCacheList');
  box.innerHTML = '<p class="muted">⏳ Lecture des caches…</p>';
  return Promise.all([
    // 1. IndexedDB
    idbKeys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return idbGet(k).then(function (v) { return { key: String(k), v: v }; }); }));
    }),
    // 2. Cache disque SW
    swCacheGroups(),
    // 3. RAM (instantané)
    Promise.resolve(memCacheStats())
  ]).then(function (res) {
    var idbEntries = res[0].sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    var groups = res[1].sort(function (a, b) {
      var order = { data: 0, geo: 1, api: 2 };
      if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
      return a.label < b.label ? -1 : 1;
    });
    var mem = res[2];
    var html = '';

    // --- Section 1 : IndexedDB ---
    html += '<h3 class="cache-h3">Associations, nomenclature & recherches entreprises (IndexedDB — persistant)</h3>';
    if (!idbEntries.length) {
      html += '<p class="muted">Aucune donnée. Ouvrez un département en mode annuaire ou lancez une recherche d\'entreprises.</p>';
    } else {
      idbEntries.forEach(function (e) {
        var label, detail;
        if (e.key === 'nomen') {
          label = 'Nomenclature WALDEC (national)';
          var n = e.v && e.v.child ? Object.keys(e.v.child).length : 0;
          detail = n.toLocaleString('fr-FR') + ' codes objets sociaux';
        } else if (e.key.indexOf('assos-') === 0) {
          var dep = e.key.slice(6);
          var rows = e.v && e.v.rows ? e.v.rows.length : 0;
          label = 'Associations — département ' + dep + (state.dep && state.dep.code === dep ? ' <span class="muted">(courant)</span>' : '');
          detail = rows.toLocaleString('fr-FR') + ' associations';
        } else if (e.key.indexOf('ent-') === 0) {
          var c = e.v || {};
          label = 'Recherche entreprises — ' + (c.dep || '?') +
            ' · « ' + esc((c.terms || []).join(' ')) + ' »' +
            (c.section ? ' · section NAF ' + esc(c.section) : '');
          detail = ((c.rows || []).length).toLocaleString('fr-FR') + ' entreprise(s)';
        } else {
          label = e.key;
          detail = '';
        }
        var d = e.v && e.v.date ? new Date(e.v.date).toLocaleString('fr-FR') : '?';
        var size = 0;
        try { size = e.v ? JSON.stringify(e.v).length : 0; } catch (er) { size = 0; }
        html += '<div class="cache-row">' +
          '<div class="cache-info"><b>' + label + '</b>' +
          '<br><span class="muted">' + detail + ' · ' + fmtSize(size) + ' · ' + esc(d) + '</span></div>' +
          '<div class="cache-actions">' +
          '<button class="cache-btn" type="button" data-type="idb" data-id="' + esc(e.key) + '" data-act="reload">🔄 Rafraîchir</button>' +
          '<button class="cache-btn cache-purge" type="button" data-type="idb" data-id="' + esc(e.key) + '" data-act="purge">🗑</button>' +
          '</div></div>';
      });
    }

    // --- Section 2 : cache disque service worker ---
    html += '<h3 class="cache-h3">Cache disque (service worker)' +
      (groups.length ? ' <button class="cache-btn cache-purge" type="button" data-type="swall" data-act="purge">Tout purger</button>' : '') +
      '</h3>';
    if (!groups.length) {
      html += '<p class="muted">' + (window.caches ? 'Cache disque vide — il se remplit à la navigation.' : 'Cache API indisponible (contexte non sécurisé ou navigateur ancien).') + '</p>';
    } else {
      groups.forEach(function (g) {
        var canRefresh = g.kind === 'data'; // un seul fichier national : purge + re-téléchargement immédiat
        html += '<div class="cache-row">' +
          '<div class="cache-info"><b>' + esc(g.label) + '</b>' +
          '<br><span class="muted">' + g.count + ' entrée(s) · ' + fmtSize(g.size) + '</span></div>' +
          '<div class="cache-actions">' +
          (canRefresh ? '<button class="cache-btn" type="button" data-type="sw" data-id="' + esc(g.id) + '" data-act="refresh">🔄 Rafraîchir</button>' : '') +
          '<button class="cache-btn cache-purge" type="button" data-type="sw" data-id="' + esc(g.id) + '" data-act="purge">🗑</button>' +
          '</div></div>';
      });
    }

    // --- Section 3 : mémoire vive ---
    html += '<h3 class="cache-h3">Mémoire vive (session en cours, non persistant)</h3>';
    html += '<p class="muted">' + mem.map(esc).join('<br>') + '</p>';

    box.innerHTML = html;
  }).catch(function (err) {
    box.innerHTML = '<p class="ann-warn">⚠️ Erreur de lecture du cache : ' + esc(err.message || String(err)) + '</p>';
  });
}

function annToggleCache(show) {
  var dlg = document.getElementById('annCacheDlg');
  var visible = show === undefined ? dlg.style.display === 'none' : show;
  dlg.style.display = visible ? 'flex' : 'none';
  if (visible) renderCachePage();
}

// Action centrale de la page cache (déléguée aux boutons)
function annCacheButtonAction(btn) {
  var act = btn.dataset.act, type = btn.dataset.type, id = btn.dataset.id;
  var after = function (msg) {
    setStatus(msg || 'Cache mis à jour');
    renderCachePage();
  };
  if (type === 'idb') {
    if (id.indexOf('assos-') === 0) {
      var dep = id.slice(6);
      idbDelete(id).then(function () {
        delete ANN.assos[dep];
        if (act === 'reload') {
          setStatus('⏳ Rechargement des associations du ' + dep + '…', 'loading');
          annReloadDept(dep).then(function () {
            after('Associations du ' + dep + ' rechargées (' + (ANN.assos[dep] || []).length.toLocaleString('fr-FR') + ')');
            if (ANN.active && state.dep && state.dep.code === dep) annApplySearch();
          }).catch(function (err) {
            showError('Impossible de recharger les associations du ' + dep + '.', err.message);
            renderCachePage();
          });
        } else {
          after('Cache des associations du ' + dep + ' supprimé (rechargé à la prochaine ouverture)');
          if (ANN.active && state.dep && state.dep.code === dep) annApplySearch();
        }
      });
    } else if (id === 'nomen') {
      idbDelete('nomen').then(function () {
        ANN.nomen = null;
        if (act === 'reload') {
          setStatus('⏳ Rechargement de la nomenclature WALDEC…', 'loading');
          loadNomen().then(function () {
            after('Nomenclature WALDEC rechargée');
            if (ANN.active && state.dep) annRebuildCat();
          }).catch(function (err) {
            showError('Impossible de recharger la nomenclature WALDEC.', err.message);
            renderCachePage();
          });
        } else {
          after('Nomenclature WALDEC supprimée du cache (rechargée à la prochaine utilisation)');
        }
      });
    } else if (id.indexOf('ent-') === 0) {
      idbGet(id).then(function (v) {
        var c = v || {};
        var ramKey = id.slice(4); // ent-<dep|terms|section>
        return idbDelete(id).then(function () {
          if (ANN.entCache[ramKey]) delete ANN.entCache[ramKey];
          if (act === 'reload' && c.dep && c.q) {
            setStatus('⏳ Relance de la recherche entreprises…', 'loading');
            return searchEntreprises(c.dep, c.q, c.section).then(function (rows) {
              after('Recherche entreprises rechargée (' + rows.length.toLocaleString('fr-FR') + ' entreprise(s))');
            }, function (err) {
              showError('Impossible de relancer la recherche entreprises.', err.message);
              renderCachePage();
            });
          }
          after('Cache de la recherche entreprises supprimé (relancée à la prochaine saisie)');
        });
      });
    }
  } else if (type === 'sw') {
    swCacheGroups().then(function (groups) {
      var g = null;
      for (var i = 0; i < groups.length; i++) if (groups[i].id === id) g = groups[i];
      if (!g) { renderCachePage(); return; }
      var urls = g.reqs.map(function (r) { return r.url; });
      // purge aussi la mémoire des fichiers déjà décodés pour forcer le re-téléchargement
      var p = swPurge(g).then(function () { swPurgeMemory(urls); });
      if (act === 'refresh') {
        setStatus('⏳ Re-téléchargement de « ' + g.label + ' »…', 'loading');
        p = p.then(function () {
          g.reqs.forEach(function (req) { fetch(req.url).catch(function () {}); });
        });
      }
      p.then(function () { after('« ' + g.label + ' » : cache disque ' + (act === 'refresh' ? 'rafraîchi' : 'purge') + ' (retéléchargé à la prochaine utilisation)'); });
    });
  } else if (type === 'swall') {
    setStatus('⏳ Purge du cache disque…', 'loading');
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) { return caches.delete(n); }));
    }).then(function () {
      for (var k in fetchCache) delete fetchCache[k];
      after('Cache disque entièrement vidé — les données seront retéléchargées à la prochaine utilisation');
    });
  }
}

// ---------- Entrée / sortie du mode annuaire ----------
function annEnter() {
  ANN.active = true;
  ANN.prevRefresh = refresh;
  refresh = annRefresh; // openDepartment/backToFrance appellent refresh()
  document.getElementById('annControls').style.display = 'flex';
  document.getElementById('annHint').style.display = '';
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('annPanel').style.display = '';
  // On conserve le département sélectionné (s'il y en a un) : on reste sur
  // le territoire en cours, sinon on repart de la vue France.
  if (state.view === 'dep' && state.dep) {
    document.getElementById('backBtn').hidden = false;
    document.getElementById('levelTitle').textContent = 'Annuaire — ' + state.dep.nom + ' (' + state.dep.code + ')';
  } else {
    state.view = 'france'; state.dep = null;
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'Annuaire — France';
  }
  loadNomen().catch(function (err) { console.warn('[OpenFrance] Nomenclature WALDEC :', err); });
  annRefresh();
}
function annLeave() {
  ANN.active = false;
  if (ANN.prevRefresh) refresh = ANN.prevRefresh;
  clearAnnMarkers();
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  var expEl2 = document.getElementById('annQueryExp');
  expEl2.innerHTML = ''; expEl2.style.display = 'none';
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('annPanel').style.display = 'none';
  // Restaure le titre correspondant au territoire conservé (le département
  // n'est PAS réinitialisé : app.js gère la suite via selectIndicator(…, keepDep))
  if (state.view === 'dep' && state.dep) {
    document.getElementById('levelTitle').textContent = state.dep.nom + ' (' + state.dep.code + ') — par commune';
  } else {
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'France — par département';
  }
}

// ---------- Branchement UI ----------
function annInitUI() {
  var catSel = document.getElementById('categorySelect');
  catSel.addEventListener('change', function () {
    if (this.value === 'annuaire') annEnter(); else if (ANN.active) annLeave();
  });

  var searchEl = document.getElementById('annSearch');
  var debounce = null;
  searchEl.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(annApplySearch, 300);
  });
  searchEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(debounce); annApplySearch(); }
  });
  document.getElementById('annSearchBtn').addEventListener('click', function () {
    clearTimeout(debounce); annApplySearch();
  });
  document.getElementById('annType').addEventListener('change', function () {
    annRebuildCat();
    annApplySearch();
  });
  document.getElementById('annCat').addEventListener('change', annApplySearch);

  // Page de gestion du cache (globale, disponible dans tous les modes)
  document.getElementById('annCacheBtn').addEventListener('click', function () { annToggleCache(); });
  document.getElementById('annCacheClose').addEventListener('click', function () { annToggleCache(false); });
  document.getElementById('annCacheDlg').addEventListener('click', function (e) {
    if (e.target === this) annToggleCache(false); // clic sur le fond
  });
  document.getElementById('annCacheList').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    annCacheButtonAction(btn);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', annInitUI);
} else {
  annInitUI();
}
