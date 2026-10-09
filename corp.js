// OpenFrance — Composeur d'entreprises : recherche d'entreprises multicritères
// (API Recherche d'entreprises, DINUM — https://recherche-entreprises.api.gouv.fr)
//
// Principe : l'utilisateur choisit un département, une ville cible (autocomplete sur
// les communes du département) et une zone (département entier / commune / rayon en km
// autour de la ville), puis compose librement ses critères : activité (section NAF ou
// codes NAF exacts), tranche d'effectifs, catégorie (PME/ETI/GE), chiffre d'affaires,
// forme juridique, labels (ESS, Bio, Qualiopi, RGE…), état administratif, texte libre.
// Résultats sous forme de marqueurs sur la carte (les établissements correspondants à
// la zone) + liste cliquable ; clic sur une entreprise → fiche détaillée (identité,
// siège, dirigeants, labels, établissements, lien vers l'annuaire officiel).
//
// ⚠️ Contraintes de l'API (vérifiées empiriquement, voir docs/ETAT-PROJET.md) :
//  - /search : TOUS les filtres côté serveur (code_commune, departement, NAF exact —
//    pas de wildcards, tranche_effectif_salarie multi-valeurs, categorie_entreprise,
//    nature_juridique UNE seule valeur, est_*, ca_min/ca_max, q) — pas de q obligatoire.
//  - /near_point (lat/long/radius) : seule l'activité (NAF/section) est filtrée côté
//    serveur ; tranche, catégorie, labels, CA, nature, état y sont IGNORÉS (q y est
//    même interdit). → en mode rayon, les autres critères sont filtrés LOCALEMENT sur
//    les pages chargées (25 résultats/page, chargement progressif « Charger plus »),
//    et le texte + le CA sont désactivés (donnée absente des résultats).
//  - per_page max 25 (100 → réponse vide), total_results plafonné à 10 000.
//  - Le cache disque (service worker) couvre automatiquement /api/ent/* (TTL /api/ 7 j).
//
// Dépend de app.js (state, map, geoLayer, DEP_FOLDERS, fetchJSONCached, setStatus,
// showError, hideError, catColor) et annuaire.js (esc, normTxt, NAF_SECTIONS, annCentroids).

var CO = {
  active: false,
  dep: '31',
  target: null,          // { code, nom, latlng } — ville cible (zone rayon/commune)
  radius: 10,             // km ; -1 = département entier, 0 = commune seulement
  geo: null, geoDep: null, cities: [], centroids: null,
  // critères
  q: '', section: '', naf: '', activesOnly: true,
  trMin: '', trMax: '', cat: '', nat: '', caMin: '', caMax: '',
  labels: {},             // clé → booléen (rempli par coInitUI)
  // résultats
  rows: [], byId: {}, shown: [],
  pagesLoaded: 0, maxPages: 0, total: 0,
  seq: 0,
  // carte
  markers: null, markerBySiret: {}, circle: null, targetMk: null,
  uiReady: false
};

var CO_URL = '/api/ent/';
var CO_PER_PAGE = 25;
var CO_PAGES_BATCH = 4;      // pages chargées par lot (4 × 25 = 100 résultats)
var CO_MAX_PAGES = 20;        // plafond absolu (20 × 25 = 500 résultats)
var CO_MAX_LIST = 300;        // lignes affichées dans la liste
var CO_MAX_MARKERS = 600;

// Tranches d'effectifs (nomenclature INSEE) — ordonnées pour les intervalles
var CO_TRANCHES = [
  ['00', '0 salarié'],
  ['01', '1–2 salariés'],
  ['02', '3–5 salariés'],
  ['03', '6–9 salariés'],
  ['11', '10–19 salariés'],
  ['12', '20–49 salariés'],
  ['21', '50–99 salariés'],
  ['22', '100–199 salariés'],
  ['31', '200–249 salariés'],
  ['32', '250–499 salariés'],
  ['41', '500–999 salariés'],
  ['42', '1 000–1 999 salariés'],
  ['51', '2 000–4 999 salariés'],
  ['52', '5 000–9 999 salariés'],
  ['53', '10 000 salariés et +']
];
function coTrLabel(code) {
  if (code === 'NN') return 'Non employeuse';
  for (var i = 0; i < CO_TRANCHES.length; i++) if (CO_TRANCHES[i][0] === code) return CO_TRANCHES[i][1];
  return null;
}
function coTrIdx(code) {
  for (var i = 0; i < CO_TRANCHES.length; i++) if (CO_TRANCHES[i][0] === code) return i;
  return -1;
}

// Formes juridiques usuelles (codes de la nomenclature INSEE) — l'API n'accepte
// qu'UNE seule valeur pour nature_juridique (pas de listes).
var CO_NATS = [
  ['', 'Toutes formes'],
  ['1000', 'Entrepreneur individuel'],
  ['5499', 'SARL'],
  ['5458', 'EURL'],
  ['5710', 'SAS'],
  ['5720', 'SASU (unipersonnelle)'],
  ['5510', 'SA (conseil d\'administration)']
];

