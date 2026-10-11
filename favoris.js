// OpenFrance — Favoris & contacts : étoiles sur toutes les entités + recherche
// automatisée d'email / site web (branche de test get_email).
//
// Mode transversal : fonctionne avec les modes existants SANS les modifier —
// favoris.js enveloppe (au DOMContentLoaded) les fonctions de rendu de
// annuaire.js / corp.js / corp_ext.js et décore le DOM qu'elles produisent :
//   renderAnnList, assoPopup, entPopup          — annuaire (assos + entreprises)
//   coRenderResults, coPopupHtml, coOpenFiche   — composeur d'entreprises (+ fiche)
//   extRenderResults, extRenderFT, extPopupHtml, extFTPopupHtml — recherche étendue
//
// Favoris : IndexedDB dédié « openfrance-favoris » (store fav, clé type:id),
// miroir RAM FAV.all. Types : 'commune' (villes cibles des composeurs + champ
// BAN du panneau), 'ent' (entreprises Sirene, La Bonne Boite, French Tech
// curatées), 'asso' (RNA). Tout reste local au navigateur.
//
// Blacklist 🚫 : l'inverse des favoris — entités à ne plus voir. Même base
// IndexedDB (store « blk »), miroir RAM FAV.bl. Une entité blacklistée est
// retirée des favoris (et réciproquement), masquée des listes (classe CSS
// .fav-blkrow, option « afficher grisées » dans le panneau) et de la carte
// (marqueur détaché de sa couche sans être retiré de l'index : la synchro par
// différence d'annuaire ne le recrée pas). Bouton ⊘/🚫 à côté de chaque
// étoile ; gestion dans la section « Blacklistées » du panneau Favoris.
//
// Recherche email/site web = SYSTÈME DE PLUGINS (moteurs cochables, config en
// localStorage « openfrance-fav-engines ») — registre déclaratif FAV_ENGINES :
//   wikidata   (client)  : P856 site officiel + P968 email (wbsearchentities +
//                          wbgetentities, origin=*) — gratuit, sans clé
//   officiel   (serveur) : mairies — Annuaire de l'administration (DILA)
//   tavily     (serveur) : découverte du site web (TAVILY_API_KEY sur Netlify)
//   scrape     (serveur) : emails du site (mailto, regex, JSON-LD, déobfuscation,
//                          Cloudflare, pages contact, contrôle MX)
//   prospector (serveur) : prospector-mcp en MCP stdio — opt-in (quota 50/jour)
// Le serveur est la fonction Netlify email.js (POST /ft/email, op=lookup).
// Ajouter un moteur = engXxx + entrée dans opLookup (email.js) + ligne dans
// FAV_ENGINES (ici).

var FAV = {
  db: null,
  all: {},        // clé -> favori {type,id,nom,siren,siret,insee,ville,dep,siteWeb,email,...}
  bl: {},         // clé -> blacklistée 🚫 {type,id,nom,...} — l'inverse des favoris
  order: [],     // clés en ordre d'ajout
  blOrder: [],   // clés blacklistées en ordre d'ajout
  blHide: true,   // true = blacklistées masquées des listes, false = affichées grisées
  looking: {},   // clé -> true (recherche email en cours)
  _inited: false,
  _allRunning: false,
  _cityTimer: null,
  blHideKey: 'openfrance-fav-blhide'
};

// Registre des moteurs (id, où il tourne, types concernés, label)
var FAV_ENGINES = [
  { id: 'wikidata', where: 'client', types: ['asso', 'ent', 'commune'], label: 'Wikidata (site officiel + email)' },
  { id: 'officiel', where: 'server', types: ['commune'], label: 'Annuaire service-public (mairies)' },
  { id: 'tavily', where: 'server', types: ['asso', 'ent', 'commune'], label: 'Tavily (découverte du site web)' },
  { id: 'scrape', where: 'server', types: ['asso', 'ent', 'commune'], label: 'Scraping du site (emails + contrôle MX)' },
  { id: 'prospector', where: 'server', types: ['ent'], label: 'prospector-mcp (vérif SMTP, opt-in)' }
];
var FAV_ENG_KEY = 'openfrance-fav-engines';

function favEngineConfig() {
  var cfg = { wikidata: true, officiel: true, tavily: true, scrape: true, prospector: false };
  try {
    var saved = JSON.parse(localStorage.getItem(FAV_ENG_KEY) || '{}');
    for (var k in cfg) if (saved[k] !== undefined) cfg[k] = !!saved[k];
  } catch (e) { /* config par défaut */ }
  return cfg;
}
function favEngineSave(cfg) {
  try { localStorage.setItem(FAV_ENG_KEY, JSON.stringify(cfg)); } catch (e) { /* best-effort */ }
}

