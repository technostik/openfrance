// OpenFrance — enrich.js : libellés NAF + tooltip de survol + bouton ✨ Enrich
// (description d'activité) — branche de test get_email.
//
// Complète favoris.js SANS le modifier et SANS toucher à annuaire.js / corp.js /
// corp_ext.js : comme favoris.js, on enveloppe les fonctions de rendu au
// DOMContentLoaded. Ordre : favoris.js s'enveloppe d'abord (étoile ⭐), enrich.js
// enveloppe ensuite (donc la description s'insère sous le titre, l'étoile reste
// en fin de popup).
//
// naf.js (chargé avant) : NAF_LABELS — nomenclature NAF rév. 2 de l'INSEE
// (732 sous-classes, Licence Ouverte 2.0), embarquée en statique : code APE
// (« 62.01Z » ou « 6201Z ») -> activité en clair, zéro appel réseau.
//
// ✨ Enrich (op describe de email.js) : Wikidata côté client (description en une
// phrase via wbsearchentities) puis POST /ft/email {op:'describe'} — DuckDuckGo
// (snippets + découverte du site, gratuit, sans clé, dégradation propre) puis
// meta du site (og:description / JSON-LD). Les annuaires/agrégateurs d'entreprises
// (annuaire-entreprises, societe.com, pappers…) ne sont jamais retenus : leurs
// textes sont génériques et inutiles (voir ENR_JUNK_SRC + email.js côté serveur).
//
// Persistance (db) : le cache enrich vit dans IndexedDB « openfrance-enrich »
// (store « enr », clé type:id, cap 300 FIFO) — même philosophie que les favoris.
// localStorage « openfrance-enrich » reste utilisé pour un démarrage instantané
// (lecture synchrone) ; la base fait foi, migration automatique de l'existant.
// Si l'entité est un favori : le site web découvert complète le favori et la
// description est aussi copiée dans son enregistrement (FAV.all + favDbPut de
// favoris.js, sans le modifier).
//
// Tooltips de survol (#enrTip, évalués AU MOMENT du survol — pas au rendu) :
//   - lignes des listes de résultats (annuaire, composeur, LBB, French Tech)
//   - marqueurs de la carte (dots) : annuaire (ent/asso), composeur, LBB, FT
// La description en cache s'affiche dès qu'elle existe (session courante ou
// précédente). Le clic garde les popups natifs Leaflet (déjà enrichis).

var ENR = {
  cache: {},     // clé type:id -> { desc, source, conf, site, date }
  running: {},   // clé -> true (Enrich en cours)
  tip: null,     // div #enrTip (tooltip de survol)
  db: null,      // IndexedDB openfrance-enrich (store enr) — null si indisponible
  _inited: false
};
var ENR_KEY = 'openfrance-enrich';
var ENR_MAX = 300; // entrées max en cache (les plus anciennes éliminées, base incluse)
// Sources inutiles (annuaires/agrégateurs d'entreprises : descriptions génériques)
// — jamais affichées ni conservées. Les anciennes entrées de ce genre sont épurées
// au chargement (localStorage + IndexedDB) et re-demandées au prochain ✨ Enrich.
var ENR_JUNK_SRC = /(annuaire-entreprises|data\.gouv|bodacc|societe\.com|societes\.com|pappers|societe\.ninja|infogreffe|verif\.com|manageo|netpme|lannuaire)/i;

function enrLoad() {
  try {
    var saved = JSON.parse(localStorage.getItem(ENR_KEY) || '{}');
    for (var k in saved) if (saved[k] && saved[k].desc && !ENR_JUNK_SRC.test(saved[k].source || '')) ENR.cache[k] = saved[k];
  } catch (e) { /* cache best-effort */ }
}
function enrSave() {
  try {
    var keys = Object.keys(ENR.cache);
    if (keys.length > ENR_MAX) {
      keys.sort(function (a, b) { return (ENR.cache[a].date || 0) - (ENR.cache[b].date || 0); });
      for (var i = 0; i < keys.length - ENR_MAX; i++) {
        delete ENR.cache[keys[i]];
        enrDbDel(keys[i]); // éviction répercutée dans la base
      }
    }
    localStorage.setItem(ENR_KEY, JSON.stringify(ENR.cache));
  } catch (e) { /* quota : best-effort, on ignore */ }
}

