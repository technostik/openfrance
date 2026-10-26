// OpenFrance — Pollens : cartographie de l'indice pollen par commune
// (département / zone multi-départements) + notation allergénique des essences.
//
// Source (via le proxy /wfs/pollen, cf. netlify.toml) :
//  - WFS Atmo France « Indice pollen » (dataset data.gouv.fr indice-pollen,
//    licence ODbL) : indice quotidien PAR COMMUNE pour la France métropolitaine
//    et la Corse, 3 échéances (aujourd'hui, demain, après-demain — publication
//    13h), 6 taxons (ambroisie, armoise, aulne, bouleau, graminées, olivier)
//    + indice synthétique (sous-indice le plus élevé). Échelle 0–6 :
//    0 indisponible, 1 très faible, 2 faible, 3 modéré, 4 élevé,
//    5 très élevé, 6 extrêmement élevé.
//  - L'API Atmo Data est protégée par token (inscription) → exclue :
//    le WFS est ouvert, gratuit, sans clé (contraintes du projet respectées).
//
// Architecture :
//  - Couche interrogée : ind_pol:ind_pol (SANS géométrie, ~35 000 communes ×
//    3 échéances). Les couches ind_national_pol* sont des couches de rendu
//    (tuiles/polygones) : inutiles ici — les contours viennent de
//    mergedZoneGeo (app.js), le WFS ne fournit que les attributs.
//  - Requête : CQL_FILTER par préfixes de départements + PROPERTYNAME pour
//    ne charger que les colonnes utiles (une seule requête pour toute la zone).
//  - Cache navigateur en 2 niveaux : mémoire (session) + IndexedDB
//    (openfrance-annuaire, clés « pl|… », TTL 6 h — publication quotidienne).
//    Le service worker ne met PAS /wfs/ en cache (données quotidiennes fraîches).
//  - Choroplèthe par commune (modèle score.js : couche propre + palette par
//    classe), légende et top des communes dans le panneau latéral.
//  - Notation allergénique des essences : référentiel statique curated
//    (échelle indicative 0–5, d'après les données de veille du RNSA et le
//    rapport ANSES 2019 sur les pollens) — sert à la recherche par essence et
//    au libellé des critères ; les indices, eux, viennent du flux Atmo France.
//
// Dépend de app.js (state, DEP_FOLDERS, depNom, zoneLabel, mergedZoneGeo,
// setStatus, showError, hideError, esc, normTxt, map) et annuaire.js (idbGet,
// idbSet). score.js (SC_TYPES) doit être chargé AVANT pollens.js pour le
// critère du Composeur (script déclaré après score.js dans index.html).

var POL = {
  active: false,
  prevRefresh: null, // refresh() d'app.js avant l'entrée dans le mode
  cache: {},        // clé pl|<deps triés> -> { v, date } (mémoire, session)
  zoneKey: null,    // clé de la zone actuellement affichée
  data: null,       // données de la zone courante { rows, dates, byDate, sources }
  geo: null,        // contours communes fusionnés de la zone (mergedZoneGeo, app.js)
  names: {},        // code -> nom de commune (issu de la géo locale)
  taxon: 'global',  // taxon affiché (id POL_TAXONS)
  date: null,       // échéance affichée (date_ech) — null = auto (jour)
  essence: null,    // essence sélectionnée (POL_ESSENCES) ou null
  layer: null,      // couche choroplèthe Leaflet (créée puis restylée en place)
  seq: 0            // anti-réponse obsolète (concurrence des refresh)
};

var PL_TTL = 6 * 3600 * 1000; // 6 h : publication quotidienne à 13h