// Labels / compléments cochables dans le composeur
// [clé UI, libellé, paramètre API, champ complements]
var CO_LABELS = [
  ['ess', 'ESS (économie sociale et solidaire)', 'est_ess', 'est_ess'],
  ['bio', 'Agriculture bio', 'est_bio', 'est_bio'],
  ['qualiopi', 'Qualiopi (formation certifiée)', 'est_qualiopi', 'est_qualiopi'],
  ['rge', 'RGE (environnement)', 'est_rge', 'est_rge'],
  ['spectacle', 'Entrepreneur de spectacles', 'est_entrepreneur_spectacle', 'est_entrepreneur_spectacle'],
  ['mission', 'Société à mission', 'est_societe_mission', 'est_societe_mission'],
  ['siae', 'SIAE (insertion par l\'emploi)', 'est_siae', 'est_siae'],
  ['patrimoine', 'Patrimoine vivant', 'est_patrimoine_vivant', 'est_patrimoine_vivant'],
  ['form', 'Organisme de formation', 'est_organisme_formation', 'est_organisme_formation']
];
// Labels affichés sur la fiche (champ complements → libellé)
var CO_FICHE_LABELS = [
  ['est_ess', 'ESS'],
  ['est_bio', 'Agriculture bio'],
  ['est_qualiopi', 'Qualiopi'],
  ['est_rge', 'RGE'],
  ['est_entrepreneur_spectacle', 'Spectacles vivants'],
  ['est_societe_mission', 'Société à mission'],
  ['est_siae', 'SIAE'],
  ['est_patrimoine_vivant', 'Patrimoine vivant'],
  ['est_organisme_formation', 'Organisme de formation'],
  ['egapro_renseignee', 'Index Egapro'],
  ['est_administration', 'Administration'],
  ['est_service_public', 'Service public'],
  ['est_avocat', 'Avocat'],
  ['est_entrepreneur_individuel', 'Entrepreneur individuel']
];

// ---------- Utilitaires ----------
function coDepLabel(dep) {
  var f = DEP_FOLDERS[dep] || dep;
  return f.replace(/^\d+A?-?/, '').replace(/-/g, ' ');
}
function coMode() { // 'near' | 'commune' | 'dep'
  if (CO.target && CO.radius > 0) return 'near';
  if (CO.target && CO.radius === 0) return 'commune';
  return 'dep';
}
function coFmtDate(d) {
  if (d === null || d === undefined) return '—';
  if (typeof d === 'number') d = new Date(d * 1000).toISOString().slice(0, 10);
  var m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  return m[3] + '/' + m[2] + '/' + m[1];
}
function coNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(String(v).replace(/[\s\u00A0]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
function coLatLon(o) {
  if (!o) return null;
  var lat = coNum(o.latitude), lon = coNum(o.longitude);
  if (lat === null || lon === null) return null;
  return [lat, lon];
}

// ---------- Géographie du département (autocomplete + coordonnées ville) ----------
function coEnsureGeo() {
  if (CO.geo && CO.dep === CO.geoDep) return Promise.resolve();
  var dep = CO.dep;
  var g = state.communesGeo[dep];
  var p = g ? Promise.resolve(g) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[dep] + '/communes-' + DEP_FOLDERS[dep] + '.geojson')
      .then(function (geo) { state.communesGeo[dep] = geo; return geo; });
  return p.then(function (geo) {
    if (CO.dep !== dep) return; // département changé entre-temps
    CO.geo = geo; CO.geoDep = dep;
    CO.centroids = annCentroids(dep);
    CO.cities = (geo.features || []).map(function (f) {
      return { code: f.properties.code, nom: f.properties.nom, n: normTxt(f.properties.nom) };
    });
  });
}

// ---------- Construction des requêtes ----------
function coNafCodes() {
  // "62.01Z, 62.02A" → liste validée ['62.01Z','62.02A'] (pas de wildcards côté API)
  var out = [];
  String(CO.naf || '').split(',').forEach(function (raw) {
    var c = raw.trim().toUpperCase();
    if (/^\d{2}\.\d{2}[A-Z]$/.test(c) && out.indexOf(c) === -1) out.push(c);
  });
  return out;
}
function coTrancheCodes() {
  var iMin = CO.trMin ? coTrIdx(CO.trMin) : 0;
  var iMax = CO.trMax ? coTrIdx(CO.trMax) : CO_TRANCHES.length - 1;
  if (iMin < 0) iMin = 0;
  if (iMax < 0 || iMax < iMin) iMax = CO_TRANCHES.length - 1;
  return CO_TRANCHES.slice(iMin, iMax + 1).map(function (t) { return t[0]; });
}

function coBuildUrl(page) {
  var mode = coMode();
  var u;
  if (mode === 'near') {
    // /near_point : filtres serveur = activité uniquement (les autres sont ignorés par l'API)
    u = CO_URL + 'near_point?lat=' + CO.target.latlng[0] + '&long=' + CO.target.latlng[1] +
      '&radius=' + CO.radius + '&per_page=' + CO_PER_PAGE + '&page=' + page +
      '&limite_matching_etablissements=5';
    var naf = coNafCodes();
    if (naf.length) u += '&activite_principale=' + encodeURIComponent(naf.join(','));
    if (CO.section) u += '&section_activite_principale=' + encodeURIComponent(CO.section);
  } else {
    // /search : tous les filtres côté serveur
    u = CO_URL + 'search?per_page=' + CO_PER_PAGE + '&page=' + page + '&est_association=false';
    if (CO.target) u += '&code_commune=' + encodeURIComponent(CO.target.code);
    else u += '&departement=' + encodeURIComponent(CO.dep);
    if (CO.activesOnly) u += '&etat_administratif=A';
    if (CO.q) u += '&q=' + encodeURIComponent(CO.q);
    var naf2 = coNafCodes();
    if (naf2.length) u += '&activite_principale=' + encodeURIComponent(naf2.join(','));
    if (CO.section) u += '&section_activite_principale=' + encodeURIComponent(CO.section);
    if (CO.trMin || CO.trMax) u += '&tranche_effectif_salarie=' + encodeURIComponent(coTrancheCodes().join(','));
    if (CO.cat) u += '&categorie_entreprise=' + encodeURIComponent(CO.cat);
    if (CO.nat) u += '&nature_juridique=' + encodeURIComponent(CO.nat);
    var caMin = coNum(CO.caMin), caMax = coNum(CO.caMax);
    if (caMin !== null && caMin > 0) u += '&ca_min=' + Math.round(caMin);
    if (caMax !== null && caMax > 0) u += '&ca_max=' + Math.round(caMax);
    CO_LABELS.forEach(function (L) {
      if (CO.labels[L[0]]) u += '&' + L[2] + '=true';
    });
  }
  return u;
}

function coPage(p) {
  return fetch(coBuildUrl(p)).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function (j) {
    if (j && j.erreur) throw new Error(j.erreur);
    return j;
  });
}

