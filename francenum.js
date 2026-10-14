// OpenFrance — France Num : recherche des « activateurs » France Num
// (dataset data.gouv « Activateurs France Num », ministère de l'Économie,
// Licence Ouverte 2.0 — https://www.data.gouv.fr/fr/datasets/activateurs-france-num/)
//
// Les activateurs France Num sont les structures labellisées qui accompagnent
// la transformation numérique des TPE/PME (conseil, formation, solutions…).
// Le dataset (~4 400 lignes) n'a PAS de SIREN : on cherche les activateurs
// EUX-MÊMES, pas des entreprises filtrées. Il est publié sur data.gouv.fr et
// hébergé sur l'API ODS (explore v2.1) de data.economie.gouv.fr : un export
// JSON complet en UNE requête, via le proxy /api/activateurs/* (netlify.toml
// + vercel.json) — jamais de copie des données dans le repo.
//
// Mode transversal, comme French Tech : une case « 🇫🇷 France Num uniquement »
// dans les trois sources « entreprises » :
//  - Annuaire (annuaire.js)   : #annFnOnly — la case remplace assos+entreprises
//    par les activateurs de la zone (state.zone), requête multi-opérateurs du
//    champ de recherche + filtre ville (« dans la ville » ou rayon) ;
//  - Composeur d'entreprises (corp.js) : #coFnOnly — la case remplace la
//    recherche API par les activateurs du ciblage courant (rayon autour de la
//    ville / commune / département-zone) ; le texte « nom/activité » devient
//    un filtre local multi-opérateurs ; les critères d'entreprise (NAF,
//    effectifs, CA, labels, état, forme) ne s'appliquent pas ;
//  - Recherche étendue (corp_ext.js) : #extFnOnly — mode annuaire (comme
//    French Tech) : ville cible → activateurs du rayon triés par distance ;
//    champ ville effacé → toute la base (comme French Tech) triée par nom. Le champ
//    « métier » devient un filtre texte local (pas de ROMEO/La Bonne Boite).
//
// Chargement UNIQUE (fnEnsure) : fetch du proxy (cache disque service worker
// /api/ 7 j automatique) puis normalisation + cache IndexedDB DÉDIÉ
// « openfrance-francenum » (persistant, TTL 7 jours). Le filtrage est 100 %
// local : zone (noms de départements normalisés — apostrophes U+2019/U+0027,
// accents, tirets), requête multi-opérateurs (parseAnnQuery/annMatch), ville.
//
// Dépend de app.js (map, distKm, mkSpreadApply, depNom, setStatus, showError)
// et annuaire.js (esc, normTxt, parseAnnQuery, annMatch). S'appuie sur
// corp.js (CO, coMode, coZoneLabel, coClearMap, coFrameZone, coResetResults,
// CO_MAX_LIST, CO_MAX_MARKERS) et corp_ext.js (EXT, extClearMap, extFrameZone,
// extInfo, extZoneDeps, EXT_MAX_LIST) pour les deux modes « entreprises ».
//
// Compatibilité favoris.js/enrich.js (chargés après, ils enveloppent les
// rendus) : les activateurs n'ont pas de SIREN → pas d'étoile favori possible
// (FAV.starHtml renvoie '' sans id) ; les lignes/marqueurs portent un « shim »
// compatible associations ({t, o, l, p}) pour que les tooltips de survol
// d'enrich.js fonctionnent sans modification. Clés marqueurs : 'f:<uuid>'.

var FN_URL = '/api/activateurs/exports/json';
var FN_VERSION = 2;          // bump = invalidation du cache IndexedDB
                            // v2 (10/2026) : l'export JSON ODS utilise les noms de champs
                            // BRUTS snake_case, pas les libellés (piège n°29)
var FN_TTL = 7 * 24 * 3600 * 1000; // 7 jours (miroir du TTL /api/ du SW)
var FN_COLOR = '#a78bfa';    // violet France Num (marqueurs + pastilles listes)
var FN_IDB = 'openfrance-francenum';

var FN = {
  rows: null,        // activateurs normalisés (FN.rows[i]._h = haystack)
  total: 0,          // nombre d'activateurs en base (statuts)
  promise: null,     // chargement en cours (dédoublonné)
  seq: 0,            // jeton anti-course du mode composeur
  lastExt: null      // dernier annuaire France Num affiché (mode étendu)
};

