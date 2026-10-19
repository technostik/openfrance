// OpenFrance — Fonction Netlify events.js : recherche unifiée d'évènements
// (catégorie « Évènements ») — OpenAgenda + Meetup (optionnel).
//
// Routes (via netlify.toml, redirect /events → /.netlify/functions/events) :
//   GET /events?op=sources                     → sources disponibles
//   GET /events?op=debug&q=&deps=&city=&days=  → diagnostic par agenda (total, échantillons)
//   GET /events?op=search&q=&deps=&city=&lat=&lon=&radius=&days=
//     - q      : texte/thématique (recherche OpenAgenda 'search', Meetup 'query')
//     - deps   : noms de départements séparés par des virgules (adminLevel2)
//     - city   : nom de ville (adminLevel4 + découverte d'agendas + Meetup)
//     - lat/lon/radius : ville cible (Meetup GraphQL, searchEvents par rayon)
//     - days   : horizon en jours (7/30/90/365 côté UI, défaut 30)
//
// Secrets (variables d'environnement, JAMAIS dans le repo) :
//   OPENAGENDA_KEY  — obligatoire (https://api.openagenda.com/v2, header 'key')
//   MEETUP_TOKEN    — optionnel (token OAuth Meetup, GraphQL api.meetup.com/gql)
//
// Contraintes fonctions Netlify (~10 s) : deadline 8,5 s, 20 agendas max,
// 2 pages/agenda, 8 requêtes en parallèle, 300 évènements max, cache mémoire
// de l'instance (découverte 12 h, résultats 20 min).
// Erreurs applicatives en HTTP 200 {ok:false} (convention du repo).
// Eventbrite écarté : la recherche publique d'évènements (GET /v3/events/search/)
// a été retirée par Eventbrite (annoncé 12/2019, effectif 02/2020).

var OA_BASE = 'https://api.openagenda.com/v2';
var EV_ENV = {
  key: process.env.OPENAGENDA_KEY || process.env.OPENAGENDA_API_KEY || '',
  meetupToken: process.env.MEETUP_TOKEN || ''
};

