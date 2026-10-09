// OpenFrance — cartographie multi-thèmes des données ouvertes françaises
// Sources (toutes via proxy Netlify, même origine) :
//  - Délinquance : Ministère de l'Intérieur (CSV départements + API tabulaire communale)
//  - Économie : Filosofi 2021 par commune (Geoptis) + statistiques DVF (prix au m²)
//  - Politique : Présidentielle 2022, Législatives 2024 (nuances par circo), Européennes 2024

var URLS = {
  delinquance: '/data/delinquance-dep.csv',
  departements: '/data/departements.json',
  tabular: '/api/communes/',
  revenus: '/data/revenus.csv',
  dvf: '/data/dvf-stats.csv',
  presT1: '/data/pres2022-t1.txt',
  presT2: '/data/pres2022-t2.txt',
  legT1: '/data/leg2024-t1.csv',
  legT2: '/data/leg2024-t2.csv',
  euroDep: '/data/euro2024-dep.csv'
};

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

var TOTAL_LABEL = 'Ensemble des faits constatés (tous indicateurs)';

// ---------- Utilitaires UI ----------
var statusEl = document.getElementById('status');
function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }
function showError(msg, detail) {
  console.error('[OpenFrance]', msg, detail || '');
  setStatus('❌ ' + msg, 'error');
  document.getElementById('errorBanner').style.display = 'block';
  document.getElementById('errorText').textContent = msg + (detail ? ' — ' + detail : '');
}
function hideError() { document.getElementById('errorBanner').style.display = 'none'; }
function fmt(n) { return (Math.round(n)).toLocaleString('fr-FR'); }
function fmt1(n) { return n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

function colorFor(t) {
  var stops = [[46,125,50],[124,179,66],[253,224,71],[244,121,32],[183,28,28]];
  var x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  var i = Math.min(stops.length - 2, Math.floor(x));
  var f = x - i;
  var c = stops[i].map(function (v, k) { return Math.round(v + f * (stops[i + 1][k] - v)); });
  return 'rgb(' + c.join(',') + ')';
}
function catColor(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ', 60%, 45%)';
}

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
function num(v) {
  v = (v || '').trim().replace(/^"|"$/g, '').replace(/\u00A0/g, '').replace(/ /g, '').replace(',', '.').replace('%', '');
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function normDep(code) { // normalise un code département ('1' -> '01', '2A'/'2B' ok)
  code = (code || '').trim().toUpperCase();
  if (/^\d$/.test(code)) return '0' + code;
  return code;
}

var map = L.map('map').setView([46.6, 2.5], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 12
}).addTo(map);
var geoLayer = null;

var state = {
  view: 'france', dep: null,
  category: 'delinquance',
  indicator: null,
  annee: null,
  communesCache: {}, communesGeo: {}, geo: null
};

var fetchCache = {}, inFlight = {};
function fetchTextCached(url) {
  if (fetchCache[url]) return Promise.resolve(fetchCache[url]);
  if (inFlight[url]) return inFlight[url];
  inFlight[url] = fetch(url).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + url);
    return res.text();
  }).then(function (t) { fetchCache[url] = t; return t; });
  return inFlight[url];
}
function fetchJSONCached(url) {
  return fetchTextCached(url).then(function (t) { return JSON.parse(t); });
}
function csvRows(text) { // -> { header (lowercase), rows: array de tableaux }
  text = text.replace(/^\uFEFF/, '');
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  var sep = lines[0].split(';').length >= lines[0].split(',').length ? ';' : ',';
  var header = splitCSVLine(lines[0], sep).map(function (h) { return h.trim().toLowerCase(); });
  var rows = [];
  for (var r = 1; r < lines.length; r++) {
    var cols = splitCSVLine(lines[r], sep);
    if (cols.length >= 2) rows.push(cols);
  }
  return { header: header, rows: rows, sep: sep };
}
function colIdx(header, re) {
  for (var i = 0; i < header.length; i++) if (re.test(header[i])) return i;
  return -1;
}

// ============================================================
// DÉLINQUANCE (inchangé)
// ============================================================
var DELINQ = { allRows: [], totalRows: [], loaded: false };

function parseDelinquanceCSV(text) {
  var p = csvRows(text);
  console.info('[OpenFrance] En-tête CSV délinquance :', p.header.join(' | '));
  var idx = {};
  ['code_departement', 'annee', 'indicateur', 'nombre', 'taux_pour_mille', 'insee_pop'].forEach(function (c) { idx[c] = p.header.indexOf(c); });
  var missing = Object.keys(idx).filter(function (c) { return idx[c] === -1; });
  if (missing.length) throw new Error('colonnes manquantes : ' + missing.join(', '));
  var rows = [];
  p.rows.forEach(function (cols) {
    var annee = Math.round(num(cols[idx.annee]) || 0);
    if (!annee) return;
    rows.push({
      dep: (cols[idx.code_departement] || '').trim(),
      annee: annee,
      indicateur: (cols[idx.indicateur] || '').trim(),
      nombre: Math.round(num(cols[idx.nombre]) || 0),
      taux: num(cols[idx.taux_pour_mille]) || 0,
      pop: Math.round(num(cols[idx.insee_pop]) || 0)
    });
  });
  if (!rows.length) throw new Error('CSV délinquance vide');
  return rows;
}

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

function loadDelinquance() {
  if (DELINQ.loaded) return Promise.resolve();
  return fetchTextCached(URLS.delinquance).then(function (t) {
    DELINQ.allRows = parseDelinquanceCSV(t);
    DELINQ.totalRows = buildAggregates(DELINQ.allRows.map(function (r) {
      return { zone: r.dep, annee: r.annee, nombre: r.nombre, pop: r.pop, estim: false };
    }));
    DELINQ.loaded = true;
  });
}

