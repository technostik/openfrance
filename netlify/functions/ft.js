// OpenFrance — Fonction Netlify : proxy France Travail (ROMEO v2, ROME 4.0, La Bonne Boite v2)
//
// Endpoints (GET, paramètre op) :
//   /ft/ft?op=romeo&text=...                            → codes ROME prédits (ROMEO v2, dédoublonnés)
//   /ft/ft?op=lbb&rome=M1806&lat=..&lon=..&dist=..      → entreprises recrutantes (LBB v2, normalisées)
//   /ft/ft?op=lbb_raw&rome=..&lat=..&lon=..&dist=..     → LBB v2 : réponse BRUTE (diagnostic)
//   /ft/ft?op=fiche&code=M1806                          → fiche métier ROME 4.0 (compétences)
//
// Secrets : FT_CLIENT_ID / FT_CLIENT_SECRET (variables d'environnement Netlify, jamais
// dans le repo). Chemins/scopes vérifiés empiriquement le 10/10/2026 (docs/ETAT-PROJET.md) :
//  - ROME fiches : /partenaire/rome-fiches-metiers/v1/fiches-rome/fiche-metier/<code>
//    (segment /fiches-rome/ obligatoire — sinon 404 ; scope sans nomenclatureRome → 403)
//  - LBB v2 : GET /partenaire/labonneboite/v2/recherche. Scope : le combiné
//    'search office api_labonneboitev2' d'abord (implémentation de référence testée en
//    prod), repli sur 'api_labonneboitev2' seul si le serveur OAuth refuse le combiné
//    (400 invalid_scope : scopes search/office non souscrits). Aucun token émissible →
//    {ok:false, code:'lbb_unavailable'} (le front dégrade proprement).
//    Paramètres : rome répétés (rome=A&rome=B), job (texte libre), latitude/longitude/
//    distance (]0;200[ km), page/page_size (max 100). 204 = aucun résultat.
//    rome = 3 premiers codes ROMEO, rome_all = tous les codes (optionnel) : si le
//    1er appel donne 0 résultat, UNE retentative automatique avec tous les codes
//    (champ 'retried:true' + 'romes' utilisés dans la réponse).
//  - Réponse LBB v2 : la doc officielle est inaccessible aux robots et la forme exacte des
//    items a varié selon les sources ({hits, items:[...]}, champs office_name/location…).
//    Le normalisateur ci-dessous est donc TOLÉRANT (plusieurs noms de champs pour la
//    liste, les coordonnées, le nom ; items sans coordonnées conservés — liste/fiche OK,
//    pas de marqueur). Si 0 item reconnu alors que hits > 0, la réponse inclut 'sample'
//    (extrait brut) + 'shape' (clés racine) pour diagnostiquer ; op=lbb_raw renvoie la
//    réponse brute complète (tronquée) pour le même effet côté navigateur.
//  - Throttles France Travail : ROMEO 350 ms, fiches ROME 1,1 s, LBB 550 ms.
//  - Les erreurs applicatives partent en HTTP 200 {ok:false} pour rester distinguables
//    des erreurs transport (réseau, 5xx, secrets manquants).

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API_BASE = 'https://api.francetravail.io/partenaire';
const SCOPES = {
  romeo: 'api_romeov2',
  fiches: 'api_rome-fiches-metiersv1 nomenclatureRome',
  lbb: 'search office api_labonneboitev2'
};
// Candidats de scope LBB, essayés dans l'ordre (repli si le combiné est refusé par l'OAuth).
const LBB_SCOPES = ['search office api_labonneboitev2', 'api_labonneboitev2'];
let lbbScope = null; // scope qui a produit un token (mémorisé)

// Cache de tokens par scope (par instance chaude de fonction) — expires_in ~ 25 min
const TOKENS = {};