// Taxons du flux WFS (champs de la couche ind_pol:ind_pol) + notation
// allergénique indicative 0–5 (RNSA/ANSES) pour l'affichage et le Composeur.
var POL_TAXONS = [
  { id: 'global',    code: 'code_qual', label: 'Indice synthétique', latin: '',      notation: null,
    hint: 'sous-indice le plus élevé parmi les 6 taxons' },
  { id: 'aulne',     code: 'code_aul',  label: 'Aulne',     latin: 'Alnus',     notation: 3 },
  { id: 'bouleau',   code: 'code_boul', label: 'Bouleau',   latin: 'Betula',    notation: 5 },
  { id: 'graminees', code: 'code_gram', label: 'Graminées', latin: 'Poaceae',   notation: 5 },
  { id: 'ambroisie', code: 'code_ambr', label: 'Ambroisie', latin: 'Ambrosia',  notation: 5 },
  { id: 'armoise',   code: 'code_arm',  label: 'Armoise',   latin: 'Artemisia', notation: 3 },
  { id: 'olivier',   code: 'code_oliv', label: 'Olivier',   latin: 'Olea',      notation: 3 }
];

// Palette officielle de l'indice pollen v2 (échelle 0–6).
var POL_CLASSES = [
  { v: 0, label: 'Indisponible',       color: '#475569' },
  { v: 1, label: 'Très faible',        color: '#22c55e' },
  { v: 2, label: 'Faible',             color: '#a3e635' },
  { v: 3, label: 'Modéré',             color: '#eab308' },
  { v: 4, label: 'Élevé',              color: '#fb923c' },
  { v: 5, label: 'Très élevé',         color: '#ef4444' },
  { v: 6, label: 'Extrêmement élevé',  color: '#b91c1c' }
];

// Référentiel des essences pour la recherche + notation (0–5, indicatif) :
// d'après les échelles de risque allergique du RNSA (pollens.fr) et le
// rapport ANSES 2019 « Qualité de l'air ambiant — pollens » (recommandations
// de gestion). Les 6 taxons du flux ont un champ `taxon` ; les autres essences
// ne sont PAS suivies par l'indice national (information seulement).
var POL_ESSENCES = [
  { nom: 'Aulne',     latin: 'Alnus',            taxon: 'aulne',     notation: 3, note: 'pollinise fin hiver ; allergie souvent croisée avec le bouleau' },
  { nom: 'Bouleau',   latin: 'Betula',           taxon: 'bouleau',   notation: 5, note: 'un des principaux allergènes arboricoles du nord et de l\'est' },
  { nom: 'Graminées', latin: 'Poaceae',          taxon: 'graminees', notation: 5, note: 'première cause de pollinose en France (prairies, céréales)' },
  { nom: 'Ambroisie', latin: 'Ambrosia',         taxon: 'ambroisie', notation: 5, note: 'allergène majeur, saison estivale (ANSES : enjeu sanitaire)' },
  { nom: 'Armoise',   latin: 'Artemisia',        taxon: 'armoise',   notation: 3, note: 'herbacée, fin d\'été' },
  { nom: 'Olivier',   latin: 'Olea europaea',    taxon: 'olivier',   notation: 3, note: 'allergène principal du pourtour méditerranéen' },
  { nom: 'Cyprès',    latin: 'Cupressus',        taxon: null,        notation: 5, note: 'allergène majeur du sud (pollinisation hivernale) — non suivi par l\'indice national (CartoPollen INRAE)' },
  { nom: 'Noisetier', latin: 'Corylus',          taxon: null,        notation: 3, note: 'réaction croisée fréquente avec le bouleau' },
  { nom: 'Frêne',     latin: 'Fraxinus',         taxon: null,        notation: 3, note: 'pollinisation précoce, croisements oléacées (olivier/lilas)' },
  { nom: 'Platane',   latin: 'Platanus',         taxon: null,        notation: 2, note: 'urbain ; poils des fruits plus irritants que le pollen' },
  { nom: 'Chêne',     latin: 'Quercus',          taxon: null,        notation: 2, note: 'fortes concentrations printanières mais faible allergénicité' },
  { nom: 'Charme',    latin: 'Carpinus',         taxon: null,        notation: 2, note: 'croisement possible avec le bouleau' },
  { nom: 'Peuplier',  latin: 'Populus',          taxon: null,        notation: 2, note: 'pollinisation précoce' },
  { nom: 'Saule',     latin: 'Salix',            taxon: null,        notation: 2, note: 'pollinisation précoce' },
  { nom: 'Tilleul',   latin: 'Tilia',            taxon: null,        notation: 2, note: 'insectes sous floraison plus souvent en cause que le pollen' },
  { nom: 'Châtaignier', latin: 'Castanea',      taxon: null,        notation: 1, note: 'pollinisation estivale, faible allergénicité' },
  { nom: 'Pin',       latin: 'Pinus',            taxon: null,        notation: 1, note: 'pollen abondant mais peu allergisant (granuleux)' },
  { nom: 'Pariétaire', latin: 'Parietaria',      taxon: null,        notation: 4, note: 'urticacée majeure du pourtour méditerranéen (murailles)' },
  { nom: 'Ortie',     latin: 'Urtica',           taxon: null,        notation: 2, note: 'urticacées, été' },
  { nom: 'Plantain',  latin: 'Plantago',         taxon: null,        notation: 2, note: 'herbacée, croisement possible avec les graminées' }
];