function delinquanceFrance(indicateur, annee) {
  var data = {};
  if (indicateur === TOTAL_LABEL) {
    DELINQ.totalRows.forEach(function (r) {
      if (r.annee === annee) data[r.zone] = { val: r.taux, lines: [fmt(r.nombre) + ' faits constatés', 'Population : ' + fmt(r.pop)] };
    });
  } else {
    DELINQ.allRows.forEach(function (r) {
      if (r.indicateur === indicateur && r.annee === annee) {
        data[r.dep] = { val: r.taux, lines: [fmt(r.nombre) + ' faits constatés', 'Population : ' + fmt(r.pop)] };
      }
    });
  }
  return data;
}

function fetchTabular(depCode, annee) {
  var geo = state.communesGeo[depCode];
  var codes = geo.features.map(function (f) { return f.properties.code; });
  var base = URLS.tabular + '?CODGEO_2026__in=' + encodeURIComponent(codes.join(',')) +
             '&annee__exact=' + annee + '&page_size=200';
  var rows = [], page = 1;
  function getPage() {
    return fetch(base + '&page=' + page).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' (page ' + page + ')');
      return res.json();
    }).then(function (j) {
      (j.data || []).forEach(function (r) { rows.push(r); });
      var total = (j.meta && j.meta.total) ? j.meta.total : rows.length;
      if ((j.data || []).length > 0 && rows.length < total) { page++; return getPage(); }
      return rows;
    });
  }
  return getPage();
}

function loadCommunesDelinquance(depCode, annee) {
  var cacheKey = depCode + '|' + annee;
  if (state.communesCache[cacheKey]) return Promise.resolve(state.communesCache[cacheKey]);
  setStatus('⏳ Chargement des communes…', 'loading');
  var geoPromise = state.communesGeo[depCode] ? Promise.resolve(state.communesGeo[depCode]) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[depCode] + '/communes-' + DEP_FOLDERS[depCode] + '.geojson')
      .then(function (geo) { state.communesGeo[depCode] = geo; return geo; });
  return geoPromise.then(function () { return fetchTabular(depCode, annee); }).then(function (raw) {
    var rows = raw.map(function (r) {
      return {
        zone: r.CODGEO_2026, annee: r.annee, indicateur: r.indicateur,
        nombre: r.nombre !== null ? r.nombre : Math.round(r.complement_info_nombre || 0),
        taux: r.taux_pour_mille !== null ? r.taux_pour_mille : (r.complement_info_taux || 0),
        pop: r.insee_pop || 0, estim: r.est_diffuse !== 'diff' || r.nombre === null
      };
    });
    var entry = { rows: rows, totals: buildAggregates(rows) };
    state.communesCache[cacheKey] = entry;
    return entry;
  });
}

function delinquanceCommunes(depCode, indicateur, annee) {
  var entry = state.communesCache[depCode + '|' + annee];
  var data = {};
  function mk(r) {
    return { val: r.taux, lines: [fmt(r.nombre) + ' faits constatés', (r.estim ? '<i>(estimé)</i>' : ''), 'Population : ' + fmt(r.pop)].filter(Boolean) };
  }
  if (indicateur === TOTAL_LABEL) entry.totals.forEach(function (r) { if (r.annee === annee) data[r.zone] = mk(r); });
  else entry.rows.forEach(function (r) { if (r.indicateur === indicateur && r.annee === annee) data[r.zone] = mk(r); });
  return data;
}

// ============================================================
// ÉCONOMIE (inchangé)
// ============================================================
var REV = { com: {}, dept: {}, loaded: false };

function loadRevenus() {
  if (REV.loaded) return Promise.resolve();
  return fetchTextCached(URLS.revenus).then(function (text) {
    var p = csvRows(text);
    console.info('[OpenFrance] En-tête CSV revenus :', p.header.join(' | '));
    var cCode = colIdx(p.header, /code.*géo/);
    var cDispMed = colIdx(p.header, /^\[disp\].*médiane/);
    var cDecMed = colIdx(p.header, /^\[dec\].*médiane/);
    var cMen = colIdx(p.header, /^\[dec\].*ménages fiscaux/) !== -1 ? colIdx(p.header, /^\[dec\].*ménages fiscaux/) : colIdx(p.header, /ménages fiscaux/);
    if (cCode === -1 || (cDispMed === -1 && cDecMed === -1)) throw new Error('colonnes revenus non trouvées');
    var depAgg = {};
    p.rows.forEach(function (cols) {
      var code = (cols[cCode] || '').trim();
      if (!/^(\d|2A|2B)/.test(code)) return;
      var val = (cDispMed !== -1 && cols[cDispMed] && cols[cDispMed].trim() !== '') ? num(cols[cDispMed]) : num(cols[cDecMed]);
      if (val === null) return;
      var w = (cMen !== -1 && cols[cMen]) ? (num(cols[cMen]) || 0) : 0;
      REV.com[code] = { val: val, w: w };
      var dep = code.slice(0, 2);
      if (/^97/.test(code)) dep = code.slice(0, 3);
      if (!depAgg[dep]) depAgg[dep] = { sum: 0, w: 0 };
      if (w > 0) { depAgg[dep].sum += val * w; depAgg[dep].w += w; }
    });
    for (var d in depAgg) if (depAgg[d].w > 0) REV.dept[d] = { val: depAgg[d].sum / depAgg[d].w, w: depAgg[d].w };
    REV.loaded = true;
    console.info('[OpenFrance] Revenus chargés : ' + Object.keys(REV.com).length + ' communes');
  });
}

function revenusFrance() {
  var data = {};
  for (var d in REV.dept) data[d] = { val: REV.dept[d].val, lines: [fmt(REV.dept[d].w) + ' ménages fiscaux', '<i>moyenne pondérée des communes</i>'] };
  return data;
}
function revenusCommunes(depCode) {
  var data = {};
  for (var c in REV.com) {
    var dep = c.slice(0, 2); if (/^97/.test(c)) dep = c.slice(0, 3);
    if (dep === depCode) data[c] = { val: REV.com[c].val, lines: [fmt(REV.com[c].w) + ' ménages fiscaux'] };
  }
  return data;
}

var DVF = { dept: {}, com: {}, loaded: false };

