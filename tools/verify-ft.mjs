#!/usr/bin/env node
/**
 * verify-ft.mjs (v2) — Vérification EMPIRIQUE des API France Travail (francetravail.io)
 * ============================================================================
 * Étape 1 de la fonctionnalité « Recherche étendue d'entreprises » (branche corp_ext).
 * Zéro dépendance : Node.js >= 18 (fetch natif). Les secrets ne sont JAMAIS
 * imprimés ni écrits dans le rapport (le client_id est partiellement masqué).
 *
 * v2 — focus diagnostic 401 passerelle :
 *   - empreinte du CLIENT_ID (pour vérifier que .env = l'appli où les APIs sont activées)
 *   - tous les en-têtes de réponse + corps d'erreur capturés
 *   - appel témoin SANS Authorization (baseline 401) et vers un chemin inexistant
 *     (contrôle du routage : 404 attendu)
 *   - API témoin « Offres d'emploi v2 » (activer cette API sur francetravail.io
 *     si ce n'est pas déjà fait : c'est la plus standard du portail)
 *   - Pages employeurs : retiré du périmètre (scope inexistant, confirmé)
 *
 * Usage :
 *   node tools/verify-ft.mjs   (lit FT_CLIENT_ID / FT_CLIENT_SECRET dans l'env ou .env)
 *
 * Sortie :
 *   - console : résumé lisible
 *   - tools/ft-report.json : rapport détaillé (gitignoré, NE PAS commit)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

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

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API_BASE = 'https://api.francetravail.io/partenaire';

const SCOPES = {
  offres: 'api_offresdemploiv2 o2dsoffre',
  romeo: 'api_romeov2',
  lbb: 'api_labonneboitev2',
  romeMetiers: 'api_rome-metiersv1 nomenclatureRome',
  romeFiches: 'api_rome-fiches-metiersv1 nomenclatureRome',
};

const report = {
  generatedAt: new Date().toISOString(),
  clientIdFingerprint: CLIENT_ID.slice(0, 12) + '…' + CLIENT_ID.slice(-4) + ' (' + CLIENT_ID.length + ' car.)',
  steps: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log(...a); }
function step(name, data) {
  report.steps.push({ name, ...data });
  if (data.ok) log('  ✓ ' + name);
  else log('  ✗ ' + name + ' : ' + (data.err || ('HTTP ' + data.status + (data.raw ? ' — ' + String(data.raw).slice(0, 120) : ''))));
}

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

async function callApi(scope, method, url, opts) {
  opts = opts || {};
  const headers = { Accept: 'application/json' };
  if (opts.noAuth !== true) {
    const t = await getToken(scope);
    headers.Authorization = 'Bearer ' + t.token;
  }
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
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  const hdrs = {};
  for (const entry of res.headers.entries()) {
    if (!/^set-cookie/i.test(entry[0])) hdrs[entry[0]] = entry[1];
  }
  return { status: res.status, ms, headers: hdrs, json, bodyLength: text.length, raw: text.slice(0, 500) };
}

function sample(json, maxItems) {
  maxItems = maxItems === undefined ? 3 : maxItems;
  if (Array.isArray(json)) return { type: 'array', length: json.length, first: json.slice(0, maxItems) };
  if (json && typeof json === 'object') {
    if (json.companies) return { keys: Object.keys(json), companies_length: json.companies.length, first: json.companies.slice(0, maxItems) };
    if (json.results) return { keys: Object.keys(json), results_length: (json.results || []).length, first: (json.results || []).slice(0, maxItems).map((o) => ({ intitule: o.intitule, codeROME: o.codeROME })) };
    return { keys: Object.keys(json), sample: json };
  }
  return json;
}

// Détail complet d'échec : TOUS les en-têtes + corps (c'est ce qui manque au 401)
function failDetail(r) {
  return {
    status: r.status, ms: r.ms,
    bodyLength: r.bodyLength,
    raw: r.raw,
    headers: r.headers,
  };
}

async function main() {
  log('\n═══════════════════════════════════════════════════════════════');
  log(' Vérification empirique des API France Travail — openfrance/corp_ext (v2)');
  log('═══════════════════════════════════════════════════════════════');
  log(' Client ID (empreinte, à comparer avec l\'appli francetravail.io) : ' + report.clientIdFingerprint);
  log('');

  // --- 1. OAuth par scope --------------------------------------------------
  log('── 1. OAuth (client_credentials, realm=/partenaire) ──');
  for (const entry of [['offres', SCOPES.offres], ['romeo', SCOPES.romeo], ['lbb', SCOPES.lbb], ['romeMetiers', SCOPES.romeMetiers], ['romeFiches', SCOPES.romeFiches]]) {
    const name = entry[0], scope = entry[1];
    try {
      const t = await getToken(scope);
      step('token ' + name, { ok: true, scope, expires_in: t.expires_in, scope_echo: t.scope_echo, ms: t.ms });
    } catch (e) { step('token ' + name, { ok: false, scope, err: String(e.message) }); }
  }
  log('');

  // --- 2. Contrôles de diagnostic (401 passerelle) ---------------------------
  log('── 2. Contrôles de diagnostic ──');
  try {
    const r = await callApi(null, 'GET', API_BASE + '/rome-metiers/v1/metiers/metier', { noAuth: true });
    step('SANS Authorization (baseline, 401 attendu)', { ok: r.status === 401, ...failDetail(r), expected: 401 });
  } catch (e) { step('SANS Authorization (baseline)', { ok: false, err: String(e.message).slice(0, 200) }); }
  try {
    const r = await callApi(SCOPES.romeo, 'GET', API_BASE + '/zzz-openfrance-inexistant');
    step('chemin inexistant avec token (404 attendu = routage OK)', { ok: r.status === 404, ...failDetail(r), expected: 404 });
  } catch (e) { step('chemin inexistant avec token', { ok: false, err: String(e.message).slice(0, 200) }); }
  log('');

  // --- 3. Témoin : Offres d'emploi v2 ---------------------------------------
  log('── 3. Témoin Offres d\'emploi v2 — GET /offresdemploi/v2/recherche ──');
  try {
    const r = await callApi(SCOPES.offres, 'GET', API_BASE + '/offresdemploi/v2/recherche?codeROME=M1806');
    step('Offres d\'emploi codeROME=M1806', {
      ok: r.status === 200, ...(r.status === 200 ? { status: r.status, ms: r.ms, fiche: sample(r.json, 2) } : failDetail(r)),
    });
  } catch (e) { step('Offres d\'emploi codeROME=M1806', { ok: false, err: String(e.message).slice(0, 300) }); }
  log('');

  // --- 4. ROMEO -------------------------------------------------------------
  log('── 4. ROMEO v2 — POST /romeo/v2/predictionMetiers ──');
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
        ok: r.status === 200, ...(r.status === 200 ? {
          status: r.status, ms: r.ms,
          nb_predictions: preds.length,
          top: preds.slice(0, 8).map((p) => ({ code: p.codeRome, rome: p.libelleRome, appellation: p.libelleAppellation, score: p.scorePrediction })),
        } : failDetail(r)),
      });
    } catch (e) { step('ROMEO "' + kw + '"', { ok: false, err: String(e.message).slice(0, 300) }); }
    await sleep(350); // ROMEO : 3 appels/s annoncés
  }
  log('');

  // --- 5. ROME 4.0 ----------------------------------------------------------
  log('── 5. ROME 4.0 — /rome-metiers/v1 · /rome-fiches-metiers/v1 ──');
  try {
    const r = await callApi(SCOPES.romeMetiers, 'GET', API_BASE + '/rome-metiers/v1/metiers/metier');
    step('ROME métiers (liste)', {
      ok: r.status === 200, ...(r.status === 200 ? { status: r.status, ms: r.ms, nb_metiers: Array.isArray(r.json) ? r.json.length : null, first: Array.isArray(r.json) ? r.json.slice(0, 2) : r.json } : failDetail(r)),
    });
  } catch (e) { step('ROME métiers (liste)', { ok: false, err: String(e.message).slice(0, 300) }); }
  await sleep(1000);
  const testCode = (romeCodesIA.find((c) => /^[A-Z]\d{4}$/.test(c || '')) || 'M1806');
  try {
    const r = await callApi(SCOPES.romeMetiers, 'GET', API_BASE + '/rome-metiers/v1/metiers/metier/' + testCode);
    step('ROME métier ' + testCode, { ok: r.status === 200, ...(r.status === 200 ? { status: r.status, ms: r.ms, fiche: sample(r.json, 1) } : failDetail(r)) });
  } catch (e) { step('ROME métier ' + testCode, { ok: false, err: String(e.message).slice(0, 300) }); }
  await sleep(1000);
  try {
    const r = await callApi(SCOPES.romeFiches, 'GET', API_BASE + '/rome-fiches-metiers/v1/fiches-rome/fiche-metier/' + testCode);
    step('ROME fiche métier ' + testCode, { ok: r.status === 200, ...(r.status === 200 ? { status: r.status, ms: r.ms, fiche: sample(r.json, 1) } : failDetail(r)) });
  } catch (e) { step('ROME fiche métier ' + testCode, { ok: false, err: String(e.message).slice(0, 300) }); }
  log('');

  // --- 6. La Bonne Boite v2 -------------------------------------------------
  log('── 6. La Bonne Boite v2 — GET /labonneboite/v2/company/ ──');
  log('   (2 appels/s max : espacement 600 ms entre chaque essai)');
  const lbbCodes = (romeCodesIA.filter((c) => c).slice(0, 3).join(',') || 'M1806,M1805');
  const lbbTests = [
    ['lat/lon + 1 code ROME', 'rome_codes=' + lbbCodes.split(',')[0] + '&latitude=43.6045&longitude=1.4442&distance=10'],
    ['lat/lon + plusieurs codes', 'rome_codes=' + lbbCodes + '&latitude=43.6045&longitude=1.4442&distance=10'],
    ['param commune (31555)', 'rome_codes=' + lbbCodes.split(',')[0] + '&commune=31555&distance=10'],
    ['param departement (31)', 'rome_codes=' + lbbCodes.split(',')[0] + '&departement=31'],
    ['pagination per_page/page', 'rome_codes=' + lbbCodes.split(',')[0] + '&latitude=43.6045&longitude=1.4442&distance=10&per_page=50&page=2'],
  ];
  for (const pair of lbbTests) {
    const label = pair[0], qs = pair[1];
    await sleep(600);
    try {
      const r = await callApi(SCOPES.lbb, 'GET', API_BASE + '/labonneboite/v2/company/?' + qs);
      const items = (r.json && (r.json.companies || (Array.isArray(r.json) ? r.json : (r.json.items || r.json.results)))) || [];
      step('LBB ' + label, {
        ok: r.status === 200, ...(r.status === 200 ? {
          status: r.status, ms: r.ms,
          nb: Array.isArray(items) ? items.length : null,
          first: (Array.isArray(items) ? items.slice(0, 2) : items),
          resp_keys: r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? Object.keys(r.json) : null,
        } : failDetail(r)),
      });
    } catch (e) { step('LBB ' + label, { ok: false, err: String(e.message).slice(0, 300) }); }
  }
  log('');

  writeFileSync('tools/ft-report.json', JSON.stringify(report, null, 2));
  const okCount = report.steps.filter((s) => s.ok).length;
  log('═══════════════════════════════════════════════════════════════');
  log(' Terminé : ' + okCount + '/' + report.steps.length + ' étapes OK — rapport : tools/ft-report.json (ne pas commit)');
  log(' Coller le contenu de ft-report.json (ou ce résumé) à l\'agent.');
  log('═══════════════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('Erreur fatale :', e); process.exit(1); });