function evJson(body, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

// ---- Noyau : OpenAgenda (découverte d'agendas puis évènements) ----
// OpenAgenda v2 n'expose PAS de recherche globale d'évènements : on liste les
// agendas du territoire (GET /v2/agendas?search=…, tri par évènements récents)
// puis on interroge chaque agenda (GET /v2/agendas/{uid}/events) avec les
// filtres search / timings / adminLevel2 (départements, par nom) / adminLevel4
// (ville, par nom). Résultats fusionnés et dédoublonnés.
// Meetup (optionnel) : GraphQL api.meetup.com/gql, searchEvents autour de la
// ville cible — activé automatiquement si MEETUP_TOKEN est présent.

var EV_CAPS = { agendas: 20, pagesPerAgenda: 2, parallel: 8, deadlineMs: 8500, maxEvents: 300 };

// Cache mémoire de l'instance (chaude entre invocations) :
//  - découverte d'agendas : 12 h
//  - résultats de recherche : 20 min
var EV_CACHE = { disc: {}, res: {} };
function evCacheGet(store, key, ttl) {
  var e = store[key];
  if (!e) return null;
  if (Date.now() - e.t > ttl) { delete store[key]; return null; }
  return e.v;
}

function evStripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function evLoc(a) {
  var la = parseFloat(a.latitude), lo = parseFloat(a.longitude);
  if (isNaN(la) || isNaN(lo)) return null;
  return [la, lo];
}

async function oaFetch(url) {
  var r = await fetch(url, { headers: { 'Content-Type': 'application/json', 'key': EV_ENV.key, 'lang': 'fr' } });
  if (!r.ok) throw new Error('OpenAgenda HTTP ' + r.status);
  return r.json();
}

// Découverte des agendas d'un territoire (nom de ville ou de département)
async function discoverAgendas(term) {
  var key = 't:' + (term || '').toLowerCase();
  var hit = evCacheGet(EV_CACHE.disc, key, 12 * 3600 * 1000);
  if (hit) return hit;
  var url = OA_BASE + '/agendas?search=' + encodeURIComponent(term) +
    '&sort=recentlyAddedEvents.desc&size=50' +
    (EV_ENV.key ? '&key=' + encodeURIComponent(EV_ENV.key) : '');
  var js = await oaFetch(url);
  var items = js.items || js.agendas || js.data || [];
  var out = [];
  for (var i = 0; i < items.length && out.length < EV_CAPS.agendas; i++) {
    var a = items[i];
    var uid = a.uid || a.id;
    var title = a.title && a.title.fr ? a.title.fr : (a.title || a.slug || String(uid));
    if (uid != null) out.push({ uid: String(uid), title: evStripHtml(title) });
  }
  EV_CACHE.disc[key] = { t: Date.now(), v: out };
  return out;
}

// Normalisation d'un évènement OpenAgenda vers la forme commune
function normalizeOA(e, agendaTitle) {
  var title = e.title && (e.title.fr || e.title) || '';
  var desc = e.description && (e.description.fr || e.description) || '';
  var longDesc = e.longDescription && (e.longDescription.fr || e.longDescription) || '';
  var tim = (e.timings && e.timings.length) ? e.timings[0] : null;
  var start = tim && tim.begin ? tim.begin : (tim && tim.start || null);
  var end = tim && tim.end ? tim.end : null;
  var loc = e.location || {};
  return {
    id: 'oa:' + (e.uid || e.id),
    source: 'openagenda',
    agenda: agendaTitle,
    title: evStripHtml(title),
    desc: evStripHtml(desc || longDesc).slice(0, 400),
    start: start, end: end,
    latlng: evLoc(loc),
    city: evStripHtml(loc.city) || null,
    dept: evStripHtml(loc.adminLevel2) || null,
    region: evStripHtml(loc.adminLevel1) || null,
    url: e.url || 'https://openagenda.com/',
    tags: (e.tags || []).map ? (e.tags || []).slice(0, 8) : []
  };
}

// URL d'interrogation d'un agenda : filtres search / timings / adminLevel2 /
// adminLevel4 + curseur 'after[]'. NB (piège n°33) : timings[gte]/[lte]
// attendent des dates ISO 8601 (pas des epoch ms) et le curseur de pagination
// est la clé 'after' au premier niveau de la réponse (pas sous 'pagination').
function oaEventsUrl(agenda, params, after) {
  var base = OA_BASE + '/agendas/' + encodeURIComponent(agenda.uid) + '/events' +
    '?lang=fr&size=100&monolingual=fr' +
    (EV_ENV.key ? '&key=' + encodeURIComponent(EV_ENV.key) : '');
  if (params.q) base += '&search=' + encodeURIComponent(params.q);
  base += '&timings%5Bgte%5D=' + encodeURIComponent(new Date(Date.now() - 3600 * 1000).toISOString());
  base += '&timings%5Blte%5D=' + encodeURIComponent(new Date(Date.now() + params.days * 24 * 3600 * 1000).toISOString());
  (params.deps || []).forEach(function (d) {
    base += '&adminLevel2%5B%5D=' + encodeURIComponent(d);
  });
  if (params.city) base += '&adminLevel4%5B%5D=' + encodeURIComponent(params.city);
  if (after) {
    (after instanceof Array ? after : [after]).forEach(function (a) {
      base += '&after%5B%5D=' + encodeURIComponent(a);
    });
  }
  return base;
}

// Évènements d'un agenda, pagination par curseur 'after[]' (max 2 pages)
async function agendaEvents(agenda, params, deadline) {
  var out = [], after = null, page = 0;
  while (page < EV_CAPS.pagesPerAgenda) {
    if (Date.now() > deadline) break;
    var js;
    try { js = await oaFetch(oaEventsUrl(agenda, params, after)); } catch (err) { break; }
    var evs = js.events || [];
    for (var i = 0; i < evs.length; i++) out.push(normalizeOA(evs[i], agenda.title));
    after = js.after || null; // curseur au premier niveau de la réponse
    if (!after || evs.length === 0) break;
    page++;
  }
  return out;
}

// Meetup (GraphQL) — uniquement si MEETUP_TOKEN et ville cible (lat/lon)
async function meetupSearch(params) {
  if (!EV_ENV.meetupToken || params.lat == null || params.lon == null) return [];
  var body = JSON.stringify({
    query: 'query { searchEvents(first: 100, filterBy: { query: ' +
      JSON.stringify(params.q || '') + ', lat: ' + Number(params.lat) +
      ', lon: ' + Number(params.lon) + ', radius: ' + Number(params.radius || 25) +
      ' }) { edges { node { id title dateTime eventUrl description venue { city state } group { name } } } } }'
  });
  var r = await fetch('https://api.meetup.com/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + EV_ENV.meetupToken },
    body: body
  });
  if (!r.ok) throw new Error('Meetup HTTP ' + r.status);
  var js = await r.json();
  var edges = (js.data && js.data.searchEvents && js.data.searchEvents.edges) || [];
  var out = [];
  edges.forEach(function (ed) {
    var n = ed.node || {};
    var v = n.venue || {};
    out.push({
      id: 'mu:' + n.id,
      source: 'meetup',
      agenda: n.group && n.group.name ? n.group.name : 'Meetup',
      title: evStripHtml(n.title),
      desc: evStripHtml(n.description).slice(0, 400),
      start: n.dateTime || null, end: null,
      latlng: [Number(params.lat), Number(params.lon)], // position approximative (zone de recherche)
      city: evStripHtml(v.city) || params.city || null,
      dept: null, region: null,
      url: n.eventUrl || 'https://www.meetup.com/',
      tags: []
    });
  });
  return out;
}

