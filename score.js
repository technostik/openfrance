// OpenFrance — Composeur de critères : indice ad hoc généralisé
// (généralisation de l'ancien « Score perso »)
//
// Principe : l'utilisateur choisit une zone (un ou plusieurs départements, avec
// suggestion des limitrophes), une ville cible (autocomplete sur les communes de la
// zone), puis compose librement son indice : ajout/retrait de
// critères (les filtres existants de l'app + distance à la ville cible), sens de
// chaque critère (⬆ plus = mieux / ⬇ moins = mieux) et pondération 0–10.
// Recalcul en temps réel, dégradé vert→rouge, meilleure commune en bleu.
//
// Types de critères (tous au niveau commune) :
//   📍 dist      — distance à la ville cible (haversine centroïde→centroïde)
//   🛡 delinq    — taux de délinquance ‰ (indicateur au choix, dernière année dispo)
//   💰 loyers    — loyer d'annonce prédit €/m² (« Carte des loyers » 2025, MTE)
//   💶 revenus   — niveau de vie médian (Filosofi 2021, Geoptis)
//   🏠 dvf       — prix moyen au m² (DVF 2015-2025, appartements ou maisons)
//   🥋 annuaire  — nombre d'associations RNA correspondant à une requête
//                  multi-opérateurs (ex. « théâtre + danse - opéra »)
//   🗳 politiq   — indicateur politique numérique par commune (abstention, voix d'un
//                  candidat/nuance/liste : Présidentielle 22, Législatives 24,
//                  Européennes 24) via le REGISTRY de app.js
//
// Dépend de app.js (state, DELINQ, REGISTRY, TOTAL_LABEL, DEP_FOLDERS, loadDelinquance,
// loadCommunesDelinquance, delinquanceCommunes, loadRevenus, revenusCommunes, loadDVF,
// dvfData, loadElectCommunes, fetchJSONCached, colorFor, setStatus, showError, hideError,
// fmt, fmt1, map, geoLayer) et annuaire.js (ANN, loadAssosDept, annCentroids, parseAnnQuery,
// annMatch, annHaystack, normTxt, esc).

var SC = {
  active: false,
  dep: null,           // département choisi = zone[0] (compat préférences)
  zone: [],            // zone multi-départements (1..n, limitrophes suggérés)
  target: null,          // { code, nom } — ville cible (critère distance)
  annee: null,           // année délinquance utilisée
  geo: null, geoZoneKey: null, centroids: null, cities: [],
  valCache: {},          // dep|typeKey -> { ready, vals: {code -> nombre}, promise }
  crits: [], nextId: 1,
  data: {}, best: null, layer: null,
  loyersByDep: {},        // dep -> { code -> €/m² }
  seeded: false, uiReady: false,
  pending: 0, errors: []
};

var SC_BLUE = '#2563eb';

// ---------- Préférences persistantes (localStorage) ----------
// Derniers choix (département, ville cible, critères avec poids et sens) : aucune
// valeur personnelle en dur, tout est restauré d'une session à l'autre.
var SC_PREF_KEY = 'openfrance-score-prefs';
function scLoadPrefs() {
  try {
    var p = JSON.parse(localStorage.getItem(SC_PREF_KEY) || 'null');
    if (!p || typeof p !== 'object' || !Array.isArray(p.crits)) return null;
    return p;
  } catch (e) { return null; }
}
function scSavePrefs() {
  try {
    localStorage.setItem(SC_PREF_KEY, JSON.stringify({
      dep: SC.dep, zone: SC.zone,
      target: SC.target,
      crits: SC.crits.map(function (c) { return { type: c.type, cfg: c.cfg, w: c.w, dir: c.dir }; })
    }));
  } catch (e) {}
}

function scoreIsActive() { return SC.active; }