// ---------- IndexedDB (openfrance-favoris, store fav, clés type:id) ----------
function favDbOpen() {
  if (FAV.db) return Promise.resolve(FAV.db);
  return new Promise(function (res, rej) {
    var rq = indexedDB.open('openfrance-favoris', 2); // v2 : + store « blk » (blacklist)
    rq.onupgradeneeded = function () {
      var db = rq.result;
      if (!db.objectStoreNames.contains('fav')) db.createObjectStore('fav');
      if (!db.objectStoreNames.contains('blk')) db.createObjectStore('blk');
    };
    rq.onsuccess = function () { FAV.db = rq.result; res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
function favDbPut(key, val) {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('fav', 'readwrite');
        tx.objectStore('fav').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}
function favDbDelete(key) {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('fav', 'readwrite');
        tx.objectStore('fav').delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}
function favDbLoadAll() {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      var out = [];
      try {
        var rq = db.transaction('fav').objectStore('fav').openCursor();
        rq.onsuccess = function () {
          var cur = rq.result;
          if (cur) { out.push({ key: cur.key, rec: cur.value }); cur.continue(); }
          else res(out);
        };
        rq.onerror = function () { res(out); };
      } catch (e) { res(out); }
    });
  }).catch(function () { return []; });
}
// Store « blk » (blacklist) — mêmes helpers que « fav », même base
function blDbPut(key, val) {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('blk', 'readwrite');
        tx.objectStore('blk').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}
function blDbDelete(key) {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction('blk', 'readwrite');
        tx.objectStore('blk').delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }).catch(function () { /* best-effort */ });
}
function blDbLoadAll() {
  return favDbOpen().then(function (db) {
    return new Promise(function (res) {
      var out = [];
      try {
        var rq = db.transaction('blk').objectStore('blk').openCursor();
        rq.onsuccess = function () {
          var cur = rq.result;
          if (cur) { out.push({ key: cur.key, rec: cur.value }); cur.continue(); }
          else res(out);
        };
        rq.onerror = function () { res(out); };
      } catch (e) { res(out); }
    });
  }).catch(function () { return []; });
}

// ---------- Builders : objet source -> entité favori normalisée ----------
FAV.fromAsso = function (a) {
  return { type: 'asso', id: a.i, nom: a.t, insee: a.n || '', ville: a.l || '', siteWeb: a.w || '' };
};
FAV.fromEnt = function (e) {
  var s = e.siege || {};
  return {
    type: 'ent', id: e.siren,
    siren: e.siren, siret: s.siret || '',
    nom: e.nom_complet || e.nom_raison_sociale || e.siren,
    ville: s.libelle_commune || '',
    dep: (typeof state !== 'undefined' && state.dep && state.dep.code) ||
         (typeof CO !== 'undefined' && CO.dep) || '',
    siteWeb: ''
  };
};
FAV.fromExtItem = function (c, cur) {
  return {
    type: 'ent', id: c.siren, siren: c.siren, siret: c.siret || '',
    nom: c.name || c.siren, ville: c.city || '',
    siteWeb: (cur && cur.site_web) || ''
  };
};
FAV.fromFTRec = function (rec) {
  return {
    type: 'ent', id: rec.siren, siren: rec.siren,
    nom: rec.nom || rec.siren, ville: rec.ville || '',
    siteWeb: rec.site_web || ''
  };
};
FAV.fromCommune = function (t) {
  return { type: 'commune', id: t.code, insee: t.code, nom: t.nom, ville: t.nom };
};
function favKey(ent) { return ent.type + ':' + ent.id; }

// ---------- Étoile (listes, popups, fiches) ----------
FAV.starHtml = function (ent) {
  if (!ent || !ent.id) return '';
  var key = favKey(ent);
  var on = !!FAV.all[key];
  return ' <span class="fav-star' + (on ? ' fav-on' : '') + '" data-favkey="' + esc(key) +
    '" data-fav="' + esc(JSON.stringify(ent)) +
    '" title="Ajouter/retirer des favoris" onclick="FAV.toggleStar(this,event)">' +
    (on ? '⭐' : '☆') + '</span>';
};
FAV.toggleStar = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  try {
    var ent = JSON.parse(el.getAttribute('data-fav') || '{}');
    var key = el.getAttribute('data-favkey');
    if (FAV.all[key]) FAV.remove(key); else FAV.add(ent);
  } catch (e) { /* clic invalide : ignoré */ }
};

// ---------- Bouton 🚫 blacklist (listes, popups, fiches) ----------
FAV.blHtml = function (ent) {
  if (!ent || !ent.id || ent.type === 'commune') return '';
  var key = favKey(ent);
  var on = !!FAV.bl[key];
  return ' <span class="fav-blk' + (on ? ' blk-on' : '') + '" data-blkkey="' + esc(key) +
    '" data-blk="' + esc(JSON.stringify(ent)) +
    '" title="Blacklister : ne plus voir cette entité (listes + carte) — l\u2019inverse des favoris" onclick="FAV.toggleBlk(this,event)">' +
    (on ? '🚫' : '⊘') + '</span>';
};
FAV.toggleBlk = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  try {
    var ent = JSON.parse(el.getAttribute('data-blk') || '{}');
    var key = el.getAttribute('data-blkkey');
    if (FAV.bl[key]) FAV.blRemove(key); else FAV.blAdd(ent);
  } catch (e) { /* clic invalide : ignoré */ }
};