// ---------- Filtrage local (mode rayon : l'API ignore ces critères) ----------
function coLocalPass(e) {
  var comp = e.complements || {};
  if (comp.est_association) return false; // entreprises uniquement
  if (CO.activesOnly && e.etat_administratif !== 'A') return false;
  if (CO.trMin || CO.trMax) {
    var idx = coTrIdx(e.tranche_effectif_salarie);
    if (idx === -1) return false; // NN ou null → hors tranche
    if (CO.trMin && idx < coTrIdx(CO.trMin)) return false;
    if (CO.trMax && idx > coTrIdx(CO.trMax)) return false;
  }
  if (CO.cat && e.categorie_entreprise !== CO.cat) return false;
  if (CO.nat && e.nature_juridique !== CO.nat) return false;
  for (var k in CO.labels) {
    if (!CO.labels[k]) continue;
    var L = null;
    for (var i = 0; i < CO_LABELS.length; i++) if (CO_LABELS[i][0] === k) L = CO_LABELS[i];
    if (!L) continue;
    if (!comp[L[3]]) return false;
  }
  return true;
}

// ---------- Chargement ----------
function coResetResults() {
  CO.rows = []; CO.byId = {}; CO.shown = [];
  CO.pagesLoaded = 0; CO.maxPages = 0; CO.total = 0;
}

function coIngest(results) {
  results.forEach(function (e) {
    if (!e || !e.siren || CO.byId[e.siren]) return;
    CO.byId[e.siren] = e;
    CO.rows.push(e);
  });
}

function coLoad() { // lot initial (pages 1 à CO_PAGES_BATCH)
  var token = ++CO.seq;
  setStatus('⏳ Recherche des entreprises…', 'loading');
  coPage(1).then(function (j) {
    if (token !== CO.seq) return;
    CO.total = j.total_results || (j.results || []).length;
    CO.maxPages = Math.min(j.total_pages || 1, CO_MAX_PAGES);
    CO.pagesLoaded = 1;
    coIngest(j.results || []);
    if (CO.maxPages > 1) {
      var next = [];
      for (var p = 2; p <= Math.min(CO_PAGES_BATCH, CO.maxPages); p++) next.push(p);
      setStatus('⏳ Chargement des résultats (' + next.length + ' pages)…', 'loading');
      return Promise.all(next.map(function (p) { return coPage(p).catch(function () { return null; }); }))
        .then(function (js) {
          if (token !== CO.seq) return;
          js.forEach(function (j2) {
            if (j2 && j2.results) { coIngest(j2.results); CO.pagesLoaded++; }
          });
        });
    }
  }).then(function () {
    if (token !== CO.seq) return;
    coAfterLoad();
  }).catch(function (err) {
    if (token !== CO.seq) return;
    console.error('[OpenFrance] Composeur d\'entreprises :', err);
    setStatus('❌ Recherche entreprises impossible', 'error');
    document.getElementById('coStatus').innerHTML =
      '<span class="ann-warn">⚠️ ' + esc(err.message || String(err)) + '</span>';
  });
}

