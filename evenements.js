// OpenFrance — Évènements : recherche unifiée par thématique sur un territoire
// (département / zone multi-départements, ou ville + rayon).
//
// Sources (via la fonction /events, cf. netlify/functions/events.js) :
//  - OpenAgenda v2 : découverte des agendas du territoire puis évènements de
//    chaque agenda (search / timings / adminLevel2 = département par nom /
//    adminLevel4 = ville par nom), fusion dédoublonnée.
//  - Meetup (optionnel, activé si MEETUP_TOKEN est configuré côté serveur) :
//    GraphQL searchEvents autour de la ville cible.
//  - Eventbrite écarté : la recherche publique d'évènements a été retirée par
//    Eventbrite (annoncé 12/2019, effectif 02/2020).
//
// Architecture :
//  - Cache navigateur en 2 niveaux, comme le reste du site : mémoire (RAM, la
//    durée de la session) + IndexedDB (openfrance-annuaire, clés « ev|… », TTL 1 h)
//    — visible/supprimable dans la page 🗂 Cache (branche générique d'annuaire.js).
//  - Le service worker ne met PAS /events en cache (données dynamiques).
//  - Recherche texte locale multi-opérateurs (parseAnnQuery/annMatch de
//    annuaire.js) appliquée au-dessus des résultats serveur, plus filtre
//    ville/rayon local (distKm, app.js) — re-render sans nouvel appel.
//  - Marqueurs par différence (modèle annuaire.js, mkSpreadApply pour les
//    évènements co-localisés) ; clic liste = popup sur la carte (piège n°29).
//  - Auto-câblage comme annuaire.js : listener propre sur #categorySelect
//    (evEnter/evLeave), aucune modification des autres modules.

var EV = {
  active: false,
  prevRefresh: null,
  cache: {},          // clé de recherche -> { events, date } (mémoire)
  last: null,         // dernière réponse serveur { events, sources, warnings }
  key: null,          // clé de la dernière recherche serveur
  showing: [],        // évènements filtrés affichés
  markers: null,      // featureGroup des marqueurs courants
  markerIndex: {},    // clé marqueur ('ev:<id>') -> marker Leaflet (maj par différence)
  spread: null,
  target: null,       // ville cible { code, nom, latlng } (null = pas de filtre)
  circle: null, cityMk: null,
  sources: null,      // op=sources (diagnostic : clés configurées ou non)
  seq: 0
};

var EV_URL = '/events';

// ---------- Zone ----------
function evZoneDeps() {
  var z = (state.zone || []).filter(function (d) { return !!DEP_FOLDERS[d]; });
  if (z.length) return z;
  return (state.view === 'dep' && state.dep && state.dep.code) ? [state.dep.code] : [];
}

// ---------- Contours de communes de la zone ----------
// annZoneCentroids()/annCityListZone() (annuaire.js) lisent state.communesGeo[dep]
// SANS le charger : l'annuaire le fait dans son propre annRefresh, pas le mode
// Évènements — il faut donc garantir le chargement avant tout usage (sinon crash
// « reading 'features' » au clic sur un département, piège n°32).
function evEnsureZoneGeo(deps) {
  return Promise.all(deps.map(function (code) {
    if (state.communesGeo[code]) return Promise.resolve(state.communesGeo[code]);
    return fetchJSONCached('/geo/communes/departements/' + DEP_FOLDERS[code] +
      '/communes-' + DEP_FOLDERS[code] + '.geojson')
      .then(function (g) { state.communesGeo[code] = g; return g; });
  }));
}


