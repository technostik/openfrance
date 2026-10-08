// OpenFrance — carte choroplèthe de la délinquance (départements + communes)
// Données : data.gouv.fr (Ministère de l'Intérieur), proxifiées via Netlify.

var CSV_URL = '/data/delinquance-dep.csv';
var GEO_URL = '/data/departements.json';
var TABULAR_URL = '/api/communes/';
var TOTAL_LABEL = 'Ensemble des faits constatés (tous indicateurs)';

// Dossiers des contours communaux (france-geojson) : code -> dossier
var DEP_FOLDERS = {
  '01':'01-ain','02':'02-aisne','03':'03-allier','04':'04-alpes-de-haute-provence','05':'05-hautes-alpes',
  '06':'06-alpes-maritimes','07':'07-ardeche','08':'08-ardennes','09':'09-ariege','10':'10-aube',
  '11':'11-aude','12':'12-aveyron','13':'13-bouches-du-rhone','14':'14-calvados','15':'15-cantal',
  '16':'16-charente','17':'17-charente-maritime','18':'18-cher','19':'19-correze','21':'21-cote-d-or',
  '22':'22-cotes-d-armor','23':'23-creuse','24':'24-dordogne','25':'25-doubs','26':'26-drome',
  '27':'27-eure','28':'28-eure-et-loir','29':'29-finistere','2A':'2A-corse-du-sud','2B':'2B-haute-corse',
  '30':'30-gard','31':'31-haute-garonne','32':'32-gers','33':'33-gironde','34':'34-herault',
  '35':'35-ille-et-vilaine','36':'36-indre','37':'37-indre-et-loire','38':'38-isere','39':'39-jura',
  '40':'40-landes','41':'41-loir-et-cher','42':'42-loire','43':'43-haute-loire','44':'44-loire-atlantique',
  '45':'45-loiret','46':'46-lot','47':'47-lot-et-garonne','48':'48-lozere','49':'49-maine-et-loire',
  '50':'50-manche','51':'51-marne','52':'52-haute-marne','53':'53-mayenne','54':'54-meurthe-et-moselle',
  '55':'55-meuse','56':'56-morbihan','57':'57-moselle','58':'58-nievre','59':'59-nord',
  '60':'60-oise','61':'61-orne','62':'62-pas-de-calais','63':'63-puy-de-dome','64':'64-pyrenees-atlantiques',
  '65':'65-hautes-pyrenees','66':'66-pyrenees-orientales','67':'67-bas-rhin','68':'68-haut-rhin','69':'69-rhone',
  '70':'70-haute-saone','71':'71-saone-et-loire','72':'72-sarthe','73':'73-savoie','74':'74-haute-savoie',
  '75':'75-paris','76':'76-seine-maritime','77':'77-seine-et-marne','78':'78-yvelines','79':'79-deux-sevres',
  '80':'80-somme','81':'81-tarn','82':'82-tarn-et-garonne','83':'83-var','84':'84-vaucluse',
  '85':'85-vendee','86':'86-vienne','87':'87-haute-vienne','88':'88-vosges','89':'89-yonne',
  '90':'90-territoire-de-belfort','91':'91-essonne','92':'92-hauts-de-seine','93':'93-seine-saint-denis',
  '94':'94-val-de-marne','95':'95-val-d-oise','971':'971-guadeloupe','972':'972-martinique',
  '973':'973-guyane','974':'974-la-reunion','976':'976-mayotte'
};

var statusEl = document.getElementById('status');
function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || '';
}
function showError(msg, detail) {
  console.error('[OpenFrance]', msg, detail || '');
  setStatus('❌ ' + msg, 'error');
  document.getElementById('errorBanner').style.display = 'block';
  document.getElementById('errorText').textContent = msg + (detail ? ' — ' + detail : '');
  document.getElementById('toplist').innerHTML = '<p class="muted">Indisponible (erreur de chargement).</p>';
}
function hideError() { document.getElementById('errorBanner').style.display = 'none'; }

// Échelle de couleurs vert -> jaune -> rouge
function colorFor(t) {
  var stops = [[46,125,50],[124,179,66],[253,224,71],[244,121,32],[183,28,28]];
  var x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  var i = Math.min(stops.length - 2, Math.floor(x));
  var f = x - i;
  var c = stops[i].map(function (v, k) { return Math.round(v + f * (stops[i + 1][k] - v)); });
  return 'rgb(' + c.join(',') + ')';
}

