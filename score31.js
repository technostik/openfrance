// OpenFrance — Score perso : indice ad hoc des communes de la Haute-Garonne (31)
// Indice composite pondérable en temps réel (sliders) :
//   📍 proximité de Toulouse — distance haversine entre centroïdes (bbox, comme l'annuaire)
//   🛡 sécurité — taux de délinquance pour 1 000 hab (ensemble des faits, dernière année dispo)
//   💰 loyers — loyer d'annonce prédit €/m² appartements (« Carte des loyers », MTE, millésime 2025)
//   🥋 clubs — associations RNA du 31 correspondant à la requête (défaut : « mma + systema + ninjutsu »)
// Dépend de app.js (state, DELINQ, loadCommunesDelinquance, colorFor, setStatus, showError,
// hideError, fmt, fmt1, map, geoLayer) et annuaire.js (ANN, loadAssosDept, annCentroids,
// parseAnnQuery, annMatch, annHaystack, esc). Source loyers via proxy /api/loyers/ (netlify.toml).

var SC = {
  active: false,
  DEP: '31',
  TLOU: '31555',        // code INSEE de Toulouse
  geo: null,
  centroids: null,
  tlse: null,           // [lat, lng] centroïde de Toulouse
  annee: null,          // année délinquance utilisée
  taux: {},             // code commune -> taux ‰ (ensemble des faits)
  loyers: {},           // code commune -> €/m² prédit
  clubCounts: {},       // code commune -> nb d'associations matchant la requête clubs
  data: {},             // code commune -> { nom, dist, taux, loyer, clubs, parts, score }
  best: null,           // code de la meilleure commune (affichée en bleu)
  layer: null,
  loaded: false
};

var SC_BLUE = '#2563eb';

function scoreIsActive() { return SC.active; }

// ---------- Normalisation robuste (P5–P95 avec saturation, comme scaleBounds) ----------
function scBounds(vals) {
  var v = vals.filter(function (x) { return x !== null && x !== undefined; }).sort(function (a, b) { return a - b; });
  if (!v.length) return { lo: 0, hi: 1 };
  var lo = v[Math.floor((v.length - 1) * 0.05)];
  var hi = v[Math.floor((v.length - 1) * 0.95)];
  if (hi <= lo) { lo = v[0]; hi = v[v.length - 1]; }
  if (hi <= lo) hi = lo + 1;
  return { lo: lo, hi: hi };
}
function scPart(v, b, lowerBetter) {
  if (v === null || v === undefined) return null;
  var t = Math.max(0, Math.min(1, (v - b.lo) / (b.hi - b.lo)));
  return lowerBetter ? 1 - t : t;
}
function scDistKm(a, b) { // haversine, a/b = [lat, lng]
  var R = 6371;
  var dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------- Chargement des données ----------
function scLoadLoyers() {
  var base = '/api/loyers/?DEP__exact=31&page_size=200';
  function page(p) {
    return fetch(base + '&page=' + p).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' (loyers, page ' + p + ')');
      return res.json();
    });
  }
  return page(1).then(function (j) {
    var rows = (j.data || []).slice();
    var total = (j.meta && j.meta.total) || rows.length;
    var npages = Math.max(1, Math.ceil(total / 200));
    var rest = [];
    for (var p = 2; p <= npages; p++) rest.push(p); // pagination manuelle, jamais links.next
    return Promise.all(rest.map(page)).then(function (js) {
      js.forEach(function (j2) { (j2.data || []).forEach(function (r) { rows.push(r); }); });
      rows.forEach(function (r) {
        var code = String(r.INSEE_C || '').trim();
        var v = parseFloat(r.loypredm2);
        if (code && !isNaN(v)) SC.loyers[code] = v;
      });
    });
  });
}

function scEnsure() {
  if (SC.loaded) return Promise.resolve();
  var annee = 0;
  DELINQ.allRows.forEach(function (r) { if (r.annee > annee) annee = r.annee; });
  SC.annee = annee;
  setStatus('⏳ Score perso : contours + délinquance ' + annee + '…', 'loading');
  // loadCommunesDelinquance charge aussi state.communesGeo['31'] (requis par loadAssosDept)
  return loadCommunesDelinquance(SC.DEP, annee).then(function (entry) {
    SC.geo = state.communesGeo[SC.DEP];
    SC.centroids = annCentroids(SC.DEP);
    SC.tlse = SC.centroids[SC.TLOU];
    if (!SC.tlse) throw new Error('Toulouse (' + SC.TLOU + ') introuvable dans les contours du 31');
    entry.totals.forEach(function (r) { if (r.annee === annee) SC.taux[r.zone] = r.taux; });
    setStatus('⏳ Score perso : loyers (Carte des loyers 2025)…', 'loading');
    return scLoadLoyers();
  }).then(function () {
    setStatus('⏳ Score perso : associations du 31 (RNA)…', 'loading');
    return loadAssosDept(SC.DEP);
  }).then(function () {
    scComputeClubs();
    SC.loaded = true;
  });
}