// ---------- Ajout / retrait ----------
FAV.add = function (ent) {
  if (!ent || !ent.id) return;
  var key = favKey(ent);
  if (FAV.bl[key]) FAV.blRemove(key); // exclusivité : on ne suit pas ce qu'on ignore
  var isNew = !FAV.all[key];
  var rec = isNew ? { type: ent.type, id: ent.id } : FAV.all[key];
  var fields = ['nom', 'siren', 'siret', 'insee', 'ville', 'dep'];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (ent[f] && !rec[f]) rec[f] = ent[f];
  }
  if (ent.siteWeb && !rec.siteWeb) rec.siteWeb = ent.siteWeb;
  rec.key = key;
  FAV.all[key] = rec;
  if (isNew) FAV.order.push(key);
  favDbPut(key, rec);
  FAV.refresh();
};
FAV.remove = function (key) {
  delete FAV.all[key];
  var i = FAV.order.indexOf(key);
  if (i !== -1) FAV.order.splice(i, 1);
  favDbDelete(key);
  FAV.refresh();
};

// ---------- Blacklist 🚫 : ajout / retrait (l'inverse des favoris) ----------
FAV.blAdd = function (ent) {
  if (!ent || !ent.id || ent.type === 'commune') return;
  var key = favKey(ent);
  if (FAV.all[key]) FAV.remove(key); // exclusivité : on ne suit pas ce qu'on ignore
  var isNew = !FAV.bl[key];
  var rec = isNew ? { type: ent.type, id: ent.id } : FAV.bl[key];
  var fields = ['nom', 'siren', 'siret', 'insee', 'ville', 'dep'];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (ent[f] && !rec[f]) rec[f] = ent[f];
  }
  rec.key = key;
  FAV.bl[key] = rec;
  if (isNew) FAV.blOrder.push(key);
  blDbPut(key, rec);
  FAV.blApply(key); // masque les marqueurs immédiatement
  FAV.refresh();
};
FAV.blRemove = function (key) {
  delete FAV.bl[key];
  var i = FAV.blOrder.indexOf(key);
  if (i !== -1) FAV.blOrder.splice(i, 1);
  blDbDelete(key);
  FAV.blApply(key); // ré-affiche les marqueurs
  FAV.refresh();
};
// Applique l'état blacklisté d'une clé aux marqueurs des 3 modes (best-effort) :
// annuaire (ANN.markerIndex 'a:<id>' / 'e:<siren>'), composeur
// (CO.markerBySiret — SIREN relu dans le popup de chaque marqueur) et étendue
// (EXT.markerBySiren). Le marqueur est détaché de sa couche SANS être retiré
// de l'index : la synchro par différence d'annuaire ne le recrée pas, et le
// ré-affichage au retrait de la blacklist est immédiat.
FAV.blApply = function (key) {
  try {
    var on = !!FAV.bl[key];
    var sep = key.indexOf(':');
    var type = key.slice(0, sep);
    var id = key.slice(sep + 1);
    if (typeof ANN !== 'undefined' && ANN.markerIndex && ANN.markers) {
      var mk = (type === 'asso' ? 'a:' : 'e:') + id;
      var m = ANN.markerIndex[mk];
      if (m) { if (on) ANN.markers.removeLayer(m); else ANN.markers.addLayer(m); }
    }
    if (type === 'ent' && typeof EXT !== 'undefined' && EXT.markerBySiren && EXT.markers) {
      var mx = EXT.markerBySiren[id];
      if (mx) { if (on) EXT.markers.removeLayer(mx); else EXT.markers.addLayer(mx); }
    }
    if (type === 'ent' && typeof CO !== 'undefined' && CO.markerBySiret && CO.markers) {
      var needle = "coOpenFiche('" + id + "')";
      for (var st in CO.markerBySiret) {
        var mm = CO.markerBySiret[st];
        var pp = mm.getPopup && mm.getPopup();
        if (pp && String(pp.getContent()).indexOf(needle) !== -1) {
          if (on) CO.markers.removeLayer(mm); else CO.markers.addLayer(mm);
        }
      }
    }
  } catch (e) { /* best-effort : la carte n'est pas critique */ }
};
FAV.blApplyAll = function () {
  for (var k in FAV.bl) FAV.blApply(k);
};