// Parser CSV robuste (guillemets, séparateur auto, BOM)
function splitCSVLine(line, sep) {
  var cols = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === sep) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  if (!lines.length) throw new Error('fichier vide');
  var sep = lines[0].split(';').length >= lines[0].split(',').length ? ';' : ',';
  var header = splitCSVLine(lines[0], sep).map(function (h) { return h.trim().toLowerCase(); });
  console.info('[OpenFrance] En-tête CSV détecté :', header.join(' | '));
  var idx = {};
  ['code_departement', 'annee', 'indicateur', 'nombre', 'taux_pour_mille', 'insee_pop'].forEach(function (col) {
    idx[col] = header.indexOf(col);
  });
  var missing = Object.keys(idx).filter(function (c) { return idx[c] === -1; });
  if (missing.length) throw new Error('colonnes manquantes dans le CSV : ' + missing.join(', '));
  function num(v) {
    v = (v || '').trim().replace(/^"|"$/g, '').replace(/\u00A0/g, '').replace(/ /g, '').replace(',', '.');
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  function intg(v) { return Math.round(num(v)); }
  var rows = [];
  for (var r = 1; r < lines.length; r++) {
    var cols = splitCSVLine(lines[r], sep);
    if (cols.length < header.length) continue;
    var annee = intg(cols[idx.annee]);
    if (!annee) continue;
    rows.push({
      dep: (cols[idx.code_departement] || '').trim(),
      annee: annee,
      indicateur: (cols[idx.indicateur] || '').trim(),
      nombre: intg(cols[idx.nombre]),
      taux: num(cols[idx.taux_pour_mille]),
      pop: intg(cols[idx.insee_pop])
    });
  }
  if (!rows.length) throw new Error('aucune ligne exploitable');
  return rows;
}

// Agrégation "tous indicateurs" avec taux recalculé sur la population INSEE
function buildAggregates(rows) {
  var agg = {};
  rows.forEach(function (r) {
    var key = r.zone + '|' + r.annee;
    if (!agg[key]) agg[key] = { zone: r.zone, annee: r.annee, nombre: 0, pop: r.pop || 0, estim: false };
    agg[key].nombre += r.nombre;
    if (r.estim) agg[key].estim = true;
    if (r.pop) agg[key].pop = r.pop;
  });
  var list = [];
  for (var k in agg) {
    var a = agg[k];
    a.indicateur = TOTAL_LABEL;
    a.taux = a.pop > 0 ? (a.nombre / a.pop) * 1000 : 0;
    list.push(a);
  }
  return list;
}

var map = L.map('map', { attributionControl: true }).setView([46.6, 2.5], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 12
}).addTo(map);

var geoLayer = null;
var allRows = [];       // lignes départementales détaillées (champ .dep)
var totalRows = [];     // lignes départementales agrégées (champ .zone)

var state = {
  view: 'france',       // 'france' | 'dep'
  dep: null,            // {code, nom}
  communesCache: {},    // "code|annee" -> {rows, totals}
  communesGeo: {}       // code -> geojson communes (cache)
};

function fmt(n) { return (Math.round(n)).toLocaleString('fr-FR'); }

// ---------- Rendu choroplèthe générique ----------
function renderChoropleth(geo, data, unitLabel) {
  var min = Infinity, max = -Infinity;
  var values = [];
  for (var k in data) { values.push(data[k]); }
  values.forEach(function (d) {
    if (d.taux < min) min = d.taux;
    if (d.taux > max) max = d.taux;
  });
  if (!values.length) { min = 0; max = 1; }
  var span = max - min || 1;

  var legend = document.getElementById('legend');
  legend.innerHTML = '';
  for (var c = 0; c < 6; c++) {
    var lo = min + span * c / 6, hi = min + span * (c + 1) / 6;
    var row = document.createElement('div');
    row.className = 'legend-row';
    var swatch = document.createElement('span');
    swatch.className = 'legend-color';
    swatch.style.background = colorFor((c + 0.5) / 6);
    var label = document.createElement('span');
    label.textContent = lo.toFixed(2) + ' – ' + hi.toFixed(2);
    row.appendChild(swatch); row.appendChild(label);
    legend.appendChild(row);
  }

  if (geoLayer) map.removeLayer(geoLayer);
  geoLayer = L.geoJSON(geo, {
    style: function (feature) {
      var d = data[feature.properties.code];
      var t = d ? (d.taux - min) / span : 0;
      return { weight: 1, color: '#0f172a', fillColor: d ? colorFor(t) : '#334155', fillOpacity: d ? 0.85 : 0.4 };
    },
    onEachFeature: function (feature, layer) {
      var code = feature.properties.code;
      var nom = feature.properties.nom;
      var d = data[code];
      var txt = '<b>' + nom + (state.view === 'france' ? ' (' + code + ')' : '') + '</b>';
      if (d) {
        txt += '<br>' + fmt(d.nombre) + ' faits constatés' +
               '<br>Taux : <b>' + d.taux.toFixed(2) + '</b> pour 1 000 hab.' +
               (d.estim ? ' <i>(estimé)</i>' : '') +
               (d.pop ? '<br>Population : ' + fmt(d.pop) : '');
      } else { txt += '<br><i>Pas de données</i>'; }
      layer.bindTooltip(txt, { sticky: true });
      if (state.view === 'france') {
        layer.on('click', function () { openDepartment(code, nom); });
      }
    }
  }).addTo(map);

  var list = values.slice().sort(function (a, b) { return b.taux - a.taux; });
  var top = document.getElementById('toplist');
  top.innerHTML = '';
  if (!list.length) { top.innerHTML = '<p class="muted">Aucune donnée pour ce filtre.</p>'; return; }
  list.slice(0, 10).forEach(function (d, i) {
    var row = document.createElement('div');
    row.className = 'top-row';
    var span = document.createElement('span');
    span.textContent = (i + 1) + '. ' + d.nom;
    var val = document.createElement('span');
    val.innerHTML = '<b>' + d.taux.toFixed(2) + '</b> ‰';
    row.appendChild(span); row.appendChild(val);
    top.appendChild(row);
  });
  setStatus(list.length + ' ' + unitLabel + ' affiché(e)s');
}