// Comptage des « clubs » : associations RNA du 31 matchant la requête multi-opérateurs
function scComputeClubs() {
  var q = parseAnnQuery(document.getElementById('scQuery').value);
  var counts = {};
  (ANN.assos[SC.DEP] || []).forEach(function (a) {
    if (!annMatch(annHaystack(a), q)) return;
    var c = String(a.n || '').trim();
    if (c) counts[c] = (counts[c] || 0) + 1;
  });
  SC.clubCounts = counts;
}

// ---------- Score ----------
function scWeights() {
  return {
    dist: parseFloat(document.getElementById('scDist').value) || 0,
    secu: parseFloat(document.getElementById('scSecu').value) || 0,
    loyer: parseFloat(document.getElementById('scLoyer').value) || 0,
    clubs: parseFloat(document.getElementById('scClubs').value) || 0
  };
}
function scWeightsSummary() {
  var w = scWeights();
  return '📍' + w.dist + ' · 🛡' + w.secu + ' · 💰' + w.loyer + ' · 🥋' + w.clubs;
}

function scCompute() {
  var w = scWeights();
  var dists = [], tauxs = [], loyers = [];
  var data = {};
  (SC.geo.features || []).forEach(function (f) {
    var code = f.properties.code;
    var c = SC.centroids[code];
    var d = (c && SC.tlse) ? scDistKm(c, SC.tlse) : null;
    var t = Object.prototype.hasOwnProperty.call(SC.taux, code) ? SC.taux[code] : null;
    var l = Object.prototype.hasOwnProperty.call(SC.loyers, code) ? SC.loyers[code] : null;
    var cl = SC.clubCounts[code] || 0;
    if (d !== null) dists.push(d);
    if (t !== null) tauxs.push(t);
    if (l !== null) loyers.push(l);
    data[code] = { nom: f.properties.nom, dist: d, taux: t, loyer: l, clubs: cl };
  });
  var bD = scBounds(dists), bT = scBounds(tauxs), bL = scBounds(loyers);
  var best = null;
  for (var code in data) {
    var e = data[code];
    var pD = scPart(e.dist, bD, true);   // plus près = mieux
    var pT = scPart(e.taux, bT, true);   // moins de délinquance = mieux
    var pL = scPart(e.loyer, bL, true);  // loyer plus bas = mieux
    var pC = Math.min(1, e.clubs / 3);   // 3 clubs ou plus = score max
    e.parts = { dist: pD, secu: pT, loyer: pL, clubs: pC };
    var pairs = [[pD, w.dist], [pT, w.secu], [pL, w.loyer], [pC, w.clubs]];
    var sum = 0, wsum = 0;
    pairs.forEach(function (pair) {
      if (pair[1] <= 0) return;
      var p = pair[0] === null ? 0.5 : pair[0]; // donnée absente → neutre (pas de pénalité)
      sum += pair[1] * p;
      wsum += pair[1];
    });
    e.score = wsum > 0 ? sum / wsum : 0;
    if (!best || e.score > data[best].score) best = code;
  }
  SC.data = data;
  SC.best = best;
}

// ---------- Rendu ----------
function scStyleFor(code) {
  if (code === SC.best) return { weight: 2.5, color: '#ffffff', fillColor: SC_BLUE, fillOpacity: 0.95 };
  var e = SC.data[code];
  if (!e) return { weight: 1, color: '#0f172a', fillColor: '#334155', fillOpacity: 0.4 };
  return { weight: 1, color: '#0f172a', fillColor: colorFor(1 - e.score), fillOpacity: 0.85 };
}
function scTooltip(code) {
  var e = SC.data[code];
  if (!e) return '<b>' + esc(code) + '</b><br><i>Pas de données</i>';
  var txt = '<b>' + esc(e.nom) + '</b>' + (code === SC.best ? ' 🏆' : '');
  txt += '<br>Score : <b>' + Math.round(e.score * 100) + ' / 100</b>';
  txt += '<br>📍 ' + (e.dist === null ? 'n.d.' : fmt1(e.dist) + ' km de Toulouse');
  txt += '<br>🛡 ' + (e.taux === null ? 'n.d. (non diffusé)' : fmt1(e.taux) + ' ‰ (délinquance ' + SC.annee + ')');
  txt += '<br>💰 ' + (e.loyer === null ? 'n.d.' : fmt(e.loyer) + ' €/m² (loyer prédit)');
  txt += '<br>🥋 ' + e.clubs + ' club(s) trouvé(s)';
  return txt;
}

