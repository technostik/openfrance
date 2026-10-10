#!/usr/bin/env node
/**
 * verify-ft.mjs — Vérification EMPIRIQUE des API France Travail (francetravail.io)
 * ============================================================================
 * Étape 1 de la fonctionnalité « Recherche étendue d'entreprises » (branche corp_ext).
 * Zéro dépendance : Node.js >= 18 (fetch natif). Les secrets ne sont JAMAIS
 * imprimés ni écrits dans le rapport.
 *
 * Usage :
 *   node tools/verify-ft.mjs            (lit FT_CLIENT_ID / FT_CLIENT_SECRET
 *                                         dans l'environnement ou dans .env du
 *                                         répertoire courant)
 *
 * Sortie :
 *   - console : résumé lisible (à coller à l'agent si besoin)
 *   - tools/ft-report.json : rapport détaillé (gitignoré, NE PAS commit)
 *
 * Prérequis : application francetravail.io souscrite aux API
 *   ROMEO 2 · ROME 4.0 Métiers · ROME 4.0 Fiches métiers · La Bonne Boite v2 · Pages employeurs v1
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Chargement des credentials (env > .env local)
// ---------------------------------------------------------------------------
function loadEnv() {
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}
loadEnv();

const CLIENT_ID = process.env.FT_CLIENT_ID;
const CLIENT_SECRET = process.env.FT_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('✗ FT_CLIENT_ID / FT_CLIENT_SECRET absents (env ou .env).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constantes (sources : doc francetravail.io + code live-testé de clients existants)
// ---------------------------------------------------------------------------
const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API_BASE = 'https://api.francetravail.io/partenaire';

const SCOPES = {
  romeo: 'api_romeov2',
  lbb: 'api_labonneboitev2',
  romeMetiers: 'api_rome-metiersv1 nomenclatureRome',
  romeFiches: 'api_rome-fiches-metiersv1 nomenclatureRome',
  // Pages employeurs : scope exact inconnu → candidats testés dans l'ordre
  pagesEmpCandidates: ['api_pages-employeursv1', 'api_pagesemployeursv1', 'api_pages-employeurs-v1'],
};

const report = { generatedAt: new Date().toISOString(), steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log(...a); }
function step(name, data) {
  report.steps.push({ name, ...data });
  if (data.ok) log('  ✓ ' + name);
  else log('  ✗ ' + name + ' : ' + (data.err || 'échec'));
}

// ---------------------------------------------------------------------------
// OAuth : un token par scope, cache mémoire (durée de vie ~1500 s annoncée)
// ---------------------------------------------------------------------------
const tokenCache = new Map();
async function getToken(scope) {
  if (tokenCache.has(scope)) return tokenCache.get(scope);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope,
  });
  const t0 = performance.now();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' sur token (scope="' + scope + '") en ' + ms + 'ms — ' + txt.slice(0, 300));
  }
  const j = await res.json();
  tokenCache.set(scope, j.access_token);
  return { token: j.access_token, expires_in: j.expires_in, scope_echo: j.scope, ms };
}

// ---------------------------------------------------------------------------
// Appel API générique GET/POST avec Bearer, retour {status, headers, json, ms}
// ---------------------------------------------------------------------------
async function callApi(scope, method, url, opts) {
  opts = opts || {};
  const { token } = await getToken(scope);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (opts.jsonBody !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers,
    body: opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : (opts.formBody !== undefined ? opts.formBody : undefined),
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* réponse non-JSON */ }
  const pick = (h) => res.headers.get(h);
  return {
    status: res.status,
    ms,
    headers: {
      'content-type': pick('content-type'),
      'content-range': pick('content-range'),
      'x-ratelimit-remaining': pick('x-ratelimit-remaining'),
      'x-ratelimit-limit': pick('x-ratelimit-limit'),
      'retry-after': pick('retry-after'),
      'cache-control': pick('cache-control'),
    },
    json,
    raw: text.slice(0, 500),
  };
}

// Échantillon compact d'une réponse JSON (évite un rapport géant)
function sample(json, maxItems) {
  maxItems = maxItems === undefined ? 3 : maxItems;
  if (Array.isArray(json)) return { type: 'array', length: json.length, first: json.slice(0, maxItems) };
  if (json && typeof json === 'object') {
    if (json.companies) return { keys: Object.keys(json), companies_length: json.companies.length, first: json.companies.slice(0, maxItems) };
    return { keys: Object.keys(json), sample: json };
  }
  return json;
}