// ---------- Persistance IndexedDB (« openfrance-enrich », store « enr ») ----------
function enrDbOpen() {
  return new Promise(function (resolve) {
    try {
      var rq = indexedDB.open('openfrance-enrich', 1);
      rq.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains('enr')) db.createObjectStore('enr', { keyPath: 'k' });
      };
      rq.onsuccess = function (ev) { ENR.db = ev.target.result; resolve(ENR.db); };
      rq.onerror = function () { resolve(null); };
      rq.onblocked = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
}
function enrDbPut(key, rec) {
  if (!ENR.db || !rec) return;
  try {
    var tx = ENR.db.transaction('enr', 'readwrite');
    tx.objectStore('enr').put({
      k: key, desc: rec.desc || '', source: rec.source || '',
      conf: rec.conf || 0, site: rec.site || '', date: rec.date || 0
    });
  } catch (e) { /* best-effort */ }
}
function enrDbDel(key) {
  if (!ENR.db) return;
  try {
    var tx = ENR.db.transaction('enr', 'readwrite');
    tx.objectStore('enr').delete(key);
  } catch (e) { /* best-effort */ }
}
// Charge la base dans ENR.cache (l'entrée la plus récente gagne), renvoie la
// liste des clés présentes en base (pour la migration localStorage -> base).
// En passant : épure les entrées issues de sources inutiles (annuaires).
function enrDbLoad() {
  return new Promise(function (resolve) {
    if (!ENR.db) return resolve({});
    var seen = {};
    try {
      var tx = ENR.db.transaction('enr', 'readwrite'); // readwrite : épuration au passage
      var rq = tx.objectStore('enr').openCursor();
      rq.onsuccess = function (ev) {
        var cur = ev.target.result;
        if (!cur) return resolve(seen);
        var v = cur.value;
        if (v && v.k && ENR_JUNK_SRC.test(v.source || '')) {
          cur.delete(); // source inutile (annuaire/agrégateur) : épurée de la base
          cur.continue();
          return;
        }
        if (v && v.k && v.desc) {
          seen[v.k] = 1;
          var old = ENR.cache[v.k];
          if (!old || (v.date || 0) >= (old.date || 0)) {
            ENR.cache[v.k] = { desc: v.desc, source: v.source, conf: v.conf, site: v.site, date: v.date };
          } else {
            enrDbPut(v.k, old); // localStorage plus récent -> réécrit en base
          }
        }
        cur.continue();
      };
      rq.onerror = function () { resolve(seen); };
    } catch (e) { resolve({}); }
  });
}
function enrDbInit() {
  return enrDbOpen().then(function () { return enrDbLoad(); }).then(function (seen) {
    // migration : les entrées connues de localStorage seulement partent en base
    var n = 0;
    for (var k in ENR.cache) {
      if (!seen[k]) { enrDbPut(k, ENR.cache[k]); n++; }
    }
    return n;
  }).catch(function () { /* IndexedDB indisponible : localStorage suffit */ });
}

// ---------- Libellés NAF (naf.js) ----------
function enrNafCode(raw) {
  var c = String(raw || '').trim().toUpperCase();
  if (/^\d{2}\.\d{2}[A-Z]$/.test(c)) return c;
  if (/^\d{4}[A-Z]$/.test(c)) return c.slice(0, 2) + '.' + c.slice(2); // « 6201Z » -> « 62.01Z »
  return '';
}
function enrNafLabel(raw) {
  var c = enrNafCode(raw);
  if (!c || typeof NAF_LABELS === 'undefined') return '';
  return NAF_LABELS[c] || '';
}

// ---------- Bloc Enrich (bouton / description) ----------
ENR.key = function (ent) { return ent.type + ':' + ent.id; };
ENR.blockHtml = function (ent) {
  if (!ent || !ent.id || ent.type === 'commune') return '';
  var c = ENR.cache[ENR.key(ent)];
  var h = '';
  if (c && c.desc && !ENR_JUNK_SRC.test(c.source || '')) {
    h += '<div class="enr-desc">💬 ' + esc(c.desc) +
      ' <span class="muted">(' + esc(c.source || '') + ')</span></div>';
  }
  h += '<span class="enr-btn" data-enr="' + esc(JSON.stringify(ent)) +
    '" onclick="ENR.go(this,event)">' + (ENR.running[ENR.key(ent)] ? '⏳ Recherche en cours…' : '✨ Enrich') + '</span>';
  return '<div class="enr-block">' + h + '</div>';
};
ENR.go = function (el, ev) {
  if (ev) { ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  var ent;
  try { ent = JSON.parse(el.getAttribute('data-enr') || 'null'); } catch (e) { return; }
  if (!ent) return;
  var key = ENR.key(ent);
  if (ENR.running[key]) return;
  ENR.running[key] = true;
  el.textContent = '⏳ Recherche en cours…';
  ENR.run(ent, key).then(function () {
    delete ENR.running[key];
    // re-rendu du bloc en place (popup ouvert ou fiche)
    var block = el.closest ? el.closest('.enr-block') : null;
    if (block) block.outerHTML = ENR.blockHtml(ent);
  });
};

// Recherche : Wikidata (client) puis serveur (DDG + meta) — fusion par confiance
ENR.run = function (ent, key) {
  var prev = ENR.cache[key] || {};
  var best = { desc: prev.desc || '', source: prev.source || '', conf: prev.conf || 0, site: ent.siteWeb || prev.site || '' };
  return ENR.wikiDesc(ent).then(function (w) {
    if (w && w.desc && 60 > best.conf) { best.desc = w.desc; best.source = 'wikidata'; best.conf = 60; }
  }).catch(function () { /* moteur best-effort */ })
    .then(function () {
      return fetch('/ft/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'describe',
          entity: {
            type: ent.type || '', nom: ent.nom || '', siren: ent.siren || '',
            insee: ent.insee || '', ville: ent.ville || '', dep: ent.dep || '',
            siteWeb: best.site || ''
          }
        })
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (j && j.ok && j.best) {
            if (j.best.website && !best.site) best.site = j.best.website;
            if (j.best.description && !ENR_JUNK_SRC.test(j.best.source || '') && (Number(j.best.confidence) || 0) > best.conf) {
              best.desc = j.best.description;
              best.source = j.best.source || 'web';
              best.conf = Number(j.best.confidence) || 0;
            }
          }
        })
        .catch(function () { /* service indisponible : Wikidata suffit parfois */ });
    })
    .then(function () {
      if (best.desc && best.desc !== prev.desc) {
        ENR.cache[key] = { desc: best.desc, source: best.source, conf: best.conf, site: best.site || '', date: Date.now() };
        enrSave();
        enrDbPut(key, ENR.cache[key]); // persistance en base (IndexedDB)
        // favori présent ? site web + description complètent le favori (sans modifier favoris.js)
        if (typeof FAV !== 'undefined' && FAV.all[key]) {
          var fav = FAV.all[key];
          if (best.site && !fav.siteWeb) fav.siteWeb = best.site;
          if (!fav.desc) { fav.desc = best.desc; fav.descSource = best.source || ''; }
          if (typeof favDbPut === 'function') favDbPut(key, fav);
          FAV.refresh();
        }
      }
    });
};

