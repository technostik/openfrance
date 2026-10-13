// OpenFrance — MaFrance : indices composites de mafrance.app (page /mafrance uniquement)
// La page /mafrance regroupe la catégorie « Délinquance » (transférée depuis la
// page principale) et la catégorie « MaFrance » ; le composeur de critères y
// gagne aussi les indices MaFrance (voir score.js, type « mf »).
//
// Données : API mafrance.app, proxifiée same-origin via /api/mafrance/*.
//  - Départements : une seule requête rankings/departements (limit 101)
//  - Communes : une requête par département rankings/communes?dept=XX (limit 5000)
// Cache navigateur : IndexedDB persistant (par département) + service worker
// (cache disque /api/, TTL 7 jours) — même mécanique que l'annuaire.
//
// Les indices mesurent l'intensité d'un phénomène par rapport à la France
// métropolitaine (base 100) : 50 = moitié de l'intensité moyenne, 200 = double.
// Mesure d'intensité, pas un jugement de valeur (méthodologie : mafrance.app/methodologie).

var MF_INDICES = [
  { key: 'total_score', label: 'Indice général (moyenne des 5)' },
  { key: 'insecurite_score', label: 'Insécurité' },
  { key: 'immigration_score', label: 'Immigration' },
  { key: 'islamisation_score', label: 'Islamisation' },
  { key: 'defrancisation_score', label: 'Défrancisation (changement culturel)' },
  { key: 'wokisme_score', label: 'Wokisme (interventionnisme social)' }
];

var MF = {
  deps: null,   // { codeDept -> { <clé score> -> valeur } }
  com: {}       // dep -> { COG -> { <clé score> -> valeur } }
};

// ---------- IndexedDB (cache persistant, même mécanique que l'annuaire) ----------
function mfIdbOpen() {
  return new Promise(function (res, rej) {
    var rq = indexedDB.open('openfrance-mafrance', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('mf'); };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
function mfIdbGet(key) {
  return mfIdbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var rq = db.transaction('mf').objectStore('mf').get(key);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }).catch(function () { return null; });
}
function mfIdbSet(key, val) {
  return mfIdbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('mf', 'readwrite');
        tx.objectStore('mf').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}

// ---------- Chargements ----------
function mfFields() { return MF_INDICES.map(function (m) { return m.key; }).join(','); }

function loadMfDeps() {
  if (MF.deps) return Promise.resolve();
  return mfIdbGet('deps').then(function (cached) {
    if (cached && cached.deps && Object.keys(cached.deps).length) {
      MF.deps = cached.deps;
      return;
    }
    setStatus('⏳ MaFrance : chargement des indices par département…', 'loading');
    return fetch('/api/mafrance/rankings/departements?sort=total_score&limit=101&fields=' +
      encodeURIComponent('departement,' + mfFields())).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var deps = {};
      (j.data || []).forEach(function (row) {
        var d = String(row.departement || '').trim();
        if (!d) return;
        var e = {};
        MF_INDICES.forEach(function (m) {
          e[m.key] = (row[m.key] === undefined || row[m.key] === null) ? null : row[m.key];
        });
        deps[d] = e;
      });
      if (!Object.keys(deps).length) throw new Error('réponse MaFrance vide');
      MF.deps = deps;
      mfIdbSet('deps', { v: 1, date: Date.now(), deps: deps });
    });
  });
}

function loadMfCommunes(dep) {
  if (MF.com[dep]) return Promise.resolve();
  return mfIdbGet('com-' + dep).then(function (cached) {
    if (cached && cached.com && Object.keys(cached.com).length) {
      MF.com[dep] = cached.com;
      return;
    }
    setStatus('⏳ MaFrance : chargement des indices des communes du ' + dep + '…', 'loading');
    return fetch('/api/mafrance/rankings/communes?dept=' + encodeURIComponent(dep) +
      '&limit=5000&fields=' + encodeURIComponent('COG,' + mfFields())).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var com = {};
      (j.data || []).forEach(function (row) {
        var c = String(row.COG || '').trim();
        if (!c) return;
        var e = {};
        MF_INDICES.forEach(function (m) {
          e[m.key] = (row[m.key] === undefined || row[m.key] === null) ? null : row[m.key];
        });
        com[c] = e;
      });
      if (!Object.keys(com).length) throw new Error('aucune commune MaFrance pour ' + dep);
      MF.com[dep] = com;
      mfIdbSet('com-' + dep, { v: 1, date: Date.now(), dep: dep, com: com });
    });
  });
}

// ---------- Données pour la carte (format REGISTRY : { code -> { val, lines } }) ----------
var MF_UNIT = 'base 100';

function mfDepsData(key) {
  var data = {};
  for (var d in MF.deps) {
    var v = MF.deps[d][key];
    if (v === null || v === undefined) continue;
    data[d] = { val: v, lines: ['Indice : ' + fmt(v) + ' (France métropolitaine = 100)'] };
  }
  return data;
}

function mfCommunesData(dep, key) {
  var com = MF.com[dep] || {}, data = {};
  for (var c in com) {
    var v = com[c][key];
    if (v === null || v === undefined) continue;
    data[c] = { val: v, lines: ['Indice : ' + fmt(v) + ' (France métropolitaine = 100)'] };
  }
  return data;
}

// ---------- Registre d'indicateurs (catégorie « MaFrance ») ----------
function mfRegisterIndicators() {
  MF_INDICES.forEach(function (m) {
    REGISTRY.push({
      cat: 'mafrance', label: 'MaFrance — ' + m.label, unit: MF_UNIT, type: 'num',
      hasYears: false, hasCommunes: true,
      ensure: loadMfDeps,
      ensureCommunes: function (dep) { return loadMfCommunes(dep); },
      france: function () { return mfDepsData(m.key); },
      communes: function (dep) { return mfCommunesData(dep, m.key); }
    });
  });
}

// Entrée dans la catégorie (branchée depuis app.js, catégorie « mafrance »)
function mfEnterCategory(keepDep) {
  if (catIndicators('mafrance').length === 0) {
    setStatus('⏳ MaFrance : chargement des indices…', 'loading');
    loadMfDeps().then(function () {
      mfRegisterIndicators();
      fillIndicatorSelect();
      if (catIndicators('mafrance').length) selectIndicator(catIndicators('mafrance')[0].label, keepDep);
    }).catch(function (err) {
      console.error('[OpenFrance] MaFrance :', err);
      showError('Impossible de charger les indices MaFrance.', err.message);
    });
    return;
  }
  fillIndicatorSelect();
  if (catIndicators('mafrance').length) selectIndicator(catIndicators('mafrance')[0].label, keepDep);
}