// ---------- IndexedDB dédié (store « kv », clé « all » : {v, date, rows}) ----------
function fnIdbOpen() {
  return new Promise(function (res, rej) {
    var rq = indexedDB.open(FN_IDB, 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
function fnIdbGet(key) {
  return fnIdbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var rq = db.transaction('kv').objectStore('kv').get(key);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }).catch(function () { return null; });
}
function fnIdbSet(key, val) {
  return fnIdbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* cache best-effort */ });
}

// ---------- Normalisation ----------
// Noms de départements/villes comparables : apostrophes U+2019 ET U+0027,
// tirets, accents (via normTxt), espaces multiples.
function fnNormName(s) {
  return normTxt(String(s == null ? '' : s).replace(/[\u2019'\u2010\u2011-]/g, ' '));
}
// Champ d'un enregistrement brut : les noms de colonnes du dataset peuvent
// contenir une apostrophe typographique (U+2019) ou droite (U+0027) selon
// l'export — on tente les deux (piège n°29, docs/ETAT-PROJET.md).
function fld(o, name) {
  if (o[name] !== undefined && o[name] !== null) return o[name];
  var alt = name.indexOf('\u2019') !== -1 ? name.replace(/\u2019/g, "'") : name.replace(/'/g, '\u2019');
  return o[alt];
}
// ⚠️ PIÈGE n°29 (bis, vérifié en prod 14/10/2026) : l'export CSV ODS (explore
// v2.1) est servi avec use_labels=true → colonnes = libellés français (« Nom
// de la structure »), MAIS l'export JSON est servi SANS use_labels → clés =
// noms BRUTS snake_case du backend (« nom_de_la_structure »,
// « perimetre_d_intervention »…) et « geoloc » y est un OBJET {lon, lat}
// (latitude/longitude en chaînes). Pour chaque champ on tente donc : le nom
// brut, puis le libellé (variantes d'apostrophe couvertes par fld).
function fldAny(o, names) {
  for (var i = 0; i < names.length; i++) {
    var v = fld(o, names[i]);
    if (v !== undefined && v !== null) return v;
  }
  return null;
}
// geoloc : objet {lon, lat} (export JSON) ou chaîne « lat, lng » (CSV).
function fnGeoloc(o) {
  var g = fldAny(o, ['geoloc']);
  if (!g) return null;
  if (typeof g === 'object') {
    var la = parseFloat(g.lat), lo = parseFloat(g.lon != null ? g.lon : g.lng);
    return (!isNaN(la) && !isNaN(lo)) ? [la, lo] : null;
  }
  var s = String(g).split(',');
  var la2 = parseFloat(s[0]), lo2 = parseFloat(s[1]);
  return (!isNaN(la2) && !isNaN(lo2)) ? [la2, lo2] : null;
}
// Valeur texte : les champs séparés peuvent arriver en tableau selon l'export.
function fnTxt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(' ; ');
  return String(v).trim();
}
function fnNormalize(r) {
  var lat = parseFloat(fldAny(r, ['latitude'])), lng = parseFloat(fldAny(r, ['longitude']));
  if (isNaN(lat) || isNaN(lng)) { // repli sur geoloc (objet JSON ou « lat, lng »)
    var g = fnGeoloc(r);
    lat = g ? g[0] : null; lng = g ? g[1] : null;
  }
  var row = {
    id: fnTxt(fldAny(r, ['identifiant_de_la_structure', 'Identifiant de la structure'])) ||
      fnTxt(fldAny(r, ['__id'])),
    nom: fnTxt(fldAny(r, ['nom_de_la_structure', 'Nom de la structure'])),
    type: fnTxt(fldAny(r, ['type', 'Type'])),
    cat: fnTxt(fldAny(r, ['categorie', 'Catégorie'])),
    taille: fnTxt(fldAny(r, ['taille_de_la_structure', 'Taille de la structure'])),
    date: fnTxt(fldAny(r, ['date_de_creation', 'Date de création'])).slice(0, 10),
    adr: fnTxt(fldAny(r, ['adresse', 'Adresse'])),
    cp: fnTxt(fldAny(r, ['code_postal', 'Code postal'])),
    ville: fnTxt(fldAny(r, ['ville', 'Ville'])),
    dep: fnTxt(fldAny(r, ['departement', 'Département'])),
    region: fnTxt(fldAny(r, ['region', 'Région'])),
    perim: fnTxt(fldAny(r, ['perimetre_d_intervention', 'Périmètre d\u2019intervention'])),
    sect: fnTxt(fldAny(r, ['secteurs_domaines_sous_domaines', 'Secteurs_domaines_sous_domaines'])),
    labels: fnTxt(fldAny(r, ['labels', 'Labels'])),
    certifs: fnTxt(fldAny(r, ['certifications', 'Certifications'])),
    reseaux: fnTxt(fldAny(r, ['reseaux', 'Réseaux'])),
    url: fnTxt(fldAny(r, ['lien_url_site_france_num', 'Lien url (site France Num)'])),
    lat: lat, lng: lng
  };
  row._dn = fnNormName(row.dep);   // nom de département normalisé (croisement zone)
  row._vn = fnNormName(row.ville);  // nom de ville normalisé (filtre « dans la ville »)
  row._h = normTxt([row.nom, row.type, row.cat, row.ville, row.dep, row.region,
    row.sect, row.labels, row.certifs, row.reseaux].join(' '));
  return row;
}

// ---------- Chargement unique (cache IndexedDB + proxy SW) ----------
function fnEnsure() {
  if (FN.rows) return Promise.resolve(FN.rows);
  if (FN.promise) return FN.promise;
  FN.promise = fnIdbGet('all').then(function (cached) {
    if (cached && cached.v === FN_VERSION && Array.isArray(cached.rows) && cached.rows.length &&
        Date.now() - (cached.date || 0) < FN_TTL) {
      FN.rows = cached.rows;
      FN.total = cached.rows.length;
      return FN.rows;
    }
    return fetch(FN_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + FN_URL);
      return r.json();
    }).then(function (arr) {
      if (!Array.isArray(arr) || !arr.length) throw new Error('réponse inattendue (0 activateur)');
      FN.rows = arr.map(fnNormalize);
      FN.total = FN.rows.length;
      fnIdbSet('all', { v: FN_VERSION, date: Date.now(), rows: FN.rows });
      return FN.rows;
    });
  }).catch(function (err) {
    FN.promise = null; // le chargement a échoué : on permettra de retenter
    throw err;
  });
  return FN.promise;
}

// ---------- Filtrage local ----------
// opts.deps   : codes de départements de la zone (vide = toute la base)
// opts.q      : requête parsée (parseAnnQuery) — multi-opérateurs
// opts.target : { nom, latlng } ville cible (filtre ville du mode appelant)
// opts.radius : 0 = « dans la ville » (nom), > 0 = rayon km (haversine)
// Retour : lignes filtrées ; en mode rayon, r._dist (km) est posé sur chaque ligne.
function fnFilter(opts) {
  opts = opts || {};
  var rows = FN.rows || [];
  var depNames = null;
  if (opts.deps && opts.deps.length) {
    depNames = {};
    opts.deps.forEach(function (d) { depNames[fnNormName(depNom(d))] = 1; });
  }
  var target = opts.target || null;
  var radius = target ? (opts.radius || 0) : -1;
  var tName = target ? fnNormName(target.nom) : '';
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (depNames && !depNames[r._dn]) continue; // activateur hors zone
    if (opts.q && !annMatch(r._h, opts.q)) continue;
    if (target) {
      if (radius > 0) {
        if (r.lat == null || r.lng == null) continue; // non localisable → hors rayon
        r._dist = distKm([r.lat, r.lng], target.latlng);
        if (r._dist > radius) continue;
      } else if (r._vn !== tName) continue; // « dans la ville » : nom de commune
    }
    out.push(r);
  }
  return out;
}
function fnSortByName(rows) {
  rows.sort(function (a, b) {
    var x = a.nom || '', y = b.nom || '';
    return x.toLowerCase() < y.toLowerCase() ? -1 : (x.toLowerCase() > y.toLowerCase() ? 1 : 0);
  });
}
function fnSortByDist(rows) {
  rows.sort(function (a, b) { return (a._dist != null ? a._dist : 1e9) - (b._dist != null ? b._dist : 1e9); });
}