// ---------- Utilitaires ----------
function scBounds(vals) {
  var v = vals.filter(function (x) { return x !== null && x !== undefined; }).sort(function (a, b) { return a - b; });
  if (!v.length) return { lo: 0, hi: 1 };
  var lo = v[Math.floor((v.length - 1) * 0.05)];
  var hi = v[Math.floor((v.length - 1) * 0.95)];
  if (hi <= lo) { lo = v[0]; hi = v[v.length - 1]; }
  if (hi <= lo) hi = lo + 1;
  return { lo: lo, hi: hi };
}
function scPart(v, b, dir) { // dir 'max' : plus haut = mieux · 'min' : plus bas = mieux
  if (v === null || v === undefined) return null;
  var t = Math.max(0, Math.min(1, (v - b.lo) / (b.hi - b.lo)));
  return dir === 'min' ? 1 - t : t;
}
function scDistKm(a, b) { // haversine, a/b = [lat, lng]
  var R = 6371;
  var dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}
function scMapVals(d) { // { code -> { val } } -> { code -> nombre }
  var out = {};
  for (var c in d) if (d[c] && d[c].val !== null && d[c].val !== undefined) out[c] = d[c].val;
  return out;
}
function scDepLabel(dep) {
  var f = DEP_FOLDERS[dep] || dep;
  return f.replace(/^\d+A?-?/, '').replace(/-/g, ' ');
}
function scLatestYear() {
  var y = 0;
  DELINQ.allRows.forEach(function (r) { if (r.annee > y) y = r.annee; });
  return y || null;
}

// ---------- Chargements ----------
function scEnsureGeo() { // géo fusionnée de la zone (mergedZoneGeo, app.js)
  var zk = SC.zone.join('+');
  if (SC.geo && zk === SC.geoZoneKey) return Promise.resolve();
  return mergedZoneGeo(SC.zone).then(function (geo) {
    if (SC.zone.join('+') !== zk) return; // zone changée entre-temps
    SC.geo = geo; SC.geoZoneKey = zk;
    var cent = {};
    SC.zone.forEach(function (d) {
      var c = annCentroids(d);
      for (var k in c) if (!cent[k]) cent[k] = c[k];
    });
    SC.centroids = cent;
    SC.cities = (geo.features || []).map(function (f) {
      return { code: f.properties.code, nom: f.properties.nom, n: normTxt(f.properties.nom) };
    });
  });
}

function scEnsureLoyers() {
  return Promise.all(SC.zone.map(function (dep) { return scEnsureLoyersDep(dep); }));
}
function scEnsureLoyersDep(dep) {
  if (SC.loyersByDep[dep]) return Promise.resolve();
  var base = '/api/loyers/?DEP__exact=' + encodeURIComponent(dep) + '&page_size=200';
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
      var map = {};
      rows.forEach(function (r) {
        var code = String(r.INSEE_C || '').trim();
        var v = parseFloat(r.loypredm2);
        if (code && !isNaN(v)) map[code] = v;
      });
      SC.loyersByDep[dep] = map;
    });
  });
}

function scEnsureAssos() {
  return scEnsureGeo().then(function () {
    return Promise.all(SC.zone.map(function (d) { return loadAssosDept(d); }));
  });
}

function scAnnCounts(q) { // requête RNA -> { code commune -> nb d'assos }
  var parsed = parseAnnQuery(q);
  var counts = {};
  SC.zone.forEach(function (dep) {
    (ANN.assos[dep] || []).forEach(function (a) {
      if (!annMatch(annHaystack(a), parsed)) return;
      var c = String(a.n || '').trim();
      if (c) counts[c] = (counts[c] || 0) + 1;
    });
  });
  return counts;
}

function scPolEntries() { // indicateurs politique numériques par commune (REGISTRY)
  return REGISTRY.filter(function (e) {
    return e.cat === 'politique' && e.type === 'num' && e.hasCommunes && e.electId;
  });
}