function plTaxon(id) {
  for (var i = 0; i < POL_TAXONS.length; i++) if (POL_TAXONS[i].id === id) return POL_TAXONS[i];
  return null;
}
function plNotationDots(n) { // ●●●●○
  n = Math.max(0, Math.min(5, Math.round(n || 0)));
  var s = '';
  for (var i = 0; i < 5; i++) s += i < n ? '●' : '○';
  return s;
}
function plClass(v) {
  for (var i = 0; i < POL_CLASSES.length; i++) if (POL_CLASSES[i].v === v) return POL_CLASSES[i];
  return POL_CLASSES[0]; // 0 = indisponible
}

// ---------- Zone ----------
function plZoneDeps() {
  var z = (state.zone || []).filter(function (d) { return !!DEP_FOLDERS[d]; });
  if (z.length) return z;
  return (state.view === 'dep' && state.dep && state.dep.code) ? [state.dep.code] : [];
}
function plKey(deps) { return 'pl|' + deps.slice().sort().join('+'); }

// ---------- Requête WFS (via le proxy /wfs/pollen) ----------
function plWfsUrl(deps) {
  // Une seule requête pour toute la zone : préfixes de code INSEE en CQL.
  // PROPERTYNAME évite de charger les géométries (contours déjà locaux) ;
  // la couche ind_pol:ind_pol n'en expose de toute façon pas (null).
  var cols = ['code_zone', 'lib_zone', 'date_ech', 'source', 'alerte'];
  POL_TAXONS.forEach(function (t) { cols.push(t.code); });
  var like = deps.map(function (d) { return "code_zone LIKE '" + d + "%'"; }).join(' OR ');
  return '/wfs/pollen?service=WFS&version=2.0.0&request=GetFeature' +
    '&outputFormat=application/json' +
    '&typeNames=' + encodeURIComponent('ind_pol:ind_pol') +
    '&PROPERTYNAME=' + encodeURIComponent(cols.join(',')) +
    '&CQL_FILTER=' + encodeURIComponent('(' + like + ')');
}