// ---------- Moteur client : Wikidata (P856 site officiel / P968 email) ----------
function favClaimValue(claims) {
  try {
    var c = claims && claims[0];
    var dv = c && c.mainsnak && c.mainsnak.datavalue;
    return (dv && typeof dv.value === 'string' && dv.value) || '';
  } catch (e) { return ''; }
}
FAV.wikidata = function (rec) {
  var name = String(rec.nom || '').trim();
  if (!name) return Promise.resolve(null);
  // retire les suffixes légaux (SAS, SARL…) : absents des libellés Wikidata
  name = name.replace(/[, ]+\s*(SASU|SAS|SARL|EURL|SELAS|SELARL|SCOP|SCI|SNC|GIE|SCA|SA)\s*$/i, '');
  name = name.replace(/\s+\d{9,14}\s*$/, ''); // SIREN collé au nom
  name = name.trim();
  if (!name) return Promise.resolve(null);
  var q = rec.type === 'commune' ? name : (name + ' ' + (rec.ville || '')).trim();
  var u = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*' +
    '&language=fr&uselang=fr&type=item&limit=5&search=' + encodeURIComponent(q);
  return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
    var ids = (((j || {}).search) || []).map(function (s) { return s.id; });
    if (!ids.length) return null;
    var u2 = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      '&props=labels|claims&languages=fr&ids=' + encodeURIComponent(ids.join('|'));
    return fetch(u2).then(function (r2) { return r2.json(); }).then(function (j2) {
      var ents = (j2 && j2.entities) || {};
      var token = normTxt(name).split(' ')[0] || '';
      for (var i = 0; i < ids.length; i++) {
        var e = ents[ids[i]];
        if (!e) continue;
        var lab = (e.labels && e.labels.fr && e.labels.fr.value) || '';
        // écarte les homonymies : le libellé doit contenir la racine du nom
        if (token && token.length >= 3 && normTxt(lab).indexOf(token) === -1) continue;
        var cl = e.claims || {};
        var site = favClaimValue(cl.P856);
        var mail = favClaimValue(cl.P968);
        if (mail && mail.indexOf('mailto:') === 0) mail = mail.slice(7);
        if (site || mail) return { site: site || '', email: mail || '' };
      }
      return null;
    });
  });
};

// ---------- Lookup (client + serveur) ----------
function favEntityForApi(rec) {
  return {
    type: rec.type || '',
    nom: rec.nom || '',
    siren: rec.siren || '',
    siret: rec.siret || '',
    insee: rec.insee || (rec.type === 'commune' ? rec.id : ''),
    ville: rec.ville || '',
    dep: rec.dep || '',
    siteWeb: rec.siteWeb || ''
  };
}
function favAbsorb(rec, j) {
  if (!j || j.ok === false) {
    rec.note = (j && j.error) || 'service email indisponible';
    return;
  }
  var best = j.best || null;
  var res = (j && j.results) || [];
  if (best) {
    if (best.website && !rec.siteWeb) { rec.siteWeb = best.website; rec.siteWSource = 'lookup'; }
    if (best.email && (Number(best.confidence) || 0) >= (Number(rec.emailConfidence) || 0)) {
      rec.email = best.email;
      rec.emailSource = best.source || 'lookup';
      rec.emailConfidence = Number(best.confidence) || 0;
      rec.emailDate = Date.now();
    }
    rec.note = null;
  } else {
    var notes = [];
    for (var i = 0; i < res.length; i++) {
      if (res[i] && res[i].note) notes.push(res[i].engine + ' : ' + res[i].note);
    }
    rec.note = notes.length ? notes.join(' · ').slice(0, 160) : 'aucun résultat';
  }
}
FAV.lookup = function (key) {
  var rec = FAV.all[key];
  if (!rec || FAV.looking[key]) return Promise.resolve();
  FAV.looking[key] = true;
  FAV.refresh(); // affiche « recherche en cours » dans le panneau
  var cfg = favEngineConfig();
  var chain = Promise.resolve();
  if (cfg.wikidata) {
    chain = chain.then(function () {
      return FAV.wikidata(rec).then(function (w) {
        if (!w) return;
        if (w.site && !rec.siteWeb) { rec.siteWeb = w.site; rec.siteWSource = 'wikidata'; }
        if (w.email && !rec.email) {
          rec.email = w.email; rec.emailSource = 'wikidata';
          rec.emailConfidence = 55; rec.emailDate = Date.now();
        }
      }).catch(function () { /* moteur best-effort */ });
    });
  }
  var engines = ['officiel', 'tavily', 'scrape', 'prospector'].filter(function (id) { return cfg[id]; });
  chain = chain.then(function () {
    return fetch('/ft/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'lookup', entity: favEntityForApi(rec), engines: engines })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { favAbsorb(rec, j); })
      .catch(function (err) { rec.note = 'Recherche impossible : ' + String((err && err.message) || err); });
  });
  return chain.then(function () {
    rec.lastLookup = Date.now();
    delete FAV.looking[key];
    favDbPut(key, rec);
    FAV.refresh();
  });
};
FAV.lookupAll = function () {
  var btn = document.getElementById('favAllBtn');
  if (!btn || FAV._allRunning) return Promise.resolve();
  var keys = FAV.order.filter(function (k) { return FAV.all[k] && !FAV.all[k].email; });
  if (!keys.length) {
    btn.textContent = '✅ tous les favoris ont un email';
    return Promise.resolve();
  }
  FAV._allRunning = true;
  btn.disabled = true;
  var i = 0;
  function step() {
    if (i >= keys.length) {
      FAV._allRunning = false;
      btn.disabled = false;
      btn.textContent = '🔎 Chercher tout (emails manquants)';
      return Promise.resolve();
    }
    btn.textContent = '🔎 ' + (i + 1) + '/' + keys.length + '…';
    return FAV.lookup(keys[i++]).then(function () { return step(); });
  }
  return step();
};

// ---------- Décoration du DOM produit par les modes existants ----------
function favAddStar(row, ent) {
  if (!row || row.querySelector('.fav-star')) return;
  var head = row.children[0];
  if (!head) head = row;
  head.insertAdjacentHTML('beforeend', FAV.starHtml(ent) + FAV.blHtml(ent));
  if (ent && FAV.bl[favKey(ent)]) row.classList.add('fav-blkrow');
}
function favDecorateAnn() {
  var box = document.getElementById('annResults');
  if (!box) return;
  var rows = box.querySelectorAll('.ann-row');
  var shown = ANN.showing.slice(0, 200); // même cap que renderAnnList
  for (var i = 0; i < rows.length && i < shown.length; i++) {
    var r = shown[i];
    favAddStar(rows[i], r.kind === 'ent' ? FAV.fromEnt(r.e) : FAV.fromAsso(r.a));
  }
}
function favDecorateRows(boxId, list, toEnt) {
  var box = document.getElementById(boxId);
  if (!box) return;
  var rows = box.querySelectorAll('.co-row');
  for (var i = 0; i < rows.length && i < list.length; i++) {
    favAddStar(rows[i], toEnt(list[i]));
  }
}
// Recherche étendue (LBB) : l'ordre affiché est trié (curées d'abord) et non
// exposé — on relit le SIREN dans le texte de chaque ligne, robuste au tri.
function favDecorateExt(lbb, curated) {
  var box = document.getElementById('extResults');
  if (!box) return;
  var bySiren = {};
  (((lbb || {}).companies) || []).forEach(function (c) { if (c && c.siren) bySiren[c.siren] = c; });
  var curBy = (curated && curated.bySiren) || {};
  var rows = box.querySelectorAll('.co-row');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.querySelector('.fav-star')) continue;
    var sub = row.querySelector('.ann-obj');
    var m = sub && sub.textContent && sub.textContent.match(/SIREN (\d{9})/);
    if (!m) continue;
    var c = bySiren[m[1]];
    if (!c) continue;
    favAddStar(row, FAV.fromExtItem(c, curBy[m[1]]));
  }
}
function favDecorateFT() {
  var data = EXT.lastFT;
  if (!data || !data.rows) return;
  favDecorateRows('extResults', data.rows.slice(0, EXT_MAX_LIST), function (r) { return FAV.fromFTRec(r.rec); });
}
function favDecorateFiche(siren) {
  var e = (typeof CO !== 'undefined' && CO.byId && CO.byId[siren]) || null;
  var title = document.getElementById('coFicheTitle');
  if (!e || !title || title.querySelector('.fav-star')) return;
  title.insertAdjacentHTML('beforeend', FAV.starHtml(FAV.fromEnt(e)) + FAV.blHtml(FAV.fromEnt(e)));
}