// Wikidata : la description en une phrase (wbsearchentities renvoie description par résultat)
ENR.wikiDesc = function (ent) {
  var name = String(ent.nom || '').replace(/[, ]+\s*(SASU|SAS|SARL|EURL|SELAS|SELARL|SCOP|SCI|SNC|GIE|SCA|SA)\s*$/i, '').trim();
  if (!name) return Promise.resolve(null);
  var q = (name + ' ' + (ent.ville || '')).trim();
  var u = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*' +
    '&language=fr&uselang=fr&type=item&limit=5&search=' + encodeURIComponent(q);
  return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
    var token = normTxt(name).split(' ')[0] || '';
    var list = (((j || {}).search) || []);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (token && token.length >= 3 && normTxt(s.label || '').indexOf(token) === -1) continue;
      if (s.description && String(s.description).length > 10) {
        return { desc: String(s.description) };
      }
    }
    return null;
  });
};

// ---------- Injection dans les popups / fiches existantes ----------
// sous le titre : à la première balise </b> (sinon à la fin)
ENR.injectAfterTitle = function (html, ins) {
  if (!ins) return html;
  var i = html.indexOf('</b>');
  if (i === -1) return html + ins;
  return html.slice(0, i + 4) + ins + html.slice(i + 4);
};
// « NAF : 62.01Z » (annuaire) -> « NAF : 62.01Z — Programmation informatique »
ENR.nafify = function (html) {
  return html.replace(/NAF : (\d{2}\.\d{2}[A-Z])/g, function (m, code) {
    var lab = enrNafLabel(code);
    return lab ? m + ' — ' + esc(lab) : m;
  });
};
ENR.nafLine = function (raw) {
  var lab = enrNafLabel(raw);
  return lab ? '<br><i>🧭 ' + esc(lab) + '</i>' : '';
};