// ---------- Recherche serveur (RAM → IndexedDB → fonction /events) ----------
function evParams() {
  var deps = evZoneDeps().map(depNom);
  var days = parseInt(document.getElementById('evPeriod').value, 10) || 30;
  var q = document.getElementById('evSearch').value.trim();
  var out = {
    q: q, deps: deps, days: days, city: null,
    lat: null, lon: null, radius: 0
  };
  if (EV.target) {
    out.city = EV.target.nom;
    out.lat = EV.target.latlng[0];
    out.lon = EV.target.latlng[1];
    out.radius = parseInt(document.getElementById('evRadius').value, 10) || 0;
  }
  return out;
}
function evParamsKey(p) {
  return 'ev|' + [p.q, p.deps.join(','), p.city || '', p.days, p.radius].join('|');
}
function evQs(p) {
  var parts = ['op=search', 'days=' + p.days];
  if (p.q) parts.push('q=' + encodeURIComponent(p.q));
  if (p.deps.length) parts.push('deps=' + encodeURIComponent(p.deps.join(',')));
  if (p.city) {
    parts.push('city=' + encodeURIComponent(p.city));
    parts.push('lat=' + p.lat + '&lon=' + p.lon);
    parts.push('radius=' + Math.max(1, p.radius || 5));
  }
  return parts.join('&');
}
function evFetch(p) {
  var key = evParamsKey(p);
  if (EV.cache[key] && Date.now() - EV.cache[key].date < 60 * 60 * 1000) {
    return Promise.resolve(EV.cache[key].events);
  }
  return idbGet(key).then(function (cached) {
    if (cached && cached.events && Date.now() - cached.date < 60 * 60 * 1000) {
      EV.cache[key] = cached;
      return cached.events;
    }
    return fetch(EV_URL + '?' + evQs(p)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (js) {
      if (!js || js.ok !== true) throw new Error((js && js.error) || 'Réponse invalide');
      var rec = { events: js, date: Date.now() };
      EV.cache[key] = rec;
      idbSet(key, rec); // best effort, clé « ev|… » visible dans la page 🗂 Cache
      return js;
    });
  });
}

// ---------- Sources disponibles (diagnostic clés API) ----------
function evLoadSources() {
  if (EV.sources) return Promise.resolve(EV.sources);
  return fetch(EV_URL + '?op=sources').then(function (r) { return r.json(); })
    .then(function (js) {
      if (js && js.ok) { EV.sources = js.sources; return js.sources; }
      return null;
    }).catch(function () { return null; });
}

// ---------- Filtrage local + rendu ----------
function evHaystack(ev) {
  if (!ev._h) {
    ev._h = normTxt([ev.title, ev.desc, ev.city, ev.dept, ev.agenda,
      (ev.tags || []).join(' ')].join(' '));
  }
  return ev._h;
}
function evInTarget(ev, target, radius) {
  if (!target) return true;
  var sameCity = ev.city && normTxt(ev.city).indexOf(normTxt(target.nom)) !== -1;
  if (radius <= 0) return sameCity; // « dans la ville »
  if (ev.latlng) return distKm(ev.latlng, target.latlng) <= radius;
  return sameCity; // sans coordonnées : gardé si la ville du texte correspond
}
function evApplySearch() {
  if (!EV.active) return;
  var q = parseAnnQuery(document.getElementById('evSearch').value.trim());
  var radius = EV.target ? (parseInt(document.getElementById('evRadius').value, 10) || 0) : 0;
  var entries = [];
  (EV.last && EV.last.events ? EV.last.events : []).forEach(function (ev) {
    if (!ev.title) return;
    if (q.req.length || q.or.length || q.neg.length) {
      if (!annMatch(evHaystack(ev), q)) return;
    }
    if (!evInTarget(ev, EV.target, radius)) return;
    entries.push(ev);
  });
  EV.showing = entries;
  // explication de la requête (comme l'annuaire)
  var expEl = document.getElementById('evQueryExp');
  var terms = document.getElementById('evSearch').value.trim();
  if (terms && expEl) {
    var pool = q.req.concat(q.or);
    expEl.innerHTML = '🔎 ' + (q.or.length
      ? 'AU MOINS UN de : ' + pool.map(esc).join(' / ')
      : 'tous les mots : ' + pool.map(esc).join(' / ')) +
      (q.neg.length ? ' — sauf : ' + q.neg.map(esc).join(' / ') : '') +
      ' <span class="muted">(filtre local sur ' + entries.length + ' évènement(s))</span>';
    expEl.style.display = '';
  } else if (expEl) {
    expEl.innerHTML = ''; expEl.style.display = 'none';
  }
  evSyncMarkers(evMarkerEntries(entries));
  evRenderList(entries);
  var st = document.getElementById('evStatus');
  if (EV.last && EV.last.warnings && EV.last.warnings.length) {
    st.innerHTML = entries.length + ' évènement(s) affiché(s) — ⚠️ ' +
      esc(EV.last.warnings.join(' · '));
  } else {
    st.textContent = entries.length + ' évènement(s) affiché(s)' +
      (EV.last && EV.last.sources ? (EV.last.sources.meetup ? ' (OpenAgenda + Meetup)' : ' (OpenAgenda)') : '');
  }
}