// File à concurrence limitée (par lot de N promesses)
async function evRunLimited(tasks, n) {
  var out = new Array(tasks.length), idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      var i = idx++;
      try { out[i] = await tasks[i](); } catch (err) { out[i] = []; }
    }
  }
  var ws = [];
  for (var w = 0; w < Math.min(n, tasks.length); w++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

// ---- Recherche unifiée ----
async function eventsSearch(params) {
  var key = JSON.stringify([params.q, params.deps, params.city, params.lat,
    params.lon, params.radius, params.days]);
  var hit = evCacheGet(EV_CACHE.res, key, 20 * 60 * 1000);
  if (hit) return hit;
  var deadline = Date.now() + EV_CAPS.deadlineMs;
  var events = [], seen = {}, warnings = [];

  if (EV_ENV.key) {
    var term = params.city || (params.deps && params.deps[0]) || params.region || 'France';
    var agendas = [];
    try {
      agendas = await discoverAgendas(term);
      if ((!agendas || !agendas.length) && params.deps && params.deps.length) {
        // ville sans agenda dédié → découverte sur le département
        agendas = await discoverAgendas(params.deps[0]);
      }
    } catch (err) {
      warnings.push('OpenAgenda (découverte) : ' + err.message);
    }
    if (agendas && agendas.length) {
      var tasks = agendas.map(function (a) {
        return function () { return agendaEvents(a, params, deadline); };
      });
      var pages = await evRunLimited(tasks, EV_CAPS.parallel);
      pages.forEach(function (evs) {
        (evs || []).forEach(function (ev) {
          if (!ev.title || seen[ev.id]) return;
          seen[ev.id] = 1; events.push(ev);
        });
      });
    }
  } else {
    warnings.push('OPENAGENDA_KEY absente : configurez la variable d\'environnement.');
  }

  try {
    var mu = await meetupSearch(params);
    (mu || []).forEach(function (ev) {
      if (!ev.title || seen[ev.id]) return;
      seen[ev.id] = 1; events.push(ev);
    });
  } catch (err) {
    warnings.push('Meetup : ' + err.message);
  }

  events.sort(function (a, b) {
    var da = a.start ? new Date(a.start).getTime() : Infinity;
    var db = b.start ? new Date(b.start).getTime() : Infinity;
    return da - db;
  });
  if (events.length > EV_CAPS.maxEvents) events = events.slice(0, EV_CAPS.maxEvents);

  var res = {
    ok: true,
    events: events,
    sources: {
      openagenda: !!EV_ENV.key,
      meetup: !!EV_ENV.meetupToken
    },
    warnings: warnings,
    cachedAt: Date.now()
  };
  EV_CACHE.res[key] = { t: Date.now(), v: res };
  return res;
}

// Paramètres normalisés depuis la query string (op, q, deps, city, lat, lon, radius, days)
function evParseParams(query) {
  function one(k, def) {
    var v = query[k];
    return v == null ? def : String(v);
  }
  return {
    q: one('q', '').trim(),
    deps: String(one('deps', '')).split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; }).slice(0, 12),
    city: one('city', '').trim() || null,
    lat: one('lat') ? parseFloat(one('lat')) : null,
    lon: one('lon') ? parseFloat(one('lon')) : null,
    radius: Math.max(1, Math.min(100, parseInt(one('radius', '25'), 10) || 25)),
    days: Math.max(1, Math.min(365, parseInt(one('days', '30'), 10) || 30))
  };
}