// ---------- Tooltip de survol (listes + marqueurs carte) ----------
ENR.tipShow = function (html, ev) {
  if (!ENR.tip) return;
  ENR.tip.innerHTML = html;
  ENR.tip.style.display = 'block';
  ENR.tipMove(ev);
};
ENR.tipMove = function (ev) {
  if (!ENR.tip || ENR.tip.style.display === 'none' || !ev) return;
  var x = (ev.clientX || 0) + 14, y = (ev.clientY || 0) + 14;
  var w = ENR.tip.offsetWidth || 260, h = ENR.tip.offsetHeight || 80;
  if (x + w > window.innerWidth - 8) x = Math.max(8, (ev.clientX || 0) - w - 14);
  if (y + h > window.innerHeight - 8) y = Math.max(8, (ev.clientY || 0) - h - 14);
  ENR.tip.style.left = x + 'px';
  ENR.tip.style.top = y + 'px';
};
ENR.tipHide = function () { if (ENR.tip) ENR.tip.style.display = 'none'; };
// Le contenu est évalué AU SURVOL (fonction builder + arguments) : la description
// apparaît dès qu'elle est en cache, même enrichie après le rendu de la liste.
function enrWireRow(row, builder, a, b) {
  row.addEventListener('mouseenter', function (ev) { ENR.tipShow(builder(a, b), ev); });
  row.addEventListener('mousemove', function (ev) { ENR.tipMove(ev); });
  row.addEventListener('mouseleave', function () { ENR.tipHide(); });
}
// Marqueurs Leaflet (dots de la carte) : même tooltip au survol, au clic le popup
// natif (déjà enrichi) s'ouvre comme avant.
ENR.wireMarker = function (m, builder, a, b) {
  if (!m || !m.on || m._enrTip) return;
  m._enrTip = true;
  m.on('mouseover', function (ev) { ENR.tipShow(builder(a, b), (ev && ev.originalEvent) || null); });
  m.on('mousemove', function (ev) { ENR.tipMove((ev && ev.originalEvent) || null); });
  m.on('mouseout', function () { ENR.tipHide(); });
};

