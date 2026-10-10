// OpenFrance — Recherche étendue d'entreprises : ROMEO → ROME 4.0 → La Bonne Boite → listes curatées
//
// Principe : l'utilisateur décrit un métier en texte libre (« intelligence artificielle »),
// choisit une ville cible et un rayon. Pipeline :
//  1. ROMEO (France Travail, via /ft/ft?op=romeo) prédit les codes ROME du texte ;
//  2. clic sur un métier → fiche ROME 4.0 (compétences) dans le MODAL partagé
//     #coFicheDlg, avec lien « 🔗 Source » vers /ft/ft?op=fiche (données officielles) ;
//  3. La Bonne Boite v2 (via /ft/ft?op=lbb, rome = 3 premiers codes + rome_all =
//     tous les codes : UNE retentative automatique si 0 résultat, champ 'retried')
//  4. croisement avec les listes curatées (Supabase via /ft/curated, ex. French Tech
//     2030) → badge 🏆 sur la carte et dans la liste (signal certain).
// Chaque entreprise LBB porte le code ROME ayant matché (champ 'rome') : badge 🔖
// cliquable (liste + popup) vers la fiche métier, et sous-filtre local par codes
// ROME (cases à cocher, tout coché par défaut). Marqueurs colorés par potentiel
// d'embauche (dégradé colorFor de app.js : rouge = faible → vert = fort ; les
// entreprises curatées gardent une bordure orange épaisse).
//
// ⚠️ Contraintes (vérifiées le 10/10/2026, voir docs/ETAT-PROJET.md) :
//  - La Bonne Boite v2 : GET /partenaire/labonneboite/v2/recherche — le token doit porter
//    le scope 'search office api_labonneboitev2' (api_labonneboitev2 seul → 403).
//    La forme exacte des items varie : le proxy normalise de façon tolérante et renvoie
//    count/noCoords/sample ; si 0 item reconnu alors que LBB annonce des résultats, le
//    front affiche un lien vers /ft/ft?op=lbb_raw (réponse brute) pour diagnostiquer.
//    Items sans coordonnées : liste + fiche détaillée OK, pas de marqueur carte.
//  - #extFiche est la ZONE D'INFORMATION du mode : elle explique toujours l'état
//    courant (synthèse X entreprises / Y curatées / Z sans coordonnées, motif exact
//    d'absence de résultat ou d'erreur avec lien lbb_raw conservé).
//  - Fiche détaillée : récupérée à la volée depuis l'API Recherche d'entreprises
//    (q=SIREN, proxy /api/ent existant) et rendue par coOpenFiche — le modal du
//    Composeur d'entreprises est réutilisé tel quel (identité, siège, dirigeants, labels,
//    établissements, lien officiel annuaire-entreprises.data.gouv.fr).
//  - Filtre « Taille » : appliqué LOCALEMENT (headcount_min de la réponse LBB).
//  - Critère « 🇫🇷 French Tech uniquement » (case #extFTOnly) : filtre LOCAL sur le
//    croisement SIREN (listes curatées contenant 'French Tech', base alimentée par
//    tools/collect-numeum.mjs + tools/resolve-sirens.mjs depuis les listes officielles
//    de lauréats — Next40/FT120, Green20/Agri20/DeepNum20/Health20, FT2030). Le bandeau
//    d'état affiche toujours le total French Tech en base ; si le filtre vide la liste,
//    #extFiche explique (total en base, 0 dans le rayon → élargir ou décocher).
//  - Les fonctions Netlify sont servies sous /ft/* : le service worker ne les met PAS
//    en cache (seuls /api/, /data/, /geo/ le sont) → résultats frais à chaque recherche.
//
// Dépend de app.js (state, map, geoLayer, DEP_FOLDERS, fetchJSONCached, setStatus,
// showError, hideError), annuaire.js (esc, normTxt, annCentroids) et corp.js (coDepLabel,
// CO.byId, coOpenFiche, coFicheClose).

var EXT = {
  active: false,
  dep: '31',
  target: null,          // { code, nom, latlng } — ville cible
  radius: 10,            // km
  size: '',              // filtre local headcount_min : '' | '10' | '50' | '100'
  onlyFT: false,         // filtre local « French Tech uniquement » (case #extFTOnly)
  geo: null, geoDep: null, cities: [], centroids: null,
  metiers: [],            // prédictions ROME en cours (dédoublonnées par code)
  curated: null,         // cache (promesse) des listes curatées Supabase
  lastLbb: null, lastCurated: null, // dernière réponse (re-render local si filtre taille/ROME)
  romeFilter: null,        // { codeROME: bool } — sous-filtre local par métier (null = tout coché)
  seq: 0,
  markers: null, markerBySiren: {}, circle: null, targetMk: null,
  uiReady: false
};

var EXT_TOP_ROME = 3;      // codes ROME transmis à La Bonne Boite
var EXT_MAX_LIST = 300;   // lignes affichées dans la liste
var EXT_FT_LABEL = 'French Tech'; // label du critère French Tech dans les listes curatées