// ---------- Chargement (RAM → IndexedDB → WFS) ----------
// { rows, dates (triées), byDate: { date -> { code -> row } }, sources }
function plParse(js) {
  var rows = [], dates = {}, byDate = {}, sources = {};
  var feats = (js && js.features) || [];
  feats.forEach(function (f) {
    var p = (f && f.properties) || {};
    var code = String(p.code_zone || '').trim();
    var date = String(p.date_ech || '').slice(0, 10);
    if (!code || !date) return;
    var r = { code: code, lib: p.lib_zone || '', date: date, src: p.source || '',
      alerte: p.alerte, vals: {} };
    POL_TAXONS.forEach(function (t) {
      var n = parseInt(p[t.code], 10);
      r.vals[t.code] = isNaN(n) ? null : n;
    });
    rows.push(r);
    dates[date] = 1;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][code] = r;
    if (r.src) sources[r.src] = 1;
  });
  return {
    rows: rows,
    dates: Object.keys(dates).sort(),
    byDate: byDate,
    sources: Object.keys(sources)
  };
}
function plLoad(deps) {
  var key = plKey(deps);
  if (POL.cache[key] && Date.now() - POL.cache[key].date < PL_TTL) {
    return Promise.resolve(POL.cache[key].v);
  }
  return idbGet(key).then(function (cached) {
    if (cached && cached.v && Date.now() - cached.date < PL_TTL) {
      POL.cache[key] = cached;
      return cached.v;
    }
    return fetch(plWfsUrl(deps)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' (WFS indice pollen)');
      return r.json();
    }).then(function (js) {
      var v = plParse(js);
      var rec = { v: v, date: Date.now() };
      POL.cache[key] = rec;
      idbSet(key, rec); // best effort, clé « pl|… » visible/purgeable dans la page 🗒 Cache
      return v;
    });
  });
}

// ---------- Échéances ----------
function plTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function plDefaultDate(dates) { // aujourd'hui si publiée, sinon la plus proche dispo
  if (!dates || !dates.length) return null;
  var today = plTodayStr();
  var best = null;
  for (var i = 0; i < dates.length; i++) {
    if (dates[i] <= today) best = dates[i]; // dernière échéance déjà publiée
  }
  return best || dates[0]; // sinon la première à venir (J+1/J+2)
}
function plDateLabel(d) {
  if (!d) return '—';
  var t = plTodayStr();
  var n = new Date();
  n.setDate(n.getDate() + 1);
  var t1 = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2);
  n.setDate(n.getDate() + 1);
  var t2 = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2);
  if (d === t) return "aujourd'hui";
  if (d === t1) return 'demain';
  if (d === t2) return 'après-demain';
  return d;
}
function plRowsFor(data, date) {
  if (!data || !data.byDate || !date) return {};
  return data.byDate[date] || {};
}

// ---------- Valeurs ----------
function plVal(row, taxon) { // 0 = indisponible (jamais « aucun pollen »)
  if (!row) return 0;
  var t = plTaxon(taxon);
  if (!t || !t.code) return 0;
  var v = row.vals ? row.vals[t.code] : null;
  return (v === null || v === undefined || isNaN(v)) ? 0 : v;
}
function plNotationHtml(t, essenceNote) { // notation allergénique d'un taxon suivi
  if (!t || t.notation === null || t.notation === undefined) return '';
  var html = 'Allergénicité : <b>' + plNotationDots(t.notation) + '</b> ' + t.notation + '/5';
  if (essenceNote) html += ' — <span class="muted">' + esc(essenceNote) + '</span>';
  return html;
}