// Contenus du tooltip : tout ce qu'on a déjà (NAF + description en cache), sans appel réseau
ENR.tipEnt = function (e) { // entreprises Sirene (annuaire + composeur)
  var s = e.siege || {};
  var parts = [];
  var lab = enrNafLabel(e.activite_principale || s.activite_principale);
  if (lab) parts.push('🧭 ' + esc(lab));
  var tr = (typeof coTrLabel === 'function') ? coTrLabel(e.tranche_effectif_salarie) : '';
  if (tr) parts.push('👥 ' + esc(tr));
  if (e.date_creation && typeof coFmtDate === 'function') parts.push('🎂 ' + esc(coFmtDate(e.date_creation)));
  var nat = (typeof coNatLabel === 'function') ? coNatLabel(e.nature_juridique) : '';
  if (nat) parts.push('🏛 ' + esc(nat));
  if (s.libelle_commune) parts.push('📍 ' + esc(s.libelle_commune));
  var h = '<b>' + esc(e.nom_complet || e.nom_raison_sociale || e.siren) + '</b>';
  if (parts.length) h += '<br>' + parts.join(' · ');
  var c = ENR.cache['ent:' + e.siren];
  if (c && c.desc && !ENR_JUNK_SRC.test(c.source || '')) h += '<br>💬 ' + esc(String(c.desc).slice(0, 180));
  var site = (c && c.site) || (typeof FAV !== 'undefined' && FAV.all && FAV.all['ent:' + e.siren] && FAV.all['ent:' + e.siren].siteWeb) || '';
  if (site) h += '<br>🌐 ' + esc(site);
  return h;
};
ENR.tipAsso = function (a) { // associations RNA : l'objet social EST la description
  var h = '<b>' + esc(a.t) + '</b>';
  var th = (typeof annTheme === 'function' && typeof ANN !== 'undefined' && ANN.nomen) ? annTheme(a) : null;
  if (th && th.p) h += '<br><i>' + esc(th.p) + (th.l && th.l !== th.p ? ' — ' + esc(th.l) : '') + '</i>';
  if (a.o) h += '<br>📝 ' + esc(String(a.o).slice(0, 200));
  h += '<br>📍 ' + esc(a.l || '') + (a.p ? ' (' + esc(a.p) + ')' : '');
  return h;
};
ENR.tipLbb = function (c, cur) { // La Bonne Boite
  var parts = [];
  var lab = enrNafLabel(c.naf);
  if (lab) parts.push('🧭 ' + esc(lab));
  else if (c.nafText) parts.push('🧭 ' + esc(c.nafText));
  if (c.headcountText) parts.push('👥 ' + esc(c.headcountText));
  if (c.city) parts.push('📍 ' + esc(c.city));
  if (cur && (cur.listes || []).length) parts.push('🏆 ' + esc(cur.listes.join(', ')));
  var h = '<b>' + esc(c.name || c.siren) + '</b>';
  if (parts.length) h += '<br>' + parts.join(' · ');
  var cc = ENR.cache['ent:' + c.siren];
  if (cc && cc.desc && !ENR_JUNK_SRC.test(cc.source || '')) h += '<br>💬 ' + esc(String(cc.desc).slice(0, 180));
  if (cc && cc.site) h += '<br>🌐 ' + esc(cc.site);
  return h;
};
ENR.tipFT = function (rec) { // annuaire French Tech (curatées)
  var parts = [];
  if (rec.ville) parts.push('📍 ' + esc(rec.ville));
  if ((rec.domaines || []).length) parts.push('🧭 ' + esc(rec.domaines.join(', ')));
  if ((rec.listes || []).length) parts.push('🏆 ' + esc(rec.listes.join(', ')));
  var h = '<b>' + esc(rec.nom || rec.siren) + '</b>';
  if (parts.length) h += '<br>' + parts.join(' · ');
  var c = ENR.cache['ent:' + rec.siren];
  if (c && c.desc && !ENR_JUNK_SRC.test(c.source || '')) h += '<br>💬 ' + esc(String(c.desc).slice(0, 180));
  if (c && c.site) h += '<br>🌐 ' + esc(c.site);
  return h;
};

