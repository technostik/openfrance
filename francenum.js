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
//
// ✨ Enrich France Num : bloc contact dédié dans chaque fiche/popup
// activateur — description, site web, email, page contact ; escalier
// DÉTERMINISTE Wikidata → describe → lookup (fiche France Num en dernier
// recours côté serveur) ; les résultats faux se rejettent (⚠️ : blacklist
// par domaine, escalier rejoué) et tout se corrige à la main (✏️ prioritaire,
// jamais écrasé) ; cache IndexedDB dédié, cf. section Enrich.

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
  lastExt: null,     // dernier annuaire France Num affiché (mode étendu)
  enrMap: null,      // cache enrich : id -> {site, email, desc, source, date}
  enrRunning: {}     // id -> true (Enrich France Num en cours)
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

// ---------- Enrich France Num : contacts (site web, email, page contact) ----------
// Bloc contact de chaque fiche/popup + escalier de recherche DÉTERMINISTE
// (volontairement pas d'agent : une liste fixe de marches, rejouable) :
//   1. Wikidata (FAV.wikidata, désambiguïsé par le nom + la ville) ;
//   2. POST /ft/email op=describe (DDG + meta : description + site officiel) ;
//   3. POST /ft/email op=lookup seedé par le site trouvé (engines tavily puis
//      scrape : email + page contact, puis francenum : la fiche France Num de
//      la structure, DERNIER recours côté serveur).
// Validation déterministe (fnEnrOkSite/fnEnrOkEmail : domaine pas blacklisté,
// pas un site du ministère, email plausible) + rejet humain ⚠️ Faux (blacklist
// par domaine, purge des valeurs auto, escalier rejoué) + saisie manuelle ✏️
// (prioritaire, jamais écrasée). ⚠️ L'URL France Num du dataset n'est jamais
// seedée comme siteWeb : c'est la fiche du ministère, pas le site de la
// structure (sinon on y trouverait des emails @francenum.gouv.fr).
// Cache : même base IndexedDB, clé « enr », map id→{site, email, page, desc,
// source, date, bad, manual}, TTL 30 j par enregistrement.
var FN_ENR_TTL = 30 * 24 * 3600 * 1000; // 30 jours
function fnEnrLoad() {
  if (FN.enrMap) return Promise.resolve(FN.enrMap);
  return fnIdbGet('enr').then(function (c) {
    FN.enrMap = (c && c.v === FN_VERSION && c.map) ? c.map : {};
    var now = Date.now(), dirty = false;
    for (var k in FN.enrMap) {
      if (now - (FN.enrMap[k].date || 0) > FN_ENR_TTL) { delete FN.enrMap[k]; dirty = true; }
    }
    if (dirty) fnEnrSave();
    return FN.enrMap;
  }).catch(function () { FN.enrMap = FN.enrMap || {}; return FN.enrMap; });
}
function fnEnrSave() {
  if (!FN.enrMap) return;
  fnIdbSet('enr', { v: FN_VERSION, date: Date.now(), map: FN.enrMap });
}
// Données portées par les boutons du bloc (le row entier ne tient pas en attribut).
function fnEnrD(row) {
  return { id: row.id, nom: row.nom, ville: row.ville, dep: row.dep, fiche: row.url || '' };
}
// Domaine normalisé d'une URL (pour la blacklist rec.bad).
function fnEnrHost(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function fnEnrBad(rec, host) {
  if (!host) return false;
  var bad = rec.bad || [];
  for (var i = 0; i < bad.length; i++) {
    if (host === bad[i] ||
        host.slice(-(bad[i].length + 1)) === '.' + bad[i] ||
        bad[i].slice(-(host.length + 1)) === '.' + host) return true;
  }
  return false;
}
// Validation déterministe (pas d'agent) : domaine pas blacklisté, pas un site
// du ministère ; email plausible et jamais @francenum.gouv.fr.
function fnEnrOkSite(rec, u) {
  var h = fnEnrHost(u);
  return !!(h &&
    !/(^|\.)francenum\.gouv\.fr$|(^|\.)data\.gouv\.fr$|(^|\.)economie\.gouv\.fr$/.test(h) &&
    !fnEnrBad(rec, h));
}
function fnEnrOkEmail(rec, e) {
  return !!(e && /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(e) &&
    !/@francenum\.gouv\.fr$/i.test(e) && !fnEnrBad(rec, e.split('@')[1]));
}
// Tooltip de survol dédié (lignes + marqueurs) : identité + contacts en cache.
function fnTip(row) {
  var h = '<b>' + esc(row.nom) + '</b>';
  if (row.type) h += '<br>🧭 ' + esc(row.type);
  if (row.taille) h += ' · 👥 ' + esc(row.taille);
  h += '<br>📍 ' + esc(row.ville || '') + (row.cp ? ' (' + esc(row.cp) + ')' : '');
  var e = FN.enrMap && FN.enrMap[row.id];
  if (e) {
    if (e.desc) h += '<br>💬 ' + esc(String(e.desc).slice(0, 180));
    if (e.site) h += '<br>🌐 ' + esc(e.site);
    if (e.email) h += '<br>✉️ ' + esc(e.email);
    else if (e.page) h += '<br>📋 ' + esc(e.page);
  }
  return h;
}
// Bloc contact : ce qu'on sait déjà (cache) + boutons ✨ / ⚠️ Faux / ✏️ Corriger.
function fnEnrBlock(d) {
  if (!d || !d.id) return '';
  var e = (FN.enrMap && FN.enrMap[d.id]) || null;
  var h = '';
  if (e && e.desc) h += '<div class="enr-desc">💬 ' + esc(e.desc) +
    (e.source ? ' <span class="muted">(' + esc(e.source) + ')</span>' : '') + '</div>';
  if (e && e.site) h += '<div>🌐 <a href="' + esc(e.site) + '" target="_blank" rel="noopener">' +
    esc(fnEnrHost(e.site) || e.site) + '</a></div>';
  if (e && e.email) h += '<div>✉️ <a href="mailto:' + esc(e.email) + '">' + esc(e.email) + '</a></div>';
  if (e && e.page && !e.email) h += '<div>📋 <a href="' + esc(e.page) + '" target="_blank" rel="noopener">Page contact</a></div>';
  if (e && e.manual) h += '<div class="muted">✏️ saisie manuelle</div>';
  var attr = ' data-fnenr="' + esc(JSON.stringify(d)) + '"';
  var lab = FN.enrRunning[d.id] ? '⏳ Recherche en cours…'
    : (e && (e.site || e.email || e.desc || e.page) ? '⟳ Re-vérifier' : '✨ Enrich (site web + email)');
  h += '<span class="enr-btn"' + attr + ' onclick="FN.enrichGo(this,event)">' + lab + '</span>';
  if (e && !e.manual && (e.site || e.email)) {
    h += ' <span class="enr-btn" title="Ce résultat est faux : le rejeter et chercher autre chose"' +
      attr + ' onclick="FN.falseGo(this,event)">⚠️ Faux</span>';
  }
  h += ' <span class="enr-btn"' + attr + ' onclick="FN.editGo(this,event)">✏️ Corriger</span>';
  return '<div class="enr-block">' + h + '</div>';
}
// Re-rendu d'un bloc en place (popup ouverte ou ligne de liste).
function fnEnrRender(node, d) {
  var block = null;
  if (node && node.classList && node.classList.contains && node.classList.contains('enr-block')) block = node;
  else if (node && node.closest) { try { block = node.closest('.enr-block'); } catch (e) { block = null; } }
  if (!block || !block.parentNode) return;
  var wrap = document.createElement('div');
  wrap.innerHTML = fnEnrBlock(d);
  if (wrap.firstChild) block.parentNode.replaceChild(wrap.firstChild, block);
}
// Clic ✨ : escalier complet (Wikidata → describe → lookup), puis re-rendu.
FN.enrichGo = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  var d;
  try { d = JSON.parse(el.getAttribute('data-fnenr') || 'null'); } catch (e) { return; }
  if (!d || !d.id || FN.enrRunning[d.id]) return;
  FN.enrRunning[d.id] = true;
  el.textContent = '⏳ Recherche en cours…';
  return fnEnrLoad().then(function () {
    return FN.enrich(d);
  }).catch(function () { /* best-effort */ }).then(function () {
    delete FN.enrRunning[d.id];
    fnEnrRender(el, d);
  });
};
// Clic ⚠️ Faux : blacklist des domaines courants (rec.bad), purge des valeurs
// automatiques (jamais la saisie manuelle), escalier rejoué avec la blacklist.
FN.falseGo = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  var d;
  try { d = JSON.parse(el.getAttribute('data-fnenr') || 'null'); } catch (e) { return; }
  if (!d || !d.id || FN.enrRunning[d.id]) return;
  FN.enrRunning[d.id] = true;
  el.textContent = '⏳…';
  return fnEnrLoad().then(function () {
    var rec = FN.enrMap[d.id] = FN.enrMap[d.id] || {};
    var hosts = [];
    if (rec.site) hosts.push(fnEnrHost(rec.site));
    if (rec.email) hosts.push(rec.email.split('@')[1]);
    rec.bad = rec.bad || [];
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i] && !fnEnrBad(rec, hosts[i])) rec.bad.push(hosts[i]);
    }
    if (!rec.manual) { // la saisie manuelle n'est JAMAIS purgée
      delete rec.site; delete rec.email; delete rec.page;
      delete rec.desc; delete rec.source;
    }
    rec.date = Date.now();
    fnEnrSave();
    return FN.enrich(d); // escalier rejoué avec la blacklist à jour
  }).catch(function () { /* best-effort */ }).then(function () {
    delete FN.enrRunning[d.id];
    fnEnrRender(el, d);
  });
};
// Clic ✏️ Corriger : formulaire local (site / email / page contact) — la
// saisie est prioritaire sur toute recherche et n'est jamais écrasée.
FN.editGo = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  var d;
  try { d = JSON.parse(el.getAttribute('data-fnenr') || 'null'); } catch (e) { return; }
  if (!d || !d.id) return;
  var block = null;
  try { block = el.closest('.enr-block'); } catch (e) { block = null; }
  if (!block) return;
  fnEnrLoad().then(function () {
    var rec = FN.enrMap[d.id] = FN.enrMap[d.id] || {};
    var form = document.createElement('form');
    form.className = 'fn-edit';
    form.addEventListener('submit', function (e2) {
      e2.preventDefault();
      var site = form._site.value.trim(), mail = form._mail.value.trim(), page = form._page.value.trim();
      if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
      if (page && !/^https?:\/\//i.test(page)) page = 'https://' + page;
      if (mail && !/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(mail)) {
        form._mail.style.outline = '2px solid #dc2626';
        return;
      }
      rec.manual = true;
      if (site) rec.site = site; else delete rec.site;
      if (mail) rec.email = mail; else delete rec.email;
      if (page) rec.page = page; else delete rec.page;
      rec.date = Date.now();
      fnEnrSave();
      fnEnrRender(block, d);
    });
    function mk(label, val, ph) {
      var wrap = document.createElement('label');
      wrap.className = 'fn-edit-l';
      var sp = document.createElement('span');
      sp.textContent = label;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = val || '';
      inp.placeholder = ph || '';
      wrap.appendChild(sp);
      wrap.appendChild(inp);
      form.appendChild(wrap);
      return inp;
    }
    form._site = mk('🌐 Site web', rec.site, 'https://…');
    form._mail = mk('✉️ Email', rec.email, 'contact@…');
    form._page = mk('📋 Page contact', rec.page, 'https://…/contact');
    var rowB = document.createElement('div');
    rowB.className = 'fn-edit-btns';
    var ok = document.createElement('button');
    ok.type = 'submit'; ok.className = 'enr-btn'; ok.textContent = '💾 Enregistrer';
    var no = document.createElement('button');
    no.type = 'button'; no.className = 'enr-btn'; no.textContent = '✖ Annuler';
    no.addEventListener('click', function () { fnEnrRender(block, d); });
    rowB.appendChild(ok);
    rowB.appendChild(no);
    form.appendChild(rowB);
    block.innerHTML = '';
    block.appendChild(form);
  });
};
// Escalier déterministe : une promesse par marche, fusion « ne remplit que le
// vide » — la saisie manuelle (rec.manual) reste reine, jamais écrasée.
FN.enrich = function (d) {
  return fnEnrLoad().then(function () {
    var rec = FN.enrMap[d.id] = FN.enrMap[d.id] || {};
    var site = rec.site || '', email = rec.email || '', page = rec.page || '',
      desc = rec.desc || '', source = rec.source || '';
    var manual = !!rec.manual;
    var ent = { type: 'ent', nom: d.nom || '', siren: '', ville: d.ville || '', dep: d.dep || '', fnFiche: d.fiche || '' };
    function post(op, engines) {
      var body = {
        op: op,
        entity: { type: 'ent', nom: ent.nom, siren: '', ville: ent.ville, dep: ent.dep, siteWeb: site, fnFiche: ent.fnFiche }
      };
      if (engines) body.engines = engines;
      return fetch('/ft/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    // Marche 1 — Wikidata (désambiguïsé par le nom + la ville)
    var p1 = ((!site || !email) && typeof FAV !== 'undefined' && typeof FAV.wikidata === 'function')
      ? FAV.wikidata({ type: 'ent', nom: ent.nom, ville: ent.ville }).then(function (w) {
          if (!w) return;
          if (!site && w.site && fnEnrOkSite(rec, w.site)) site = w.site;
          if (!email && w.email && fnEnrOkEmail(rec, w.email)) email = w.email;
        }).catch(function () { /* moteur best-effort */ })
      : Promise.resolve();
    return p1
      // Marche 2 — describe : description + découverte du site officiel. Si le
      // site découvert est rejeté (blacklist), sa description l'est aussi.
      .then(function () {
        return post('describe').then(function (j) {
          var b = (j && j.ok && j.best) || null;
          if (!b) return;
          var wok = b.website && fnEnrOkSite(rec, b.website);
          if (!site && wok) site = b.website;
          if (!manual && b.description && (wok || !b.website)) {
            desc = b.description;
            source = b.source || 'web';
          }
        }).catch(function () { /* service indisponible : la chaîne continue */ });
      })
      // Marche 3 — lookup : email, site, page contact ; la fiche France Num
      // reste le DERNIER recours du serveur (moteur « francenum »).
      .then(function () {
        return post('lookup', ['tavily', 'scrape', 'francenum']).then(function (j) {
          var b = (j && j.ok && j.best) || null;
          if (!b) return;
          if (!site && b.website && fnEnrOkSite(rec, b.website)) site = b.website;
          if (!email && b.email && fnEnrOkEmail(rec, b.email)) email = b.email;
          if (!page && b.contact && fnEnrOkSite(rec, b.contact)) page = b.contact;
        }).catch(function () { /* best-effort */ });
      })
      .then(function () {
        var changed = false;
        if (site && site !== rec.site) { rec.site = site; changed = true; }
        if (email && !rec.email) { rec.email = email; changed = true; }
        if (page && !rec.page) { rec.page = page; changed = true; }
        if (!manual && desc && desc !== rec.desc) { rec.desc = desc; rec.source = source; changed = true; }
        if (changed) { rec.date = Date.now(); fnEnrSave(); }
      });
  });
};
// Styles minimaux du formulaire ✏️ (auto-injectés : le module reste autonome).
if (typeof document !== 'undefined' && document.head) {
  try {
    var st = document.createElement('style');
    st.textContent = '.fn-edit-l{display:block;margin:2px 0}.fn-edit-l span{display:inline-block;width:86px;font-size:11px}.fn-edit-l input{width:150px;max-width:100%;font-size:12px;padding:1px 4px}.fn-edit-btns{margin-top:4px}';
    document.head.appendChild(st);
  } catch (e) { /* sans DOM : rien */ }
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
  fnEnrLoad(); // cache enrich (site/email) — best-effort, sans attendre
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
  html += fnEnrBlock(fnEnrD(row)); // bloc enrich (site web + email, cf. FN.enrich)
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
      enrWireRow(el, fnTip, row);
    }
  } catch (e) { /* sans enrich : pas de tooltip */ }
  return el;
}
// Tooltip de survol des marqueurs (best-effort, cf. fnRowEl).
function fnWireTip(m, row) {
  try {
    if (typeof ENR !== 'undefined' && ENR.wireMarker) ENR.wireMarker(m, fnTip, row);
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
    // popup dynamique : ré-évaluée à chaque ouverture (le bloc enrich se
    // rafraîchit après un clic ✨ sans re-render de la carte)
    m.bindPopup(function () { return fnPopup(row); });
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