function loadDVF() {
  if (DVF.loaded) return Promise.resolve();
  setStatus('⏳ Chargement des statistiques DVF (~29 Mo)…', 'loading');
  return fetchTextCached(URLS.dvf).then(function (text) {
    var lines = text.split(/\r?\n/);
    var header = lines[0].split(',');
    console.info('[OpenFrance] En-tête CSV DVF :', header.join(' | '));
    var iCode = header.indexOf('code_geo');
    var iEch = header.indexOf('echelle_geo');
    var iApt = header.indexOf('moy_prix_m2_whole_appartement');
    var iAptN = header.indexOf('nb_ventes_whole_appartement');
    var iMai = header.indexOf('moy_prix_m2_whole_maison');
    var iMaiN = header.indexOf('nb_ventes_whole_maison');
    if (iCode === -1 || iEch === -1) throw new Error('colonnes DVF non trouvées');
    for (var r = 1; r < lines.length; r++) {
      if (!lines[r]) continue;
      var cols = lines[r].split(',');
      if (cols.length < header.length) continue;
      var ech = cols[iEch], code = cols[iCode];
      if (ech === 'departement') DVF.dept[code] = { apt: num(cols[iApt]), aptN: Math.round(num(cols[iAptN]) || 0), mai: num(cols[iMai]), maiN: Math.round(num(cols[iMaiN]) || 0) };
      else if (ech === 'commune') DVF.com[code] = { apt: num(cols[iApt]), aptN: Math.round(num(cols[iAptN]) || 0), mai: num(cols[iMai]), maiN: Math.round(num(cols[iMaiN]) || 0) };
    }
    DVF.loaded = true;
    console.info('[OpenFrance] DVF chargé : ' + Object.keys(DVF.dept).length + ' départements, ' + Object.keys(DVF.com).length + ' communes');
  });
}

function dvfData(which, kind) {
  var src = kind === 'dept' ? DVF.dept : DVF.com;
  var data = {};
  for (var code in src) {
    var v = src[code][which === 'apt' ? 'apt' : 'mai'];
    var n = src[code][which === 'apt' ? 'aptN' : 'maiN'];
    if (v === null || v === 0) continue;
    data[code] = { val: v, lines: [fmt(n) + ' ventes (2015-2025)'] };
  }
  return data;
}

// ============================================================
// POLITIQUE — Présidentielle 2022 (départements)
// ============================================================
var PRES = { t1: null, t2: null };

function parseElections(text, label) {
  var p = csvRows(text);
  console.info('[OpenFrance] En-tête ' + label + ' :', p.header.join(' | '));
  var iDep = colIdx(p.header, /code.*d[eé]part/); if (iDep === -1) iDep = 0;
  var iIns = colIdx(p.header, /inscrit/);
  var iAbs = colIdx(p.header, /abstention/);
  var iExpr = colIdx(p.header, /exprim/);
  var iNom = colIdx(p.header, /^nom$/);
  var iVoix = colIdx(p.header, /^voix$/);
  var iNua = colIdx(p.header, /nuance/);
  if (iIns === -1 || iAbs === -1 || iVoix === -1 || iNom === -1) throw new Error('colonnes élections non trouvées');
  var depts = {};
  p.rows.forEach(function (cols) {
    var code = normDep(cols[iDep]);
    if (!/^(\d{2}|\d{3}|2A|2B)$/.test(code)) return;
    var ins = num(cols[iIns]), abs = num(cols[iAbs]), expr = num(cols[iExpr] !== undefined ? cols[iExpr] : null);
    var voix = num(cols[iVoix]);
    var nom = (cols[iNom] || '').trim();
    var nuance = iNua !== -1 ? (cols[iNua] || '').trim() : '';
    if (!depts[code]) depts[code] = { inscrits: ins, abstentions: abs, exprimes: expr || 0, candidats: [] };
    var pctExp = (expr && expr > 0) ? (voix / expr) * 100 : 0;
    depts[code].candidats.push({ nom: nom, nuance: nuance, voix: voix || 0, pct: pctExp });
  });
  for (var d in depts) {
    var cand = depts[d].candidats.slice().sort(function (a, b) { return b.voix - a.voix; });
    depts[d].winner = cand[0] ? cand[0].nom : null;
    depts[d].winnerPct = cand[0] ? cand[0].pct : 0;
    depts[d].winnerNua = cand[0] ? cand[0].nuance : '';
    depts[d].abstPct = depts[d].inscrits > 0 ? (depts[d].abstentions / depts[d].inscrits) * 100 : 0;
  }
  if (!Object.keys(depts).length) throw new Error('aucun département parsé dans ' + label);
  return depts;
}

function loadElections() {
  if (PRES.t1) return Promise.resolve();
  return Promise.all([
    fetchTextCached(URLS.presT1).then(function (t) { PRES.t1 = parseElections(t, 'présidentielle T1'); }),
    fetchTextCached(URLS.presT2).then(function (t) { PRES.t2 = parseElections(t, 'présidentielle T2'); })
  ]);
}

function electionsWinnerData(tour) {
  var src = tour === 1 ? PRES.t1 : PRES.t2;
  var data = {};
  for (var d in src) {
    var e = src[d];
    data[d] = {
      key: e.winner, val: e.winnerPct,
      lines: [fmt(e.winnerPct) + ' % des exprimés', (e.winnerNua ? 'Nuance : ' + e.winnerNua : ''), fmt(e.inscrits) + ' inscrits'].filter(Boolean)
    };
  }
  return data;
}
function electionsAbstData(tour) {
  var src = tour === 1 ? PRES.t1 : PRES.t2;
  var data = {};
  for (var d in src) {
    var e = src[d];
    data[d] = { val: e.abstPct, lines: [fmt(e.inscrits) + ' inscrits', fmt(e.abstentions) + ' abstentions'] };
  }
  return data;
}
function electionsCandidateData(tour, nomCand) {
  var src = tour === 1 ? PRES.t1 : PRES.t2;
  var data = {};
  for (var d in src) {
    var e = src[d];
    var c = null;
    for (var i = 0; i < e.candidats.length; i++) if (e.candidats[i].nom === nomCand) c = e.candidats[i];
    if (!c) continue;
    data[d] = { val: c.pct, lines: [fmt(c.voix) + ' voix', (c.nuance ? 'Nuance : ' + c.nuance : ''), fmt(e.inscrits) + ' inscrits'].filter(Boolean) };
  }
  return data;
}
function electionsCandidates(tour) {
  var src = tour === 1 ? PRES.t1 : PRES.t2;
  var seen = {};
  for (var d in src) src[d].candidats.forEach(function (c) { seen[c.nom] = (seen[c.nom] || 0) + c.voix; });
  return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; });
}