// Une fiche curatée est « French Tech » si son champ listes contient le label.
function extIsFT(rec) {
  return !!(rec && rec.listes && rec.listes.indexOf(EXT_FT_LABEL) !== -1);
}

// ---------- Utilitaires ----------
function extUrl(op, params) {
  var qs = [];
  for (var k in params) {
    var v = params[k];
    if (v !== undefined && v !== null && v !== '') qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return '/ft/ft?op=' + op + (qs.length ? '&' + qs.join('&') : '');
}
// Les erreurs applicatives du proxy arrivent en HTTP 200 {ok:false} : on les rejette
// avec une étiquette e.ft pour les distinguer des erreurs réseau/HTTP.
function extFetchJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url);
    return r.json();
  }).then(function (j) {
    if (j && j.ok === false) {
      var e = new Error(j.message || j.error || 'erreur proxy');
      e.ft = j;
      throw e;
    }
    return j;
  });
}

// ---------- Géographie du département (comme corp.js) ----------
function extEnsureGeo() {
  if (EXT.geo && EXT.dep === EXT.geoDep) return Promise.resolve();
  var dep = EXT.dep;
  var g = state.communesGeo[dep];
  var p = g ? Promise.resolve(g) :
    fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[dep] + '/communes-' + DEP_FOLDERS[dep] + '.geojson')
      .then(function (geo) { state.communesGeo[dep] = geo; return geo; });
  return p.then(function (geo) {
    if (EXT.dep !== dep) return; // département changé entre-temps
    EXT.geo = geo; EXT.geoDep = dep;
    EXT.centroids = annCentroids(dep);
    EXT.cities = (geo.features || []).map(function (f) {
      return { code: f.properties.code, nom: f.properties.nom, n: normTxt(f.properties.nom), latlng: EXT.centroids[f.properties.code] };
    }).filter(function (c) { return !!c.latlng; });
  });
}