// ---------- Marqueurs ----------
function evColor(ev) { return ev.source === 'meetup' ? '#f59e0b' : '#a78bfa'; }
function evPopup(ev) {
  var html = '<div style="max-width:260px"><b>' + esc(ev.title) + '</b><br>' +
    '<span class="muted">' + esc(ev.agenda || '') + ' · ' + evFmtDate(ev) + '</span>';
  if (ev.city) html += '<br>📍 ' + esc(ev.city);
  if (ev.desc) html += '<br><span class="muted">' + esc(ev.desc.slice(0, 200)) + '…</span>';
  html += '<br><a href="' + esc(ev.url) + '" target="_blank" rel="noopener">Voir l\'évènement ↗</a></div>';
  return html;
}
function evMarkerEntries(entries) {
  var out = [];
  entries.forEach(function (ev) {
    if (!ev.latlng) return;
    out.push({
      key: 'ev:' + ev.id, rec: ev, latlng: ev.latlng,
      color: evColor(ev), popup: evPopup(ev)
    });
  });
  return out;
}
function evEnsureLayer() {
  if (!EV.markers) EV.markers = L.featureGroup().addTo(map);
  return EV.markers;
}
function evSyncMarkers(entries) {
  var group = evEnsureLayer();
  var wanted = {};
  entries.forEach(function (en) { wanted[en.key] = en; });
  // 1. retire les marqueurs qui ne sont plus dans les résultats
  for (var k in EV.markerIndex) {
    if (!wanted[k]) { group.removeLayer(EV.markerIndex[k]); delete EV.markerIndex[k]; }
  }
  // 2. crée uniquement les marqueurs manquants
  var spreadItems = [];
  entries.forEach(function (en) {
    if (!EV.markerIndex[en.key]) {
      var m = L.circleMarker(en.latlng, {
        radius: 5, weight: 1, color: '#0f172a', fillColor: en.color, fillOpacity: 0.85
      });
      m.bindPopup(en.popup);
      m.addTo(group);
      EV.markerIndex[en.key] = m;
    }
    en.rec._marker = EV.markerIndex[en.key];
    // plusieurs évènements peuvent partager la même position (même lieu)
    spreadItems.push({ m: EV.markerIndex[en.key], base: en.latlng });
  });
  // 3. écarte en spirale les marqueurs co-localisés (mécanisme généralisé, app.js)
  EV.spread = mkSpreadApply(spreadItems);
}
function evClearMarkers() {
  if (EV.markers) { map.removeLayer(EV.markers); EV.markers = null; }
  if (EV.circle) { map.removeLayer(EV.circle); EV.circle = null; }
  if (EV.cityMk) { map.removeLayer(EV.cityMk); EV.cityMk = null; }
  EV.showing = [];
  EV.markerIndex = {};
  EV.spread = null;
  mkSpreadClear();
}

