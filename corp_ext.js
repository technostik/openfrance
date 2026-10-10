// OpenFrance — Recherche étendue d'entreprises : ROMEO → ROME 4.0 → La Bonne Boite → listes curatées
//
// Principe : l'utilisateur décrit un métier en texte libre (« intelligence artificielle »),
// choisit une ville cible et un rayon. Pipeline :
//  1. ROMEO (France Travail, via /ft/ft?op=romeo) prédit les codes ROME du texte ;
//  2. clic sur un métier → fiche ROME 4.0 (compétences, via /ft/ft?op=fiche) ;
//  3. La Bonne Boite (via /ft/ft?op=lbb) liste les entreprises qui recrutent sur ces
//     codes ROME autour de la ville cible ;
//  4. croisement avec les listes curatées (Airtable via /ft/airtable, ex. French Tech
//     2030) → badge 🏆 sur la carte et dans la liste (signal certain).
//
// ⚠️ Contraintes (vérifiées empiriquement le 10/10/2026, voir docs/ETAT-PROJET.md) :
//  - La Bonne Boite renvoie 403 insufficient_scope tant que l'abonnement n'est pas
//    provisionné côté francetravail.io → dégradation gracieuse : message + métiers
//    ROME affichés quand même. La forme exacte de la réponse LBB est inconnue : le
//    normalisateur (netlify/functions/ft.js) est tolérant, à ajuster si besoin.
//  - Les fonctions Netlify sont servies sous /ft/* : le service worker ne les met PAS
//    en cache (seuls /api/, /data/, /geo/ le sont) → résultats frais à chaque recherche.
//
// Dépend de app.js (state, map, geoLayer, DEP_FOLDERS, fetchJSONCached, setStatus,
// showError, hideError), annuaire.js (esc, normTxt, annCentroids) et corp.js (coDepLabel).

var EXT = {
  active: false,
  dep: '31',
  target: null,          // { code, nom, latlng } — ville cible
  radius: 10,            // km
  geo: null, geoDep: null, cities: [], centroids: null,
  metiers: [],            // prédictions ROME en cours
  curated: null,         // cache (promesse) des listes curatées Airtable
  seq: 0,
  markers: null, markerBySiren: {}, circle: null, targetMk: null,
  uiReady: false
};

var EXT_TOP_ROME = 3;      // codes ROME transmis à La Bonne Boite
var EXT_MAX_LIST = 300;   // lignes affichées dans la liste

// ---------- Utilitaires ----------
function extUrl(op, params) {
  var qs = [];
  for (var k in params) {
    var v = params[k];
    if (v !== undefined && v !== null && v !== '') qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return '/ft/ft?op=' + op + (qs.length ? '&' + qs.join('&') : '');
}
// Les erreurs applicatives du proxy arrivent en HTTP 200 {ok:false} : on les rejette
// avec une étiquette e.ft pour les distinguer des erreurs réseau/HTTP.
function extFetchJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url);
    return r.json();
  }).then(function (j) {
    if (j && j.ok === false) {
      var e = new Error(j.message || j.error || 'erreur proxy');
      e.ft = j;
      throw e;
    }
    return j;
  });
}

// ---------- Géographie du département (comme corp.js) ----------
function extEnsureGeo() {
  if (EXT.geo && EXT.dep === EXT.geoDep) return Promise.resolve();
  var dep = EXT.dep;
  var g = state.communesGeo[dep];
  var p = g ? Promise.resolve(g) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[dep] + '/communes-' + DEP_FOLDERS[dep] + '.geojson')
      .then(function (geo) { state.communesGeo[dep] = geo; return geo; });
  return p.then(function (geo) {
    if (EXT.dep !== dep) return; // département changé entre-temps
    EXT.geo = geo; EXT.geoDep = dep;
    EXT.centroids = annCentroids(dep);
    EXT.cities = (geo.features || []).map(function (f) {
      return { code: f.properties.code, nom: f.properties.nom, n: normTxt(f.properties.nom), latlng: EXT.centroids[f.properties.code] };
    }).filter(function (c) { return !!c.latlng; });
  });
}