// ============================================================
// POLITIQUE — Législatives 2024 (circonscriptions, nuances)
// ============================================================
var LEG = {
  loaded: false,
  circos: {},           // codCir -> { dep, inscrits, abstentions, exprimes }
  seatsByDep: {},       // dep -> { nuanceCode: sièges }
  seatsByNua: {},       // code -> sièges nationaux
  nuaLabels: {},        // code -> libellé
  votesByDepNua: {},    // dep -> { nuance: voix T1 }
  exprByDep: {},        // dep -> exprimés T1
  abstPctByDep: {}      // dep -> % abstention pondéré
};

function loadLegislatives() {
  if (LEG.loaded) return Promise.resolve();
  return Promise.all([fetchTextCached(URLS.legT1), fetchTextCached(URLS.legT2)]).then(function (res) {
    // --- T1 : une ligne par candidat (format long) ---
    var p1 = csvRows(res[0]);
    console.info('[OpenFrance] En-tête législatives T1 :', p1.header.join(' | '));
    var h = p1.header;
    var iDep = colIdx(h, /^departement$/);
    var iCir = colIdx(h, /^codcirelec$/);
    var iIns = colIdx(h, /^inscrits$/);
    var iAbs = colIdx(h, /^abstentions$/);
    var iExp = colIdx(h, /^exprimes$/);
    var iNuaC = colIdx(h, /^codnuacand$/);
    var iNuaL = colIdx(h, /^libnuacand$/);
    var iVoix = colIdx(h, /^nbvoix$/);
    var iElu = colIdx(h, /^elu$/);
    if (iDep === -1 || iCir === -1 || iVoix === -1) throw new Error('colonnes législatives T1 non trouvées');
    p1.rows.forEach(function (cols) {
      var dep = normDep(cols[iDep]);
      var cir = (cols[iCir] || '').trim();
      if (!/^(\d{2}|\d{3}|2A|2B)$/.test(dep)) return;
      var code = dep + '|' + cir;
      if (!LEG.circos[code]) {
        LEG.circos[code] = {
          dep: dep,
          inscrits: num(cols[iIns]) || 0,
          abstentions: num(cols[iAbs]) || 0,
          exprimes: num(cols[iExp]) || 0
        };
      }
      var nuaC = (cols[iNuaC] || '').trim();
      if (nuaC && iNuaL !== -1) LEG.nuaLabels[nuaC] = (cols[iNuaL] || '').trim();
      var voix = num(cols[iVoix]) || 0;
      if (!LEG.votesByDepNua[dep]) LEG.votesByDepNua[dep] = {};
      LEG.votesByDepNua[dep][nuaC] = (LEG.votesByDepNua[dep][nuaC] || 0) + voix;
      // Élu dès le 1er tour
      var elu = (cols[iElu] || '').trim().toLowerCase();
      if (elu && elu !== 'non' && elu !== 'qualif t2') addSeat(dep, nuaC);
    });
    // Agrégats départements T1
    for (var code in LEG.circos) {
      var c = LEG.circos[code];
      LEG.exprByDep[c.dep] = (LEG.exprByDep[c.dep] || 0) + c.exprimes;
    }
    // --- T2 : une ligne par circo, candidats en colonnes (format large) ---
    var p2 = csvRows(res[1]);
    console.info('[OpenFrance] En-tête législatives T2 :', p2.header.slice(0, 30).join(' | ') + '…');
    var h2 = p2.header;
    var iDep2 = colIdx(h2, /code.*d[eé]part/);
    var iCir2 = colIdx(h2, /code.*circonscription/);
    var iEluPrefix = [];
    for (var n = 1; n <= 6; n++) {
      var iNua = colIdx(h2, new RegExp('^nuance candidat ' + n + '$'));
      var iEl = colIdx(h2, new RegExp('^elu ' + n + '$'));
      if (iNua !== -1 && iEl !== -1) iEluPrefix.push({ nua: iNua, elu: iEl });
    }
    if (iDep2 === -1 || !iEluPrefix.length) throw new Error('colonnes législatives T2 non trouvées');
    var seenCir = {};
    p2.rows.forEach(function (cols) {
      var dep = normDep(cols[iDep2]);
      var cir = (cols[iCir2] || '').trim();
      var key = dep + '|' + cir;
      if (seenCir[key]) return; seenCir[key] = 1;
      iEluPrefix.forEach(function (m) {
        var elu = (cols[m.elu] || '').trim().toLowerCase();
        if (elu.indexOf('élu') !== -1 && elu.indexOf('éliminé') === -1) {
          addSeat(dep, (cols[m.nua] || '').trim());
        }
      });
    });
    function nuanceLabel(code) { return LEG.nuaLabels[code] || code; }
    LEG.nuaLabel = nuanceLabel;
    LEG.loaded = true;
    console.info('[OpenFrance] Législatives : ' + countSeats() + ' sièges, ' + Object.keys(LEG.nuaLabels).length + ' nuances');
  });

  function addSeat(dep, nuaC) {
    if (!nuaC) return;
    if (!LEG.seatsByDep[dep]) LEG.seatsByDep[dep] = {};
    LEG.seatsByDep[dep][nuaC] = (LEG.seatsByDep[dep][nuaC] || 0) + 1;
    LEG.seatsByNua[nuaC] = (LEG.seatsByNua[nuaC] || 0) + 1;
  }
  function countSeats() {
    var t = 0; for (var k in LEG.seatsByNua) t += LEG.seatsByNua[k];
    return t;
  }
}

