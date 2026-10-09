// OpenFrance — Annuaire : associations (RNA/Waldec) + entreprises (API Recherche d'entreprises)
//
// Sources (proxifiées via Netlify, même origine) :
//  - Associations : RNA agrégé national (Waldec) via l'API tabulaire data.gouv
//    → chargement par département (communes INSEE du département), cache IndexedDB.
//  - Thèmes : nomenclature WALDEC (objet social code → libellé, thème parent)
//  - Entreprises : API Recherche d'entreprises (DINUM) — recherche texte par département.
//
// Recherche multi-mots-clés (locale, sur les données du département en cache) :
//   ninjutsu + mma - boxe
//   → « ninjutsu » OU « mma », mais sans « boxe »
//   mots simples = tous requis (ET) · +mot = OU (au moins un) · -mot = exclusion

var ANN = {
  active: false,
  prevRefresh: null,
  assos: {},          // dep -> [{ i,t,o,c,n,l,p,w }]
  nomen: null,        // { child: { codeNum -> { p, l } } }
  centroids: {},      // dep -> { codeCommune -> [lat, lng] }
  entCache: {},       // "dep|q|section" -> rows
  markers: null,      // featureGroup des marqueurs courants
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
function normTxt(s) {
  s = String(s == null ? '' : s).toLowerCase();
  if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// Analyse d'une requête « a b +c -d "e f" »
function parseAnnQuery(str) {
  var req = [], or = [], neg = [];
  var tokens = String(str || '').match(/"[^"]*"|\S+/g) || [];
  tokens.forEach(function (tok) {
    var sign = '';
    if (tok.charAt(0) === '-') { sign = 'neg'; tok = tok.slice(1); }
    else if (tok.charAt(0) === '+') { sign = 'or'; tok = tok.slice(1); }
    tok = normTxt(tok.replace(/"/g, ''));
    if (!tok) return;
    if (sign === 'neg') { if (neg.indexOf(tok) === -1) neg.push(tok); }
    else if (sign === 'or') { if (or.indexOf(tok) === -1) or.push(tok); }
    else { if (req.indexOf(tok) === -1) req.push(tok); }
  });
  return { req: req, or: or, neg: neg };
}

// haystack pré-normalisé, mis en cache sur l'enregistrement
function annHaystack(a) {
  if (!a._h) a._h = normTxt(a.t + ' ' + (a.o || '') + ' ' + (a.l || ''));
  return a._h;
}
function annMatch(h, q) {
  for (var i = 0; i < q.req.length; i++) if (h.indexOf(q.req[i]) === -1) return false;
  if (q.or.length) {
    var ok = false;
    for (var j = 0; j < q.or.length; j++) if (h.indexOf(q.or[j]) !== -1) { ok = true; break; }
    if (!ok) return false;
  }
  for (var k = 0; k < q.neg.length; k++) if (h.indexOf(q.neg[k]) !== -1) return false;
  return true;
}

// ---------- IndexedDB (cache persistant par département) ----------
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

// ---------- Nomenclature WALDEC (thèmes) ----------
function loadNomen() {
  if (ANN.nomen) return Promise.resolve();
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
    ANN.nomen = { child: child };
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
function fetchEntPages(base) {
  function page(p) { return fetch(base + '&page=' + p).then(function (r) { return r.json(); }); }
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

function searchEntreprises(dep, q, section) {
  var terms = q.req.concat(q.or).filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (!terms.length) return Promise.resolve([]);
  var key = dep + '|' + terms.join(' ') + '|' + (section || '');
  if (ANN.entCache[key]) return Promise.resolve(ANN.entCache[key]);
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
    // Tous les termes requis doivent matcher (chaque terme = un appel séparé)
    var out = [];
    for (var s in bySiren) {
      if (q.req.length > 1 && counts[s] < q.req.length) continue;
      var e = bySiren[s];
      var h = normTxt((e.nom_complet || '') + ' ' + ((e.siege && e.siege.adresse) || '') + ' ' + ((e.siege && e.siege.activite_principale) || ''));
      var bad = false;
      for (var k = 0; k < q.neg.length; k++) if (h.indexOf(q.neg[k]) !== -1) { bad = true; break; }
      if (!bad) out.push(e);
    }
    ANN.entCache[key] = out;
    return out;
  });
}

// ---------- Rendu carte ----------
function clearAnnMarkers() {
  if (ANN.markers) { map.removeLayer(ANN.markers); ANN.markers = null; }
  ANN.showing = [];
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

function addAssoMarkers(list, centroids, cap) {
  var max = cap || 2000;
  var shown = list.slice(0, max);
  shown.forEach(function (a) {
    var c = centroids[a.n];
    if (!c) return; // pas de code INSEE → non localisable
    var th = annTheme(a);
    var m = L.circleMarker(c, {
      radius: 5, weight: 1, color: '#0f172a',
      fillColor: th && th.p ? catColor(th.p) : '#60a5fa', fillOpacity: 0.85
    });
    m.bindPopup(assoPopup(a, th));
    m.addTo(ANN.markers);
    a._marker = m;
  });
  return shown;
}
function addEntMarkers(list) {
  list.forEach(function (e) {
    var co = e.siege && e.siege.coordonnees;
    if (!co) return;
    var parts = String(co).split(',');
    var lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lon)) return;
    var m = L.circleMarker([lat, lon], {
      radius: 5, weight: 1, color: '#0f172a', fillColor: entColor(e), fillOpacity: 0.85
    });
    m.bindPopup(entPopup(e));
    m.addTo(ANN.markers);
    e._marker = m;
  });
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
  var type = document.getElementById('annType').value;
  var cat = document.getElementById('annCat').value;
  var code = state.dep.code;

  clearAnnMarkers();
  ANN.markers = L.featureGroup().addTo(map);
  ANN.showing = [];
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
    var capped = addAssoMarkers(list, centroids, 2000);
    capped.forEach(function (a) { ANN.showing.push({ kind: 'asso', a: a }); });
  }

  // --- Entreprises : recherche texte via l'API (uniquement si requête) ---
  var entPromise;
  if (type === 'ent' || type === 'both') {
    if (q.req.length + q.or.length > 0) {
      var section = type === 'ent' ? cat : '';
      setStatus('⏳ Recherche entreprises…', 'loading');
      entPromise = searchEntreprises(code, q, section).catch(function (err) {
        console.error('[OpenFrance] Recherche entreprises :', err);
        return [];
      });
    } else {
      document.getElementById('annStatus').innerHTML =
        (assoCount ? assoCount.toLocaleString('fr-FR') + ' association(s)' : '') +
        (type === 'both' || type === 'ent' ? ' — <i>saisissez un mot-clé pour chercher des entreprises</i>' : '');
    }
  }

  var entCount = 0;
  (entPromise || Promise.resolve(null)).then(function (ents) {
    if (token !== ANN.seq) return; // une recherche plus récente a pris le dessus
    if (ents && ents.length) {
      entCount = ents.length;
      addEntMarkers(ents);
      ents.forEach(function (e) { ANN.showing.push({ kind: 'ent', e: e }); });
    }
    renderAnnList();
    var parts = [];
    if (type !== 'ent' && assoCount) parts.push(assoCount.toLocaleString('fr-FR') + ' association(s)');
    if ((type === 'ent' || type === 'both') && (ents || entCount)) parts.push(entCount.toLocaleString('fr-FR') + ' entreprise(s)');
    var entHint = (ents === null && (type === 'both' || type === 'ent'))
      ? ' — <i>saisissez un mot-clé pour chercher des entreprises</i>' : '';
    document.getElementById('annStatus').innerHTML = parts.join(' · ') +
      ((assoCount > 2000 || entCount > 2000) ? ' (marqueurs limités à 2000)' : '') + entHint;
    setStatus('Annuaire : ' + (assoCount + entCount).toLocaleString('fr-FR') + ' résultat(s)');
  });

  if (!entPromise) {
    renderAnnList();
    setStatus('Annuaire : ' + assoCount.toLocaleString('fr-FR') + ' association(s)');
  }
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
  setStatus('Annuaire — cliquez sur un département');
}

// ---------- refresh() du mode annuaire (remplace celui d'app.js) ----------
function annRefresh() {
  hideError();
  clearAnnMarkers();
  if (state.view === 'france' || !state.dep) { annRenderFrance(); return; }
  var code = state.dep.code;
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
    });
  }).catch(function (err) {
    console.error('[OpenFrance] Annuaire :', err);
    showError('Impossible de charger les associations de ' + state.dep.nom + '.', err.message);
  });
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
  // retour à la vue France
  state.view = 'france'; state.dep = null;
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'Annuaire — France';
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
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('annPanel').style.display = 'none';
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
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', annInitUI);
} else {
  annInitUI();
}