async function getToken(scope) {
  const cached = TOKENS[scope];
  if (cached && Date.now() < cached.exp) return cached.value;
  if (!process.env.FT_CLIENT_ID || !process.env.FT_CLIENT_SECRET) {
    throw new Error("FT_CLIENT_ID / FT_CLIENT_SECRET manquants (variables d'environnement Netlify)");
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.FT_CLIENT_ID,
    client_secret: process.env.FT_CLIENT_SECRET,
    scope: scope
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Token France Travail HTTP ' + res.status + ' : ' + txt.slice(0, 200));
  const j = JSON.parse(txt);
  TOKENS[scope] = { value: j.access_token, exp: Date.now() + ((j.expires_in || 1499) - 60) * 1000 };
  return j.access_token;
}

// Throttle par famille (file séquentielle + intervalle mini entre départs)
const MIN_INTERVAL = { romeo: 350, fiches: 1100, lbb: 550 };
const lastCall = {};
const queues = {};
function waitTurn(family) {
  const prev = queues[family] || Promise.resolve();
  const job = prev.then(function () {
    const wait = Math.max(0, (lastCall[family] || 0) + MIN_INTERVAL[family] - Date.now());
    if (!wait) return;
    return new Promise(function (r) { setTimeout(r, wait); });
  }).then(function () { lastCall[family] = Date.now(); });
  queues[family] = job.catch(function () {});
  return job;
}

async function apiCall(path, family, opts) {
  await waitTurn(family);
  const token = await getToken((opts && opts.scope) || SCOPES[family]);
  const init = { method: (opts && opts.method) || 'GET', headers: { Authorization: 'Bearer ' + token } };
  if (opts && opts.payload) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.payload);
  }
  const res = await fetch(API_BASE + path, init);
  return { status: res.status, text: await res.text() };
}