// ---------- Vue France (départements) ----------
function updateFrance(indicateur, annee) {
  var data = {};
  if (indicateur === TOTAL_LABEL) {
    totalRows.forEach(function (r) {
      if (r.annee === annee) {
        data[r.zone] = { taux: r.taux, nombre: r.nombre, pop: r.pop, estim: r.estim, nom: r.zone };
      }
    });
  } else {
    allRows.forEach(function (r) {
      if (r.indicateur === indicateur && r.annee === annee) {
        data[r.dep] = { taux: r.taux, nombre: r.nombre, pop: r.pop, nom: r.dep };
      }
    });
  }
  // Noms des départements depuis le GeoJSON
  window.__depGeo.features.forEach(function (f) {
    if (data[f.properties.code]) data[f.properties.code].nom = f.properties.nom;
  });
  document.getElementById('legendTitle').textContent =
    'Taux pour 1 000 hab. — ' + indicateur + ' (' + annee + ')';
  document.getElementById('topTitle').textContent = 'Top 10 départements';
  renderChoropleth(window.__depGeo, data, 'départements');
}

// ---------- Vue département (communes) ----------
function fetchTabular(depCode, annee) {
  var geo = state.communesGeo[depCode];
  var codes = geo.features.map(function (f) { return f.properties.code; });
  var first = TABULAR_URL + '?CODGEO_2026__in=' + encodeURIComponent(codes.join(',')) +
              '&annee__exact=' + annee + '&page_size=200'; // max autorisé par l'API
  var rows = [];
  function getPage(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (j) {
      (j.data || []).forEach(function (r) { rows.push(r); });
      if (j.links && j.links.next) return getPage(j.links.next.replace(/^https?:\/\/[^/]+/, ''));
      return rows;
    });
  }
  return getPage(first);
}

function loadCommunes(depCode, annee) {
  var cacheKey = depCode + '|' + annee;
  if (state.communesCache[cacheKey]) {
    return Promise.resolve(state.communesCache[cacheKey]);
  }
  setStatus('⏳ Chargement des communes…', 'loading');
  var geoPromise;
  if (state.communesGeo[depCode]) {
    geoPromise = Promise.resolve(state.communesGeo[depCode]);
  } else {
    var folder = DEP_FOLDERS[depCode];
    if (!folder) return Promise.reject(new Error('Contours communaux indisponibles pour ' + depCode));
    geoPromise = fetch('/geo/communes/departements/' + folder + '/communes-' + folder + '.geojson')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' (geojson communes)');
        return res.json();
      }).then(function (geo) { state.communesGeo[depCode] = geo; return geo; });
  }
  return geoPromise.then(function () { return fetchTabular(depCode, annee); }).then(function (raw) {
    var rows = raw.map(function (r) {
      var estim = r.est_diffuse !== 'diff' || r.nombre === null;
      return {
        zone: r.CODGEO_2026,
        annee: r.annee,
        indicateur: r.indicateur,
        nombre: r.nombre !== null ? r.nombre : Math.round(r.complement_info_nombre || 0),
        taux: r.taux_pour_mille !== null ? r.taux_pour_mille : (r.complement_info_taux || 0),
        pop: r.insee_pop || 0,
        estim: estim
      };
    });
    var totals = buildAggregates(rows);
    var entry = { rows: rows, totals: totals };
    state.communesCache[cacheKey] = entry;
    return entry;
  });
}