// ---------- Autocomplete ville (comme corp.js) ----------
function extTargetSearch(q) {
  q = normTxt(q);
  if (!q) return [];
  var out = [];
  for (var i = 0; i < EXT.cities.length && out.length < 10; i++) {
    var c = EXT.cities[i];
    if (c.n.indexOf(q) !== -1) out.push(c);
  }
  return out;
}
function extTargetDropEl(show) {
  var d = document.getElementById('extTargetDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function extTargetRender(matches) {
  var d = document.getElementById('extTargetDrop');
  d.innerHTML = '';
  matches.forEach(function (m) {
    var row = document.createElement('div');
    row.innerHTML = esc(m.nom) + ' <span class="muted">(' + m.code + ')</span>';
    row.addEventListener('mousedown', function (ev) { // mousedown : avant le blur
      ev.preventDefault();
      extSetTarget(m.code, m.nom);
      extTargetDropEl(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}
function extSetTarget(code, nom) {
  var c = (EXT.centroids || {})[code];
  if (!c) return;
  EXT.target = { code: code, nom: nom, latlng: c };
  document.getElementById('extTarget').value = nom;
  extFrameZone(); // feedback immédiat : cercle de la zone sur la carte
}

// ---------- Listes curatées (Supabase, via fonction Netlify) ----------
function extCurated() {
  if (!EXT.curated) {
    EXT.curated = fetch('/ft/curated').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' sur /ft/curated');
      return r.json();
    }).then(function (j) {
      var bySiren = {};
      var ftCount = 0;
      ((j && j.records) || []).forEach(function (rec) {
        if (rec.siren) bySiren[rec.siren] = rec;
        if (extIsFT(rec)) ftCount++;
      });
      return { bySiren: bySiren, count: ((j && j.records) || []).length, ftCount: ftCount };
    });
    EXT.curated.catch(function () { EXT.curated = null; }); // réessayé à la prochaine recherche
  }
  return EXT.curated;
}

// ---------- Recherche ----------
function extSearch() {
  if (!EXT.active) return;
  var text = (document.getElementById('extText').value || '').trim();
  var seq = ++EXT.seq;
  var status = document.getElementById('extStatus');
  extClearMap();
  EXT.lastLbb = null; EXT.lastCurated = null; EXT.romeFilter = null; // nouvelle recherche : filtres locaux réinitialisés
  document.getElementById('extMetiers').innerHTML = '';
  extInfo(null);
  document.getElementById('extResults').innerHTML = '';
  if (!text) {
    status.textContent = 'Entrez un métier en texte libre (ex. « intelligence artificielle »).';
    return;
  }
  if (!EXT.target) {
    status.textContent = "Choisissez une ville cible — La Bonne Boite cherche par zone autour d'un point.";
    return;
  }
  status.textContent = '⏳ Prédiction des métiers (ROMEO)…';
  extFetchJson(extUrl('romeo', { text: text })).then(function (j) {
    if (seq !== EXT.seq) return;
    EXT.metiers = (j && j.metiers) || [];
    // Dédoublonnage local de sécurité (le proxy dédoublonne déjà côté serveur)
    var seen = {}, uniq = [];
    EXT.metiers.forEach(function (m) {
      if (m && m.codeRome && !seen[m.codeRome]) { seen[m.codeRome] = 1; uniq.push(m); }
    });
    EXT.metiers = uniq;
    extRenderMetiers();
    if (!EXT.metiers.length) {
      status.textContent = 'Aucun métier prédit pour cette description — essayez une formulation plus générique.';
      return;
    }
    status.textContent = '⏳ Entreprises recrutantes (La Bonne Boite)…';
    var codes = EXT.metiers.slice(0, EXT_TOP_ROME).map(function (m) { return m.codeRome; });
    var lbbP = extFetchJson(extUrl('lbb', {
      rome: codes.join(','),
      rome_all: EXT.metiers.map(function (m) { return m.codeRome; }).join(','),
      lat: EXT.target.latlng[0],
      lon: EXT.target.latlng[1],
      dist: EXT.radius
    }));
    return Promise.all([lbbP, extCurated().catch(function () { return null; })]).then(function (arr) {
      if (seq !== EXT.seq) return;
      EXT.lastLbb = arr[0]; EXT.lastCurated = arr[1];
      extRenderResults(arr[0], arr[1]);
    });
  }).catch(function (err) {
    if (seq !== EXT.seq) return;
    if (err && err.ft) {
      if (err.ft.code === 'lbb_unavailable') {
        status.innerHTML = '⚠️ <b>La Bonne Boite indisponible</b> — abonnement à valider sur francetravail.io (403 insufficient_scope). Les métiers ROME ci-dessus restent affichés.';
      } else {
        status.textContent = '⚠️ ' + err.message;
      }
      return;
    }
    console.error('[OpenFrance] Recherche étendue :', err);
    showError('Recherche étendue impossible.', err && err.message);
  });
}

// ---------- Zone détail / diagnostic (#extFiche) ----------
// Cette zone explique TOUJOURS l'état courant du mode : synthèse en cas de
// succès, motif exact en cas d'absence de résultat ou d'erreur (fiche métier,
// fiche entreprise, structure LBB non reconnue + lien lbb_raw).
function extInfo(html) {
  var box = document.getElementById('extFiche');
  if (!html) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = html;
}

// ---------- Rendu : métiers prédits + fiche ROME (modal partagé) ----------
function extRenderMetiers() {
  var box = document.getElementById('extMetiers');
  box.innerHTML = '';
  var hint = document.createElement('div');
  hint.className = 'muted';
  hint.style.margin = '0 0 4px 0';
  hint.textContent = 'Métiers détectés à partir de votre texte — codes ROME (référentiel métiers France Travail). ' +
    'Clic sur un métier : fiche métier (compétences). Les ' + EXT_TOP_ROME +
    ' premiers (surlignés) sont utilisés pour chercher les entreprises recrutantes :';
  box.appendChild(hint);
  EXT.metiers.forEach(function (m, i) {
    var chip = document.createElement('span');
    chip.className = 'ext-chip' + (i < EXT_TOP_ROME ? ' ext-chip-on' : '');
    chip.innerHTML = esc(m.libelleRome) + ' <b>' + esc(m.codeRome) + '</b>' +
      (m.scorePrediction !== undefined && m.scorePrediction !== null ? ' <span class="muted">' + Math.round(m.scorePrediction * 100) + '%</span>' : '');
    chip.title = i < EXT_TOP_ROME ? 'Utilisé pour La Bonne Boite — clic : compétences (ROME 4.0)' : 'Clic : compétences (ROME 4.0)';
    chip.addEventListener('click', function () { extShowFiche(m); });
    box.appendChild(chip);
  });
}
function extShowFiche(m) {
  // Fiche métier ROME dans le modal partagé #coFicheDlg (clic hors popup = fermer,
  // listeners posés dans extInitUI), avec lien vers les données source officielles.
  document.getElementById('coFicheTitle').textContent = '📋 ' + m.libelleRome + ' (' + m.codeRome + ')';
  document.getElementById('coFicheBody').innerHTML = '<p class="muted">⏳ Chargement de la fiche ROME…</p>';
  document.getElementById('coFicheDlg').style.display = 'flex';
  extFetchJson(extUrl('fiche', { code: m.codeRome })).then(function (j) {
    var f = (j && j.fiche) || {};
    var lib = (f.metier && f.metier.libelle) || f.libelle || m.libelleRome;
    var groups = f.groupesCompetencesMobilisees || f.groupesCompetences || [];
    var html = '<p><b>' + esc(lib) + '</b> (' + esc(m.codeRome) + ')</p>';
    if (!groups.length) {
      html += '<p class="muted">Aucune compétence détaillée dans cette fiche.</p>';
    }
    groups.forEach(function (g) {
      var glib = (g.enjeu && g.enjeu.libelle) || g.libelle || 'Compétences';
      html += '<p><b>' + esc(glib) + '</b></p><ul>';
      (g.competences || []).forEach(function (c) {
        html += '<li>' + esc(c.libelle || c.code || '') + '</li>';
      });
      html += '</ul>';
    });
    html += '<a class="co-official" href="' + extUrl('fiche', { code: m.codeRome }) +
      '" target="_blank" rel="noopener">🔗 Source : fiche ROME (France Travail)</a>';
    document.getElementById('coFicheBody').innerHTML = html;
  }).catch(function (err) {
    var raw = err && err.ft
      ? ('Fiche métier ' + m.codeRome + ' indisponible : HTTP ' + (err.ft.status || '?') +
         ' — ' + (err.ft.message || err.ft.error || 'erreur proxy'))
      : ('Fiche métier ' + m.codeRome + ' indisponible : ' + (err && err.message));
    document.getElementById('coFicheBody').innerHTML = '<p class="muted">' + esc(raw) + '</p>';
    extInfo('<span class="muted">⚠️ ' + esc(raw) + '</span>');
  });
}

// ---------- Fiche détaillée entreprise (base Sirene via /api/ent, modal du Composeur) ----------
function extOpenFiche(siren) {
  var dlg = document.getElementById('coFicheDlg');
  document.getElementById('coFicheTitle').textContent = '⏳ Chargement de la fiche…';
  document.getElementById('coFicheBody').innerHTML = '<p class="muted">Interrogation de la base Sirene…</p>';
  dlg.style.display = 'flex';
  fetch('/api/ent/search?per_page=1&page=1&est_association=false&q=' + encodeURIComponent(siren))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      var e = (j.results || [])[0];
      if (!e) {
        document.getElementById('coFicheTitle').textContent = 'Entreprise ' + siren;
        document.getElementById('coFicheBody').innerHTML =
          '<p class="muted">Fiche Sirene introuvable pour ce SIREN.</p>' +
          '<a class="co-official" href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + encodeURIComponent(siren) + '" target="_blank" rel="noopener">🔗 Fiche officielle — annuaire-entreprises.data.gouv.fr</a>';
        extInfo('<span class="muted">⚠️ Fiche entreprise ' + esc(siren) +
          ' introuvable : SIREN absent de la base Sirene (API Recherche d\u2019entreprises, 0 résultat).</span>');
        return;
      }
      CO.byId[siren] = e; // réutilise le rendu complet du Composeur d'entreprises
      coOpenFiche(siren);
    })
    .catch(function (err) {
      document.getElementById('coFicheTitle').textContent = 'Entreprise ' + siren;
      document.getElementById('coFicheBody').innerHTML = '<p class="muted">Fiche indisponible : ' + esc(err.message) + '</p>';
      extInfo('<span class="muted">⚠️ Fiche entreprise ' + esc(siren) +
        ' indisponible : ' + esc(err.message) + '</span>');
    });
}

// ---------- Rendu : résultats (liste + carte) ----------
function extSizePass(c) {
  if (!EXT.size) return true;
  return c.headcount != null && c.headcount >= parseInt(EXT.size, 10);
}
function extRomePass(c) {
  if (!EXT.romeFilter) return true;
  if (!c.rome) return true; // ROME inconnu : on garde (non attribuable)
  return EXT.romeFilter[c.rome] !== false;
}
function extRomeLib(code) {
  var lib = '';
  (EXT.metiers || []).forEach(function (m) { if (m.codeRome === code) lib = m.libelleRome; });
  return lib;
}
// Fiche métier depuis un code ROME (lien entreprise → métier) : libellé retrouvé
// dans les prédictions ROMEO quand il y est, sinon le code seul.
function extOpenMetier(code) {
  extShowFiche({ codeRome: code, libelleRome: extRomeLib(code) || code });
}
// Barre de sous-filtre par codes ROME (re-render local, sans nouvel appel API).
// Chaque case affiche le nombre de résultats du code ; les codes à 0 sont
// décochés d'office et grisés (case désactivée).
function extRomeFilterBar(filterCodes, romeCounts) {
  var bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;margin:6px 0;';
  var title = document.createElement('span');
  title.className = 'muted';
  title.textContent = '🔖 Métiers (ROME) :';
  bar.appendChild(title);
  filterCodes.forEach(function (code) {
    var n = (romeCounts && romeCounts[code] !== undefined) ? romeCounts[code] : 0;
    var lab = document.createElement('label');
    lab.style.cssText = 'font-size:.78rem;white-space:nowrap;' +
      (n === 0 ? 'color:#64748b;cursor:not-allowed;' : 'color:#e2e8f0;cursor:pointer;');
    lab.title = (extRomeLib(code) || code) + ' — ' + n + ' résultat(s)';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = n > 0 && EXT.romeFilter[code] !== false;
    cb.disabled = n === 0;
    cb.addEventListener('change', function () {
      EXT.romeFilter[code] = cb.checked;
      if (EXT.lastLbb) extRenderResults(EXT.lastLbb, EXT.lastCurated);
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + code + ' (' + n + ')'));
    bar.appendChild(lab);
  });
  var all = document.createElement('a');
  all.href = '#';
  all.className = 'muted';
  all.textContent = 'Tout';
  all.addEventListener('click', function (ev) {
    ev.preventDefault();
    filterCodes.forEach(function (code) {
      if (!romeCounts || romeCounts[code] > 0) EXT.romeFilter[code] = true;
    });
    if (EXT.lastLbb) extRenderResults(EXT.lastLbb, EXT.lastCurated);
  });
  var none = document.createElement('a');
  none.href = '#';
  none.className = 'muted';
  none.textContent = 'Rien';
  none.addEventListener('click', function (ev) {
    ev.preventDefault();
    filterCodes.forEach(function (code) { EXT.romeFilter[code] = false; });
    if (EXT.lastLbb) extRenderResults(EXT.lastLbb, EXT.lastCurated);
  });
  var sep = document.createElement('span');
  sep.className = 'muted';
  sep.textContent = '·';
  bar.appendChild(all);
  bar.appendChild(sep);
  bar.appendChild(none);
  return bar;
}
// Couleur d'un marqueur selon le potentiel d'embauche : vert (fort) → rouge
// (faible), via le dégradé global colorFor de app.js (0 = vert, 1 = rouge).
function extScoreColor(c) {
  var s = (c && c.score != null) ? c.score : ((c && c.stars != null) ? c.stars / 5 : 0);
  if (typeof colorFor === 'function') return colorFor(1 - s);
  return s >= 0.66 ? '#22c55e' : (s >= 0.33 ? '#eab308' : '#ef4444');
}
function extPopupHtml(c, cur) {
  var html = '<b>' + esc(c.name || c.siren) + '</b>';
  if (c.city) html += '<br>' + esc(c.city) + (c.zipcode ? ' (' + esc(c.zipcode) + ')' : '');
  html += '<br><i>⭐ ' + c.stars + '/5 — potentiel d\'embauche' +
    (c.headcountText ? ' · 👥 ' + esc(c.headcountText) : '') + '</i>';
  if (c.nafText) html += '<br>' + esc(c.nafText);
  if (c.rome) {
    html += '<br>🔖 ROME ' + esc(c.rome) +
      ' — <a href="#" onclick="extOpenMetier(\'' + c.rome + '\');return false;">Fiche métier</a>';
  }
  if (cur && (cur.listes || []).length) html += '<br>🏆 ' + esc(cur.listes.join(', '));
  html += '<br><a href="#" onclick="extOpenFiche(\'' + c.siren + '\');return false;">📋 Fiche détaillée</a>';
  html += ' · <a href="https://labonneboite.francetravail.fr/entreprise/' + encodeURIComponent(c.siret || c.siren) + '" target="_blank" rel="noopener">La Bonne Boite</a>';
  return html;
}
function extRenderResults(lbb, curated) {
  var status = document.getElementById('extStatus');
  var box = document.getElementById('extResults');
  box.innerHTML = '';
  var all = (lbb && lbb.companies) || [];
  var total = (lbb && lbb.total != null) ? lbb.total : all.length;
  var noCoords = (lbb && lbb.noCoords) || 0;
  var sized = all.filter(extSizePass);
  var romesUsed = (lbb && lbb.romes && lbb.romes.length)
    ? lbb.romes
    : EXT.metiers.slice(0, EXT_TOP_ROME).map(function (m) { return m.codeRome; });
  // Codes proposés en cases à cocher : romes utilisés + éventuels codes rapportés
  // par les entreprises mais hors liste
  var filterCodes = romesUsed.slice();
  all.forEach(function (c) {
    if (c.rome && filterCodes.indexOf(c.rome) === -1) filterCodes.push(c.rome);
  });
  // Nombre de résultats par code (après filtre Taille, avant filtre ROME)
  var romeCounts = {};
  filterCodes.forEach(function (code) { romeCounts[code] = 0; });
  sized.forEach(function (c) { if (c.rome && romeCounts[c.rome] !== undefined) romeCounts[c.rome]++; });
  // Sous-filtre ROME : par défaut tout est coché, SAUF les codes à 0 résultat
  // (décochés d'office et grisés — ils ne rapportent rien ; réappliqué à chaque
  // rendu pour suivre le filtre Taille, sans toucher aux choix utilisateur)
  if (!EXT.romeFilter) EXT.romeFilter = {};
  filterCodes.forEach(function (code) {
    if (romeCounts[code] === 0) EXT.romeFilter[code] = false;
    else if (EXT.romeFilter[code] === undefined) EXT.romeFilter[code] = true;
  });
  var comps = sized.filter(extRomePass);
  var bySiren = (curated && curated.bySiren) || {};
  var ftTotal = (curated && curated.ftCount != null) ? curated.ftCount : 0;
  // Critère « French Tech uniquement » : filtre LOCAL sur le croisement SIREN
  // (même mécanique que le badge 🏆) — aucun nouvel appel API.
  var preFT = comps;
  if (EXT.onlyFT) {
    comps = comps.filter(function (c) { return extIsFT(bySiren[c.siren]); });
  }
  var checkedCount = 0;
  filterCodes.forEach(function (code) { if (EXT.romeFilter[code] !== false) checkedCount++; });
  var romeFilterNote = (checkedCount < filterCodes.length)
    ? ' · 🔖 filtre ROME : ' + checkedCount + '/' + filterCodes.length + ' codes'
    : '';
  var curatedCount = 0;
  comps.forEach(function (c) { if (bySiren[c.siren]) curatedCount++; });
  var retryNote = (lbb && lbb.retried)
    ? ' · 🔁 0 résultat avec les ' + EXT_TOP_ROME + ' premiers codes → relance automatique avec les ' + romesUsed.length + ' codes ROME'
    : '';
  status.innerHTML = '📍 ' + esc(EXT.target.nom) + ' — rayon ' + EXT.radius + ' km · <b>' +
    comps.length + ' entreprise(s) recrutante(s)</b>' + (comps.length < total ? ' sur ' + total : '') +
    (noCoords ? ' · ' + noCoords + ' sans coordonnées GPS (liste et fiche seulement)' : '') +
    (curatedCount ? ' · 🏆 ' + curatedCount + ' dans les listes curatées' : '') +
    (curated ? ' · 🇫🇷 ' + ftTotal + ' French Tech en base' : '') +
    (EXT.onlyFT ? ' · <b>filtre 🇫🇷 French Tech actif</b>' : '') +
    ' · ROME : ' + esc(romesUsed.join(', ')) + retryNote + romeFilterNote;
  extClearMap(); // re-render local (filtres) : retire les anciens marqueurs/cercle avant de reconstruire
  extFrameZone();
  // Sous-filtre par codes ROME (cases à cocher, tout coché par défaut ; re-render local)
  box.appendChild(extRomeFilterBar(filterCodes, romeCounts));
  // liste : les entreprises des listes curatées en premier
  var sorted = comps.slice().sort(function (a, b) {
    return (bySiren[b.siren] ? 1 : 0) - (bySiren[a.siren] ? 1 : 0);
  });
  sorted.slice(0, EXT_MAX_LIST).forEach(function (c) {
    var row = document.createElement('div');
    row.className = 'co-row';
    var cur = bySiren[c.siren];
    var head = document.createElement('div');
    head.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
      (cur ? '#f59e0b' : '#22c55e') + '"></span> <b>' + esc(c.name || c.siren) + '</b>' +
      ' <span class="co-badge" title="Potentiel d\'embauche (La Bonne Boite)">⭐ ' + c.stars + '</span>' +
      (c.headcountText ? ' <span class="co-badge">👥 ' + esc(c.headcountText) + '</span>' : '') +
      (c.city ? ' <span class="co-badge">' + esc(c.city) + '</span>' : '') +
      (c.rome ? ' <a class="co-badge" href="#" title="' + esc((extRomeLib(c.rome) ? extRomeLib(c.rome) + ' — ' : '') + 'clic : fiche métier') +
        '" onclick="event.stopPropagation();extOpenMetier(\'' + c.rome + '\');return false;">🔖 ' + esc(c.rome) + '</a>' : '') +
      (cur ? ' <span class="co-badge ext-curated">🏆 ' + esc((cur.listes || []).join(', ')) + '</span>' : '');
    var sub = document.createElement('div');
    sub.className = 'ann-obj';
    sub.textContent = (c.naf ? c.naf + ' · ' : '') + (c.nafText || '') +
      ' · SIREN ' + c.siren +
      (cur && (cur.domaines || []).length ? ' · ' + cur.domaines.join(', ') : '');
    row.appendChild(head);
    row.appendChild(sub);
    row.addEventListener('click', function () { extOpenFiche(c.siren); });
    box.appendChild(row);
  });
  if (!comps.length) {
    // Zone détail : explique TOUJOURS pourquoi il n'y a aucun marqueur
    if (EXT.onlyFT && !curated) {
      extInfo('<span class="muted">🇫🇷 Filtre « French Tech uniquement » actif mais listes curatées ' +
        'indisponibles (erreur réseau) — 0 marqueur sur la carte pour cette raison. Décochez la case pour voir tous les résultats.</span>');
    } else if (EXT.onlyFT && preFT.length) {
      extInfo('<span class="muted">🇫🇷 ' + ftTotal + ' entreprise(s) French Tech dans la base, ' +
        '0 dans ce rayon sur ces métiers (' + esc(romesUsed.join(', ')) + ') — élargissez le rayon ou décochez ' +
        '« French Tech uniquement » pour voir les ' + preFT.length + ' entreprise(s) recrutante(s).</span>');
    } else if (EXT.size && all.length) {
      extInfo('<span class="muted">Aucune entreprise ne passe le filtre Taille sur les ' +
        all.length + ' résultat(s) — 0 marqueur sur la carte pour cette raison.</span>');
    } else if (total > 0) {
      // LBB annonce des résultats mais aucun item n'a été reconnu → diagnostic
      if (lbb && lbb.sample) {
        console.warn('[OpenFrance] LBB : ' + total + ' résultat(s) reçus, 0 reconnu — réponse brute :', lbb.sample, 'shape :', lbb.shape);
      }
      extInfo('<span class="muted">⚠️ ' + total + ' résultat(s) reçus de La Bonne Boite mais aucun champ reconnu ' +
        '(structure de réponse inattendue) — 0 marqueur sur la carte. ' +
        'Ouvrez <a href="' + extUrl('lbb_raw', {
          rome: romesUsed.join(','),
          lat: EXT.target.latlng[0], lon: EXT.target.latlng[1], dist: EXT.radius
        }) + '" target="_blank" rel="noopener">la réponse brute (diagnostic)</a> et transmettez son contenu.</span>');
    } else {
      extInfo('<span class="muted">0 marqueur sur la carte : La Bonne Boite ne signale aucune entreprise ' +
        'recrutante sur ces métiers (' + esc(romesUsed.join(', ')) + ') dans un rayon de ' + EXT.radius +
        ' km autour de ' + esc(EXT.target.nom) + (retryNote ? ' (relance avec tous les codes incluse)' : '') +
        ' — élargissez le rayon' + (EXT.onlyFT ? ', décochez « French Tech uniquement »' : '') +
        ' ou reformulez le métier.</span>');
    }
  } else {
    // Succès : synthèse dans la zone détail
    extInfo('<span class="muted">✅ ' + comps.length + ' entreprise(s) recrutante(s)' +
      (comps.length < total ? ' affichée(s) sur ' + total : '') +
      (curatedCount ? ' · 🏆 ' + curatedCount + ' dans les listes curatées' : '') +
      (noCoords ? ' · ' + noCoords + ' sans coordonnées GPS (liste et fiche seulement, pas de marqueur)' : '') +
      (retryNote ? ' · 🔁 trouvées grâce à la relance avec tous les codes ROME' : '') +
      ' · 🎨 couleur des marqueurs : potentiel d\u2019embauche (rouge = faible → vert = fort).</span>');
    if (comps.length > EXT_MAX_LIST) {
      var p2 = document.createElement('p');
      p2.className = 'muted';
      p2.textContent = '+' + (comps.length - EXT_MAX_LIST) + ' autre(s) résultat(s) non affiché(s) — élargissez le rayon pour voir les marqueurs.';
      box.appendChild(p2);
    }
  }
  setStatus('Recherche étendue : ' + comps.length + ' entreprise(s) recrutante(s)');
  // marqueurs (uniquement les items avec coordonnées ; le reste reste dans la liste)
  if (!comps.length) return;
  EXT.markers = L.featureGroup();
  comps.slice(0, 600).forEach(function (c) {
    if (c.lat == null || c.lon == null) return; // sans coordonnées : pas de marqueur
    var cur = bySiren[c.siren];
    var m = L.circleMarker([c.lat, c.lon], {
      radius: cur ? 7 : 5, weight: cur ? 2 : 1, color: cur ? '#f59e0b' : '#0f172a',
      fillColor: extScoreColor(c), fillOpacity: 0.85
    });
    m.bindPopup(extPopupHtml(c, cur));
    m.addTo(EXT.markers);
    EXT.markerBySiren[c.siren] = m;
  });
  EXT.markers.addTo(map);
}

// ---------- Carte ----------
function extFrameZone() {
  if (EXT.circle) { map.removeLayer(EXT.circle); EXT.circle = null; }
  if (EXT.targetMk) { map.removeLayer(EXT.targetMk); EXT.targetMk = null; }
  if (!EXT.target) return;
  EXT.circle = L.circle(EXT.target.latlng, {
    radius: EXT.radius * 1000, weight: 1.5, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.06
  }).addTo(map);
  EXT.targetMk = L.circleMarker(EXT.target.latlng, {
    radius: 6, weight: 2, color: '#ffffff', fillColor: '#2563eb', fillOpacity: 1
  }).addTo(map);
  EXT.targetMk.bindTooltip(esc(EXT.target.nom) + ' — rayon ' + EXT.radius + ' km');
  map.fitBounds(EXT.circle.getBounds(), { padding: [30, 30] });
}
function extClearMap() {
  if (EXT.markers) { map.removeLayer(EXT.markers); EXT.markers = null; }
  EXT.markerBySiren = {};
  if (EXT.circle) { map.removeLayer(EXT.circle); EXT.circle = null; }
  if (EXT.targetMk) { map.removeLayer(EXT.targetMk); EXT.targetMk = null; }
}

// ---------- Initialisation UI ----------
function extInitUI() {
  if (EXT.uiReady) return;
  EXT.uiReady = true;
  var depSel = document.getElementById('extDep');
  Object.keys(DEP_FOLDERS).sort().forEach(function (d) {
    var o = document.createElement('option');
    o.value = d;
    o.textContent = d + ' — ' + coDepLabel(d);
    depSel.appendChild(o);
  });
  depSel.value = EXT.dep;
  depSel.addEventListener('change', function () { extSetDep(depSel.value); });

  var radSel = document.getElementById('extRadius');
  radSel.value = String(EXT.radius);
  radSel.addEventListener('change', function () { EXT.radius = parseInt(radSel.value, 10); });

  var sizeSel = document.getElementById('extSize');
  sizeSel.addEventListener('change', function () {
    EXT.size = sizeSel.value;
    if (EXT.lastLbb) extRenderResults(EXT.lastLbb, EXT.lastCurated); // re-render local
  });

  var ftCb = document.getElementById('extFTOnly');
  ftCb.addEventListener('change', function () {
    EXT.onlyFT = ftCb.checked;
    if (EXT.lastLbb) extRenderResults(EXT.lastLbb, EXT.lastCurated); // re-render local
  });

  var tin = document.getElementById('extTarget');
  var deb = null;
  tin.addEventListener('input', function () {
    clearTimeout(deb);
    if (!tin.value.trim()) { extTargetDropEl(false); return; }
    deb = setTimeout(function () { extTargetRender(extTargetSearch(tin.value)); }, 120);
  });
  tin.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      var m = extTargetSearch(tin.value);
      if (m.length) { extSetTarget(m[0].code, m[0].nom); extTargetDropEl(false); }
    } else if (ev.key === 'Escape') extTargetDropEl(false);
  });
  tin.addEventListener('blur', function () { setTimeout(function () { extTargetDropEl(false); }, 150); });
  tin.addEventListener('focus', function () {
    if (tin.value.trim()) extTargetRender(extTargetSearch(tin.value));
  });

  var txt = document.getElementById('extText');
  if (!txt.value.trim()) txt.value = 'intelligence artificielle'; // valeur par défaut à l'entrée du mode
  txt.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); extSearch(); }
  });
  document.getElementById('extSearchBtn').addEventListener('click', extSearch);

  // modal fiche (partagé avec le Composeur : les listeners sont posés par coInitUI
  // à l'entrée du mode corp ; on les pose ici aussi pour couvrir le cas corp jamais visité)
  document.getElementById('coFicheClose').addEventListener('click', coFicheClose);
  document.getElementById('coFicheDlg').addEventListener('click', function (ev) {
    if (ev.target === this) coFicheClose();
  });
}