// ---------- Rendu partagé : popup, badges, ligne de liste ----------
// Shim compatible « asso » ({t, o, l, p}) : favoris.js/enrich.js traitent les
// lignes/marqueurs non-entreprise comme des associations — les tooltips de
// survol d'enrich.js fonctionnent ainsi sans modification (pas d'étoile : pas
// d'identifiant SIREN/ RNA, FAV.starHtml renvoie '' sans id).
function fnShim(row) {
  if (!row._shim) {
    row._shim = {
      t: row.nom,
      o: [row.type, row.sect].filter(Boolean).join(' — '),
      l: row.ville, p: row.cp
    };
  }
  return row._shim;
}
function fnPopup(row) {
  var html = '<b>' + esc(row.nom) + '</b>';
  if (row.type) html += '<br><i>🧭 ' + esc(row.type) + '</i>';
  if (row.adr || row.ville) html += '<br>' + esc(row.adr || '') +
    (row.adr && row.ville ? ' — ' : '') + esc([row.cp, row.ville].filter(Boolean).join(' '));
  if (row.taille || row.cat) html += '<br>👥 ' + esc(row.taille || '—') +
    (row.cat ? ' · ' + esc(row.cat) : '');
  if (row.perim) html += '<br>🎯 Périmètre d\u2019intervention : ' + esc(row.perim);
  if (row.sect) html += '<br>🧩 ' + esc(row.sect);
  if (row.labels) html += '<br>🏷 ' + esc(row.labels);
  if (row.certifs) html += '<br>✅ ' + esc(row.certifs);
  if (row.reseaux) html += '<br>🤝 ' + esc(row.reseaux);
  if (row.url) html += '<br>🔗 <a href="' + esc(row.url) + '" target="_blank" rel="noopener">Fiche France Num</a>';
  return html;
}
function fnBadges(row, dist) {
  var b = '';
  if (dist != null) b += ' <span class="co-badge">📍 ' + (Math.round(dist * 10) / 10) + ' km</span>';
  if (row.type) b += ' <span class="co-badge">' + esc(row.type) + '</span>';
  if (row.taille) b += ' <span class="co-badge">' + esc(row.taille) + '</span>';
  if (row.perim && row.perim !== 'Département') b += ' <span class="co-badge">🎯 ' + esc(row.perim) + '</span>';
  return b;
}
// Ligne de liste des modes composeur/étendu (classe .co-row), clic → vol carte.
function fnRowEl(row, markerBy) {
  var el = document.createElement('div');
  el.className = 'co-row';
  var head = document.createElement('div');
  head.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + FN_COLOR + '"></span> <b>' +
    esc(row.nom) + '</b>' + fnBadges(row, row._dist);
  var sub = document.createElement('div');
  sub.className = 'ann-obj';
  sub.textContent = 'Activateur France Num · ' + [row.adr, [row.cp, row.ville].filter(Boolean).join(' ')].filter(Boolean).join(' — ') +
    (row.dep ? ' (' + row.dep + ')' : '');
  el.appendChild(head);
  el.appendChild(sub);
  el.addEventListener('click', function () {
    var m = markerBy ? markerBy['f:' + row.id] : null;
    if (m) { map.panTo(m.getLatLng()); m.openPopup(); }
  });
  // tooltip de survol enrichi (best-effort : enrich.js peut ne pas être là)
  try {
    if (typeof ENR !== 'undefined' && typeof enrWireRow === 'function') {
      enrWireRow(el, ENR.tipAsso, fnShim(row));
    }
  } catch (e) { /* sans enrich : pas de tooltip */ }
  return el;
}
// Tooltip de survol des marqueurs (best-effort, cf. fnRowEl).
function fnWireTip(m, row) {
  try {
    if (typeof ENR !== 'undefined' && ENR.wireMarker) ENR.wireMarker(m, ENR.tipAsso, fnShim(row));
  } catch (e) { /* sans enrich : pas de tooltip */ }
}
// Marqueurs d'un groupe Leaflet (composeur/étendu) + étalement spirale.
// Retourne { group, markerBy, spread } — l'appelant les stocke dans son mode
// (CO.markers/CO.markerBySiret ou EXT.markers) pour que son *_clearMap les retire.
function fnPlaceMarkers(rows, cap) {
  var group = L.featureGroup();
  var markerBy = {};
  var spreadItems = [];
  rows.slice(0, cap || 600).forEach(function (row) {
    if (row.lat == null || row.lng == null) return;
    var m = L.circleMarker([row.lat, row.lng], {
      radius: 5, weight: 1, color: '#0f172a', fillColor: FN_COLOR, fillOpacity: 0.85
    });
    m.bindPopup(fnPopup(row));
    m.addTo(group);
    markerBy['f:' + row.id] = m;
    fnWireTip(m, row);
    spreadItems.push({ m: m, base: [row.lat, row.lng] });
  });
  var spread = spreadItems.length ? mkSpreadApply(spreadItems) : null;
  if (spreadItems.length) group.addTo(map);
  return { group: group, markerBy: markerBy, spread: spread };
}
// Entrées marqueur du mode annuaire (annSyncMarkers, clés 'f:<id>', cap 2000).
function fnEntries(list, cap) {
  var out = [];
  list.slice(0, cap || 2000).forEach(function (row) {
    if (row.lat == null || row.lng == null) return; // non localisable → pas de marqueur
    out.push({ key: 'f:' + row.id, rec: fnShim(row), latlng: [row.lat, row.lng],
      color: FN_COLOR, popup: fnPopup(row) });
  });
  return out;
}