// ---------- Types de critères ----------
var SC_TYPES = {
  dist: {
    icon: '📍', label: 'Distance à la ville cible', dir: 'min', cfg: 'target',
    key: function () { return 'dist|' + (SC.target ? SC.target.code : 'none'); },
    describe: function () { return SC.target ? ('Distance à ' + SC.target.nom) : 'Distance (ville cible ?)'; },
    ensure: function () { return scEnsureGeo(); },
    vals: function () {
      var out = {};
      if (!SC.target) return out;
      var t = SC.centroids[SC.target.code];
      if (!t) return out;
      for (var c in SC.centroids) out[c] = scDistKm(SC.centroids[c], t);
      return out;
    },
    fmt: function (v) { return fmt1(v) + ' km'; }
  },
  delinq: {
    icon: '🛡', label: 'Délinquance', dir: 'min', cfg: 'select', field: 'ind',
    defCfg: function () { return { ind: TOTAL_LABEL }; },
    key: function (cfg) { return 'delinq|' + cfg.ind; },
    cfgOptions: function () {
      var seen = {}, opts = [{ v: TOTAL_LABEL, l: 'Ensemble des faits' }];
      DELINQ.allRows.forEach(function (r) { if (!seen[r.indicateur]) { seen[r.indicateur] = 1; opts.push({ v: r.indicateur, l: r.indicateur }); } });
      return opts;
    },
    describe: function (cfg) { return 'Délinquance — ' + (cfg.ind === TOTAL_LABEL ? 'ensemble' : cfg.ind); },
    ensure: function () { return scEnsureGeo().then(function () {
      return Promise.all(SC.zone.map(function (d) { return loadCommunesDelinquance(d, SC.annee); }));
    }); },
    vals: function (cfg) {
      var merged = {};
      SC.zone.forEach(function (d) {
        var dz = delinquanceCommunes(d, cfg.ind, SC.annee);
        for (var c in dz) if (!(c in merged)) merged[c] = dz[c];
      });
      return scMapVals(merged);
    },
    fmt: function (v) { return fmt1(v) + ' ‰'; }
  },
  loyers: {
    icon: '💰', label: 'Loyers d\'annonce (€/m²)', dir: 'min', cfg: 'none',
    key: function () { return 'loyers'; },
    describe: function () { return 'Loyers d\'annonce €/m²'; },
    ensure: function () { return scEnsureLoyers(); },
    vals: function () {
      var out = {};
      SC.zone.forEach(function (d) {
        var m = SC.loyersByDep[d] || {};
        for (var c in m) if (!(c in out)) out[c] = m[c];
      });
      return out;
    },
    fmt: function (v) { return fmt1(v) + ' €/m²'; }
  },
  revenus: {
    icon: '💶', label: 'Niveau de vie médian', dir: 'max', cfg: 'none',
    key: function () { return 'revenus'; },
    describe: function () { return 'Niveau de vie médian (Filosofi)'; },
    ensure: function () { return loadRevenus(); },
    vals: function () {
      var merged = {};
      SC.zone.forEach(function (d) {
        var r = revenusCommunes(d);
        for (var c in r) if (!(c in merged)) merged[c] = r[c];
      });
      return scMapVals(merged);
    },
    fmt: function (v) { return fmt(v) + ' €/an'; }
  },
  dvf: {
    icon: '🏠', label: 'Prix au m² (DVF)', dir: 'min', cfg: 'select', field: 'which',
    defCfg: function () { return { which: 'apt' }; },
    key: function (cfg) { return 'dvf|' + cfg.which; },
    cfgOptions: function () { return [{ v: 'apt', l: 'Appartements' }, { v: 'mai', l: 'Maisons' }]; },
    describe: function (cfg) { return 'Prix m² ' + (cfg.which === 'apt' ? 'appartements' : 'maisons') + ' (DVF)'; },
    ensure: function () { return loadDVF(); },
    vals: function (cfg) {
      var all = dvfData(cfg.which, 'com'), out = {};
      for (var c in all) {
        var d = c.slice(0, 2); if (/^97/.test(c)) d = c.slice(0, 3);
        if (SC.zone.indexOf(d) !== -1) out[c] = all[c].val;
      }
      return out;
    },
    fmt: function (v) { return fmt(v) + ' €/m²'; }
  },
  ann: {
    icon: '🥋', label: 'Associations (requête RNA)', dir: 'max', cfg: 'text',
    defCfg: function () { return { q: '' }; }, // vide = toutes les associations
    key: function (cfg) { return 'ann|' + cfg.q; },
    describe: function (cfg) { return cfg.q ? 'Assos « ' + cfg.q + ' »' : 'Associations RNA (toutes)'; },
    ensure: function () { return scEnsureAssos(); },
    vals: function (cfg) { return scAnnCounts(cfg.q); },
    fmt: function (v) { return fmt(v) + ' asso(s)'; }
  },
  pol: {
    icon: '🗳', label: 'Politique (par commune)', dir: 'max', cfg: 'select', field: 'idx',
    defCfg: function () { return { idx: 0 }; },
    key: function (cfg) { return 'pol|' + cfg.idx; },
    cfgOptions: function () { return scPolEntries().map(function (e, i) { return { v: i, l: e.label }; }); },
    describe: function (cfg) {
      var l = scPolEntries()[cfg.idx];
      return l ? l.label : 'Politique';
    },
    defDir: function (cfg) {
      var l = scPolEntries()[cfg.idx];
      return l && /abstention/i.test(l.label) ? 'min' : 'max';
    },
    ensure: function (cfg) {
      var e = scPolEntries()[cfg.idx];
      if (!e) return Promise.reject(new Error('indicateur politique inconnu'));
      return scEnsureGeo().then(function () {
        return Promise.all(SC.zone.map(function (d) { return loadElectCommunes(d, e.electId); }));
      });
    },
    vals: function (cfg) {
      var e = scPolEntries()[cfg.idx];
      if (!e) return {};
      var merged = {};
      SC.zone.forEach(function (d) {
        var r = e.communes(d);
        for (var c in r) if (!(c in merged)) merged[c] = r[c];
      });
      return scMapVals(merged);
    },
    fmt: function (v) { return fmt1(v) + ' %'; }
  }
};