function coLoadMore() { // lot suivant (bouton « Charger plus »)
  var token = ++CO.seq;
  var from = CO.pagesLoaded + 1;
  if (from > CO.maxPages) return;
  var next = [];
  for (var p = from; p <= Math.min(from + CO_PAGES_BATCH - 1, CO.maxPages); p++) next.push(p);
  setStatus('⏳ Chargement de ' + next.length + ' page(s) de plus…', 'loading');
  Promise.all(next.map(function (p) { return coPage(p).catch(function () { return null; }); }))
    .then(function (js) {
      if (token !== CO.seq) return;
      js.forEach(function (j2) {
        if (j2 && j2.results) { coIngest(j2.results); CO.pagesLoaded++; }
      });
      coAfterLoad();
    }).catch(function (err) {
      if (token !== CO.seq) return;
      console.error('[OpenFrance] Composeur d\'entreprises :', err);
      setStatus('❌ Chargement impossible', 'error');
    });
}

function coAfterLoad() {
  CO.shown = CO.rows.filter(coLocalPass);
  coRenderResults();
  coSyncMarkers();
  coStatusLine();
}

// ---------- Rendu : statut ----------
function coStatusLine() {
  var mode = coMode();
  var el = document.getElementById('coStatus');
  var total = CO.total.toLocaleString('fr-FR') + (CO.total >= 10000 ? ' (plafonné à 10 000)' : '');
  var parts = [];
  if (mode === 'near') parts.push('📍 Autour de ' + esc(CO.target.nom) + ' — rayon ' + CO.radius + ' km');
  else if (mode === 'commune') parts.push('🏘 Commune de ' + esc(CO.target.nom));
  else parts.push('🗺 Département ' + esc(CO.dep));
  parts.push(total + ' au total (API)');
  parts.push(CO.rows.length.toLocaleString('fr-FR') + ' chargée(s)');
  if (mode === 'near') parts.push('<b>' + CO.shown.length.toLocaleString('fr-FR') + ' retenue(s)</b> — critères filtrés sur les résultats chargés');
  else parts.push('<b>' + CO.shown.length.toLocaleString('fr-FR') + ' résultat(s)</b>');
  el.innerHTML = parts.join(' · ');
  var more = document.getElementById('coMore');
  more.hidden = !(CO.pagesLoaded < CO.maxPages);
  more.textContent = '＋ Charger plus (' + Math.min(CO_PAGES_BATCH, CO.maxPages - CO.pagesLoaded) + ' pages)';
  setStatus('Entreprises : ' + CO.shown.length.toLocaleString('fr-FR') + ' résultat(s) affiché(s)');
}

// ---------- Rendu : liste ----------
function coEntColor(e) {
  return catColor((e.section_activite_principale || (e.siege && e.siege.activite_principale) || '?').charAt(0));
}

function coRenderResults() {
  var box = document.getElementById('coResults');
  box.innerHTML = '';
  CO.shown.slice(0, CO_MAX_LIST).forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'co-row';
    var head = document.createElement('div');
    var tr = coTrLabel(e.tranche_effectif_salarie);
    head.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + coEntColor(e) + '"></span> <b>' +
      esc(e.nom_complet || e.nom_raison_sociale || e.siren) + '</b>' +
      (e.etat_administratif !== 'A' ? ' <span class="co-badge co-badge-off">cessée</span>' : '') +
      (e.categorie_entreprise ? ' <span class="co-badge">' + esc(e.categorie_entreprise) + '</span>' : '') +
      (tr ? ' <span class="co-badge">' + esc(tr) + '</span>' : '');
    var sub = document.createElement('div');
    sub.className = 'ann-obj';
    var naf = e.activite_principale || (e.siege && e.siege.activite_principale) || '';
    var sec = NAF_SECTIONS[e.section_activite_principale] || '';
    sub.textContent = (naf ? naf + ' · ' : '') + (sec ? sec + ' · ' : '') +
      ((e.siege && e.siege.libelle_commune) || '') +
      (e.nombre_etablissements_ouverts ? ' · ' + e.nombre_etablissements_ouverts + ' établissement(s) ouvert(s)' : '');
    row.appendChild(head); row.appendChild(sub);
    row.addEventListener('click', function () { coOpenFiche(e.siren); });
    box.appendChild(row);
  });
  if (!CO.shown.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Aucune entreprise ne correspond aux critères (sur les ' + CO.rows.length + ' chargées).';
    box.appendChild(p);
  } else if (CO.shown.length > CO_MAX_LIST) {
    var p2 = document.createElement('p');
    p2.className = 'muted';
    p2.textContent = '+' + (CO.shown.length - CO_MAX_LIST) + ' autre(s) résultat(s) non affiché(s) — affinez les critères.';
    box.appendChild(p2);
  }
}