function updateCommunes(indicateur, annee) {
  var entry = state.communesCache[state.dep.code + '|' + annee];
  var data = {};
  if (indicateur === TOTAL_LABEL) {
    entry.totals.forEach(function (r) {
      if (r.annee === annee) {
        data[r.zone] = { taux: r.taux, nombre: r.nombre, pop: r.pop, estim: r.estim, nom: r.zone };
      }
    });
  } else {
    entry.rows.forEach(function (r) {
      if (r.indicateur === indicateur && r.annee === annee) {
        data[r.zone] = { taux: r.taux, nombre: r.nombre, pop: r.pop, estim: r.estim, nom: r.zone };
      }
    });
  }
  state.communesGeo[state.dep.code].features.forEach(function (f) {
    if (data[f.properties.code]) data[f.properties.code].nom = f.properties.nom;
  });
  document.getElementById('legendTitle').textContent =
    'Taux pour 1 000 hab. — ' + indicateur + ' (' + annee + ')';
  document.getElementById('topTitle').textContent = 'Top 10 communes';
  renderChoropleth(state.communesGeo[state.dep.code], data, 'communes');
}

function openDepartment(code, nom) {
  state.view = 'dep';
  state.dep = { code: code, nom: nom };
  document.getElementById('backBtn').hidden = false;
  document.getElementById('levelTitle').textContent = nom + ' (' + code + ') — par commune';
  var annee = parseInt(document.getElementById('yearSelect').value, 10);
  loadCommunes(code, annee).then(function () {
    updateCommunes(document.getElementById('indicatorSelect').value, annee);
    map.fitBounds(geoLayer.getBounds(), { padding: [30, 30] });
  }).catch(function (err) {
    console.error('[OpenFrance] Échec du chargement des communes :', err);
    showError('Impossible de charger les communes de ' + nom + '.', err.message);
  });
}

function backToFrance() {
  state.view = 'france';
  state.dep = null;
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'France — par département';
  refresh();
  map.setView([46.6, 2.5], 6);
}

function refresh() {
  var indicateur = document.getElementById('indicatorSelect').value;
  var annee = parseInt(document.getElementById('yearSelect').value, 10);
  if (state.view === 'france') {
    updateFrance(indicateur, annee);
  } else {
    loadCommunes(state.dep.code, annee).then(function () {
      updateCommunes(indicateur, annee);
    }).catch(function (err) {
      showError('Impossible de charger les communes.', err.message);
    });
  }
}

function initUI() {
  totalRows = buildAggregates(allRows.map(function (r) {
    return { zone: r.dep, annee: r.annee, nombre: r.nombre, pop: r.pop, estim: false };
  }));
  var indicateurs = [], annees = [], seenI = {}, seenA = {};
  allRows.forEach(function (r) {
    if (!seenI[r.indicateur]) { seenI[r.indicateur] = 1; indicateurs.push(r.indicateur); }
    if (!seenA[r.annee]) { seenA[r.annee] = 1; annees.push(r.annee); }
  });
  indicateurs.sort();
  annees.sort(function (a, b) { return b - a; });
  var iSel = document.getElementById('indicatorSelect');
  var ySel = document.getElementById('yearSelect');
  iSel.disabled = false; ySel.disabled = false;
  iSel.innerHTML = '<option>' + TOTAL_LABEL + '</option>' +
    indicateurs.map(function (i) { return '<option>' + i + '</option>'; }).join('');
  ySel.innerHTML = annees.map(function (a) { return '<option>' + a + '</option>'; }).join('');
  iSel.addEventListener('change', refresh);
  ySel.addEventListener('change', refresh);
  document.getElementById('backBtn').addEventListener('click', backToFrance);
  updateFrance(iSel.value, parseInt(ySel.value, 10));
}

setStatus('⏳ Chargement des données…', 'loading');
Promise.all([
  fetch(CSV_URL).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + CSV_URL);
    return res.text();
  }),
  fetch(GEO_URL).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + GEO_URL);
    return res.json();
  })
]).then(function (res) {
  window.__depGeo = res[1];
  allRows = parseCSV(res[0]);
  hideError();
  setStatus('Données chargées : ' + fmt(allRows.length) + ' lignes');
  initUI();
}).catch(function (err) {
  console.error('[OpenFrance] Échec du chargement :', err);
  showError('Impossible de charger les données. Détails dans la console (F12).', err.message);
});