// ---------------------------------------------------------------------------
async function main() {
  log('\n═══════════════════════════════════════════════════════════════');
  log(' Vérification empirique des API France Travail — openfrance/corp_ext');
  log('═══════════════════════════════════════════════════════════════\n');

  // --- 1. OAuth par scope --------------------------------------------------
  log('── 1. OAuth (client_credentials, realm=/partenaire) ──');
  for (const entry of [['romeo', SCOPES.romeo], ['lbb', SCOPES.lbb], ['romeMetiers', SCOPES.romeMetiers], ['romeFiches', SCOPES.romeFiches]]) {
    const name = entry[0], scope = entry[1];
    try {
      const t = await getToken(scope);
      step('token ' + name, { ok: true, scope, expires_in: t.expires_in, scope_echo: t.scope_echo, ms: t.ms });
    } catch (e) { step('token ' + name, { ok: false, scope, err: String(e.message) }); }
  }
  // Pages employeurs : on teste les scopes candidats
  let pagesScopeOk = null;
  for (const sc of SCOPES.pagesEmpCandidates) {
    try {
      const t = await getToken(sc);
      step('token pagesEmp "' + sc + '"', { ok: true, expires_in: t.expires_in, ms: t.ms });
      if (!pagesScopeOk) pagesScopeOk = sc;
    } catch (e) { step('token pagesEmp "' + sc + '"', { ok: false, err: String(e.message).slice(0, 200) }); }
  }
  log('');

  // --- 2. ROMEO : qualité du rapprochement texte libre → codes ROME ---------
  log('── 2. ROMEO v2 — POST /romeo/v2/predictionMetiers ──');
  const romeCodesIA = [];
  for (const kw of ['intelligence artificielle', 'data scientist', 'machine learning', 'transition écologique']) {
    try {
      const r = await callApi(SCOPES.romeo, 'POST', API_BASE + '/romeo/v2/predictionMetiers', {
        jsonBody: {
          appellations: [{ intitule: kw, identifiant: '1' }],
          options: { nbResultats: 10, nomAppelant: 'openfrance', toggleScorePrediction: true },
        },
      });
      const preds = Array.isArray(r.json) ? r.json.flatMap((p) => p.metiersRome || []) : [];
      if (kw === 'intelligence artificielle') for (const p of preds) romeCodesIA.push(p.codeRome);
      step('ROMEO "' + kw + '"', {
        ok: r.status === 200, status: r.status, ms: r.ms,
        nb_predictions: preds.length,
        top: preds.slice(0, 8).map((p) => ({ code: p.codeRome, rome: p.libelleRome, appellation: p.libelleAppellation, score: p.scorePrediction })),
        headers: r.headers,
        unexpected: r.status !== 200 ? r.raw : undefined,
      });
    } catch (e) { step('ROMEO "' + kw + '"', { ok: false, err: String(e.message).slice(0, 300) }); }
    await sleep(250); // ROMEO ~10 appels/s annoncés
  }
  log('');

  // --- 3. ROME 4.0 Métiers --------------------------------------------------
  log('── 3. ROME 4.0 — /rome-metiers/v1/metiers/metier ──');
  try {
    const r = await callApi(SCOPES.romeMetiers, 'GET', API_BASE + '/rome-metiers/v1/metiers/metier');
    step('ROME métiers (liste)', {
      ok: r.status === 200, status: r.status, ms: r.ms,
      nb_metiers: Array.isArray(r.json) ? r.json.length : null,
      first: Array.isArray(r.json) ? r.json.slice(0, 2) : r.json,
      headers: r.headers,
    });
  } catch (e) { step('ROME métiers (liste)', { ok: false, err: String(e.message).slice(0, 300) }); }
  const testCode = (romeCodesIA.find((c) => /^[A-Z]\d{4}$/.test(c || '')) || 'M1806');
  try {
    const r = await callApi(SCOPES.romeMetiers, 'GET', API_BASE + '/rome-metiers/v1/metiers/metier/' + testCode);
    step('ROME métier ' + testCode, { ok: r.status === 200, status: r.status, ms: r.ms, fiche: sample(r.json, 1), unexpected: r.status !== 200 ? r.raw : undefined });
  } catch (e) { step('ROME métier ' + testCode, { ok: false, err: String(e.message).slice(0, 300) }); }
  try {
    const r = await callApi(SCOPES.romeFiches, 'GET', API_BASE + '/rome-fiches-metiers/v1/fiches-rome/fiche-metier/' + testCode);
    step('ROME fiche métier ' + testCode, { ok: r.status === 200, status: r.status, ms: r.ms, fiche: sample(r.json, 1), unexpected: r.status !== 200 ? r.raw : undefined });
  } catch (e) { step('ROME fiche métier ' + testCode, { ok: false, err: String(e.message).slice(0, 300) }); }
  log('');

  // --- 4. La Bonne Boite v2 : LE point non documenté ------------------------
  log('── 4. La Bonne Boite v2 — GET /labonneboite/v2/company/ ──');
  log('   (2 appels/s max : espacement 600 ms entre chaque essai)');
  const lbbCodes = (romeCodesIA.filter((c) => c).slice(0, 3).join(',') || 'M1806,M1805');
  const lbbTests = [
    ['lat/lon + 1 code ROME', 'rome_codes=' + lbbCodes.split(',')[0] + '&latitude=43.6045&longitude=1.4442&distance=10'],
    ['lat/lon + plusieurs codes', 'rome_codes=' + lbbCodes + '&latitude=43.6045&longitude=1.4442&distance=10'],
    ['param commune (31555)', 'rome_codes=' + lbbCodes.split(',')[0] + '&commune=31555&distance=10'],
    ['param departement (31)', 'rome_codes=' + lbbCodes.split(',')[0] + '&departement=31'],
    ['pagination per_page/page', 'rome_codes=' + lbbCodes.split(',')[0] + '&latitude=43.6045&longitude=1.4442&distance=10&per_page=50&page=2'],
  ];
  let lbbSampleSiret = null;
  for (const pair of lbbTests) {
    const label = pair[0], qs = pair[1];
    await sleep(600);
    try {
      const r = await callApi(SCOPES.lbb, 'GET', API_BASE + '/labonneboite/v2/company/?' + qs);
      const items = r.json && (r.json.companies || (Array.isArray(r.json) ? r.json : (r.json.items || r.json.results))) || [];
      if (!lbbSampleSiret && items[0] && items[0].siret) lbbSampleSiret = items[0].siret;
      step('LBB ' + label, {
        ok: r.status === 200, status: r.status, ms: r.ms,
        nb: Array.isArray(items) ? items.length : null,
        first: (Array.isArray(items) ? items.slice(0, 2) : items),
        resp_keys: r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? Object.keys(r.json) : null,
        headers: r.headers,
        unexpected: r.status !== 200 ? r.raw : undefined,
      });
    } catch (e) { step('LBB ' + label, { ok: false, err: String(e.message).slice(0, 300) }); }
  }
  log('');

  // --- 5. Pages employeurs v1 (endpoints à découvrir) ------------------------
  log('── 5. Pages employeurs v1 (sonde de chemins) ──');
  if (!pagesScopeOk) log('   ⚠ scope OAuth inconnu : essaie les scopes candidats + chemins candidats');
  const siret = lbbSampleSiret || '34326262214546';
  const pePaths = [
    '/pages-employeurs/v1/entreprise/' + siret,
    '/pages-employeurs/v1/pages-employeurs/entreprise/' + siret,
    '/pages-employeurs/v1/entreprises/' + siret,
    '/pagesemployeurs/v1/entreprise/' + siret,
  ];
  let peFound = false;
  for (const p of pePaths) {
    if (peFound) break;
    for (const sc of (pagesScopeOk ? [pagesScopeOk] : SCOPES.pagesEmpCandidates)) {
      await sleep(300);
      try {
        const r = await callApi(sc, 'GET', API_BASE + p);
        if (r.status === 200) {
          step('Pages employeurs ' + p + ' (scope ' + sc + ')', { ok: true, status: 200, ms: r.ms, fiche: sample(r.json, 1), headers: r.headers });
          peFound = true;
          break;
        } else {
          step('Pages employeurs ' + p + ' (scope ' + sc + ')', { ok: false, status: r.status, err: r.raw });
          if (pagesScopeOk) break; // scope bon mais chemin faux : inutile de retester les scopes
        }
      } catch (e) { step('Pages employeurs ' + p + ' (scope ' + sc + ')', { ok: false, err: String(e.message).slice(0, 200) }); if (pagesScopeOk) break; }
    }
  }
  log('');

  // --- Écriture du rapport ---------------------------------------------------
  writeFileSync('tools/ft-report.json', JSON.stringify(report, null, 2));
  const okCount = report.steps.filter((s) => s.ok).length;
  log('═══════════════════════════════════════════════════════════════');
  log(' Terminé : ' + okCount + '/' + report.steps.length + ' étapes OK — rapport détaillé : tools/ft-report.json (ne pas commit)');
  log(" Coller le contenu de ft-report.json (ou ce résumé) à l'agent pour finaliser l'implémentation.");
  log('═══════════════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('Erreur fatale :', e); process.exit(1); });