// ---------- Composeur d'entreprises (corp.js, case #coFnOnly) ----------
// Appelé par coApply() quand la case est cochée : remplace la recherche API.
// Ciblage = celui du composeur (coMode) : near (ville+rayon), commune, ou
// département/zone entière. Le texte « nom/activité » (CO.q) devient un filtre
// local multi-opérateurs ; les autres critères d'entreprise ne s'appliquent pas.
function fnCorpSearch() {
  var el = document.getElementById('coStatus');
  var hint = document.getElementById('coModeHint');
  hint.innerHTML = '💡 Mode 🇫🇷 France Num : affiche les <b>activateurs France Num</b> (accompagnement numérique des TPE/PME, data.gouv.fr) au lieu des entreprises — le ciblage (ville/rayon/commune/département) et le texte s\u2019appliquent, les autres critères (NAF, effectifs, CA, labels, état, forme) ne concernent pas les activateurs.';
  hint.style.display = '';
  el.textContent = '⏳ Activateurs France Num…';
  coResetResults();
  document.getElementById('coMore').hidden = true;
  var seq = ++FN.seq;
  fnEnsure().then(function () {
    if (seq !== FN.seq || !CO.active) return;
    var mode = coMode();
    // Ciblage géo identique aux entreprises : near/commune → ville/rayon SANS
    // filtre zone (le rayon suffit : un activateur d'Essonne à 15 km de Paris
    // doit sortir), dep → département(s) de la zone.
    var opts = { q: parseAnnQuery(CO.q || '') };
    if (mode === 'near' || mode === 'commune') {
      opts.target = CO.target;
      opts.radius = mode === 'near' ? CO.radius : 0;
    } else {
      opts.deps = (typeof coZoneDeps === 'function') ? coZoneDeps() : (CO.zone || []);
    }
    var rows = fnFilter(opts);
    if (mode === 'near') fnSortByDist(rows); else fnSortByName(rows);

    // carte : même mécanique que les entreprises (cercle du rayon, spirale)
    coClearMap();
    coFrameZone();
    var placed = fnPlaceMarkers(rows, CO_MAX_MARKERS);
    CO.markers = placed.group;
    CO.markerBySiret = placed.markerBy; // clés 'f:<id>' — coClearMap réinitialise
    CO.spread = placed.spread;

    // liste (cap du composeur)
    var box = document.getElementById('coResults');
    box.innerHTML = '';
    var shown = rows.slice(0, CO_MAX_LIST);
    shown.forEach(function (row) { box.appendChild(fnRowEl(row, CO.markerBySiret)); });
    if (!shown.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Aucun activateur France Num dans ce ciblage — élargissez le rayon ou changez de zone.';
      box.appendChild(p);
    } else if (rows.length > shown.length) {
      var p2 = document.createElement('p');
      p2.className = 'muted';
      p2.textContent = '+' + (rows.length - shown.length) + ' autre(s) activateur(s) non affiché(s).';
      box.appendChild(p2);
    }

    // statut
    var parts = [];
    if (mode === 'near' && CO.target) parts.push('📍 Autour de ' + esc(CO.target.nom) + ' — rayon ' + CO.radius + ' km');
    else if (mode === 'commune' && CO.target) parts.push('🏘 Commune de ' + esc(CO.target.nom));
    else parts.push('🗺 Zone ' + esc(coZoneLabel()));
    parts.push('<b>' + rows.length.toLocaleString('fr-FR') + ' activateur(s) France Num</b>');
    if (rows.length < FN.total) parts.push('base : ' + FN.total.toLocaleString('fr-FR'));
    if (CO.spread && CO.spread.groups) parts.push('📍 ' + CO.spread.groups + ' groupe(s) de marqueurs écartés en spirale');
    el.innerHTML = parts.join(' · ');
    setStatus('France Num : ' + rows.length.toLocaleString('fr-FR') + ' activateur(s)');
  }).catch(function (err) {
    if (seq !== FN.seq) return;
    console.error('[OpenFrance] France Num (composeur) :', err);
    el.innerHTML = '<span class="ann-warn">⚠️ Activateurs France Num : ' + esc(err.message || String(err)) + '</span>';
  });
}