// ---------- Liste ----------
var EV_MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
var EV_JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
function evFmtDate(ev) {
  if (!ev.start) return 'date à confirmer';
  var d = new Date(ev.start);
  if (isNaN(d.getTime())) return String(ev.start);
  var out = EV_JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + EV_MOIS[d.getMonth()];
  var h = d.getHours(), mn = d.getMinutes();
  if (h || mn) out += ' · ' + (h < 10 ? '0' : '') + h + 'h' + (mn < 10 ? '0' : '') + (mn || '00');
  return out;
}
function evRenderList(entries) {
  var el = document.getElementById('evResults');
  if (!entries.length) {
    el.innerHTML = '<p class="muted">Aucun évènement. Élargissez la période, changez de mots-clés, ou vérifiez la clé OpenAgenda (voir la note dans le statut).</p>';
    return;
  }
  var html = '';
  entries.slice(0, 300).forEach(function (ev) {
    html += '<div class="ann-row ev-row" data-evid="' + esc(ev.id) + '">' +
      '<b>' + esc(ev.title) + '</b>' +
      '<div class="ann-obj">' + esc(ev.agenda || '') + ' — ' + evFmtDate(ev) +
      (ev.city ? ' · 📍 ' + esc(ev.city) : '') + '</div></div>';
  });
  el.innerHTML = html;
  Array.prototype.forEach.call(el.querySelectorAll('.ev-row'), function (row) {
    row.addEventListener('click', function () {
      var id = row.getAttribute('data-evid');
      for (var i = 0; i < EV.showing.length; i++) {
        if (EV.showing[i].id === id) {
          var ev = EV.showing[i];
          if (ev._marker && ev.latlng) {
            map.panTo(ev.latlng);
            ev._marker.openPopup();
          } else if (ev.url) {
            window.open(ev.url, '_blank', 'noopener');
          }
          return;
        }
      }
    });
  });
}

// ---------- Vue France ----------
function evRenderFrance() {
  document.getElementById('evStatus').textContent =
    'Cliquez sur un département (ou définissez une zone) pour chercher des évènements.';
  document.getElementById('evResults').innerHTML = '';
  document.getElementById('levelTitle').textContent = 'Évènements — France';
}

// ---------- Recherche principale ----------
function evRefresh() {
  hideError();
  evClearMarkers();
  if (state.view === 'france' || !state.dep) { evRenderFrance(); return; }
  var deps = evZoneDeps();
  if (!deps.length) { evRenderFrance(); return; }
  var zoneLbl = zoneLabel(deps);
  document.getElementById('backBtn').hidden = false;
  document.getElementById('levelTitle').textContent = 'Évènements — ' + zoneLbl;
  var seq = ++EV.seq;
  setStatus('⏳ Recherche d\'évènements…', 'loading');
  document.getElementById('evStatus').textContent =
    '⏳ Interrogation d\'OpenAgenda (agendas de ' + zoneLbl + ')…';
  var p = evParams();
  EV.key = evParamsKey(p);
  Promise.all([evFetch(p), evEnsureZoneGeo(deps)]).then(function (res) {
    if (seq !== EV.seq) return; // réponse obsolète
    var js = res[0];
    EV.last = js;
    // recadrage : ville cible si définie, sinon la zone
    if (EV.target) {
      evFrameZone();
    } else {
      var centZ = annZoneCentroids(deps);
      var xs = [], ys = [];
      for (var k in centZ) { xs.push(centZ[k][1]); ys.push(centZ[k][0]); }
      if (xs.length) map.fitBounds([[Math.min.apply(null, ys), Math.min.apply(null, xs)], [Math.max.apply(null, ys), Math.max.apply(null, xs)]], { padding: [30, 30] });
    }
    evApplySearch();
    setStatus(EV.showing.length + ' évènement(s) — ' + zoneLbl);
    evLoadSources().then(function (srcs) {
      if (!srcs) return;
      var oa = null, mu = null;
      srcs.forEach(function (s) { if (s.id === 'openagenda') oa = s; if (s.id === 'meetup') mu = s; });
      var stEl = document.getElementById('evStatus');
      if (oa && !oa.ready) {
        stEl.innerHTML = '⚠️ OPENAGENDA_KEY absente côté serveur : ajoutez-la dans .env (netlify dev) ou dans les variables d\'environnement Netlify.';
      } else if (mu && !mu.ready) {
        stEl.innerHTML = esc(stEl.textContent) + ' <span class="muted">(MEETUP_TOKEN absent : Meetup désactivé)</span>';
      }
    });
    if (document.getElementById('annCacheDlg').style.display !== 'none') renderCachePage();
  }).catch(function (err) {
    if (seq !== EV.seq) return;
    console.error('[OpenFrance] Évènements :', err);
    setStatus('Erreur évènements');
    showError('Impossible de charger les évènements.', err.message);
    document.getElementById('evStatus').textContent = 'Erreur : ' + err.message;
  });
}