function extSetDep(dep) {
  EXT.dep = dep;
  EXT.geo = null; EXT.target = null;
  EXT.lastLbb = null; EXT.lastCurated = null;
  document.getElementById('extTarget').value = '';
  extClearMap();
  extEnsureGeo().then(function () {
    if (!EXT.active) return;
    document.getElementById('levelTitle').textContent =
      'Recherche étendue — ' + coDepLabel(dep) + ' (' + dep + ')';
    document.getElementById('extStatus').textContent =
      'Entrez un métier en texte libre, choisissez une ville, puis « 🔎 Rechercher ».';
  }).catch(function (err) {
    console.error('[OpenFrance] Recherche étendue :', err);
    showError('Impossible de charger le département.', err.message);
  });
}

// ---------- Entrée / sortie du mode ----------
function extEnter() {
  EXT.active = true;
  extInitUI();
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('annControls').style.display = 'none';
  document.getElementById('annHint').style.display = 'none';
  document.getElementById('annQueryExp').style.display = 'none';
  document.getElementById('annPanel').style.display = 'none';
  document.getElementById('scoreControls').style.display = 'none';
  document.getElementById('coControls').style.display = 'none';
  document.getElementById('coModeHint').style.display = 'none';
  document.getElementById('coPanel').style.display = 'none';
  document.getElementById('extControls').style.display = 'flex';
  document.getElementById('extPanel').style.display = '';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent =
    'Recherche étendue — ' + coDepLabel(EXT.dep) + ' (' + EXT.dep + ')';
  state.view = 'france'; state.dep = null;
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  hideError();
  extSetDep(EXT.dep);
}

function extLeave() {
  EXT.active = false;
  EXT.seq++; // invalide les recherches en vol
  EXT.lastLbb = null; EXT.lastCurated = null;
  extTargetDropEl(false);
  extClearMap();
  EXT.metiers = [];
  if (typeof coFicheClose === 'function') coFicheClose();
  document.getElementById('extControls').style.display = 'none';
  document.getElementById('extPanel').style.display = 'none';
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('backBtn').hidden = true;
  document.getElementById('levelTitle').textContent = 'France — par département';
}

// ---------- Branchement UI (comme corp.js : écoute directe du select) ----------
function extInitWiring() {
  document.getElementById('categorySelect').addEventListener('change', function () {
    if (this.value === 'corp_ext') extEnter();
    else if (EXT.active) extLeave();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', extInitWiring);
} else {
  extInitWiring();
}