// ---------- Enveloppes des fonctions de rendu (aucune modification des .js existants) ----------
FAV.wrapAll = function () {
  var _renderAnnList = renderAnnList;
  window.renderAnnList = function () {
    _renderAnnList();
    try { favDecorateAnn(); } catch (e) { /* décoration best-effort */ }
  };
  var _assoPopup = assoPopup;
  window.assoPopup = function (a, th) { return _assoPopup(a, th) + FAV.starHtml(FAV.fromAsso(a)) + FAV.blHtml(FAV.fromAsso(a)); };
  var _entPopup = entPopup;
  window.entPopup = function (e) { return _entPopup(e) + FAV.starHtml(FAV.fromEnt(e)) + FAV.blHtml(FAV.fromEnt(e)); };

  var _coRenderResults = coRenderResults;
  window.coRenderResults = function () {
    _coRenderResults();
    try { favDecorateRows('coResults', CO.shown.slice(0, CO_MAX_LIST), FAV.fromEnt); } catch (e) {}
  };
  var _coPopupHtml = coPopupHtml;
  window.coPopupHtml = function (e, et) { return _coPopupHtml(e, et) + FAV.starHtml(FAV.fromEnt(e)) + FAV.blHtml(FAV.fromEnt(e)); };
  var _coOpenFiche = coOpenFiche;
  window.coOpenFiche = function (siren) {
    _coOpenFiche(siren);
    try { favDecorateFiche(siren); } catch (e) {}
  };

  var _extPopupHtml = extPopupHtml;
  window.extPopupHtml = function (c, cur) { return _extPopupHtml(c, cur) + FAV.starHtml(FAV.fromExtItem(c, cur)) + FAV.blHtml(FAV.fromExtItem(c, cur)); };
  var _extFTPopupHtml = extFTPopupHtml;
  window.extFTPopupHtml = function (row) { return _extFTPopupHtml(row) + FAV.starHtml(FAV.fromFTRec(row.rec)) + FAV.blHtml(FAV.fromFTRec(row.rec)); };
  var _extRenderResults = extRenderResults;
  window.extRenderResults = function (lbb, curated) {
    _extRenderResults(lbb, curated);
    try { favDecorateExt(lbb, curated); } catch (e) {}
    try { FAV.blApplyAll(); } catch (e) { /* best-effort */ }
  };
  var _extRenderFT = extRenderFT;
  window.extRenderFT = function () {
    _extRenderFT();
    try { favDecorateFT(); } catch (e) {}
    try { FAV.blApplyAll(); } catch (e) { /* best-effort */ }
  };
  // Blacklist 🚫 : masque aussi les marqueurs à chaque synchro carte des modes
  // existants (annuaire recrée les marqueurs manquants, composeur les recrée
  // tous — l'application doit donc suivre chaque rendu).
  var _annSyncMarkers = annSyncMarkers;
  window.annSyncMarkers = function (entries) {
    _annSyncMarkers(entries);
    try { FAV.blApplyAll(); } catch (e) { /* best-effort */ }
  };
  var _coSyncMarkers = coSyncMarkers;
  window.coSyncMarkers = function () {
    _coSyncMarkers();
    try { FAV.blApplyAll(); } catch (e) { /* best-effort */ }
  };
};

