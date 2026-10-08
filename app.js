// OpenFrance — carte choroplèthe de la délinquance par département
// Données : data.gouv.fr (Ministère de l'Intérieur), proxifiées via Netlify (même origine -> pas de CORS).

var CSV_URL = '/data/delinquance-dep.csv';
var GEO_URL = '/data/departements.json';

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

// Parser CSV robuste : gère les guillemets, les séparateurs ; ou , et le BOM.
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

  // Correspondance insensible à la casse
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
    if (!annee) continue; // ligne sans année valide -> ignorée
    rows.push({
      dep: (cols[idx.code_departement] || '').trim(),
      annee: annee,
      indicateur: (cols[idx.indicateur] || '').trim(),
      nombre: intg(cols[idx.nombre]),
      taux: num(cols[idx.taux_pour_mille]),
      pop: intg(cols[idx.insee_pop])
    });
  }
  if (!rows.length) throw new Error('aucune ligne exploitable (annee illisible ?)');
  return rows;
}

var map = L.map('map', { attributionControl: true }).setView([46.6, 2.5], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 10
}).addTo(map);

var geoLayer = null;
var allRows = [];
var currentData = {};

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