async function opRomeo(params) {
  const text = String(params.text || '').slice(0, 300).trim();
  if (!text) return { ok: false, error: 'paramètre text requis' };
  const r = await apiCall('/romeo/v2/predictionMetiers', 'romeo', {
    method: 'POST',
    payload: {
      appellations: [{ intitule: text, identifiant: '1' }],
      options: { nbResultats: 10, nomAppelant: 'openfrance', toggleScorePrediction: true }
    }
  });
  if (r.status !== 200) {
    return { ok: false, code: 'ft_error', status: r.status, message: 'ROMEO indisponible', detail: r.text.slice(0, 300) };
  }
  const j = JSON.parse(r.text);
  // Dédoublonnage par code ROME (ROMEO peut renvoyer le même code plusieurs fois avec des
  // libellés différents) — on garde la 1re occurrence (meilleur score, liste triée).
  const seen = {};
  const metiers = [];
  ((((j && j[0]) || {}).metiersRome) || []).forEach(function (m) {
    const code = m && m.codeRome;
    if (!code || seen[code]) return;
    seen[code] = 1;
    metiers.push({ codeRome: code, libelleRome: m.libelleRome, scorePrediction: m.scorePrediction });
  });
  return { ok: true, metiers: metiers };
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function headcountText(min, max) {
  if (min === null && max === null) return '';
  if (min !== null && max !== null) return min === max ? (min + ' salariés') : (min + ' à ' + max + ' salariés');
  if (min !== null) return min + ' salariés et plus';
  return 'jusqu\'à ' + max + ' salariés';
}

// Trouve le tableau d'objets des résultats dans la réponse LBB, quel que soit le nom de la
// clé (items, companies, results, entreprises… ou 1er tableau d'objets trouvé à la racine).
function firstObjectArray(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return Array.isArray(j) ? j : null;
  const known = ['items', 'companies', 'results', 'entreprises'];
  for (let i = 0; i < known.length; i++) {
    if (Array.isArray(j[known[i]])) return j[known[i]];
  }
  for (const k in j) {
    if (Array.isArray(j[k]) && j[k].length && j[k][0] && typeof j[k][0] === 'object') return j[k];
  }
  return null;
}

// Normalise un item LBB v2 — tolérant sur les noms de champs (la forme exacte varie selon
// les sources : office_name/company_name, location{latitude,longitude}/lat-lon racine,
// emballage {company:{…}}…). Les items sans coordonnées sont CONSERVÉS (lat/lon null) :
// liste et fiche détaillées fonctionnent, seul le marqueur carte est absent.
function normalizeCompany(item) {
  let c = item;
  if (!c || typeof c !== 'object') return null;
  if (!c.siret && !c.siren && !c.office_name && !c.company_name && !c.name && !c.nom) {
    const inner = c.company || c.entreprise || c.etablissement;
    if (inner && typeof inner === 'object') c = inner;
  }
  const siret = String(c.siret || c.siret_etablissement || '').trim();
  const sirenRaw = String(c.siren || siret).trim();
  if (!/^\d{9,14}$/.test(sirenRaw)) return null; // ni SIREN ni SIRET : inexploitable
  const siren = sirenRaw.slice(0, 9);
  let loc = {};
  if (c.location && typeof c.location === 'object') loc = c.location;
  let lat = toNum(loc.latitude != null ? loc.latitude : loc.lat);
  if (lat == null) lat = toNum(c.latitude != null ? c.latitude : c.lat);
  if (lat == null && typeof c.location === 'string') lat = toNum(c.location.split(',')[0]);
  let lon = toNum(loc.longitude != null ? loc.longitude : (loc.lon != null ? loc.lon : loc.lng));
  if (lon == null) lon = toNum(c.longitude != null ? c.longitude : (c.lon != null ? c.lon : c.lng));
  if (lon == null && typeof c.location === 'string') lon = toNum(c.location.split(',')[1]);
  const potential = Number(c.hiring_potential != null ? c.hiring_potential : (c.potential != null ? c.potential : c.score_potentiel));
  const hcMin = intOrNull(c.headcount_min);
  const hcMax = intOrNull(c.headcount_max);
  // Code ROME ayant matché l'entreprise côté LBB (v2 : champ 'rome' par item) —
  // sert au sous-filtre local par métier et au lien vers la fiche ROME.
  const romeRaw = String(c.rome || c.codeRome || c.code_rome || c.rome_code || '').trim().toUpperCase();
  const score01 = isFinite(potential) ? Math.min(Math.max(potential, 0), 100) / 100 : 0;
  return {
    siren: siren,
    siret: siret,
    name: c.office_name || c.company_name || c.name || c.nom || c.raison_sociale || ('Entreprise ' + siren),
    naf: c.naf || '',
    nafText: c.naf_label || c.naf_text || '',
    city: c.city || c.ville || '',
    zipcode: c.postcode || c.zipcode || '',
    lat: lat, lon: lon,
    headcount: hcMin,
    headcountMax: hcMax,
    headcountText: headcountText(hcMin, hcMax),
    rome: /^[A-Z]\d{4}$/.test(romeRaw) ? romeRaw : '',
    score: Math.round(score01 * 1000) / 1000, // potentiel 0-1 (couleur marqueur : 0 rouge → 1 vert)
    // hiring_potential 0-100 → étoiles 0-5 (arrondi au dixième)
    stars: Math.round(score01 * 5 * 10) / 10
  };
}

async function lbbCall(rome, job, lat, lon, dist) {
  const qs = new URLSearchParams();
  qs.set('latitude', String(lat));
  qs.set('longitude', String(lon));
  qs.set('distance', String(dist));
  qs.set('page', '1');
  qs.set('page_size', '100');
  rome.forEach(function (c) { qs.append('rome', c); });
  if (job) qs.set('job', job);
  // Appel avec repli de scope : combiné 'search office api_labonneboitev2' d'abord ;
  // refus OAuth (400 invalid_scope) → retente api_labonneboitev2 seul (mémorisé).
  const path = '/labonneboite/v2/recherche?' + qs.toString();
  const candidates = lbbScope ? [lbbScope] : LBB_SCOPES.slice();
  const refused = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const r = await apiCall(path, 'lbb', { scope: candidates[i] });
      lbbScope = candidates[i];
      return { r: r, path: path };
    } catch (e) {
      const msg = String((e && e.message) || e);
      refused.push(msg.slice(0, 160));
      if (!/invalid_scope|Unknown\/invalid scope/i.test(msg)) throw e; // transport : on propage
    }
  }
  return { unavailable: refused };
}

function lbbNormalize(j) {
  const rawItems = firstObjectArray(j) || [];
  const total = Number(
    (j && j.hits != null) ? j.hits :
    (j && j.companies_count != null) ? j.companies_count :
    (j && j.total != null) ? j.total : rawItems.length
  );
  let noCoords = 0;
  const companies = rawItems.map(function (it) { return normalizeCompany(it); })
    .filter(function (c) {
      if (!c) return false;
      if (c.lat == null || c.lon == null) noCoords++;
      return true; // sans coordonnées : conservé (liste + fiche), pas de marqueur côté front
    });
  const out = { ok: true, companies: companies, total: total, count: rawItems.length, noCoords: noCoords };
  // Diagnostic : rien reconnu alors que LBB annonce des résultats → extraits pour débogage
  if (!companies.length && total > 0) {
    out.sample = JSON.stringify(j).slice(0, 1500);
    out.shape = j && typeof j === 'object' ? Object.keys(j).join(',') : typeof j;
  }
  return out;
}