// ---------- Panneau des favoris ----------
FAV.toggle = function (show) {
  var dlg = document.getElementById('favDlg');
  if (!dlg) return;
  var visible = dlg.style.display !== 'none';
  var want = show === undefined ? !visible : !!show;
  dlg.style.display = want ? 'flex' : 'none';
  if (want) { favRenderEngines(); FAV.refresh(); }
};
FAV.removeRow = function (key) { FAV.remove(key); };

function favTypeLabel(t) {
  return t === 'commune' ? 'Ville' : (t === 'ent' ? 'Entreprise' : 'Association');
}
function favHost(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u); }
}
function favStatusHtml(rec) {
  if (FAV.looking[rec.key]) return '<div class="fav-status">🔎 Recherche en cours…</div>';
  var h = '';
  if (rec.email) {
    h += '📧 <a href="mailto:' + esc(rec.email) + '">' + esc(rec.email) + '</a>' +
      ' <span class="muted">' + esc(rec.emailSource || '') +
      (rec.emailConfidence ? ' · ' + esc(String(rec.emailConfidence)) + '%' : '') + '</span>';
  }
  if (rec.siteWeb) {
    h += (h ? ' · ' : '') + '🔗 <a href="' + esc(rec.siteWeb) + '" target="_blank" rel="noopener">' +
      esc(favHost(rec.siteWeb)) + '</a>';
  }
  if (!h) {
    h = rec.note ? '⚠️ <span class="muted">' + esc(String(rec.note).slice(0, 110)) + '</span>'
      : '<span class="muted">jamais recherché — bouton 🔎</span>';
  } else if (rec.note) {
    h += ' <span class="muted">(' + esc(String(rec.note).slice(0, 60)) + ')</span>';
  }
  if (rec.lastLookup && !rec.email) {
    h += ' <span class="muted">· recherché le ' + new Date(rec.lastLookup).toLocaleDateString('fr-FR') + '</span>';
  }
  return '<div class="fav-status">' + h + '</div>';
}
function favRow(rec, key) {
  var row = document.createElement('div');
  row.className = 'cache-row';
  var info = document.createElement('div');
  info.className = 'cache-info';
  var head = document.createElement('div');
  head.innerHTML = '<b>' + esc(rec.nom || key) + '</b> <span class="co-badge">' +
    esc(favTypeLabel(rec.type)) + '</span>';
  info.appendChild(head);
  var sub = [];
  if (rec.ville) sub.push(rec.ville);
  if (rec.siren) sub.push('SIREN ' + rec.siren);
  if (rec.insee && rec.type !== 'commune') sub.push('INSEE ' + rec.insee);
  if (sub.length) {
    var s = document.createElement('div');
    s.className = 'fav-sub';
    s.textContent = sub.join(' · ');
    info.appendChild(s);
  }
  info.insertAdjacentHTML('beforeend', favStatusHtml(rec));
  var actions = document.createElement('div');
  actions.className = 'cache-actions';
  var btnL = document.createElement('button');
  btnL.className = 'cache-btn';
  btnL.type = 'button';
  btnL.title = 'Chercher email + site web (moteurs cochés)';
  btnL.textContent = '🔎';
  btnL.addEventListener('click', function () { FAV.lookup(key); });
  actions.appendChild(btnL);
  if (rec.siteWeb) {
    var a = document.createElement('a');
    a.className = 'cache-btn';
    a.href = rec.siteWeb;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = 'Ouvrir le site web';
    a.textContent = '🌐';
    actions.appendChild(a);
  }
  var btnD = document.createElement('button');
  btnD.className = 'cache-btn cache-purge';
  btnD.type = 'button';
  btnD.title = 'Retirer des favoris';
  btnD.textContent = '🗑';
  btnD.addEventListener('click', function () { FAV.remove(key); });
  actions.appendChild(btnD);
  row.appendChild(info);
  row.appendChild(actions);
  return row;
}
// Ligne « blacklistée » du panneau : bouton ↩ pour ré-afficher l'entité
function favBlkRow(rec, key) {
  var row = document.createElement('div');
  row.className = 'cache-row';
  row.style.opacity = '.6';
  var info = document.createElement('div');
  info.className = 'cache-info';
  var head = document.createElement('div');
  head.innerHTML = '<b>' + esc(rec.nom || key) + '</b> <span class="co-badge">' +
    esc(favTypeLabel(rec.type)) + '</span> <span class="muted">masquée des listes et de la carte</span>';
  info.appendChild(head);
  var sub = [];
  if (rec.ville) sub.push(rec.ville);
  if (rec.siren) sub.push('SIREN ' + rec.siren);
  if (sub.length) {
    var s = document.createElement('div');
    s.className = 'fav-sub';
    s.textContent = sub.join(' · ');
    info.appendChild(s);
  }
  var actions = document.createElement('div');
  actions.className = 'cache-actions';
  var btnR = document.createElement('button');
  btnR.className = 'cache-btn';
  btnR.type = 'button';
  btnR.title = 'Retirer de la blacklist (ré-afficher l\u2019entité)';
  btnR.textContent = '↩';
  btnR.addEventListener('click', function () { FAV.blRemove(key); });
  actions.appendChild(btnR);
  row.appendChild(info);
  row.appendChild(actions);
  return row;
}
function favRenderPanel() {
  var box = document.getElementById('favList');
  if (!box) return;
  var groups = { commune: [], ent: [], asso: [] };
  FAV.order.forEach(function (k) {
    var rec = FAV.all[k];
    if (rec && groups[rec.type]) groups[rec.type].push(k);
  });
  box.innerHTML = '';
  ['commune', 'ent', 'asso'].forEach(function (t) {
    if (!groups[t].length) return;
    var h3 = document.createElement('div');
    h3.className = 'cache-h3';
    h3.textContent = favTypeLabel(t) + 's (' + groups[t].length + ')';
    box.appendChild(h3);
    groups[t].forEach(function (k) { box.appendChild(favRow(FAV.all[k], k)); });
  });
  if (FAV.blOrder.length) {
    var hb = document.createElement('div');
    hb.className = 'cache-h3';
    hb.textContent = 'Blacklistées 🚫 (' + FAV.blOrder.length + ')';
    box.appendChild(hb);
    FAV.blOrder.forEach(function (k) { if (FAV.bl[k]) box.appendChild(favBlkRow(FAV.bl[k], k)); });
  }
  if (!FAV.order.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = "Aucun favori — cliquez sur ☆ dans les listes, popups, fiches ou sur l'étoile de ville.";
    box.appendChild(p);
  }
}
function favRenderEngines() {
  var box = document.getElementById('favEngines');
  if (!box) return;
  var cfg = favEngineConfig();
  var hints = {
    officiel: 'mairies uniquement (source officielle DILA)',
    tavily: "nécessite TAVILY_API_KEY (variable d'environnement Netlify)",
    prospector: 'quota gratuit : 50 vérifications/jour — décoché par défaut'
  };
  box.innerHTML = '';
  FAV_ENGINES.forEach(function (eng) {
    var lab = document.createElement('label');
    lab.title = (hints[eng.id] || '') + ' — types : ' + eng.types.join(', ');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!cfg[eng.id];
    cb.addEventListener('change', function () {
      cfg[eng.id] = cb.checked;
      favEngineSave(cfg);
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(eng.label));
    box.appendChild(lab);
  });
}

// ---------- Raffraîchissement (étoiles déjà affichées + panneau) ----------
FAV.refresh = function () {
  var btn = document.getElementById('favBtn');
  var n = FAV.order.length;
  if (btn) btn.textContent = '⭐ Favoris' + (n ? ' (' + n + ')' : '');
  favSyncStars();
  favSyncBlk();
  favSyncCityStars();
  var dlg = document.getElementById('favDlg');
  if (dlg && dlg.style.display !== 'none') favRenderPanel();
};
function favSyncStars() {
  var stars = document.querySelectorAll('.fav-star[data-favkey]');
  for (var i = 0; i < stars.length; i++) {
    var el = stars[i];
    var on = !!FAV.all[el.getAttribute('data-favkey')];
    el.className = 'fav-star' + (on ? ' fav-on' : '');
    el.textContent = on ? '⭐' : '☆';
  }
}
// Boutons 🚫 déjà affichés + lignes concernées + option « afficher grisées »
function favSyncBlk() {
  var bls = document.querySelectorAll('.fav-blk[data-blkkey]');
  for (var i = 0; i < bls.length; i++) {
    var el = bls[i];
    var on = !!FAV.bl[el.getAttribute('data-blkkey')];
    el.className = 'fav-blk' + (on ? ' blk-on' : '');
    el.textContent = on ? '🚫' : '⊘';
    var row = el.closest ? el.closest('.ann-row, .co-row') : null;
    if (row) { if (on) row.classList.add('fav-blkrow'); else row.classList.remove('fav-blkrow'); }
  }
  try {
    document.body.classList[FAV.blHide ? 'remove' : 'add']('fav-blshow');
  } catch (e) { /* best-effort */ }
}

// ---------- Étoile de ville cible (composeur + recherche étendue) ----------
function favSyncCityStars() {
  favCityStar('coTargetWrap', 'coCityStar', function () {
    return (typeof CO !== 'undefined' && CO.target) || null;
  });
  favCityStar('extTargetWrap', 'extCityStar', function () {
    return (typeof EXT !== 'undefined' && EXT.target) || null;
  });
}
function favCityStar(wrapId, starId, getTarget) {
  var wrap = document.getElementById(wrapId);
  if (!wrap) return;
  var star = document.getElementById(starId);
  if (!star) {
    star = document.createElement('button');
    star.id = starId;
    star.type = 'button';
    star.className = 'fav-city';
    star.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
      var t = getTarget();
      if (!t) return;
      var ent = FAV.fromCommune(t);
      var key = favKey(ent);
      if (FAV.all[key]) FAV.remove(key); else FAV.add(ent);
    });
    wrap.appendChild(star);
  }
  var t = getTarget();
  if (!t) { star.style.display = 'none'; star.textContent = ''; return; }
  var key = 'commune:' + t.code;
  var on = !!FAV.all[key];
  star.style.display = '';
  star.textContent = on ? '⭐' : '☆';
  star.title = on ? 'Retirer ' + t.nom + ' des favoris' : 'Ajouter ' + t.nom + ' aux favoris';
}