// ---------- Rendu ----------
function plLegend(t) {
  var el = document.getElementById('plLegend');
  el.innerHTML = '';
  POL_CLASSES.forEach(function (c) {
    var row = document.createElement('div');
    row.className = 'legend-row';
    var sw = document.createElement('span');
    sw.className = 'legend-color';
    sw.style.background = c.color;
    var lab = document.createElement('span');
    lab.textContent = c.v + ' — ' + c.label;
    row.appendChild(sw); row.appendChild(lab);
    el.appendChild(row);
  });
  var note = document.createElement('div');
  note.className = 'muted';
  note.style.marginTop = '6px';
  var nh = t ? esc(t.label) + (t.latin ? ' <i>(' + esc(t.latin) + ')</i>' : '') : '';
  if (t && t.hint) nh += '<br>' + esc(t.hint);
  if (plNotationHtml(t)) nh += '<br>' + plNotationHtml(t);
  note.innerHTML = nh;
  el.appendChild(note);
}
function plResults(vals, t) {
  var el = document.getElementById('plResults');
  var arr = [];
  for (var code in vals) {
    arr.push({ code: code, nom: (POL.names && POL.names[code]) || code, v: vals[code] });
  }
  arr.sort(function (a, b) { return b.v - a.v || (a.nom < b.nom ? -1 : 1); });
  if (!arr.length) {
    el.innerHTML = '<p class="muted">Aucune commune avec un indice publié pour ce taxon et cette échéance.</p>';
    return;
  }
  var html = '<p class="muted" style="margin:4px 0 2px">Top ' + Math.min(30, arr.length) +
    ' communes — ' + esc(t ? t.label : 'indice') + ' (' + esc(plDateLabel(POL.date)) + ')</p>';
  arr.slice(0, 30).forEach(function (a, i) {
    var c = plClass(a.v);
    html += '<div class="top-row"><span>' + (i + 1) + '. ' + esc(a.nom) +
      '</span><span style="color:' + c.color + '"><b>' + c.v + '</b> · ' + esc(c.label) + '</span></div>';
  });
  el.innerHTML = html;
}
function plStyleFor(vals, code, t) {
  var v = vals[code];
  var c = plClass(v || 0);
  return { weight: 1, color: '#0f172a', fillColor: c.color, fillOpacity: v > 0 ? 0.85 : 0.35 };
}
function plDraw(geo, vals, t, date) {
  if (POL.layer) { // redessin en place : setStyle, pas de nouvelle couche
    POL.layer.eachLayer(function (l) {
      if (l.feature) l.setStyle(plStyleFor(vals, l.feature.properties.code, t));
    });
    return;
  }
  POL.layer = L.geoJSON(geo, {
    style: function (f) { return plStyleFor(vals, f.properties.code, t); },
    onEachFeature: function (f, l) {
      l.bindTooltip(function () { // live : suit taxon/échéance sans rebind
        var code = f.properties.code;
        var nom = (POL.names && POL.names[code]) || code;
        var rows = plRowsFor(POL.data, POL.date);
        var row = rows[code];
        var v = plVal(row, POL.taxon);
        var c = plClass(v || 0);
        var html = '<b>' + esc(nom) + '</b>';
        if (!row) html += '<br><i>Indice non publié</i>';
        else {
          html += '<br>' + esc(t ? t.label : 'Indice') + ' : <b style="color:' + c.color + '">' +
            (v > 0 ? v + '/6 — ' + esc(c.label) : 'n.d.') + '</b>';
          var det = [];
          POL_TAXONS.forEach(function (tx) {
            if (tx.id === 'global') return;
            var tv = plVal(row, tx.id);
            if (tv > 0) det.push(esc(tx.label) + ' ' + tv);
          });
          if (det.length) html += '<br><span class="muted">' + det.join(' · ') + '</span>';
        }
        return html;
      }, { sticky: true });
    }
  }).addTo(map);
  map.fitBounds(POL.layer.getBounds(), { padding: [30, 30] });
}
function plEcheanceRebuild(dates) {
  var sel = document.getElementById('plEcheance');
  var cur = POL.date || plDefaultDate(dates);
  sel.innerHTML = '';
  (dates || []).forEach(function (d) {
    var o = document.createElement('option');
    o.value = d;
    o.textContent = plDateLabel(d);
    sel.appendChild(o);
  });
  POL.date = (dates && dates.length) ? ((dates.indexOf(cur) !== -1) ? cur : plDefaultDate(dates)) : null;
  if (POL.date) sel.value = POL.date;
}
function plTaxonOptions() {
  var sel = document.getElementById('plTaxon');
  sel.innerHTML = '';
  POL_TAXONS.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.label + (t.notation !== null ? ' (allergénicité ' + t.notation + '/5)' : '');
    sel.appendChild(o);
  });
  sel.value = POL.taxon;
}