// Page principale (politiquement correcte) : le critère délinquance disparaît.
if (!window.MF_PAGE) delete SC_TYPES.delinq;

// Page /mafrance : les six indices composites MaFrance deviennent des critères
// du composeur (base 100 = France métropolitaine ; mesure d'intensité, pas un
// jugement de valeur).
if (window.MF_PAGE && typeof MF_INDICES !== 'undefined') {
  SC_TYPES.mf = {
    icon: '📊', label: 'Indice MaFrance', dir: 'max', cfg: 'select', field: 'idx',
    defCfg: function () { return { idx: 0 }; },
    key: function (cfg) { return 'mf|' + cfg.idx; },
    cfgOptions: function () {
      return MF_INDICES.map(function (m, i) { return { v: i, l: 'MaFrance — ' + m.label }; });
    },
    describe: function (cfg) {
      return 'MaFrance — ' + (MF_INDICES[cfg.idx] ? MF_INDICES[cfg.idx].label : 'indice');
    },
    defDir: function (cfg) {
      // insécurité : moins élevé = mieux par défaut ; le reste au sens inverse,
      // l'utilisateur peut basculer librement.
      return (MF_INDICES[cfg.idx] && MF_INDICES[cfg.idx].key === 'insecurite_score') ? 'min' : 'max';
    },
    ensure: function () { return Promise.all(SC.zone.map(function (d) { return loadMfCommunes(d); })); },
    vals: function (cfg) {
      var m = MF_INDICES[cfg.idx], out = {};
      SC.zone.forEach(function (d) {
        var com = MF.com[d] || {};
        for (var c in com) {
          if (out[c] !== undefined) continue;
          var v = com[c][m.key];
          if (v !== undefined && v !== null) out[c] = v;
        }
      });
      return out;
    },
    fmt: function (v) { return fmt(v) + ' (base 100)'; }
  };
}

// ---------- Cycle de vie d'un critère ----------
function scCacheKey(crit) { return SC.zone.join('+') + '|' + SC_TYPES[crit.type].key(crit.cfg); }