// ---------- Recherche étendue (corp_ext.js, case #extFnOnly) ----------
// Mode annuaire (comme French Tech) : ville cible → activateurs du rayon
// (tri par distance, SANS filtre zone — miroir de extShowFTAround) ; champ
// ville effacé → toute la base (tri par nom). Le champ « métier » devient un
// filtre texte local — pas de ROMEO/LBB.
function extShowFNAround() {
  var status = document.getElementById('extStatus');
  var seq = ++EXT.seq;
  extClearMap();
  EXT.lastLbb = null; EXT.lastCurated = null; EXT.lastFT = null; EXT.romeFilter = null;
  document.getElementById('extMetiers').innerHTML = '';
  document.getElementById('extResults').innerHTML = '';
  extInfo(null);
  var q = parseAnnQuery((document.getElementById('extText').value || '').trim());
  status.textContent = '⏳ Activateurs France Num…';
  fnEnsure().then(function () {
    if (seq !== EXT.seq) return;
    // Comme French Tech (extShowFTAround) : PAS de filtre zone — rayon seul
    // autour de la ville cible ; champ effacé → base entière.
    var opts = { q: q };
    if (EXT.target) { opts.target = EXT.target; opts.radius = EXT.radius; }
    var rows = fnFilter(opts);
    if (EXT.target) fnSortByDist(rows); else fnSortByName(rows);
    FN.lastExt = { rows: rows, total: FN.total };
    fnExtRender();
  }).catch(function (err) {
    if (seq !== EXT.seq) return;
    console.error('[OpenFrance] Annuaire France Num :', err);
    showError('Annuaire France Num impossible.', err && err.message);
  });
}
function fnExtRender() {
  var status = document.getElementById('extStatus');
  var box = document.getElementById('extResults');
  box.innerHTML = '';
  var data = FN.lastExt;
  if (!data) return;
  var rows = data.rows.slice(0, EXT_MAX_LIST);
  extClearMap();
  extFrameZone();

  status.innerHTML = '🇫🇷 <b>' + data.rows.length.toLocaleString('fr-FR') + ' activateur(s) France Num</b>' +
    (EXT.target ? ' autour de ' + esc(EXT.target.nom) + ' — rayon ' + EXT.radius + ' km' :
      ' — France entière') +
    (data.rows.length < data.total ? ' · base : ' + data.total.toLocaleString('fr-FR') : '');

  rows.forEach(function (row) { box.appendChild(fnRowEl(row, EXT.markerBySiren)); });
  if (data.rows.length > rows.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '+' + (data.rows.length - rows.length) + ' autre(s) — affinez avec une ville et un rayon.';
    box.appendChild(p);
  }
  if (!data.rows.length) {
    extInfo('<span class="muted">🇫🇷 0 activateur France Num ' +
      (EXT.target ? 'dans un rayon de ' + EXT.radius + ' km autour de ' + esc(EXT.target.nom) : 'en France entière') +
      ' (sur ' + data.total + ' en base) — élargissez le rayon ou changez de zone.</span>');
    setStatus('Annuaire France Num : 0 activateur dans la zone');
    return;
  }
  extInfo('<span class="muted">✅ ' + data.rows.length + ' activateur(s) France Num' +
    (EXT.target ? ' autour de ' + esc(EXT.target.nom) + ' (' + EXT.radius + ' km)' : ' dans toute la base') +
    ' · 📍 positions = coordonnées du dataset (sièges indicatifs), fiche France Num au clic.</span>');
  setStatus('Annuaire France Num : ' + data.rows.length + ' activateur(s)');

  // marqueurs (groupe du mode étendu : retiré par extClearMap)
  var placed = fnPlaceMarkers(data.rows, EXT_MAX_LIST);
  EXT.markers = placed.group;
  EXT.markerBySiren = placed.markerBy; // clés 'f:<id>' (activateurs : pas de SIREN)
}