function legSeatsWinnerData() {
  var data = {};
  for (var dep in LEG.seatsByDep) {
    var best = null, total = 0, parts = [];
    for (var nua in LEG.seatsByDep[dep]) {
      var s = LEG.seatsByDep[dep][nua];
      total += s;
      parts.push({ nua: nua, s: s });
      if (!best || s > best.s) best = { nua: nua, s: s };
    }
    parts.sort(function (a, b) { return b.s - a.s; });
    var breakdown = parts.slice(0, 4).map(function (p) { return LEG.nuaLabel(p.nua) + ' : ' + p.s; }).join(' · ');
    data[dep] = { key: LEG.nuaLabel(best.nua), val: best.s, catUnit: ' sièges', lines: [total + ' sièges au total', breakdown] };
  }
  return data;
}

function legSeatsNuaData(nuaCode) {
  var label = LEG.nuaLabel(nuaCode);
  var data = {};
  for (var dep in LEG.seatsByDep) {
    var s = LEG.seatsByDep[dep][nuaCode] || 0;
    data[dep] = { val: s, lines: [label] };
  }
  return data;
}

function legAbstData() {
  var data = {};
  for (var code in LEG.circos) {
    var c = LEG.circos[code];
    var d = c.dep;
    if (!data[d]) data[d] = { ins: 0, abs: 0 };
    data[d].ins += c.inscrits;
    data[d].abs += c.abstentions;
  }
  var out = {};
  for (var dep in data) {
    out[dep] = {
      val: data[dep].ins > 0 ? (data[dep].abs / data[dep].ins) * 100 : 0,
      lines: [fmt(data[dep].ins) + ' inscrits', fmt(data[dep].abs) + ' abstentions', '<i>T1, pondéré par circonscription</i>']
    };
  }
  return out;
}

function legVotesNuaData(nuaCode) {
  var label = LEG.nuaLabel(nuaCode);
  var data = {};
  for (var dep in LEG.votesByDepNua) {
    var voix = LEG.votesByDepNua[dep][nuaCode] || 0;
    var expr = LEG.exprByDep[dep] || 0;
    if (expr <= 0) continue;
    data[dep] = { val: (voix / expr) * 100, lines: [fmt(voix) + ' voix (T1)', label] };
  }
  return data;
}

function topNuances(max) {
  var arr = Object.keys(LEG.seatsByNua).sort(function (a, b) { return LEG.seatsByNua[b] - LEG.seatsByNua[a]; });
  return arr.slice(0, max || 8);
}

// ============================================================
// POLITIQUE — Européennes 2024 (départements, toutes les listes)
// ============================================================
var EURO = { loaded: false, byDep: {}, lists: {} }; // lists: label -> voix nationales

function loadEuropeennes() {
  if (EURO.loaded) return Promise.resolve();
  return fetchTextCached(URLS.euroDep).then(function (text) {
    var p = csvRows(text);
    console.info('[OpenFrance] En-tête européennes (extrait) :', p.header.slice(0, 25).join(' | ') + '…');
    var h = p.header;
    var iDep = colIdx(h, /code.*d[eé]part/);
    var iIns = colIdx(h, /inscrit/);
    var iAbs = colIdx(h, /abstention/);
    if (iDep === -1) throw new Error('colonne département européennes non trouvée');
    var lists = [];
    for (var n = 1; n <= 38; n++) {
      var iNua = colIdx(h, new RegExp('^nuance liste ' + n + '$'));
      var iLab = colIdx(h, new RegExp('^libellé abrégé de liste ' + n + '$'));
      var iVoix = colIdx(h, new RegExp('^voix ' + n + '$'));
      var iPct = colIdx(h, new RegExp('% voix/exprimés ' + n + '$'));
      if (iVoix !== -1) lists.push({ n: n, nua: iNua, lab: iLab, voix: iVoix, pct: iPct });
    }
    if (!lists.length) throw new Error('colonnes listes européennes non trouvées');
    p.rows.forEach(function (cols) {
      var dep = normDep(cols[iDep]);
      if (!/^(\d{2}|\d{3}|2A|2B)$/.test(dep)) return;
      var ins = num(cols[iIns]) || 0, abs = num(cols[iAbs]) || 0;
      var entry = { inscrits: ins, abstentions: abs, lists: [] };
      lists.forEach(function (L) {
        var voix = num(cols[L.voix]);
        if (voix === null || voix === 0) return;
        var label = L.lab !== -1 ? (cols[L.lab] || '').trim() : ('Liste ' + L.n);
        var nua = L.nua !== -1 ? (cols[L.nua] || '').trim() : '';
        var pct = L.pct !== -1 ? num(cols[L.pct]) : null;
        entry.lists.push({ label: label, nua: nua, voix: voix, pct: pct });
        EURO.lists[label] = (EURO.lists[label] || 0) + voix;
      });
      entry.lists.sort(function (a, b) { return b.voix - a.voix; });
      EURO.byDep[dep] = entry;
    });
    EURO.loaded = true;
    console.info('[OpenFrance] Européennes : ' + Object.keys(EURO.byDep).length + ' départements, ' + Object.keys(EURO.lists).length + ' listes');
  });
}

function euroWinnerData() {
  var data = {};
  for (var dep in EURO.byDep) {
    var e = EURO.byDep[dep];
    if (!e.lists.length) continue;
    var top = e.lists[0];
    data[dep] = {
      key: top.label, val: top.pct !== null ? top.pct : 0, catUnit: ' % des exprimés',
      lines: [fmt(top.voix) + ' voix', (top.nua ? 'Nuance : ' + top.nua : ''), fmt(e.inscrits) + ' inscrits'].filter(Boolean)
    };
  }
  return data;
}

function euroListData(label) {
  var data = {};
  for (var dep in EURO.byDep) {
    var e = EURO.byDep[dep];
    var found = null;
    e.lists.forEach(function (l) { if (l.label === label) found = l; });
    if (!found) continue;
    data[dep] = { val: found.pct !== null ? found.pct : 0, lines: [fmt(found.voix) + ' voix', (found.nua ? 'Nuance : ' + found.nua : '')].filter(Boolean) };
  }
  return data;
}