// ---------- Ville cible (autocomplete réutilisé de l'annuaire) ----------
function evCityDropEl(show) {
  var d = document.getElementById('evCityDrop');
  d.style.display = show ? 'block' : 'none';
  if (!show) d.innerHTML = '';
}
function evCityRender(matches) {
  var d = document.getElementById('evCityDrop');
  d.innerHTML = '';
  matches.forEach(function (m) {
    var row = document.createElement('div');
    row.innerHTML = esc(m.nom) + ' <span class="muted">(' + m.code + ')</span>';
    row.addEventListener('mousedown', function (e) {
      e.preventDefault();
      evSetTarget(m.code, m.nom);
      evCityDropEl(false);
    });
    d.appendChild(row);
  });
  d.style.display = matches.length ? 'block' : 'none';
}
function evSetTarget(code, nom) {
  var c = annZoneCentroids(evZoneDeps())[code];
  if (!c) return;
  EV.target = { code: code, nom: nom, latlng: c };
  document.getElementById('evCity').value = nom;
  evFrameZone();
  evRefresh(); // la ville change les filtres serveur (adminLevel4, Meetup)
}
function evClearTarget() {
  if (EV.circle) { map.removeLayer(EV.circle); EV.circle = null; }
  if (EV.cityMk) { map.removeLayer(EV.cityMk); EV.cityMk = null; }
  if (!EV.target) return;
  EV.target = null;
  evRefresh();
}
function evFrameZone() {
  if (EV.circle) { map.removeLayer(EV.circle); EV.circle = null; }
  if (EV.cityMk) { map.removeLayer(EV.cityMk); EV.cityMk = null; }
  if (!EV.target) return;
  var radius = parseInt(document.getElementById('evRadius').value, 10) || 0;
  EV.cityMk = L.circleMarker(EV.target.latlng, {
    radius: 6, weight: 2, color: '#ffffff', fillColor: '#a78bfa', fillOpacity: 1
  }).addTo(map);
  EV.cityMk.bindTooltip(esc(EV.target.nom) + (radius ? ' — rayon ' + radius + ' km' : ''));
  if (radius > 0) {
    EV.circle = L.circle(EV.target.latlng, {
      radius: radius * 1000, weight: 1.5, color: '#a78bfa', fillColor: '#a78bfa', fillOpacity: 0.06
    }).addTo(map);
    map.fitBounds(EV.circle.getBounds(), { padding: [30, 30] });
  } else {
    map.setView(EV.target.latlng, 12);
  }
}