async function opLbb(params, raw) {
  // v2 : au moins un critère job|rome requis ; rome en paramètres répétés.
  // Le front envoie rome = 3 premiers codes ROMEO et rome_all = tous les codes
  // prédits : si le 1er appel donne 0 résultat, on retente UNE fois avec tous
  // les codes (les codes très spécialisés type M1889 « IA » ont souvent 0 hit
  // alors que les codes voisins M1805/M1841 en ont des dizaines).
  const rome = String(params.rome || '').split(',').map(function (s) { return s.trim(); })
    .filter(Boolean).slice(0, 60);
  const romeAll = String(params.rome_all || '').split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && rome.indexOf(s) === -1; }).slice(0, 60);
  const job = String(params.job || '').slice(0, 100).trim();
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  const dist = Math.min(100, Math.max(1, parseInt(params.dist || '10', 10) || 10));
  if (!rome.length && !job) return { ok: false, error: 'critère requis (rome ou job)' };
  if (isNaN(lat) || isNaN(lon)) return { ok: false, error: 'paramètres lat, lon requis' };
  const first = await lbbCall(rome, job, lat, lon, dist);
  if (first.unavailable) {
    return {
      ok: false,
      code: 'lbb_unavailable',
      message: 'La Bonne Boite indisponible — token refusé pour les scopes essayés (' +
        first.unavailable.join(' / ') + '). Abonnement à valider sur francetravail.io.'
    };
  }
  const r = first.r;
  // Mode diagnostic : réponse brute (tronquée)
  if (raw) return { ok: true, status: r.status, url: first.path, raw: r.text.slice(0, 30000) };
  if (r.status === 403) {
    return {
      ok: false,
      code: 'lbb_unavailable',
      message: "La Bonne Boite indisponible (403 insufficient_scope — abonnement à valider sur francetravail.io)"
    };
  }
  if (r.status !== 200 && r.status !== 204) {
    return { ok: false, code: 'ft_error', status: r.status, message: 'La Bonne Boite a renvoyé HTTP ' + r.status, detail: r.text.slice(0, 300) };
  }
  let out = r.status === 204 ? { ok: true, companies: [], total: 0, count: 0, noCoords: 0 } : lbbNormalize(JSON.parse(r.text));
  out.romes = rome;
  out.retried = false;
  // 0 résultat avec les 3 premiers codes → une seule retentative avec tous les codes ROMEO
  if (out.total === 0 && !out.companies.length && romeAll.length) {
    const second = await lbbCall(rome.concat(romeAll), job, lat, lon, dist);
    if (!second.unavailable && (second.r.status === 200 || second.r.status === 204)) {
      out = second.r.status === 204
        ? { ok: true, companies: [], total: 0, count: 0, noCoords: 0 }
        : lbbNormalize(JSON.parse(second.r.text));
      out.romes = rome.concat(romeAll);
      out.retried = true;
    }
  }
  return out;
}

async function opFiche(params) {
  const code = String(params.code || '').trim().toUpperCase();
  // ROME 4.0 : codes A-Z + 4 chiffres (les prédictions ROMEO incluent des codes
  // en M/N/… — restreindre à A-K rejetait à tort la majorité des fiches).
  if (!/^[A-Z]\d{4}$/.test(code)) return { ok: false, error: 'paramètre code requis (format ROME, ex. M1806)' };
  const r = await apiCall('/rome-fiches-metiers/v1/fiches-rome/fiche-metier/' + encodeURIComponent(code), 'fiches');
  if (r.status !== 200) {
    return { ok: false, code: 'ft_error', status: r.status, message: 'Fiche ROME indisponible', detail: r.text.slice(0, 300) };
  }
  return { ok: true, fiche: JSON.parse(r.text) };
}

function json(obj, status) {
  return { statusCode: status || 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  const params = (event && event.queryStringParameters) || {};
  try {
    if (params.op === 'romeo') return json(await opRomeo(params));
    if (params.op === 'lbb') return json(await opLbb(params, false));
    if (params.op === 'lbb_raw') return json(await opLbb(params, true));
    if (params.op === 'fiche') return json(await opFiche(params));
    return json({ ok: false, error: 'op inconnu (romeo | lbb | lbb_raw | fiche)' }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
};