function euroAbstData() {
  var data = {};
  for (var dep in EURO.byDep) {
    var e = EURO.byDep[dep];
    data[dep] = {
      val: e.inscrits > 0 ? (e.abstentions / e.inscrits) * 100 : 0,
      lines: [fmt(e.inscrits) + ' inscrits', fmt(e.abstentions) + ' abstentions']
    };
  }
  return data;
}

function topEuroLists(max) {
  var arr = Object.keys(EURO.lists).sort(function (a, b) { return EURO.lists[b] - EURO.lists[a]; });
  return arr.slice(0, max || 8);
}

// ============================================================
// REGISTRE DES INDICATEURS
// ============================================================
var REGISTRY = [];

function registerDelinquanceIndicators() {
  REGISTRY.push({
    cat: 'delinquance', label: TOTAL_LABEL, unit: '‰', type: 'num',
    hasYears: true, hasCommunes: true,
    ensure: loadDelinquance,
    france: function () { return delinquanceFrance(TOTAL_LABEL, state.annee); },
    communes: function (dep) { return delinquanceCommunes(dep, TOTAL_LABEL, state.annee); }
  });
  var indicateurs = [], seen = {};
  DELINQ.allRows.forEach(function (r) { if (!seen[r.indicateur]) { seen[r.indicateur] = 1; indicateurs.push(r.indicateur); } });
  indicateurs.sort().forEach(function (ind) {
    REGISTRY.push({
      cat: 'delinquance', label: ind, unit: '‰', type: 'num',
      hasYears: true, hasCommunes: true,
      ensure: loadDelinquance,
      france: function () { return delinquanceFrance(ind, state.annee); },
      communes: function (dep) { return delinquanceCommunes(dep, ind, state.annee); }
    });
  });
}

function registerEconomieIndicators() {
  REGISTRY.push({
    cat: 'economie', label: 'Niveau de vie médian (Filosofi, 2021)', unit: '€/an', type: 'num',
    hasYears: false, hasCommunes: true,
    ensure: loadRevenus, france: revenusFrance, communes: revenusCommunes
  });
  ['apt', 'mai'].forEach(function (which) {
    var lab = which === 'apt' ? 'appartements' : 'maisons';
    REGISTRY.push({
      cat: 'economie', label: 'Prix moyen au m² — ' + lab + ' (DVF, 2015-2025)', unit: '€/m²', type: 'num',
      hasYears: false, hasCommunes: true,
      ensure: loadDVF,
      france: function () { return dvfData(which, 'dept'); },
      communes: function (dep) {
        var all = dvfData(which, 'com'), out = {};
        for (var c in all) {
          var d = c.slice(0, 2); if (/^97/.test(c)) d = c.slice(0, 3);
          if (d === dep) out[c] = all[c];
        }
        return out;
      }
    });
  });
}

function registerPolitiqueIndicators() {
  // --- Présidentielle 2022 ---
  REGISTRY.push({
    cat: 'politique', label: 'Présidentielle 2022 — candidat en tête (T1)', unit: '%', type: 'cat',
    hasYears: false, hasCommunes: false,
    ensure: loadElections, france: function () { return electionsWinnerData(1); }, communes: null
  });
  REGISTRY.push({
    cat: 'politique', label: 'Présidentielle 2022 — abstention (T1)', unit: '%', type: 'num',
    hasYears: false, hasCommunes: false,
    ensure: loadElections, france: function () { return electionsAbstData(1); }, communes: null
  });
  electionsCandidates(1).forEach(function (nom) {
    REGISTRY.push({
      cat: 'politique', label: 'Présidentielle 2022 — voix ' + nom + ' (T1, %)', unit: '%', type: 'num',
      hasYears: false, hasCommunes: false,
      ensure: loadElections, france: function () { return electionsCandidateData(1, nom); }, communes: null
    });
  });
  REGISTRY.push({
    cat: 'politique', label: 'Présidentielle 2022 — candidat en tête (T2)', unit: '%', type: 'cat',
    hasYears: false, hasCommunes: false,
    ensure: loadElections, france: function () { return electionsWinnerData(2); }, communes: null
  });
  REGISTRY.push({
    cat: 'politique', label: 'Présidentielle 2022 — abstention (T2)', unit: '%', type: 'num',
    hasYears: false, hasCommunes: false,
    ensure: loadElections, france: function () { return electionsAbstData(2); }, communes: null
  });
  electionsCandidates(2).forEach(function (nom) {
    REGISTRY.push({
      cat: 'politique', label: 'Présidentielle 2022 — voix ' + nom + ' (T2, %)', unit: '%', type: 'num',
      hasYears: false, hasCommunes: false,
      ensure: loadElections, france: function () { return electionsCandidateData(2, nom); }, communes: null
    });
  });

  // --- Législatives 2024 ---
  REGISTRY.push({
    cat: 'politique', label: 'Législatives 2024 — nuance majoritaire (sièges)', unit: 'sièges', type: 'cat',
    hasYears: false, hasCommunes: false,
    ensure: loadLegislatives, france: legSeatsWinnerData, communes: null
  });
  topNuances(8).forEach(function (nua) {
    REGISTRY.push({
      cat: 'politique', label: 'Législatives 2024 — sièges ' + LEG.nuaLabel(nua), unit: 'sièges', type: 'num',
      hasYears: false, hasCommunes: false,
      ensure: loadLegislatives, france: function () { return legSeatsNuaData(nua); }, communes: null
    });
  });
  REGISTRY.push({
    cat: 'politique', label: 'Législatives 2024 — abstention (T1)', unit: '%', type: 'num',
    hasYears: false, hasCommunes: false,
    ensure: loadLegislatives, france: legAbstData, communes: null
  });
  topNuances(6).forEach(function (nua) {
    REGISTRY.push({
      cat: 'politique', label: 'Législatives 2024 — voix ' + LEG.nuaLabel(nua) + ' (T1, %)', unit: '%', type: 'num',
      hasYears: false, hasCommunes: false,
      ensure: loadLegislatives, france: function () { return legVotesNuaData(nua); }, communes: null
    });
  });

  // --- Européennes 2024 ---
  REGISTRY.push({
    cat: 'politique', label: 'Européennes 2024 — liste en tête', unit: '%', type: 'cat',
    hasYears: false, hasCommunes: false,
    ensure: loadEuropeennes, france: euroWinnerData, communes: null
  });
  REGISTRY.push({
    cat: 'politique', label: 'Européennes 2024 — abstention', unit: '%', type: 'num',
    hasYears: false, hasCommunes: false,
    ensure: loadEuropeennes, france: euroAbstData, communes: null
  });
  topEuroLists(6).forEach(function (label) {
    REGISTRY.push({
      cat: 'politique', label: 'Européennes 2024 — voix ' + label + ' (%)', unit: '%', type: 'num',
      hasYears: false, hasCommunes: false,
      ensure: loadEuropeennes, france: function () { return euroListData(label); }, communes: null
    });
  });
}