// ---------- Autocomplete ville (comme corp.js) ----------
function extTargetSearch(q) {
  q = normTxt(q);
  if (!q) return [];
  var out = [];
  for (var i = 0; i < EXT.cities.length && out.length < 10; i++) {
    var c = EXT.cities[i];
    if (c.n.indexOf(q) !== -1) out.push(c);
  }
  return out;
}
function extTargetDropEl(show) {
  var d = document.getElementById('extTargetDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function extTargetRender(matches) {
  var d = document.getElementById('extTargetDrop');
  d.innerHTML = '';
  matches.forEach(function (m) {
    var row = document.createElement('div');
    row.innerHTML = esc(m.nom) + ' <span class="muted">(' + m.code + ')</span>';
    row.addEventListener('mousedown', function (ev) { // mousedown : avant le blur
      ev.preventDefault();
      extSetTarget(m.code, m.nom);
      extTargetDropEl(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}
function extSetTarget(code, nom) {
  var c = (EXT.centroids || {})[code];
  if (!c) return;
  EXT.target = { code: code, nom: nom, latlng: c };
  document.getElementById('extTarget').value = nom;
  extFrameZone(); // feedback immédiat : cercle de la zone sur la carte
}

// ---------- Listes curatées (Airtable, via fonction Netlify) ----------
function extCurated() {
  if (!EXT.curated) {
    EXT.curated = fetch('/ft/airtable').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' sur /ft/airtable');
      return r.json();
    }).then(function (j) {
      var bySiren = {};
      ((j && j.records) || []).forEach(function (rec) {
        if (rec.siren) bySiren[rec.siren] = rec;
      });
      return { bySiren: bySiren, count: ((j && j.records) || []).length };
    });
    EXT.curated.catch(function () { EXT.curated = null; }); // réessayé à la prochaine recherche
  }
  return EXT.curated;
}

// ---------- Recherche ----------
function extSearch() {
  if (!EXT.active) return;
  var text = (document.getElementById('extText').value || '').trim();
  var seq = ++EXT.seq;
  var status = document.getElementById('extStatus');
  extClearMap();
  document.getElementById('extMetiers').innerHTML = '';
  document.getElementById('extFiche').style.display = 'none';
  document.getElementById('extResults').innerHTML = '';
  if (!text) {
    status.textContent = 'Entrez un métier en texte libre (ex. « intelligence artificielle »).';
    return;
  }
  if (!EXT.target) {
    status.textContent = "Choisissez une ville cible — La Bonne Boite cherche par zone autour d'un point.";
    return;
  }
  status.textContent = '⏳ Prédiction des métiers (ROMEO)…';
  extFetchJson(extUrl('romeo', { text: text })).then(function (j) {
    if (seq !== EXT.seq) return;
    EXT.metiers = (j && j.metiers) || [];
    extRenderMetiers();
    if (!EXT.metiers.length) {
      status.textContent = 'Aucun métier prédit pour cette description — essayez une formulation plus générique.';
      return;
    }
    status.textContent = '⏳ Entreprises recrutantes (La Bonne Boite)…';
    var codes = EXT.metiers.slice(0, EXT_TOP_ROME).map(function (m) { return m.codeRome; });
    var lbbP = extFetchJson(extUrl('lbb', {
      rome: codes.join(','),
      lat: EXT.target.latlng[0],
      lon: EXT.target.latlng[1],
      dist: EXT.radius
    }));
    return Promise.all([lbbP, extCurated().catch(function () { return null; })]).then(function (arr) {
      if (seq !== EXT.seq) return;
      extRenderResults(arr[0], arr[1]);
    });
  }).catch(function (err) {
    if (seq !== EXT.seq) return;
    if (err && err.ft) {
      if (err.ft.code === 'lbb_unavailable') {
        status.innerHTML = '⚠️ <b>La Bonne Boite indisponible</b> — abonnement à valider sur francetravail.io (403 insufficient_scope). Les métiers ROME ci-dessus restent affichés.';
      } else {
        status.textContent = '⚠️ ' + err.message;
      }
      return;
    }
    console.error('[OpenFrance] Recherche étendue :', err);
    showError('Recherche étendue impossible.', err && err.message);
  });
}

// ---------- Rendu : métiers prédits + fiche ROME ----------
function extRenderMetiers() {
  var box = document.getElementById('extMetiers');
  box.innerHTML = '';
  EXT.metiers.forEach(function (m, i) {
    var chip = document.createElement('span');
    chip.className = 'ext-chip' + (i < EXT_TOP_ROME ? ' ext-chip-on' : '');
    chip.innerHTML = esc(m.libelleRome) + ' <b>' + esc(m.codeRome) + '</b>' +
      (m.scorePrediction !== undefined && m.scorePrediction !== null ? ' <span class="muted">' + Math.round(m.scorePrediction * 100) + '%</span>' : '');
    chip.title = i < EXT_TOP_ROME ? 'Utilisé pour La Bonne Boite — clic : compétences (ROME 4.0)' : 'Clic : compétences (ROME 4.0)';
    chip.addEventListener('click', function () { extShowFiche(m); });
    box.appendChild(chip);
  });
}
function extShowFiche(m) {
  var box = document.getElementById('extFiche');
  box.style.display = '';
  box.innerHTML = '⏳ Fiche ROME ' + esc(m.codeRome) + '…';
  extFetchJson(extUrl('fiche', { code: m.codeRome })).then(function (j) {
    var f = (j && j.fiche) || {};
    var lib = (f.metier && f.metier.libelle) || f.libelle || m.libelleRome;
    var comps = [];
    (f.groupesCompetencesMobilisees || []).forEach(function (g) {
      (g.competences || []).forEach(function (c) { comps.push(c.libelle); });
    });
    var html = '<b>' + esc(lib) + '</b> (' + esc(m.codeRome) + ')';
    if (comps.length) html += '<p class="muted">Compétences : ' + esc(comps.slice(0, 12).join(' · ')) + (comps.length > 12 ? ' …' : '') + '</p>';
    box.innerHTML = html;
  }).catch(function () {
    box.innerHTML = '<span class="muted">Fiche indisponible.</span>';
  });
}

// ---------- Rendu : résultats (liste + carte) ----------
function extPopupHtml(c, cur) {
  var html = '<b>' + esc(c.name || c.siren) + '</b>';
  if (c.city) html += '<br>' + esc(c.city);
  if (cur && (cur.listes || []).length) html += '<br>🏆 ' + esc(cur.listes.join(', '));
  if (cur && (cur.domaines || []).length) html += ' <span class="muted">' + esc(cur.domaines.join(', ')) + '</span>';
  if (c.rome) html += '<br><i>ROME ' + esc(String(c.rome)) + '</i>';
  html += '<br><a href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + encodeURIComponent(c.siren) + '" target="_blank" rel="noopener">🗂 Fiche officielle</a>';
  return html;
}
function extRenderResults(lbb, curated) {
  var status = document.getElementById('extStatus');
  var box = document.getElementById('extResults');
  box.innerHTML = '';
  var comps = (lbb && lbb.companies) || [];
  var bySiren = (curated && curated.bySiren) || {};
  var curatedCount = 0;
  comps.forEach(function (c) { if (bySiren[c.siren]) curatedCount++; });
  status.innerHTML = '📍 ' + esc(EXT.target.nom) + ' — rayon ' + EXT.radius + ' km · <b>' +
    comps.length + ' entreprise(s) recrutante(s)</b>' +
    (curatedCount ? ' · 🏆 ' + curatedCount + ' dans les listes curatées' : '') +
    ' · ROME : ' + esc(EXT.metiers.slice(0, EXT_TOP_ROME).map(function (m) { return m.codeRome; }).join(', '));
  extFrameZone();
  // liste : les entreprises des listes curatées en premier
  var sorted = comps.slice().sort(function (a, b) {
    return (bySiren[b.siren] ? 1 : 0) - (bySiren[a.siren] ? 1 : 0);
  });
  sorted.slice(0, EXT_MAX_LIST).forEach(function (c) {
    var row = document.createElement('div');
    row.className = 'co-row';
    var cur = bySiren[c.siren];
    var head = document.createElement('div');
    head.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
      (cur ? '#f59e0b' : '#22c55e') + '"></span> <b>' + esc(c.name || c.siren) + '</b>' +
      (c.city ? ' <span class="co-badge">' + esc(c.city) + '</span>' : '') +
      (cur ? ' <span class="co-badge ext-curated">🏆 ' + esc((cur.listes || []).join(', ')) + '</span>' : '') +
      (cur && (cur.domaines || []).length ? ' <span class="co-badge">' + esc(cur.domaines.join(', ')) + '</span>' : '');
    var sub = document.createElement('div');
    sub.className = 'ann-obj';
    sub.textContent = 'SIREN ' + c.siren + (c.hiring ? ' · recrute' : '') + (c.rome ? ' · ROME ' + c.rome : '');
    row.appendChild(head);
    row.appendChild(sub);
    row.addEventListener('click', function () {
      var mk = EXT.markerBySiren[c.siren];
      if (mk && c.lat !== null && c.lon !== null) { map.setView([c.lat, c.lon], 13); mk.openPopup(); }
    });
    box.appendChild(row);
  });
  if (!comps.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Aucune entreprise recrutante trouvée sur ces métiers dans la zone — élargissez le rayon ou reformulez.';
    box.appendChild(p);
  }
  setStatus('Recherche étendue : ' + comps.length + ' entreprise(s) recrutante(s)');
  // marqueurs (seulement celles avec coordonnées)
  var entries = comps.filter(function (c) { return c.lat !== null && c.lon !== null && !isNaN(c.lat) && !isNaN(c.lon); });
  if (!entries.length) return;
  EXT.markers = L.featureGroup();
  entries.slice(0, 600).forEach(function (c) {
    var cur = bySiren[c.siren];
    var m = L.circleMarker([c.lat, c.lon], {
      radius: cur ? 7 : 5, weight: 1, color: '#0f172a',
      fillColor: cur ? '#f59e0b' : '#22c55e', fillOpacity: 0.85
    });
    m.bindPopup(extPopupHtml(c, cur));
    m.addTo(EXT.markers);
    EXT.markerBySiren[c.siren] = m;
  });
  EXT.markers.addTo(map);
}

// ---------- Carte ----------
function extFrameZone() {
  if (EXT.circle) { map.removeLayer(EXT.circle); EXT.circle = null; }
  if (EXT.targetMk) { map.removeLayer(EXT.targetMk); EXT.targetMk = null; }
  if (!EXT.target) return;
  EXT.circle = L.circle(EXT.target.latlng, {
    radius: EXT.radius * 1000, weight: 1.5, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.06
  }).addTo(map);
  EXT.targetMk = L.circleMarker(EXT.target.latlng, {
    radius: 6, weight: 2, color: '#ffffff', fillColor: '#2563eb', fillOpacity: 1
  }).addTo(map);
  EXT.targetMk.bindTooltip(esc(EXT.target.nom) + ' — rayon ' + EXT.radius + ' km');
  map.fitBounds(EXT.circle.getBounds(), { padding: [30, 30] });
}
function extClearMap() {
  if (EXT.markers) { map.removeLayer(EXT.markers); EXT.markers = null; }
  EXT.markerBySiren = {};
  if (EXT.circle) { map.removeLayer(EXT.circle); EXT.circle = null; }
  if (EXT.targetMk) { map.removeLayer(EXT.targetMk); EXT.targetMk = null; }
}

// ---------- Initialisation UI ----------
function extInitUI() {
  if (EXT.uiReady) return;
  EXT.uiReady = true;
  var depSel = document.getElementById('extDep');
  Object.keys(DEP_FOLDERS).sort().forEach(function (d) {
    var o = document.createElement('option');
    o.value = d;
    o.textContent = d + ' — ' + coDepLabel(d);
    depSel.appendChild(o);
  });
  depSel.value = EXT.dep;
  depSel.addEventListener('change', function () { extSetDep(depSel.value); });

  var radSel = document.getElementById('extRadius');
  radSel.value = String(EXT.radius);
  radSel.addEventListener('change', function () { EXT.radius = parseInt(radSel.value, 10); });

  var tin = document.getElementById('extTarget');
  var deb = null;
  tin.addEventListener('input', function () {
    clearTimeout(deb);
    if (!tin.value.trim()) { extTargetDropEl(false); return; }
    deb = setTimeout(function () { extTargetRender(extTargetSearch(tin.value)); }, 120);
  });
  tin.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      var m = extTargetSearch(tin.value);
      if (m.length) { extSetTarget(m[0].code, m[0].nom); extTargetDropEl(false); }
    } else if (ev.key === 'Escape') extTargetDropEl(false);
  });
  tin.addEventListener('blur', function () { setTimeout(function () { extTargetDropEl(false); }, 150); });
  tin.addEventListener('focus', function () {
    if (tin.value.trim()) extTargetRender(extTargetSearch(tin.value));
  });

  var txt = document.getElementById('extText');
  txt.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); extSearch(); }
  });
  document.getElementById('extSearchBtn').addEventListener('click', extSearch);
}