// ---------- Ajout de ville via la BAN (champ du panneau) ----------
function favWireCityField() {
  var inp = document.getElementById('favCity');
  var drop = document.getElementById('favCityDrop');
  if (!inp || !drop) return;
  var token = 0;
  inp.addEventListener('input', function () {
    var q = inp.value.trim();
    clearTimeout(FAV._cityTimer);
    drop.style.display = 'none';
    drop.innerHTML = '';
    if (q.length < 2) return;
    var my = ++token;
    FAV._cityTimer = setTimeout(function () {
      fetch('/api/adr/search/?q=' + encodeURIComponent(q) + '&type=municipality&limit=5')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (my !== token) return;
          drop.innerHTML = '';
          (((j || {}).features) || []).forEach(function (f) {
            var p = (f && f.properties) || {};
            if (!p.citycode) return;
            var d = document.createElement('div');
            d.innerHTML = esc(p.name || p.label || '') + ' <span class="muted">(' +
              esc(p.citycode) + ')</span>';
            d.addEventListener('mousedown', function (ev) {
              ev.preventDefault();
              FAV.add(FAV.fromCommune({ code: p.citycode, nom: p.name || p.label || '' }));
              inp.value = '';
              drop.style.display = 'none';
            });
            drop.appendChild(d);
          });
          drop.style.display = drop.childNodes.length ? 'block' : 'none';
        })
        .catch(function () { /* BAN indisponible : champ silencieux */ });
    }, 250);
  });
  inp.addEventListener('blur', function () {
    setTimeout(function () { drop.style.display = 'none'; }, 150);
  });
}