// ---------- Recherche d'essence (notation + bascule du taxon) ----------
function plEssDropEl(show) {
  var d = document.getElementById('plEssenceDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function plEssRender(matches) {
  var d = document.getElementById('plEssenceDrop');
  d.innerHTML = '';
  matches.forEach(function (e) {
    var row = document.createElement('div');
    row.innerHTML = esc(e.nom) + ' <span class="muted">(' + esc(e.latin) + ' · ' +
      plNotationDots(e.notation) + ' ' + e.notation + '/5)</span>';
    row.addEventListener('mousedown', function (ev) { // mousedown : avant le blur
      ev.preventDefault();
      plSetEssence(e);
      plEssDropEl(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}
function plEssSearch(q) {
  q = normTxt(q);
  if (!q) return [];
  return POL_ESSENCES.filter(function (e) {
    return normTxt(e.nom).indexOf(q) !== -1 || normTxt(e.latin).indexOf(q) !== -1;
  }).slice(0, 8);
}
function plSetEssence(e) {
  POL.essence = e || null;
  document.getElementById('plEssence').value = e ? e.nom : '';
  if (e && e.taxon && e.taxon !== POL.taxon) {
    // essence suivie par l'indice national : la carte bascule sur son taxon
    POL.taxon = e.taxon;
    document.getElementById('plTaxon').value = POL.taxon;
  }
  plNotationUpdate();
  plRedraw();
}
function plNotationUpdate() { // ligne de notation du taxon courant (sans essence)
  var el = document.getElementById('plNotation');
  var t = plTaxon(POL.taxon);
  var e = POL.essence;
  var html = '';
  if (e) {
    html = '🌿 <b>' + esc(e.nom) + '</b> (' + esc(e.latin) + ') — notation <b>' +
      plNotationDots(e.notation) + '</b> ' + e.notation + '/5' +
      (e.note ? '<br><span class="muted">' + esc(e.note) + '</span>' : '') +
      (e.taxon ? '' : '<br><span class="muted">Essence non suivie par l\'indice national : information seulement.</span>');
  } else if (t && t.notation !== null && t.notation !== undefined) {
    html = esc(t.label) + ' — allergénicité <b>' + plNotationDots(t.notation) + '</b> ' +
      t.notation + '/5' +
      (t.hint ? '<br><span class="muted">' + esc(t.hint) + '</span>' : '');
  }
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

// ---------- Vue France ----------
function plRenderFrance() {
  document.getElementById('plStatus').textContent =
    'Cliquez sur un département (ou définissez une zone multi-départements) pour afficher l\'indice pollen de ses communes.';
  document.getElementById('plLegend').innerHTML = '';
  document.getElementById('plResults').innerHTML = '';
  document.getElementById('levelTitle').textContent = 'Pollens — France';
}

// ---------- Rendu principal ----------
function plRedraw() { // re-rendu sans nouvelle requête (taxon/échéance/essence)
  if (!POL.active || !POL.data || !POL.geo) return;
  var t = plTaxon(POL.taxon);
  var rows = plRowsFor(POL.data, POL.date);
  var vals = {};
  for (var code in rows) {
    var v = plVal(rows[code], POL.taxon);
    if (v > 0) vals[code] = v; // 0 = indisponible → non coloré (gris)
  }
  plDraw(POL.geo, vals, t, POL.date);
  plLegend(t);
  plResults(vals, t);
  plStatusUpdate(vals);
}
function plStatusUpdate(vals) {
  var el = document.getElementById('plStatus');
  var data = POL.data;
  if (!data || !data.rows.length) {
    el.innerHTML = 'Aucune donnée pollen pour cette zone : le flux Atmo France couvre la France métropolitaine et la Corse uniquement (pas de DOM).';
    return;
  }
  var t = plTaxon(POL.taxon);
  var zoneLbl = zoneLabel(plZoneDeps());
  var n = 0;
  for (var c in vals) n++;
  el.innerHTML = (t ? esc(t.label) : 'Indice') + ' · ' + esc(plDateLabel(POL.date)) +
    ' — <b>' + n + '</b> commune(s) avec indice publié sur ' + esc(zoneLbl) +
    (data.sources && data.sources.length ? ' <span class="muted">(' + esc(data.sources.join(' · ')) + ')</span>' : '');
}
function plRefresh() {
  hideError();
  if (POL.layer) { map.removeLayer(POL.layer); POL.layer = null; }
  if (state.view === 'france' || !state.dep) { plRenderFrance(); return; }
  var deps = plZoneDeps();
  if (!deps.length) { plRenderFrance(); return; }
  var zoneLbl = zoneLabel(deps);
  document.getElementById('backBtn').hidden = false;
  document.getElementById('levelTitle').textContent = 'Pollens — ' + zoneLbl;
  var seq = ++POL.seq;
  setStatus("⏳ Indice pollen de " + zoneLbl + "…", 'loading');
  document.getElementById('plStatus').textContent =
    "⏳ Interrogation du flux Atmo France (indice pollen par commune)…";
  Promise.all([plLoad(deps), mergedZoneGeo(deps)]).then(function (res) {
    if (seq !== POL.seq) return; // réponse obsolète
    var data = res[0], geo = res[1];
    POL.data = data; POL.geo = geo; POL.zoneKey = plKey(deps);
    var names = {};
    (geo.features || []).forEach(function (f) { names[f.properties.code] = f.properties.nom; });
    POL.names = names;
    plEcheanceRebuild(data.dates);
    if (!data.rows.length) {
      // zone sans données (DOM 97x : le flux ne couvre pas l'outre-mer) :
      // message explicite, jamais de carte muette
      plRenderFrance();
      document.getElementById('plStatus').innerHTML =
        'Aucune donnée pollen pour ' + esc(zoneLbl) +
        ' : le flux Atmo France couvre la France métropolitaine et la Corse uniquement (pas de DOM).';
      setStatus('Pollens — ' + zoneLbl + ' : pas de données');
      return;
    }
    plRedraw();
    setStatus('🌾 Pollens — ' + zoneLbl);
    var acd = document.getElementById('annCacheDlg');
    if (acd && acd.style.display !== 'none') renderCachePage();
  }).catch(function (err) {
    if (seq !== POL.seq) return;
    console.error('[OpenFrance] Pollens :', err);
    setStatus('Erreur pollens');
    showError('Impossible de charger l\'indice pollen.', err.message);
    document.getElementById('plStatus').textContent = 'Erreur : ' + err.message;
  });
}

// ---------- Entrée/sortie de catégorie ----------
function plEnter() {
  POL.active = true;
  POL.prevRefresh = refresh;
  refresh = plRefresh; // openDepartment/backToFrance appellent refresh()
  document.getElementById('plControls').style.display = 'flex';
  document.getElementById('plHint').style.display = '';
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('plPanel').style.display = '';
  var zIn = (state.zone || []).filter(function (d) { return !!DEP_FOLDERS[d]; });
  if (!zIn.length && state.view === 'dep' && state.dep) zIn = [state.dep.code];
  if (zIn.length) {
    state.zone = zIn;
    state.view = 'dep';
    state.dep = { code: zIn[0], nom: depNom(zIn[0]) };
    document.getElementById('backBtn').hidden = false;
    document.getElementById('levelTitle').textContent = 'Pollens — ' + zoneLabel(zIn);
  } else {
    state.view = 'france'; state.dep = null;
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'Pollens — France';
  }
  // Rafraîchissement différé : les listeners des autres catégories restituent
  // la zone APRÈS plEnter (ordre des listeners, bug n°27).
  setTimeout(plRefresh, 0);
}
function plLeave() {
  POL.active = false;
  if (POL.prevRefresh) refresh = POL.prevRefresh;
  if (POL.layer) { map.removeLayer(POL.layer); POL.layer = null; }
  document.getElementById('plControls').style.display = 'none';
  document.getElementById('plHint').style.display = 'none';
  document.getElementById('plNotation').style.display = 'none';
  plEssDropEl(false);
  document.getElementById('plEssence').value = '';
  POL.essence = null;
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('plPanel').style.display = 'none';
  // Restaure le titre correspondant au territoire conservé (app.js gère la suite)
  if (state.view === 'dep' && state.dep) {
    document.getElementById('levelTitle').textContent =
      ((state.zone && state.zone.length) ? zoneLabel(state.zone) : state.dep.nom + ' (' + state.dep.code + ')') + ' — par commune';
  } else {
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'France — par département';
  }
}

// ---------- Critère « Pollens » du Composeur de critères ----------
// pollens.js s'enregistre dans SC_TYPES au chargement : le menu ＋ du Composeur
// et la restauration des préférences lisent SC_TYPES dynamiquement, donc tout critère
// ajouté avant scInitUI() apparaît et fonctionne (sens ⬇ par défaut : moins de
// pollen = mieux). Valeur = sous-indice du taxon pour l'échéance du jour
// (aujourd'hui si publiée, sinon la plus proche disponible).
if (typeof SC_TYPES !== 'undefined') {
  SC_TYPES.pollen = {
    icon: '🌾', label: 'Pollens (indice du taxon)', dir: 'min', cfg: 'select', field: 'taxon',
    defCfg: function () { return { taxon: 'graminees' }; },
    key: function (cfg) { return 'pollen|' + cfg.taxon; },
    cfgOptions: function () {
      return POL_TAXONS.map(function (t) {
        return {
          v: t.id,
          l: 'Pollens — ' + t.label + (t.notation !== null ? ' (allergénicité ' + t.notation + '/5)' : '')
        };
      });
    },
    describe: function (cfg) {
      var t = plTaxon(cfg.taxon);
      return 'Pollens — ' + (t ? t.label : '?') +
        (t && t.notation !== null ? ' (notation ' + t.notation + '/5)' : '');
    },
    defDir: function () { return 'min'; },
    ensure: function () { return plLoad(SC.zone.slice()); },
    vals: function (cfg) {
      var deps = SC.zone.slice();
      var data = POL.cache[plKey(deps)] && POL.cache[plKey(deps)].v;
      if (!data) return {}; // chargée par ensure() (cache mémoire partagé)
      var d = plDefaultDate(data.dates);
      var rows = plRowsFor(data, d), out = {};
      for (var code in rows) {
        var v = plVal(rows[code], cfg.taxon);
        if (v > 0) out[code] = v; // 0 = indisponible → donnée absente (part neutre)
      }
      return out;
    },
    fmt: function (v) { return v + '/6'; }
  };
}

// ---------- Branchement UI ----------
function plInitUI() {
  var catSel = document.getElementById('categorySelect');
  catSel.addEventListener('change', function () {
    if (this.value === 'pollens') plEnter(); else if (POL.active) plLeave();
  });

  plTaxonOptions();
  document.getElementById('plTaxon').addEventListener('change', function () {
    POL.taxon = this.value;
    POL.essence = null; // changement manuel de taxon : la notation suit le taxon
    plRedraw();
    plNotationUpdate();
  });
  document.getElementById('plEcheance').addEventListener('change', function () {
    POL.date = this.value;
    plRedraw();
  });

  // Recherche d'essence : notation + bascule du taxon si suivi par le flux
  var essIn = document.getElementById('plEssence');
  var essDeb = null;
  essIn.addEventListener('input', function () {
    clearTimeout(essDeb);
    if (!essIn.value.trim()) { plEssDropEl(false); POL.essence = null; plNotationUpdate(); return; }
    essDeb = setTimeout(function () { plEssRender(plEssSearch(essIn.value)); }, 120);
  });
  essIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var m = plEssSearch(essIn.value);
      if (m.length) { plSetEssence(m[0]); plEssDropEl(false); }
    } else if (e.key === 'Escape') plEssDropEl(false);
  });
  essIn.addEventListener('blur', function () { setTimeout(function () { plEssDropEl(false); }, 150); });
  essIn.addEventListener('focus', function () {
    if (essIn.value.trim()) plEssRender(plEssSearch(essIn.value));
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', plInitUI);
}