function scEnsureCrit(crit) {
  var key = scCacheKey(crit);
  var T = SC_TYPES[crit.type];
  var existing = SC.valCache[key];
  if (existing && existing.promise) return existing.promise; // déjà en cours/terminé
  var entry = { ready: false, vals: {}, promise: null };
  SC.valCache[key] = entry;
  SC.pending++;
  setStatus('⏳ Composeur : chargement « ' + T.describe(crit.cfg) + ' »…', 'loading');
  entry.promise = Promise.resolve().then(function () { return T.ensure(crit.cfg); }).then(function () {
    entry.vals = T.vals(crit.cfg);
    entry.ready = true;
  }).catch(function (err) {
    delete SC.valCache[key];
    console.warn('[OpenFrance] Composeur, critère « ' + T.label + ' » :', err);
    SC.errors.push(T.label + ' : ' + err.message);
  }).then(function () {
    SC.pending--;
    if (SC.active) {
      if (!SC.pending) {
        if (SC.errors.length) { setStatus('⚠️ Critères en échec : ' + SC.errors.join(' · '), 'error'); SC.errors = []; }
        else setStatus(Object.keys(SC.data).length + ' communes scorées — composez !');
      }
      scDraw();
    }
  });
  return entry.promise;
}

function scEnsureAll() {
  return Promise.all(SC.crits.map(function (crit) { return scEnsureCrit(crit); }));
}

function scAddCrit(type, cfg, w, dir, silent) {
  var T = SC_TYPES[type];
  var c = cfg || (T.defCfg ? T.defCfg() : null);
  var crit = {
    id: SC.nextId++, type: type, cfg: c,
    w: (w === undefined ? 5 : w),
    dir: dir || (T.defDir ? T.defDir(c) : T.dir)
  };
  SC.crits.push(crit);
  scRenderCrits();
  if (!silent) scEnsureCrit(crit);
  // Ajout du critère « distance » sans ville cible : on invite à en choisir une
  if (!silent && type === 'dist' && !SC.target) {
    var tin = document.getElementById('scTarget');
    if (tin) tin.focus();
  }
  return crit;
}

function scRemoveCrit(id) {
  SC.crits = SC.crits.filter(function (c) { return c.id !== id; });
  scRenderCrits();
  scDraw();
}

function scCritChanged(crit) { // config modifiée : invalide le cache et recharge
  delete SC.valCache[scCacheKey(crit)];
  scRenderCrits();
  scEnsureCrit(crit);
}