// ---------- Rendu : carte ----------
function coClearMap() {
  if (CO.markers) { map.removeLayer(CO.markers); CO.markers = null; }
  CO.markerBySiret = {};
  if (CO.circle) { map.removeLayer(CO.circle); CO.circle = null; }
  if (CO.targetMk) { map.removeLayer(CO.targetMk); CO.targetMk = null; }
}

function coPopupHtml(e, et) {
  var s = et || (e.siege || {});
  var html = '<b>' + esc(e.nom_complet || e.siren) + '</b>';
  if (s.adresse) html += '<br>' + esc(s.adresse);
  var tr = coTrLabel(e.tranche_effectif_salarie);
  if (tr) html += '<br><i>' + esc(tr) + '</i>';
  html += '<br><a href="#" onclick="coOpenFiche(\'' + e.siren + '\');return false;">📋 Fiche détaillée</a>';
  return html;
}

function coSyncMarkers() {
  coClearMap();
  var mode = coMode();
  var entries = [];
  CO.shown.slice(0, CO_MAX_MARKERS).forEach(function (e) {
    var etabs = e.matching_etablissements || [];
    var placed = 0;
    for (var i = 0; i < etabs.length && placed < 20; i++) {
      var ll = coLatLon(etabs[i]);
      if (!ll) continue;
      entries.push({ key: 'c:' + etabs[i].siret, latlng: ll, e: e, et: etabs[i] });
      placed++;
    }
    if (!placed && mode !== 'near') {
      // hors mode rayon : on retombe sur le siège (peut être hors zone : c'est
      // l'unité légale qui correspond, un de ses établissements est dans la zone)
      var ll2 = coLatLon(e.siege);
      if (ll2) entries.push({ key: 'c:' + ((e.siege && e.siege.siret) || e.siren), latlng: ll2, e: e, et: null });
    }
  });
  if (!entries.length) return;
  CO.markers = L.featureGroup();
  entries.forEach(function (en) {
    var m = L.circleMarker(en.latlng, {
      radius: 5, weight: 1, color: '#0f172a', fillColor: coEntColor(en.e), fillOpacity: 0.85
    });
    m.bindPopup(coPopupHtml(en.e, en.et));
    m.addTo(CO.markers);
    CO.markerBySiret[en.key.slice(2)] = m;
  });
  CO.markers.addTo(map);
}

function coFrameZone() {
  var mode = coMode();
  if (mode === 'near' && CO.target) {
    CO.circle = L.circle(CO.target.latlng, {
      radius: CO.radius * 1000, weight: 1.5, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.06
    }).addTo(map);
    CO.targetMk = L.circleMarker(CO.target.latlng, {
      radius: 6, weight: 2, color: '#ffffff', fillColor: '#2563eb', fillOpacity: 1
    }).addTo(map);
    CO.targetMk.bindTooltip(esc(CO.target.nom) + ' — rayon ' + CO.radius + ' km');
    map.fitBounds(CO.circle.getBounds(), { padding: [30, 30] });
  } else if (mode === 'commune' && CO.target) {
    map.setView(CO.target.latlng, 12);
  } else {
    var cs = CO.centroids || {}, xs = [], ys = [];
    for (var k in cs) { xs.push(cs[k][1]); ys.push(cs[k][0]); }
    if (xs.length) map.fitBounds([[Math.min.apply(null, ys), Math.min.apply(null, xs)], [Math.max.apply(null, ys), Math.max.apply(null, xs)]], { padding: [30, 30] });
  }
}

// ---------- Application des critères ----------
function coPaintHint() {
  var isNear = coMode() === 'near';
  // texte + CA : indisponibles en mode rayon (interdits/absents côté near_point)
  ['coQ', 'coCaMin', 'coCaMax'].forEach(function (id) {
    var el = document.getElementById(id);
    el.disabled = isNear;
    el.title = isNear ? 'Indisponible en mode rayon (l\'API ne le permet pas)' : '';
  });
  var hint = document.getElementById('coModeHint');
  hint.innerHTML = isNear
    ? '💡 Mode rayon : l\'API filtre la zone et l\'activité côté serveur ; les autres critères (effectifs, catégorie, forme, labels, état) sont appliqués <b>localement</b> aux pages chargées — utilisez « Charger plus » pour élargir. Le texte et le CA ne sont pas disponibles dans ce mode (utilisez « La commune seulement » ou « Tout le département »).'
    : '💡 Tous les critères sont appliqués par l\'API. Sans ville : département entier ; avec « La commune seulement » : entreprises ayant un établissement dans la commune.';
  hint.style.display = '';
}