// ---------- Décoration des listes (tooltips) et fiches (NAF + description) ----------
function enrDecorate(boxId, rowsSel, items, htmlFor) {
  var box = document.getElementById(boxId);
  if (!box) return;
  var rows = box.querySelectorAll(rowsSel);
  Array.prototype.forEach.call(rows, function (row, i) {
    if (items[i]) enrWireRow(row, htmlFor, items[i]);
  });
}
function enrDecorateAnn() {
  var box = document.getElementById('annResults');
  if (!box) return;
  var rows = box.querySelectorAll('.ann-row');
  var shown = ANN.showing.slice(0, 200); // même cap que renderAnnList
  Array.prototype.forEach.call(rows, function (row, i) {
    var r = shown[i];
    if (!r) return;
    enrWireRow(row, r.kind === 'ent' ? ENR.tipEnt : ENR.tipAsso, r.kind === 'ent' ? r.e : r.a);
  });
}
// LBB : ordre trié non exposé -> SIREN relu dans le texte des lignes (même astuce que favoris.js)
function enrDecorateExt(lbb, curated) {
  var box = document.getElementById('extResults');
  if (!box) return;
  var bySiren = {}, curBy = (curated && curated.bySiren) || {};
  (((lbb || {}).companies) || []).forEach(function (c) { if (c && c.siren) bySiren[c.siren] = c; });
  var rows = box.querySelectorAll('.co-row');
  Array.prototype.forEach.call(rows, function (row) {
    var sub = row.querySelector('.ann-obj');
    var m = sub && sub.textContent && sub.textContent.match(/SIREN (\d{9})/);
    if (!m) return;
    var c = bySiren[m[1]];
    if (c) enrWireRow(row, ENR.tipLbb, c, curBy[m[1]]);
  });
}
function enrDecorateFT() {
  var data = EXT.lastFT;
  if (!data || !data.rows) return;
  enrDecorate('extResults', '.co-row', data.rows.slice(0, EXT_MAX_LIST), function (r) { return ENR.tipFT(r.rec); });
}
function enrDecorateFiche(siren) {
  var e = (typeof CO !== 'undefined' && CO.byId && CO.byId[siren]) || null;
  if (!e) return;
  // description en tête de fiche + libellé NAF dans la grille « Activité (NAF) »
  var body = document.getElementById('coFicheBody');
  if (body && !body.querySelector('.enr-block')) {
    body.insertAdjacentHTML('afterbegin', ENR.blockHtml(FAV.fromEnt(e)));
  }
  if (!body) return;
  var kvs = body.querySelectorAll('.co-kv');
  for (var i = 0; i < kvs.length; i++) {
    var lab = kvs[i].querySelector('span');
    if (!lab || lab.textContent.indexOf('Activité (NAF)') === -1) continue;
    var b = kvs[i].querySelector('b');
    if (!b || b.querySelector('.enr-naf')) break;
    var m = b.textContent.match(/(\d{2}\.\d{2}[A-Z])/);
    if (m) {
      var nlab = enrNafLabel(m[1]);
      if (nlab) {
        var sm = document.createElement('span');
        sm.className = 'enr-naf muted';
        sm.textContent = ' — ' + nlab;
        b.appendChild(sm);
      }
    }
    break;
  }
}

// ---------- Marqueurs de carte : tooltip de survol (dots) ----------
// Annuaire : les entrées portent le rec (ent ou asso), clé 'e:<siren>' / 'a:<id>'
function enrWireAnnMarkers(entries) {
  (entries || []).forEach(function (en) {
    var m = (typeof ANN !== 'undefined' && ANN.markerIndex) ? ANN.markerIndex[en.key] : null;
    if (!m) return;
    if (en.key.charAt(0) === 'e') ENR.wireMarker(m, ENR.tipEnt, en.rec);
    else ENR.wireMarker(m, ENR.tipAsso, en.rec);
  });
}
// Composeur : CO.markerBySiret est indexé par SIRET (ou SIREN pour le siège) ->
// on remappe vers l'unité légale correspondante dans CO.shown
function enrWireCoMarkers() {
  var byKey = {};
  (CO.shown || []).forEach(function (e) {
    var ets = e.matching_etablissements || [];
    for (var i = 0; i < ets.length; i++) if (ets[i].siret) byKey[ets[i].siret] = e;
    if (e.siren) byKey[e.siren] = e;
  });
  for (var siret in CO.markerBySiret) {
    var e = byKey[siret];
    if (e) ENR.wireMarker(CO.markerBySiret[siret], ENR.tipEnt, e);
  }
}
// Recherche étendue : EXT.markerBySiren est indexé par SIREN
function enrWireExtMarkers(lbb, curated) {
  var bySiren = {}, curBy = (curated && curated.bySiren) || {};
  (((lbb || {}).companies) || []).forEach(function (c) { if (c && c.siren) bySiren[c.siren] = c; });
  for (var siren in EXT.markerBySiren) {
    var c = bySiren[siren];
    if (c) ENR.wireMarker(EXT.markerBySiren[siren], ENR.tipLbb, c, curBy[siren]);
  }
}
function enrWireFTMarkers() {
  var bySiren = {};
  (((EXT.lastFT || {}).rows) || []).forEach(function (row) {
    if (row && row.rec && row.rec.siren) bySiren[row.rec.siren] = row.rec;
  });
  for (var siren in EXT.markerBySiren) {
    var rec = bySiren[siren];
    if (rec) ENR.wireMarker(EXT.markerBySiren[siren], ENR.tipFT, rec);
  }
}