// ---------- Score ----------
function scCompute() {
  var feats = SC.geo.features || [];
  var items = [];
  SC.crits.forEach(function (crit) {
    if (crit.w <= 0) return;
    var T = SC_TYPES[crit.type];
    var entry = SC.valCache[scCacheKey(crit)];
    var bounds = null;
    if (entry && entry.ready) {
      var vals = [];
      feats.forEach(function (f) {
        var v = entry.vals[f.properties.code];
        if (v !== undefined) vals.push(v);
      });
      bounds = scBounds(vals);
    }
    items.push({ crit: crit, T: T, entry: entry, bounds: bounds });
  });

  var data = {}, best = null;
  feats.forEach(function (f) {
    var code = f.properties.code;
    var e = { nom: f.properties.nom, vals: {}, score: 0 };
    var sum = 0, wsum = 0;
    items.forEach(function (it) {
      var v, part;
      if (it.entry && it.entry.ready) v = it.entry.vals[code];
      if (v === undefined) part = 0.5; // donnée absente → neutre, pas de pénalité
      else {
        e.vals[it.crit.id] = v;
        part = scPart(v, it.bounds, it.crit.dir);
      }
      sum += it.crit.w * part;
      wsum += it.crit.w;
    });
    e.score = wsum > 0 ? sum / wsum : 0;
    data[code] = e;
    if (!best || e.score > data[best].score) best = code;
  });
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
  SC.crits.forEach(function (crit) {
    if (crit.w <= 0) return;
    var T = SC_TYPES[crit.type];
    var v = e.vals[crit.id];
    txt += '<br>' + T.icon + ' ' + esc(T.describe(crit.cfg)) + ' : <b>' + (v === undefined ? 'n.d.' : T.fmt(v)) + '</b>';
  });
  return txt;
}
function scSidepanel() {
  var wsum = 0;
  SC.crits.forEach(function (c) { if (c.w > 0) wsum += c.w; });
  var readyN = SC.crits.filter(function (c) {
    var e = SC.valCache[scCacheKey(c)];
    return e && e.ready;
  }).length;
  document.getElementById('legendTitle').textContent =
    'Score composite (' + readyN + '/' + SC.crits.length + ' critères chargés, poids total ' + wsum + ')';
  var legend = document.getElementById('legend');
  legend.innerHTML = '';
  for (var c = 0; c < 6; c++) {
    var row = document.createElement('div');
    row.className = 'legend-row';
    var swatch = document.createElement('span');
    swatch.className = 'legend-color';
    swatch.style.background = colorFor((c + 0.5) / 6);
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
function scDraw() {
  if (!SC.geo || !SC.active) return;
  scCompute();
  if (!SC.layer) {
    SC.layer = L.geoJSON(SC.geo, {
      style: function (f) { return scStyleFor(f.properties.code); },
      onEachFeature: function (f, l) {
        l.bindTooltip(function () { return scTooltip(f.properties.code); }, { sticky: true });
      }
    }).addTo(map);
    map.fitBounds(SC.layer.getBounds(), { padding: [30, 30] });
  } else {
    SC.layer.eachLayer(function (l) {
      if (l.feature) l.setStyle(scStyleFor(l.feature.properties.code));
    });
  }
  scSidepanel();
}

// ---------- Département / ville cible ----------
function scSetZone(deps) { // zone = 1..n départements (widget commun, app.js)
  deps = (deps || []).filter(function (d) { return !!DEP_FOLDERS[d]; });
  if (!deps.length) return;
  var saved = scLoadPrefs();
  var keepT = (SC._savedTarget && SC._savedTarget.code) ? SC._savedTarget :
              (SC.target && SC.target.code) ? SC.target :
              (saved && saved.target && saved.target.code) ? saved.target : null;
  SC._savedTarget = null;
  SC.zone = deps.slice();
  SC.dep = deps[0];
  SC.geo = null; SC.data = {}; SC.best = null;
  if (SC.layer) { map.removeLayer(SC.layer); SC.layer = null; }
  SC.target = null;
  scSavePrefs(); // changement de zone
  document.getElementById('scTarget').value = '';
  document.getElementById('levelTitle').textContent = 'Composeur — ' + zoneLabel(SC.zone);
  var zw = document.getElementById('scZoneWrap');
  if (zw) zoneWidgetRender(zw, SC.zone, scSetZone);
  var delinqP = (!window.MF_PAGE || DELINQ.loaded) ? Promise.resolve() : loadDelinquance();
  delinqP.then(function () {
    SC.annee = scLatestYear();
    return scEnsureGeo();
  }).then(function () {
    // la ville cible n'est conservée que si elle appartient à la nouvelle zone
    if (keepT && SC.zone.indexOf(depOfCommune(keepT.code)) !== -1) scSetTarget(keepT.code, keepT.nom);
    scRenderCrits();
    return scEnsureAll();
  }).then(function () { scDraw(); }).catch(function (err) {
    console.error('[OpenFrance] Composeur :', err);
    showError('Composeur : impossible de charger la zone.', err.message);
  });
}

function scSetTarget(code, nom) {
  SC.target = { code: code, nom: nom };
  document.getElementById('scTarget').value = nom;
  var prefix = SC.zone.join('+') + '|dist|'; // invalide les distances de la zone courante
  for (var k in SC.valCache) if (k.indexOf(prefix) === 0) delete SC.valCache[k];
  SC.crits.forEach(function (crit) {
    if (crit.type === 'dist') scEnsureCrit(crit);
  });
  scRenderCrits();
}

// ---------- Autocomplete ville cible ----------
function scTargetSearch(q) {
  q = normTxt(q);
  if (!q) return [];
  var out = [];
  for (var i = 0; i < SC.cities.length && out.length < 10; i++) {
    var c = SC.cities[i];
    if (c.n.indexOf(q) !== -1) out.push(c);
  }
  return out;
}
function scTargetDrop(show) {
  var d = document.getElementById('scTargetDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function scTargetRender(matches) {
  var d = document.getElementById('scTargetDrop');
  d.innerHTML = '';
  matches.forEach(function (m) {
    var row = document.createElement('div');
    row.innerHTML = esc(m.nom) + ' <span class="muted">(' + m.code + ')</span>';
    row.addEventListener('mousedown', function (ev) { // mousedown : avant le blur
      ev.preventDefault();
      scSetTarget(m.code, m.nom);
      scTargetDrop(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}

// ---------- UI des critères ----------
function scRenderCrits() {
  var box = document.getElementById('scCrits');
  if (!box) return;
  box.innerHTML = '';
  SC.crits.forEach(function (crit) { box.appendChild(scCritRow(crit)); });
  scUpdateTargetVisibility();
  scSavePrefs(); // ajout/retrait/config d'un critère : persistance
}

// La « ville cible » n'est utilisée que par le critère « distance » : le champ
// ne s'affiche que si un tel critère est présent dans la composition.
function scUpdateTargetVisibility() {
  var wrap = document.getElementById('scTargetWrap');
  if (wrap) wrap.style.display = SC.crits.some(function (c) { return c.type === 'dist'; }) ? '' : 'none';
}

function scCritRow(crit) {
  var T = SC_TYPES[crit.type];
  var row = document.createElement('div');
  row.className = 'sc-crit';

  var ico = document.createElement('span');
  ico.className = 'sc-ico';
  ico.textContent = T.icon;
  row.appendChild(ico);

  if (T.cfg === 'select') {
    var sel = document.createElement('select');
    T.cfgOptions().forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.l;
      sel.appendChild(opt);
    });
    sel.value = crit.cfg[T.field];
    sel.addEventListener('change', function () {
      crit.cfg[T.field] = T.field === 'idx' ? parseInt(sel.value, 10) : sel.value;
      if (T.defDir) crit.dir = T.defDir(crit.cfg); // ex. abstention → moins = mieux
      scCritChanged(crit);
    });
    row.appendChild(sel);
  } else if (T.cfg === 'text') {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = crit.cfg.q;
    inp.className = 'sc-q';
    var deb = null;
    inp.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(function () {
        crit.cfg.q = inp.value;
        scCritChanged(crit);
      }, 400);
    });
    row.appendChild(inp);
  } else {
    var lab = document.createElement('span');
    lab.className = 'sc-lab';
    lab.textContent = T.describe(crit.cfg);
    row.appendChild(lab);
  }

  // Sens : ⬆ plus = mieux · ⬇ moins = mieux
  var dir = document.createElement('button');
  dir.className = 'sc-dir';
  dir.type = 'button';
  function paintDir() {
    dir.textContent = crit.dir === 'min' ? '⬇' : '⬆';
    dir.title = crit.dir === 'min' ? 'Moins c\'est mieux (cliquer pour inverser)' : 'Plus c\'est mieux (cliquer pour inverser)';
  }
  paintDir();
  dir.addEventListener('click', function () {
    crit.dir = crit.dir === 'min' ? 'max' : 'min';
    paintDir();
    scDraw();
    scSavePrefs();
  });
  row.appendChild(dir);

  // Pondération 0-10
  var w = document.createElement('input');
  w.type = 'range'; w.min = '0'; w.max = '10'; w.value = crit.w;
  w.title = 'Pondération';
  var wv = document.createElement('b');
  wv.textContent = crit.w;
  w.addEventListener('input', function () {
    crit.w = parseInt(w.value, 10);
    wv.textContent = crit.w;
    scDraw();
    scSavePrefs();
  });
  row.appendChild(w);
  row.appendChild(wv);

  var del = document.createElement('button');
  del.className = 'sc-del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = 'Retirer ce critère';
  del.addEventListener('click', function () { scRemoveCrit(crit.id); });
  row.appendChild(del);

  return row;
}

function scInitUI() {
  if (SC.uiReady) return;
  SC.uiReady = true;

  var zw = document.getElementById('scZoneWrap');
  if (zw && SC.zone.length) zoneWidgetRender(zw, SC.zone, scSetZone);

  var addSel = document.getElementById('scAddType');
  Object.keys(SC_TYPES).forEach(function (k) {
    var o = document.createElement('option');
    o.value = k;
    o.textContent = SC_TYPES[k].icon + ' ' + SC_TYPES[k].label;
    addSel.appendChild(o);
  });
  document.getElementById('scAddBtn').addEventListener('click', function () {
    scAddCrit(addSel.value);
  });

  var tin = document.getElementById('scTarget');
  var deb = null;
  tin.addEventListener('input', function () {
    clearTimeout(deb);
    if (!tin.value.trim()) { scTargetDrop(false); return; }
    deb = setTimeout(function () { scTargetRender(scTargetSearch(tin.value)); }, 120);
  });
  tin.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var m = scTargetSearch(tin.value);
      if (m.length) { scSetTarget(m[0].code, m[0].nom); scTargetDrop(false); }
    } else if (e.key === 'Escape') scTargetDrop(false);
  });
  tin.addEventListener('blur', function () { setTimeout(function () { scTargetDrop(false); }, 150); });
  tin.addEventListener('focus', function () {
    if (tin.value.trim()) scTargetRender(scTargetSearch(tin.value));
  });
}

// ---------- Entrée / sortie du mode ----------
function scoreEnter() {
  SC.active = true;
  // Département consulté dans l'appli au moment d'entrer dans le composeur
  // (s'il y en a un) : il devient le département par défaut.
  var curDep = (state.view === 'dep' && state.dep && state.dep.code && DEP_FOLDERS[state.dep.code]) ? state.dep.code : null;
  scInitUI();
  var zwr = document.getElementById('scZoneWrap');
  if (zwr) zwr.style.display = '';
  scUpdateTargetVisibility();
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  document.getElementById('annPanel').style.display = 'none';
  document.getElementById('scoreControls').style.display = 'flex';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('backBtn').hidden = true;
  state.view = 'france'; state.dep = null; state.zone = [];
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  hideError();
  if (!SC.seeded) {
    SC.seeded = true;
    var saved = scLoadPrefs();
    var sz = (saved && Array.isArray(saved.zone)) ? saved.zone.filter(function (d) { return !!DEP_FOLDERS[d]; }) : [];
    if (!sz.length && saved && saved.dep && DEP_FOLDERS[saved.dep]) sz = [saved.dep];
    if (!sz.length) sz = [Object.keys(DEP_FOLDERS).sort()[0]];
    SC.zone = sz; SC.dep = sz[0];
    SC.crits = []; SC.nextId = 1;
    if (saved && saved.crits.length) {
      saved.crits.forEach(function (c) {
        if (SC_TYPES[c.type]) {
          scAddCrit(c.type, (c.cfg && typeof c.cfg === 'object') ? c.cfg : null, c.w, c.dir, true);
        }
      });
    } else {
      scAddCrit(window.MF_PAGE && SC_TYPES.delinq ? 'delinq' : 'revenus', null, 5, null, true); // critère neutre au premier passage
    }
    SC._savedTarget = (saved && saved.target && saved.target.code &&
      SC.zone.indexOf(depOfCommune(saved.target.code)) !== -1) ? saved.target : null;
  }
  // Département par défaut : département consulté dans l'appli > dernier
  // sauvegardé > 01 — Ain.
  if (curDep && SC.zone.indexOf(curDep) === -1) { SC.zone = [curDep]; SC.dep = curDep; SC._savedTarget = null; }
  scSetZone(SC.zone);
}

function scoreLeave() {
  SC.active = false;
  scTargetDrop(false);
  if (SC.layer) { map.removeLayer(SC.layer); SC.layer = null; }
  document.getElementById('scoreControls').style.display = 'none';
  var zwl = document.getElementById('scZoneWrap');
  if (zwl) zwl.style.display = 'none';
  if (state.category !== 'annuaire') {
    document.getElementById('indicatorLabel').style.display = '';
    document.getElementById('legendBlock').style.display = '';
    if (state.view === 'dep' && state.dep) {
      document.getElementById('levelTitle').textContent =
        ((state.zone && state.zone.length) ? zoneLabel(state.zone) : state.dep.nom + ' (' + state.dep.code + ')') + ' — par commune';
    } else {
      document.getElementById('backBtn').hidden = true;
      document.getElementById('levelTitle').textContent = 'France — par département';
    }
  }
}

