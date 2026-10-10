// OpenFrance — Fonction Netlify : proxy France Travail (ROMEO v2, ROME 4.0, La Bonne Boite v2)
//
// Endpoints (GET, paramètre op) :
//   /ft/ft?op=romeo&text=...                            → codes ROME prédits (ROMEO v2)
//   /ft/ft?op=lbb&rome=M1806&lat=..&lon=..&dist=..      → entreprises recrutantes (LBB v2)
//   /ft/ft?op=fiche&code=M1806                          → fiche métier ROME 4.0 (compétences)
//
// Secrets : FT_CLIENT_ID / FT_CLIENT_SECRET (variables d'environnement Netlify, jamais
// dans le repo). Chemins/scopes vérifiés empiriquement le 10/10/2026 (docs/ETAT-PROJET.md) :
//  - ROME fiches : /partenaire/rome-fiches-metiers/v1/fiches-rome/fiche-metier/<code>
//    (segment /fiches-rome/ obligatoire — sinon 404 ; scope sans nomenclatureRome → 403)
//  - LBB v2 : GET /partenaire/labonneboite/v2/recherche — le token doit porter le scope
//    'search office api_labonneboitev2' (api_labonneboitev2 SEUL → 403 insufficient_scope).
//    Paramètres : rome répétés (rome=A&rome=B, pas de rome_codes), job (texte libre),
//    latitude/longitude/distance (]0;200[ km), page/page_size (max 100, LBB plafonne à 100).
//    Réponse : {hits, items:[{siret, office_name, company_name, naf, naf_label,
//    location{latitude,longitude}, city, postcode, headcount_min/max, hiring_potential 0-100}]}
//    204 = aucun résultat ; 403 → {ok:false, code:'lbb_unavailable'} (dégradation côté front).
//  - Throttles France Travail : ROME 1/s, LBB 2/s, ROMEO 3/s (file séquentielle ci-dessous)
//  - Les erreurs applicatives partent en HTTP 200 {ok:false} pour rester distinguables
//    des erreurs transport (réseau, 5xx, secrets manquants).

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API_BASE = 'https://api.francetravail.io/partenaire';
const SCOPES = {
  romeo: 'api_romeov2',
  fiches: 'api_rome-fiches-metiersv1 nomenclatureRome',
  lbb: 'search office api_labonneboitev2'
};

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
  const token = await getToken(SCOPES[family]);
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
  const metiers = (((j && j[0]) || {}).metiersRome || []).map(function (m) {
    return { codeRome: m.codeRome, libelleRome: m.libelleRome, scorePrediction: m.scorePrediction };
  });
  return { ok: true, metiers: metiers };
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function headcountText(min, max) {
  if (min === null && max === null) return '';
  if (min !== null && max !== null) return min === max ? (min + ' salariés') : (min + ' à ' + max + ' salariés');
  if (min !== null) return min + ' salariés et plus';
  return 'jusqu\'à ' + max + ' salariés';
}

async function opLbb(params) {
  // v2 : au moins un critère job|rome requis ; rome en paramètres répétés
  const rome = String(params.rome || '').split(',').map(function (s) { return s.trim(); })
    .filter(Boolean).slice(0, 60);
  const job = String(params.job || '').slice(0, 100).trim();
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  const dist = Math.min(100, Math.max(1, parseInt(params.dist || '10', 10) || 10));
  if (!rome.length && !job) return { ok: false, error: 'critère requis (rome ou job)' };
  if (isNaN(lat) || isNaN(lon)) return { ok: false, error: 'paramètres lat, lon requis' };
  const qs = new URLSearchParams();
  qs.set('latitude', String(lat));
  qs.set('longitude', String(lon));
  qs.set('distance', String(dist));
  qs.set('page', '1');
  qs.set('page_size', '100'); // max LBB v2 ; la carte en affiche jusqu'à 600 mais 100 suffisent
  rome.forEach(function (c) { qs.append('rome', c); });
  if (job) qs.set('job', job);
  const r = await apiCall('/labonneboite/v2/recherche?' + qs.toString(), 'lbb');
  if (r.status === 204) return { ok: true, companies: [], total: 0 };
  if (r.status === 403) {
    // Abonnement non provisionné OU scope incomplet (v2 : 'search office api_labonneboitev2')
    return {
      ok: false,
      code: 'lbb_unavailable',
      message: "La Bonne Boite indisponible (403 insufficient_scope — abonnement à valider sur francetravail.io)"
    };
  }
  if (r.status !== 200) {
    return { ok: false, code: 'ft_error', status: r.status, message: 'La Bonne Boite a renvoyé HTTP ' + r.status, detail: r.text.slice(0, 300) };
  }
  const j = JSON.parse(r.text);
  // v2 : {hits, items:[...]} — tolérant aux variantes (companies|tableau) par prudence
  const raw = Array.isArray(j.items) ? j.items : (Array.isArray(j.companies) ? j.companies : (Array.isArray(j) ? j : []));
  const companies = raw.map(function (c) {
    const loc = (c && c.location) || {};
    const siret = String(c.siret || '');
    const potential = Number(c.hiring_potential);
    const hcMin = intOrNull(c.headcount_min);
    const hcMax = intOrNull(c.headcount_max);
    return {
      siren: String(c.siren || siret).slice(0, 9), // SIREN = 9 premiers chiffres du SIRET
      siret: siret,
      name: c.office_name || c.company_name || c.name || c.nom || '',
      naf: c.naf || '',
      nafText: c.naf_label || c.naf_text || '',
      city: c.city || '',
      zipcode: c.postcode || c.zipcode || '',
      lat: Number(loc.latitude != null ? loc.latitude : c.lat),
      lon: Number(loc.longitude != null ? loc.longitude : c.lon),
      headcount: hcMin,
      headcountMax: hcMax,
      headcountText: headcountText(hcMin, hcMax),
      // hiring_potential 0-100 → étoiles 0-5 (arrondi au dixième)
      stars: isFinite(potential) ? Math.round(Math.min(Math.max(potential, 0), 100) / 20 * 10) / 10 : 0
    };
  }).filter(function (c) {
    return c.siren && c.name && isFinite(c.lat) && isFinite(c.lon) && c.lat !== 0 && c.lon !== 0;
  });
  const total = (j && j.hits != null) ? j.hits : companies.length;
  return { ok: true, companies: companies, total: total };
}

async function opFiche(params) {
  const code = String(params.code || '').trim().toUpperCase();
  if (!/^[A-K]\d{4}$/.test(code)) return { ok: false, error: 'paramètre code requis (format ROME, ex. M1806)' };
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
    if (params.op === 'lbb') return json(await opLbb(params));
    if (params.op === 'fiche') return json(await opFiche(params));
    return json({ ok: false, error: 'op inconnu (romeo | lbb | fiche)' }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
};