function coApply() {
  if (!CO.active) return;
  coPaintHint();
  coResetResults();
  coClearMap();
  coFrameZone();
  coRenderResults();
  document.getElementById('coMore').hidden = true;
  document.getElementById('coStatus').textContent = '⏳ Recherche…';
  coLoad();
}

function coSetDep(dep) {
  CO.dep = dep;
  CO.geo = null; CO.target = null;
  document.getElementById('coTarget').value = '';
  coClearMap();
  coEnsureGeo().then(function () {
    document.getElementById('levelTitle').textContent =
      'Entreprises — ' + coDepLabel(dep) + ' (' + dep + ')';
    coApply();
  }).catch(function (err) {
    console.error('[OpenFrance] Composeur d\'entreprises :', err);
    showError('Impossible de charger le département.', err.message);
  });
}

// ---------- Autocomplete ville ----------
function coTargetSearch(q) {
  q = normTxt(q);
  if (!q) return [];
  var out = [];
  for (var i = 0; i < CO.cities.length && out.length < 10; i++) {
    var c = CO.cities[i];
    if (c.n.indexOf(q) !== -1) out.push(c);
  }
  return out;
}
function coTargetDropEl(show) {
  var d = document.getElementById('coTargetDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function coTargetRender(matches) {
  var d = document.getElementById('coTargetDrop');
  d.innerHTML = '';
  matches.forEach(function (m) {
    var row = document.createElement('div');
    row.innerHTML = esc(m.nom) + ' <span class="muted">(' + m.code + ')</span>';
    row.addEventListener('mousedown', function (ev) { // mousedown : avant le blur
      ev.preventDefault();
      coSetTarget(m.code, m.nom);
      coTargetDropEl(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}
function coSetTarget(code, nom) {
  var c = (CO.centroids || {})[code];
  if (!c) return;
  CO.target = { code: code, nom: nom, latlng: c };
  document.getElementById('coTarget').value = nom;
  coApply();
}

// ---------- Fiche entreprise ----------
function coNatLabel(code) {
  if (!code) return '';
  for (var i = 0; i < CO_NATS.length; i++) if (CO_NATS[i][0] === code) return CO_NATS[i][1];
  return code;
}
function coFicheHtml(e) {
  var s = e.siege || {};
  var comp = e.complements || {};
  var html = '';

  // identité
  html += '<div class="co-grid">';
  html += '<div class="co-kv"><span>SIREN</span><b>' + esc(e.siren) + '</b></div>';
  html += '<div class="co-kv"><span>Créée le</span><b>' + coFmtDate(e.date_creation) + '</b></div>';
  html += '<div class="co-kv"><span>Forme juridique</span><b>' + esc(coNatLabel(e.nature_juridique) || '—') + '</b></div>';
  html += '<div class="co-kv"><span>Catégorie</span><b>' + esc(e.categorie_entreprise || '—') + '</b></div>';
  var tr = coTrLabel(e.tranche_effectif_salarie);
  html += '<div class="co-kv"><span>Effectifs</span><b>' + esc(tr || 'inconnu') +
    (e.annee_tranche_effectif_salarie ? ' <span class="muted">(' + esc(e.annee_tranche_effectif_salarie) + ')</span>' : '') + '</b></div>';
  html += '<div class="co-kv"><span>Activité (NAF)</span><b>' + esc(e.activite_principale || s.activite_principale || '—') +
    (NAF_SECTIONS[e.section_activite_principale] ? ' <span class="muted">— ' + esc(NAF_SECTIONS[e.section_activite_principale]) + '</span>' : '') + '</b></div>';
  html += '<div class="co-kv"><span>Établissements</span><b>' +
    esc(String(e.nombre_etablissements_ouverts != null ? e.nombre_etablissements_ouverts : '?')) +
    ' ouvert(s) / ' + esc(String(e.nombre_etablissements != null ? e.nombre_etablissements : '?')) + '</b></div>';
  html += '</div>';

  // siège
  html += '<h3 class="co-h3">🏢 Siège social</h3>';
  html += '<p class="co-p">' + esc(s.adresse || 'adresse non diffusée') + '</p>';
  if (s.siret) html += '<p class="muted">SIRET siège : ' + esc(s.siret) + '</p>';

  // état & labels
  var chips = [];
  chips.push(e.etat_administratif === 'A' ? '✅ Active' : '⛔ Cessée');
  if (e.statut_diffusion === 'P') chips.push('🔒 Diffusion partielle (données masquées)');
  CO_FICHE_LABELS.forEach(function (L) { if (comp[L[0]]) chips.push(L[1]); });
  html += '<h3 class="co-h3">🏷 État & labels</h3>';
  html += '<p>' + chips.map(function (c) { return '<span class="co-badge">' + esc(c) + '</span>'; }).join(' ') + '</p>';

  // dirigeants
  var dirs = [];
  (e.dirigeants || []).forEach(function (d) {
    if (d.type_dirigeant === 'personne morale') {
      dirs.push(esc(d.denomination || '?') + (d.qualite ? ' — ' + esc(d.qualite) : ''));
    } else {
      dirs.push(esc((d.nom || '?') + (d.prenoms ? ' ' + d.prenoms : '')) + (d.qualite ? ' — ' + esc(d.qualite) : ''));
    }
  });
  if (dirs.length) {
    html += '<h3 class="co-h3">👤 Dirigeants</h3><ul class="co-list">';
    dirs.slice(0, 30).forEach(function (d) { html += '<li>' + d + '</li>'; });
    if (dirs.length > 30) html += '<li class="muted">+ ' + (dirs.length - 30) + ' autres</li>';
    html += '</ul>';
  }

  // établissements correspondant à la recherche (dans la zone)
  var etabs = e.matching_etablissements || [];
  if (etabs.length) {
    html += '<h3 class="co-h3">🏭 Établissements dans la zone (' + etabs.length + ')</h3><div class="co-etabs">';
    etabs.forEach(function (et) {
      var tre = coTrLabel(et.tranche_effectif_salarie);
      html += '<div class="co-etab" data-siret="' + esc(String(et.siret)) + '" data-lat="' + coNum(et.latitude) + '" data-lon="' + coNum(et.longitude) + '">' +
        '<b>' + esc(et.adresse || 'adresse non diffusée') + '</b>' +
        '<br><span class="muted">' + esc(String(et.siret || '')) +
        (tre ? ' · ' + esc(tre) : '') +
        (et.est_siege ? ' · siège' : '') + '</span></div>';
    });
    html += '</div>';
  }

  // lien officiel (les coordonnées de contact ne sont pas dans la base Sirene)
  html += '<p class="muted co-p">Site web / email / téléphone : non fournis par la base Sirene (open data) — consultez la fiche officielle.</p>';
  html += '<a class="co-official" href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + encodeURIComponent(e.siren) +
    '" target="_blank" rel="noopener">🔗 Fiche officielle — annuaire-entreprises.data.gouv.fr</a>';
  return html;
}

function coOpenFiche(siren) {
  var e = CO.byId[siren];
  if (!e) return;
  document.getElementById('coFicheTitle').innerHTML =
    esc(e.nom_complet || e.nom_raison_sociale || e.siren) +
    (e.sigle ? ' <span class="muted">(' + esc(e.sigle) + ')</span>' : '');
  document.getElementById('coFicheBody').innerHTML = coFicheHtml(e);
  document.getElementById('coFicheDlg').style.display = 'flex';
  // clic sur un établissement de la fiche → vol de la carte vers son marqueur
  Array.prototype.forEach.call(document.querySelectorAll('#coFicheBody .co-etab'), function (row) {
    row.addEventListener('click', function () {
      var siret = row.getAttribute('data-siret');
      var mk = CO.markerBySiret[siret];
      if (mk) { map.panTo(mk.getLatLng()); mk.openPopup(); return; }
      var lat = coNum(row.getAttribute('data-lat')), lon = coNum(row.getAttribute('data-lon'));
      if (lat !== null && lon !== null) map.panTo([lat, lon]);
    });
  });
}
function coFicheClose() { document.getElementById('coFicheDlg').style.display = 'none'; }

// ---------- UI ----------
function coInitUI() {
  if (CO.uiReady) return;
  CO.uiReady = true;
  CO_LABELS.forEach(function (L) { CO.labels[L[0]] = false; });

  // département
  var depSel = document.getElementById('coDep');
  Object.keys(DEP_FOLDERS).sort().forEach(function (d) {
    var o = document.createElement('option');
    o.value = d;
    o.textContent = d + ' — ' + coDepLabel(d);
    depSel.appendChild(o);
  });
  depSel.value = CO.dep;
  depSel.addEventListener('change', function () { coSetDep(depSel.value); });

  // rayon / zone
  var radSel = document.getElementById('coRadius');
  radSel.value = String(CO.radius);
  radSel.addEventListener('change', function () {
    CO.radius = parseInt(radSel.value, 10);
    coApply();
  });

  // ville cible (autocomplete)
  var tin = document.getElementById('coTarget');
  var deb = null;
  tin.addEventListener('input', function () {
    clearTimeout(deb);
    if (!tin.value.trim()) { coTargetDropEl(false); return; }
    deb = setTimeout(function () { coTargetRender(coTargetSearch(tin.value)); }, 120);
  });
  tin.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      var m = coTargetSearch(tin.value);
      if (m.length) { coSetTarget(m[0].code, m[0].nom); coTargetDropEl(false); }
    } else if (ev.key === 'Escape') coTargetDropEl(false);
  });
  tin.addEventListener('blur', function () { setTimeout(function () { coTargetDropEl(false); }, 150); });
  tin.addEventListener('focus', function () {
    if (tin.value.trim()) coTargetRender(coTargetSearch(tin.value));
  });

  // section NAF
  var secSel = document.getElementById('coSection');
  var oAll = document.createElement('option');
  oAll.value = ''; oAll.textContent = 'Tous les secteurs';
  secSel.appendChild(oAll);
  for (var sc in NAF_SECTIONS) {
    var o = document.createElement('option');
    o.value = sc; o.textContent = sc + ' — ' + NAF_SECTIONS[sc];
    secSel.appendChild(o);
  }
  secSel.addEventListener('change', function () { CO.section = secSel.value; coApply(); });

  // texte + codes NAF (debounce)
  var qIn = document.getElementById('coQ');
  var nafIn = document.getElementById('coNaf');
  var deb2 = null;
  function debounced() {
    clearTimeout(deb2);
    deb2 = setTimeout(coApply, 400);
  }
  qIn.addEventListener('input', function () { CO.q = qIn.value.trim(); debounced(); });
  nafIn.addEventListener('input', function () { CO.naf = nafIn.value; debounced(); });

  // tranches d'effectifs
  var trMinSel = document.getElementById('coTrMin');
  var trMaxSel = document.getElementById('coTrMax');
  [trMinSel, trMaxSel].forEach(function (sel) {
    var oEmpty = document.createElement('option');
    oEmpty.value = ''; oEmpty.textContent = '—';
    sel.appendChild(oEmpty);
    CO_TRANCHES.forEach(function (t) {
      var o2 = document.createElement('option');
      o2.value = t[0]; o2.textContent = t[1];
      sel.appendChild(o2);
    });
  });
  trMinSel.addEventListener('change', function () { CO.trMin = trMinSel.value; coApply(); });
  trMaxSel.addEventListener('change', function () { CO.trMax = trMaxSel.value; coApply(); });

  // catégorie (PME / ETI / GE)
  var catSel = document.getElementById('coCat');
  ['', 'PME', 'ETI', 'GE'].forEach(function (v) {
    var o = document.createElement('option');
    o.value = v; o.textContent = v || 'Toutes tailles';
    catSel.appendChild(o);
  });
  catSel.addEventListener('change', function () { CO.cat = catSel.value; coApply(); });

  // forme juridique
  var natSel = document.getElementById('coNat');
  CO_NATS.forEach(function (n) {
    var o = document.createElement('option');
    o.value = n[0]; o.textContent = n[1];
    natSel.appendChild(o);
  });
  natSel.addEventListener('change', function () { CO.nat = natSel.value; coApply(); });

  // CA min / max (€)
  var caMin = document.getElementById('coCaMin');
  var caMax = document.getElementById('coCaMax');
  var deb3 = null;
  caMin.addEventListener('input', function () { CO.caMin = caMin.value; clearTimeout(deb3); deb3 = setTimeout(coApply, 500); });
  caMax.addEventListener('input', function () { CO.caMax = caMax.value; clearTimeout(deb3); deb3 = setTimeout(coApply, 500); });

  // actives uniquement
  var act = document.getElementById('coActive');
  act.checked = CO.activesOnly;
  act.addEventListener('change', function () { CO.activesOnly = act.checked; coApply(); });

  // labels
  var labBox = document.getElementById('coLabels');
  CO_LABELS.forEach(function (L) {
    var lab = document.createElement('label');
    lab.className = 'co-labchip';
    lab.title = L[1];
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', function () { CO.labels[L[0]] = cb.checked; coApply(); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + L[1]));
    labBox.appendChild(lab);
  });

  // charger plus + fiche
  document.getElementById('coMore').addEventListener('click', coLoadMore);
  document.getElementById('coFicheClose').addEventListener('click', coFicheClose);
  document.getElementById('coFicheDlg').addEventListener('click', function (ev) {
    if (ev.target === this) coFicheClose();
  });
}

// ---------- Entrée / sortie du mode ----------
function corpEnter() {
  CO.active = true;
  coInitUI();
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  document.getElementById('annQueryExp').style.display = 'none';
  document.getElementById('annPanel').style.display = 'none';
  document.getElementById('scoreControls').style.display = 'none';
  document.getElementById('coControls').style.display = 'flex';
  document.getElementById('coPanel').style.display = '';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'Entreprises — ' + coDepLabel(CO.dep) + ' (' + CO.dep + ')';
  state.view = 'france'; state.dep = null;
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  hideError();
  coSetDep(CO.dep);
}

function corpLeave() {
  CO.active = false;
  coTargetDropEl(false);
  coClearMap();
  coResetResults();
  coFicheClose();
  document.getElementById('coControls').style.display = 'none';
  document.getElementById('coModeHint').style.display = 'none';
  document.getElementById('coPanel').style.display = 'none';
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'France — par département';
}

// ---------- Branchement UI (comme annuaire.js : écoute directe du select) ----------
function corpInitUI() {
  var catSel = document.getElementById('categorySelect');
  catSel.addEventListener('change', function () {
    if (this.value === 'corp') corpEnter();
    else if (CO.active) corpLeave();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', corpInitUI);
} else {
  corpInitUI();
}