// ---------- Entrée/sortie de catégorie ----------
function evEnter() {
  EV.active = true;
  EV.prevRefresh = refresh;
  refresh = evRefresh; // openDepartment/backToFrance appellent refresh()
  document.getElementById('evControls').style.display = 'flex';
  document.getElementById('evHint').style.display = '';
  document.getElementById('indicatorLabel').style.display = 'none';
  document.getElementById('yearLabel').style.display = 'none';
  document.getElementById('legendBlock').style.display = 'none';
  document.getElementById('evPanel').style.display = '';
  var zIn = (state.zone || []).filter(function (d) { return !!DEP_FOLDERS[d]; });
  if (!zIn.length && state.view === 'dep' && state.dep) zIn = [state.dep.code];
  if (zIn.length) {
    state.zone = zIn;
    state.view = 'dep';
    state.dep = { code: zIn[0], nom: depNom(zIn[0]) };
    document.getElementById('backBtn').hidden = false;
    document.getElementById('levelTitle').textContent = 'Évènements — ' + zoneLabel(zIn);
  } else {
    state.view = 'france'; state.dep = null;
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'Évènements — France';
  }
  // Rafraîchissement différé : les listeners des autres catégories restituent
  // la zone APRÈS evEnter (ordre des listeners, bug n°27).
  setTimeout(evRefresh, 0);
}
function evLeave() {
  EV.active = false;
  if (EV.prevRefresh) refresh = EV.prevRefresh;
  evClearMarkers();
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  document.getElementById('evControls').style.display = 'none';
  document.getElementById('evHint').style.display = 'none';
  var expEl = document.getElementById('evQueryExp');
  expEl.innerHTML = ''; expEl.style.display = 'none';
  document.getElementById('indicatorLabel').style.display = '';
  document.getElementById('legendBlock').style.display = '';
  document.getElementById('evPanel').style.display = 'none';
  // Restaure le titre correspondant au territoire conservé (app.js gère la suite)
  if (state.view === 'dep' && state.dep) {
    document.getElementById('levelTitle').textContent =
      ((state.zone && state.zone.length) ? zoneLabel(state.zone) : state.dep.nom + ' (' + state.dep.code + ')') + ' — par commune';
  } else {
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'France — par département';
  }
}

// ---------- Branchement UI ----------
function evInitUI() {
  var catSel = document.getElementById('categorySelect');
  catSel.addEventListener('change', function () {
    if (this.value === 'evenements') evEnter(); else if (EV.active) evLeave();
  });

  var searchEl = document.getElementById('evSearch');
  var debounce = null;
  searchEl.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(evApplySearch, 300); // re-filtre local, pas d'appel serveur
  });
  searchEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(debounce); evRefresh(); }
  });
  document.getElementById('evSearchBtn').addEventListener('click', function () {
    clearTimeout(debounce); evRefresh();
  });
  document.getElementById('evPeriod').addEventListener('change', evRefresh);

  // Filtre ville : autocomplete sur les communes de la zone (annuaire.js réutilisé)
  var cityIn = document.getElementById('evCity');
  var cityDeb = null;
  cityIn.addEventListener('input', function () {
    clearTimeout(cityDeb);
    if (!cityIn.value.trim()) { evCityDropEl(false); evClearTarget(); return; }
    cityDeb = setTimeout(function () {
      var dz = evZoneDeps();
      evEnsureZoneGeo(dz).then(function () { // contours requis par annCityListZone
        annCityListZone(dz); // peuple ANN.cities pour annCitySearch
        evCityRender(annCitySearch(cityIn.value));
      }).catch(function (err) {
        console.warn('[OpenFrance] Autocomplete ville évènements :', err);
        evCityRender([]);
      });
    }, 120);
  });
  cityIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var dz = evZoneDeps();
      evEnsureZoneGeo(dz).then(function () {
        annCityListZone(dz);
        var m = annCitySearch(cityIn.value);
        if (m.length) { evSetTarget(m[0].code, m[0].nom); evCityDropEl(false); }
      });
    } else if (e.key === 'Escape') evCityDropEl(false);
  });
  cityIn.addEventListener('blur', function () { setTimeout(function () { evCityDropEl(false); }, 150); });
  cityIn.addEventListener('focus', function () {
    if (cityIn.value.trim()) {
      var dz = evZoneDeps();
      evEnsureZoneGeo(dz).then(function () {
        annCityListZone(dz);
        evCityRender(annCitySearch(cityIn.value));
      });
    }
  });
  document.getElementById('evRadius').addEventListener('change', function () {
    if (EV.target) evRefresh(); // le rayon change les filtres serveur (Meetup)
    else evApplySearch();
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', evInitUI);
}