// ============================================================
// RENDU
// ============================================================
function renderChoropleth(geo, data, indicator, unitLabel) {
  var values = [];
  for (var k in data) if (data[k].val !== undefined) values.push(data[k]);
  var legend = document.getElementById('legend');
  legend.innerHTML = '';

  if (indicator.type === 'cat') {
    var counts = {};
    values.forEach(function (d) { if (d.key) counts[d.key] = (counts[d.key] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    keys.forEach(function (key) {
      var row = document.createElement('div');
      row.className = 'legend-row';
      var sw = document.createElement('span');
      sw.className = 'legend-color';
      sw.style.background = catColor(key);
      var lb = document.createElement('span');
      lb.textContent = key + ' (' + counts[key] + ')';
      row.appendChild(sw); row.appendChild(lb);
      legend.appendChild(row);
    });
  } else {
    var min = Infinity, max = -Infinity;
    values.forEach(function (d) {
      if (d.val !== null && d.val < min) min = d.val;
      if (d.val !== null && d.val > max) max = d.val;
    });
    if (!values.length) { min = 0; max = 1; }
    var span = max - min || 1;
    for (var c = 0; c < 6; c++) {
      var lo = min + span * c / 6, hi = min + span * (c + 1) / 6;
      var row = document.createElement('div');
      row.className = 'legend-row';
      var swatch = document.createElement('span');
      swatch.className = 'legend-color';
      swatch.style.background = colorFor((c + 0.5) / 6);
      var label = document.createElement('span');
      label.textContent = (indicator.unit === '€/an' || indicator.unit === '€/m²' ? fmt(lo) + ' – ' + fmt(hi) : lo.toFixed(2) + ' – ' + hi.toFixed(2));
      row.appendChild(swatch); row.appendChild(label);
      legend.appendChild(row);
    }
  }

  if (geoLayer) map.removeLayer(geoLayer);
  var minV = Infinity, maxV = -Infinity, spanV = 1;
  if (indicator.type === 'num') {
    values.forEach(function (d) { if (d.val !== null && d.val < minV) minV = d.val; if (d.val !== null && d.val > maxV) maxV = d.val; });
    if (!values.length) { minV = 0; maxV = 1; }
    spanV = maxV - minV || 1;
  }

  geoLayer = L.geoJSON(geo, {
    style: function (feature) {
      var d = data[feature.properties.code];
      if (!d) return { weight: 1, color: '#0f172a', fillColor: '#334155', fillOpacity: 0.4 };
      var fill;
      if (indicator.type === 'cat') fill = d.key ? catColor(d.key) : '#334155';
      else fill = colorFor((d.val - minV) / spanV);
      return { weight: 1, color: '#0f172a', fillColor: fill, fillOpacity: 0.85 };
    },
    onEachFeature: function (feature, layer) {
      var code = feature.properties.code;
      var nom = feature.properties.nom;
      var d = data[code];
      var txt = '<b>' + nom + (state.view === 'france' ? ' (' + code + ')' : '') + '</b>';
      if (d) {
        if (indicator.type === 'cat') {
          txt += '<br>En tête : <b style="color:' + catColor(d.key) + '">' + d.key + '</b>' +
                 '<br><b>' + fmt(d.val) + (d.catUnit || ' %') + '</b>';
        } else {
          txt += '<br><b>' + fmt(d.val) + '</b> ' + indicator.unit;
        }
        (d.lines || []).forEach(function (l) { txt += '<br>' + l; });
      } else { txt += '<br><i>Pas de données</i>'; }
      layer.bindTooltip(txt, { sticky: true });
      if (state.view === 'france' && indicator.hasCommunes) {
        layer.on('click', function () { openDepartment(code, nom); });
      }
    }
  }).addTo(map);

  var top = document.getElementById('toplist');
  top.innerHTML = '';
  document.getElementById('topTitle').textContent = state.view === 'france' ? 'Top 10 départements' : 'Top 10 communes';
  if (indicator.type === 'cat') {
    var counts2 = {};
    values.forEach(function (d) { if (d.key) counts2[d.key] = (counts2[d.key] || 0) + 1; });
    Object.keys(counts2).sort(function (a, b) { return counts2[b] - counts2[a]; }).slice(0, 10).forEach(function (key) {
      var row = document.createElement('div');
      row.className = 'top-row';
      var sp = document.createElement('span');
      sp.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + catColor(key) + '"></span> ' + key;
      var v = document.createElement('span');
      v.innerHTML = '<b>' + counts2[key] + '</b>';
      row.appendChild(sp); row.appendChild(v);
      top.appendChild(row);
    });
  } else {
    var list = values.filter(function (d) { return d.val !== null && d.val !== undefined; });
    list.sort(function (a, b) { return b.val - a.val; });
    list.slice(0, 10).forEach(function (d, i) {
      var row = document.createElement('div');
      row.className = 'top-row';
      var sp = document.createElement('span');
      sp.textContent = (i + 1) + '. ' + d.nom;
      var v = document.createElement('span');
      v.innerHTML = '<b>' + fmt(d.val) + '</b>';
      row.appendChild(sp); row.appendChild(v);
      top.appendChild(row);
    });
  }
  if (!values.length) top.innerHTML = '<p class="muted">Aucune donnée.</p>';
  setStatus(values.length + ' ' + unitLabel + ' affiché(e)s');
}

function applyNames(data, geo) {
  geo.features.forEach(function (f) { if (data[f.properties.code]) data[f.properties.code].nom = f.properties.nom; });
}

function updateFrance() {
  var ind = state.indicator;
  if (!ind) return;
  var data = ind.france();
  applyNames(data, state.geo);
  document.getElementById('legendTitle').textContent = ind.label + ' — ' + ind.unit;
  renderChoropleth(state.geo, data, ind, 'départements');
}

function openDepartment(code, nom) {
  state.view = 'dep';
  state.dep = { code: code, nom: nom };
  document.getElementById('backBtn').hidden = false;
  document.getElementById('levelTitle').textContent = nom + ' (' + code + ') — par commune';
  refresh();
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
  var ind = state.indicator;
  if (!ind) return;
  hideError();
  if (state.view === 'france') {
    updateFrance();
  } else if (ind.hasCommunes) {
    var prep = ind.cat === 'delinquance' ? loadCommunesDelinquance(state.dep.code, state.annee) : Promise.resolve();
    prep.then(function () {
      var geoPromise = state.communesGeo[state.dep.code] ? Promise.resolve(state.communesGeo[state.dep.code]) :
        fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[state.dep.code] + '/communes-' + DEP_FOLDERS[state.dep.code] + '.geojson')
          .then(function (g) { state.communesGeo[state.dep.code] = g; return g; });
      return geoPromise;
    }).then(function (geo) {
      var data = ind.communes(state.dep.code);
      applyNames(data, geo);
      document.getElementById('legendTitle').textContent = ind.label + ' — ' + ind.unit;
      renderChoropleth(geo, data, ind, 'communes');
      if (geoLayer) map.fitBounds(geoLayer.getBounds(), { padding: [30, 30] });
    }).catch(function (err) {
      console.error('[OpenFrance] Échec communes :', err);
      showError('Impossible de charger les communes de ' + state.dep.nom + '.', err.message);
    });
  } else {
    setStatus('ℹ️ Indicateur disponible uniquement au niveau départemental.');
    document.getElementById('toplist').innerHTML = '<p class="muted">Non disponible au niveau communal.</p>';
  }
}

function catIndicators(cat) { return REGISTRY.filter(function (i) { return i.cat === cat; }); }

function fillIndicatorSelect() {
  var sel = document.getElementById('indicatorSelect');
  var inds = catIndicators(state.category);
  sel.innerHTML = inds.map(function (i) { return '<option>' + i.label + '</option>'; }).join('');
  sel.disabled = inds.length === 0;
}

function currentIndicatorByLabel(label) {
  return catIndicators(state.category).filter(function (i) { return i.label === label; })[0] || catIndicators(state.category)[0];
}

function selectIndicator(label, keepView) {
  var ind = currentIndicatorByLabel(label);
  state.indicator = ind;
  if (!keepView) { state.view = 'france'; state.dep = null; document.getElementById('backBtn').hidden = true; document.getElementById('levelTitle').textContent = 'France — par département'; }
  var yearLabel = document.getElementById('yearLabel');
  var ySel = document.getElementById('yearSelect');
  if (ind.hasYears) {
    yearLabel.style.display = '';
    var annees = [], seen = {};
    DELINQ.allRows.forEach(function (r) { if (!seen[r.annee]) { seen[r.annee] = 1; annees.push(r.annee); } });
    annees.sort(function (a, b) { return b - a; });
    ySel.innerHTML = annees.map(function (a) { return '<option>' + a + '</option>'; }).join('');
    ySel.disabled = false;
    if (state.annee && annees.indexOf(state.annee) !== -1) ySel.value = state.annee;
    state.annee = parseInt(ySel.value, 10);
  } else {
    yearLabel.style.display = 'none';
    ySel.disabled = true;
  }
  setStatus('⏳ Chargement des données…', 'loading');
  ind.ensure().then(function () {
    hideError();
    refresh();
  }).catch(function (err) {
    console.error('[OpenFrance] Échec :', err);
    showError('Impossible de charger « ' + ind.label + ' ».', err.message);
  });
}

function initUI() {
  registerDelinquanceIndicators();
  fillIndicatorSelect();
  selectIndicator(catIndicators('delinquance')[0].label, false);

  document.getElementById('categorySelect').addEventListener('change', function () {
    state.category = this.value;
    if (state.category === 'economie' && catIndicators('economie').length === 0) registerEconomieIndicators();
    if (state.category === 'politique' && catIndicators('politique').length === 0) registerPolitiqueIndicators();
    fillIndicatorSelect();
    if (catIndicators(state.category).length) selectIndicator(catIndicators(state.category)[0].label, false);
  });
  document.getElementById('indicatorSelect').addEventListener('change', function () {
    selectIndicator(this.value, true);
  });
  document.getElementById('yearSelect').addEventListener('change', function () {
    state.annee = parseInt(this.value, 10);
    refresh();
  });
  document.getElementById('backBtn').addEventListener('click', backToFrance);
}

setStatus('⏳ Chargement des données…', 'loading');
Promise.all([
  fetchTextCached(URLS.delinquance),
  fetchJSONCached(URLS.departements)
]).then(function (res) {
  state.geo = res[1];
  DELINQ.allRows = parseDelinquanceCSV(res[0]);
  DELINQ.totalRows = buildAggregates(DELINQ.allRows.map(function (r) {
    return { zone: r.dep, annee: r.annee, nombre: r.nombre, pop: r.pop, estim: false };
  }));
  DELINQ.loaded = true;
  hideError();
  setStatus('Données chargées');
  initUI();
}).catch(function (err) {
  console.error('[OpenFrance] Échec du démarrage :', err);
  showError('Impossible de charger les données. Détails dans la console (F12).', err.message);
});