function extSetDep(dep) {
  EXT.dep = dep;
  EXT.geo = null; EXT.target = null;
  document.getElementById('extTarget').value = '';
  extClearMap();
  extEnsureGeo().then(function () {
    if (!EXT.active) return;
    document.getElementById('levelTitle').textContent =
      'Recherche étendue — ' + coDepLabel(dep) + ' (' + dep + ')';
    document.getElementById('extStatus').textContent =
      'Entrez un métier en texte libre, choisissez une ville, puis « 🔎 Rechercher ».';
  }).catch(function (err) {
    console.error('[OpenFrance] Recherche étendue :', err);
    showError('Impossible de charger le département.', err.message);
  });
}

// ---------- Entrée / sortie du mode ----------
function extEnter() {
  EXT.active = true;
  extInitUI();
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  document.getElementById('annQueryExp').style.display = 'none';
  document.getElementById('annPanel').style.display = 'none';
  document.getElementById('scoreControls').style.display = 'none';
  document.getElementById('coControls').style.display = 'none';
  document.getElementById('coModeHint').style.display = 'none';
  document.getElementById('coPanel').style.display = 'none';
  document.getElementById('extControls').style.display = 'flex';
  document.getElementById('extPanel').style.display = '';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent =
    'Recherche étendue — ' + coDepLabel(EXT.dep) + ' (' + EXT.dep + ')';
  state.view = 'france'; state.dep = null;
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  hideError();
  extSetDep(EXT.dep);
}

function extLeave() {
  EXT.active = false;
  EXT.seq++; // invalide les recherches en vol
  extTargetDropEl(false);
  extClearMap();
  EXT.metiers = [];
  document.getElementById('extControls').style.display = 'none';
  document.getElementById('extPanel').style.display = 'none';
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'France — par département';
}

// ---------- Branchement UI (comme corp.js : écoute directe du select) ----------
function extInitWiring() {
  document.getElementById('categorySelect').addEventListener('change', function () {
    if (this.value === 'corp_ext') extEnter();
    else if (EXT.active) extLeave();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', extInitWiring);
} else {
  extInitWiring();
}