function scSidepanel() {
  document.getElementById('legendTitle').textContent = 'Score perso (0–100) — ' + scWeightsSummary();
  var legend = document.getElementById('legend');
  legend.innerHTML = '';
  for (var c = 0; c < 6; c++) {
    var row = document.createElement('div');
    row.className = 'legend-row';
    var swatch = document.createElement('span');
    swatch.className = 'legend-color';
    swatch.style.background = colorFor((c + 0.5) / 6); // vert (bon score) → rouge (mauvais)
    var label = document.createElement('span');
    label.textContent = c === 0 ? 'Score élevé' : (c === 5 ? 'Score faible' : '');
    row.appendChild(swatch); row.appendChild(label);
    legend.appendChild(row);
  }
  var win = document.createElement('div');
  win.className = 'sc-winline';
  var e = SC.data[SC.best];
  win.innerHTML = '🏆 <b>' + (e ? esc(e.nom) : '—') + '</b>' + (e ? ' — ' + Math.round(e.score * 100) + ' / 100' : '');
  legend.appendChild(win);

  document.getElementById('topTitle').textContent = 'Top 10 communes';
  var top = document.getElementById('toplist');
  top.innerHTML = '';
  var list = Object.keys(SC.data).map(function (c) { return { c: c, s: SC.data[c].score }; });
  list.sort(function (a, b) { return b.s - a.s; });
  list.slice(0, 10).forEach(function (d, i) {
    var row2 = document.createElement('div');
    row2.className = 'top-row' + (d.c === SC.best ? ' sc-win' : '');
    var sp = document.createElement('span');
    sp.textContent = (i + 1) + '. ' + SC.data[d.c].nom;
    var v = document.createElement('span');
    v.innerHTML = '<b>' + Math.round(d.s * 100) + '</b>';
    row2.appendChild(sp); row2.appendChild(v);
    top.appendChild(row2);
  });
}

function scRender() {
  if (SC.layer) { map.removeLayer(SC.layer); SC.layer = null; }
  scCompute();
  SC.layer = L.geoJSON(SC.geo, {
    style: function (f) { return scStyleFor(f.properties.code); },
    onEachFeature: function (f, l) {
      l.bindTooltip(function () { return scTooltip(f.properties.code); }, { sticky: true });
    }
  }).addTo(map);
  map.fitBounds(SC.layer.getBounds(), { padding: [30, 30] });
  scSidepanel();
  setStatus(Object.keys(SC.data).length + ' communes du 31 scorées — bougez les curseurs !');
}

// Mise à jour temps réel : recalcul (rapide, ~600 communes) puis re-style en place,
// sans recréer la couche Leaflet.
function scUpdateLive() {
  if (!SC.layer) return;
  scCompute();
  SC.layer.eachLayer(function (l) {
    if (l.feature) l.setStyle(scStyleFor(l.feature.properties.code));
  });
  scSidepanel();
}

// ---------- Entrée / sortie du mode ----------
function scoreEnter() {
  SC.active = true;
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  document.getElementById('annPanel').style.display = 'none';
  document.getElementById('scoreControls').style.display = 'flex';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'Score perso — Haute-Garonne (31)';
  state.view = 'france'; state.dep = null;
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  hideError();
  scEnsure().then(function () {
    scRender();
  }).catch(function (err) {
    console.error('[OpenFrance] Score perso :', err);
    showError('Impossible de charger les données du score perso.', err.message);
  });
}

function scoreLeave() {
  SC.active = false;
  if (SC.layer) { map.removeLayer(SC.layer); SC.layer = null; }
  document.getElementById('scoreControls').style.display = 'none';
  // Si l'annuaire reprend la main, c'est lui qui gère l'UI partagée.
  if (state.category !== 'annuaire') {
    document.getElementById('indicatorLabel').style.display = '';
    document.getElementById('legendBlock').style.display = '';
    if (state.view === 'dep' && state.dep) {
      document.getElementById('levelTitle').textContent = state.dep.nom + ' (' + state.dep.code + ') — par commune';
    } else {
      document.getElementById('backBtn').hidden = true;
      document.getElementById('levelTitle').textContent = 'France — par département';
    }
  }
}

// ---------- Branchement UI ----------
(function () {
  ['scDist', 'scSecu', 'scLoyer', 'scClubs'].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener('input', function () {
      document.getElementById(id + 'V').textContent = el.value;
      scUpdateLive();
    });
  });
  var q = document.getElementById('scQuery');
  var deb = null;
  function applyQuery() { scComputeClubs(); scUpdateLive(); }
  q.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(applyQuery, 300); });
  q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(deb); applyQuery(); } });
})();