// ---------- Enveloppes (par-dessus celles de favoris.js, chargé avant) ----------
ENR.wrapAll = function () {
  var _renderAnnList = renderAnnList;
  window.renderAnnList = function () {
    _renderAnnList();
    try { enrDecorateAnn(); } catch (e) { /* best-effort */ }
  };
  var _assoPopup = assoPopup;
  window.assoPopup = function (a, th) {
    return ENR.injectAfterTitle(_assoPopup(a, th), ENR.blockHtml(FAV.fromAsso(a)));
  };
  var _entPopup = entPopup;
  window.entPopup = function (e) {
    return ENR.nafify(ENR.injectAfterTitle(_entPopup(e),
      ENR.nafLine(e.activite_principale || (e.siege && e.siege.activite_principale)) +
      ENR.blockHtml(FAV.fromEnt(e))));
  };

  var _coRenderResults = coRenderResults;
  window.coRenderResults = function () {
    _coRenderResults();
    try { enrDecorate('coResults', '.co-row', CO.shown.slice(0, CO_MAX_LIST), ENR.tipEnt); } catch (e) {}
  };
  var _coPopupHtml = coPopupHtml;
  window.coPopupHtml = function (e, et) {
    return ENR.injectAfterTitle(_coPopupHtml(e, et),
      ENR.nafLine(e.activite_principale || (e.siege && e.siege.activite_principale)) +
      ENR.blockHtml(FAV.fromEnt(e)));
  };
  var _coOpenFiche = coOpenFiche;
  window.coOpenFiche = function (siren) {
    _coOpenFiche(siren);
    try { enrDecorateFiche(siren); } catch (e) {}
  };

  var _extPopupHtml = extPopupHtml;
  window.extPopupHtml = function (c, cur) {
    return ENR.injectAfterTitle(_extPopupHtml(c, cur), ENR.nafLine(c.naf) + ENR.blockHtml(FAV.fromExtItem(c, cur)));
  };
  var _extFTPopupHtml = extFTPopupHtml;
  window.extFTPopupHtml = function (row) {
    return ENR.injectAfterTitle(_extFTPopupHtml(row), ENR.blockHtml(FAV.fromFTRec(row.rec)));
  };
  var _extRenderResults = extRenderResults;
  window.extRenderResults = function (lbb, curated) {
    _extRenderResults(lbb, curated);
    try { enrDecorateExt(lbb, curated); } catch (e) {}
    try { enrWireExtMarkers(lbb, curated); } catch (e) {}
  };
  var _extRenderFT = extRenderFT;
  window.extRenderFT = function () {
    _extRenderFT();
    try { enrDecorateFT(); } catch (e) {}
    try { enrWireFTMarkers(); } catch (e) {}
  };

  // marqueurs de carte (dots) : tooltip enrichi au survol (le clic ouvre le popup natif)
  var _annSyncMarkers = annSyncMarkers;
  window.annSyncMarkers = function (entries) {
    var r = _annSyncMarkers(entries);
    try { enrWireAnnMarkers(entries); } catch (e) { /* best-effort */ }
    return r;
  };
  var _coSyncMarkers = coSyncMarkers;
  window.coSyncMarkers = function () {
    var r = _coSyncMarkers();
    try { enrWireCoMarkers(); } catch (e) { /* best-effort */ }
    return r;
  };
};

document.addEventListener('DOMContentLoaded', function () {
  if (ENR._inited) return;
  ENR._inited = true;
  ENR.tip = document.createElement('div');
  ENR.tip.id = 'enrTip';
  ENR.tip.style.display = 'none';
  document.body.appendChild(ENR.tip);
  enrLoad();           // localStorage : démarrage instantané
  enrDbInit();         // IndexedDB : base de vérité + migration (asynchrone, best-effort)
  try { ENR.wrapAll(); }
  catch (e) { console.warn('[OpenFrance] Enrich : enveloppement impossible :', e); }
});
