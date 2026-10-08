// OpenFrance — carte choroplèthe de la délinquance par département
// Données : data.gouv.fr (Ministère de l'Intérieur) — chargées directement dans le navigateur.

var CSV_URL = 'https://static.data.gouv.fr/resources/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/20260709-120038/donnee-dep-data.gouv-2025-geographie2026-produit-le2026-06-25.csv';
var GEO_URL = 'https://france-geojson.github.io/departements.geojson';

var statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

// Échelle de couleurs vert -> jaune -> rouge
function colorFor(t) { // t in [0,1]
  var stops = [[46,125,50],[124,179,66],[253,224,71],[244,121,32],[183,28,28]];
  var x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  var i = Math.min(stops.length - 2, Math.floor(x));
  var f = x - i;
  var c = stops[i].map(function (v, k) { return Math.round(v + f * (stops[i + 1][k] - v)); });
  return 'rgb(' + c.join(',') + ')';
}

function parseCSV(text) {
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  var sep = lines[0].indexOf(';') >= 0 ? ';' : ',';
  var header = lines[0].split(sep).map(function (h) { return h.trim().replace(/^"|"$/g, ''); });
  var idx = {};
  header.forEach(function (h, i) { idx[h] = i; });
  var rows = [];
  for (var r = 1; r < lines.length; r++) {
    var cols = lines[r].split(sep);
    if (cols.length < header.length) continue;
    rows.push({
      dep: (cols[idx.Code_departement] || '').trim().replace(/^"|"$/g, ''),
      annee: parseInt(cols[idx.annee], 10),
      indicateur: (cols[idx.indicateur] || '').trim().replace(/^"|"$/g, ''),
      nombre: parseInt(cols[idx.nombre], 10) || 0,
      taux: parseFloat((cols[idx.taux_pour_mille] || '0').replace(',', '.')) || 0,
      pop: parseInt(cols[idx.insee_pop], 10) || 0
    });
  }
  return rows;
}

var map = L.map('map', { attributionControl: true }).setView([46.6, 2.5], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 10
}).addTo(map);

var geoLayer = null;
var allRows = [];
var currentData = {}; // dep -> {taux, nombre, pop}

function fmt(n) { return n.toLocaleString('fr-FR'); }

function updateMap(indicateur, annee) {
  currentData = {};
  var min = Infinity, max = -Infinity;
  allRows.forEach(function (r) {
    if (r.indicateur === indicateur && r.annee === annee) {
      currentData[r.dep] = r;
      if (r.taux < min) min = r.taux;
      if (r.taux > max) max = r.taux;
    }
  });
  var span = max - min || 1;
  document.getElementById('legendTitle').textContent =
    'Taux pour 1 000 hab. — ' + indicateur + ' (' + annee + ')';

  // Légende : 6 classes
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
  geoLayer = L.geoJSON(window.__depGeo, {
    style: function (feature) {
      var code = feature.properties.code;
      var d = currentData[code];
      var t = d ? (d.taux - min) / span : 0;
      return { weight: 1, color: '#0f172a', fillColor: d ? colorFor(t) : '#334155', fillOpacity: d ? 0.85 : 0.4 };
    },
    onEachFeature: function (feature, layer) {
      var code = feature.properties.code;
      var nom = feature.properties.nom;
      var d = currentData[code];
      var txt = '<b>' + nom + ' (' + code + ')</b>';
      if (d) {
        txt += '<br>' + fmt(d.nombre) + ' faits constatés' +
               '<br>Taux : <b>' + d.taux.toFixed(2) + '</b> pour 1 000 hab.' +
               '<br>Population : ' + fmt(d.pop);
      } else { txt += '<br><i>Pas de données</i>'; }
      layer.bindTooltip(txt, { sticky: true });
      layer.on('click', function () { map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 8 }); });
    }
  }).addTo(map);

  // Top 10
  var list = [];
  for (var dep in currentData) list.push(currentData[dep]);
  list.sort(function (a, b) { return b.taux - a.taux; });
  var top = document.getElementById('toplist');
  top.innerHTML = '';
  if (!list.length) { top.innerHTML = '<p class="muted">Aucune donnée pour ce filtre.</p>'; return; }
  list.slice(0, 10).forEach(function (d, i) {
    var row = document.createElement('div');
    row.className = 'top-row';
    var span = document.createElement('span');
    span.textContent = (i + 1) + '. ' + d.dep;
    var val = document.createElement('span');
    val.innerHTML = '<b>' + d.taux.toFixed(2) + '</b> ‰';
    row.appendChild(span); row.appendChild(val);
    top.appendChild(row);
  });
  setStatus(list.length + ' départements affichés');
}

function initUI() {
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
  iSel.innerHTML = indicateurs.map(function (i) { return '<option>' + i + '</option>'; }).join('');
  ySel.innerHTML = annees.map(function (a) { return '<option>' + a + '</option>'; }).join('');
  function refresh() { updateMap(iSel.value, parseInt(ySel.value, 10)); }
  iSel.addEventListener('change', refresh);
  ySel.addEventListener('change', refresh);
  refresh();
}

Promise.all([
  fetch(CSV_URL).then(function (r) { return r.text(); }),
  fetch(GEO_URL).then(function (r) { return r.json(); })
]).then(function (res) {
  window.__depGeo = res[1];
  allRows = parseCSV(res[0]);
  if (!allRows.length) throw new Error('CSV vide ou format inattendu');
  setStatus('Données chargées : ' + fmt(allRows.length) + ' lignes');
  initUI();
}).catch(function (err) {
  setStatus('Erreur de chargement : ' + err.message);
  console.error(err);
});