// ---- Diagnostic (op=debug) : découverte + détail par agenda ----
async function eventsDebug(params) {
  var out = {
    ok: true,
    keyPresent: !!EV_ENV.key,
    term: params.city || (params.deps && params.deps[0]) || 'France',
    agendasFound: 0, agendas: [], warnings: []
  };
  var agendas = [];
  try {
    agendas = await discoverAgendas(out.term);
    if ((!agendas || !agendas.length) && params.deps && params.deps.length) {
      out.termFallback = params.deps[0];
      agendas = await discoverAgendas(params.deps[0]);
    }
  } catch (err) {
    out.warnings.push('OpenAgenda (découverte) : ' + (err && err.message ? err.message : String(err)));
  }
  out.agendasFound = agendas.length;
  out.agendas = await evRunLimited(agendas.slice(0, EV_CAPS.agendas).map(function (a) {
    return function () {
      return oaFetch(oaEventsUrl(a, params, null)).then(function (js) {
        var evs = js.events || [];
        return {
          uid: a.uid, title: a.title,
          total: (js.total == null ? evs.length : js.total), got: evs.length,
          after: js.after || null,
          url: oaEventsUrl(a, params, null).replace(/([?&])key=[^&]+/, '$1key=***'),
          sample: evs.slice(0, 3).map(function (e) { return (e.title && (e.title.fr || e.title)) || ''; })
        };
      }).catch(function (err) {
        return { uid: a.uid, title: a.title, error: String((err && err.message) || err) };
      });
    };
  }), EV_CAPS.parallel);
  return out;
}

// ---- Handler Netlify ----
exports.handler = async function (event) {
  var query = event.queryStringParameters || {};
  try {
    if (String(query.op || '') === 'sources') {
      return evJson({
        ok: true,
        sources: [
          { id: 'openagenda', label: 'OpenAgenda', ready: !!EV_ENV.key },
          { id: 'meetup', label: 'Meetup', ready: !!EV_ENV.meetupToken }
        ]
      });
    }
    if (String(query.op || '') === 'debug') {
      return evJson(await eventsDebug(evParseParams(query)));
    }
    var params = evParseParams(query);
    var res = await eventsSearch(params);
    return evJson(res);
  } catch (err) {
    return evJson({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