// ---------- Câblage UI + init ----------
FAV.wireUI = function () {
  var btn = document.getElementById('favBtn');
  if (btn) btn.addEventListener('click', function () { FAV.toggle(); });
  var close = document.getElementById('favClose');
  if (close) close.addEventListener('click', function () { FAV.toggle(false); });
  var all = document.getElementById('favAllBtn');
  if (all) all.addEventListener('click', function () { FAV.lookupAll(); });
  favWireCityField();
  favWireBlkToggle();
};

// Case « masquer les blacklistées » (persistée en localStorage)
function favWireBlkToggle() {
  var cb = document.getElementById('favBlkHide');
  if (!cb) return;
  try { FAV.blHide = localStorage.getItem(FAV.blHideKey) !== '0'; } catch (e) { /* défaut : masquer */ }
  cb.checked = FAV.blHide;
  cb.addEventListener('change', function () {
    FAV.blHide = cb.checked;
    try { localStorage.setItem(FAV.blHideKey, FAV.blHide ? '1' : '0'); } catch (e) { /* best-effort */ }
    FAV.refresh();
  });
}

document.addEventListener('DOMContentLoaded', function () {
  if (FAV._inited) return;
  FAV._inited = true;
  favDbLoadAll().catch(function () { /* IndexedDB bloqué : favoris de session seulement */ })
    .then(function (pairs) {
      (pairs || []).forEach(function (p) {
        if (p && p.key && p.rec) {
          p.rec.key = p.key;
          FAV.all[p.key] = p.rec;
          FAV.order.push(p.key);
        }
      });
      return blDbLoadAll().catch(function () { return []; });
    })
    .then(function (blPairs) {
      (blPairs || []).forEach(function (p) {
        if (p && p.key && p.rec) {
          p.rec.key = p.key;
          FAV.bl[p.key] = p.rec;
          FAV.blOrder.push(p.key);
        }
      });
    })
    .catch(function () { /* IndexedDB bloqué : session seulement */ })
    .then(function () {
      try { FAV.wrapAll(); }
      catch (e) { console.warn('[OpenFrance] Favoris : enveloppement impossible :', e); }
      FAV.wireUI();
      FAV.blApplyAll(); // masque les marqueurs blacklistés déjà affichés
      FAV.refresh();
    });
});
