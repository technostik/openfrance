#!/usr/bin/env node
// tools/verify-ft.mjs — v3 : bac à sable France Travail + canari prod
// Usage : node tools/verify-ft.mjs  (racine du repo ; FT_CLIENT_ID/FT_CLIENT_SECRET dans env ou .env)
// Sortie : résumé console + tools/ft-report.json (gitignoré, ne pas committer)

import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API_BASE = 'https://api.francetravail.io/partenaire';
const NL = String.fromCharCode(10);

try {
  const txt = readFileSync('.env', 'utf8');
  for (const line of txt.split(NL)) {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  }
} catch (e) {}

const CLIENT_ID = process.env.FT_CLIENT_ID;
const CLIENT_SECRET = process.env.FT_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('FT_CLIENT_ID / FT_CLIENT_SECRET introuvables (ni env, ni .env).');
  process.exit(1);
}

const fingerprint = CLIENT_ID.slice(0, 10) + '...' + CLIENT_ID.slice(-4) + ' (' + CLIENT_ID.length + ' car.)';
const report = { generatedAt: new Date().toISOString(), clientIdFingerprint: fingerprint, steps: [] };

function step(name, obj) { obj.name = name; report.steps.push(obj); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const tokens = {};
async function getToken(scope) {
  if (tokens[scope] && Date.now() < tokens[scope].exp) return tokens[scope].value;
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', CLIENT_ID);
  body.set('client_secret', CLIENT_SECRET);
  body.set('scope', scope);
  const t0 = Date.now();
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const txt = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' sur token (scope="' + scope + '") en ' + (Date.now() - t0) + 'ms — ' + txt.slice(0, 200));
  const j = JSON.parse(txt);
  tokens[scope] = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function apiCall(path, scope, opts) {
  const token = await getToken(scope);
  const init = { method: (opts && opts.method) || 'GET', headers: { Authorization: 'Bearer ' + token } };
  if (opts && opts.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const t0 = Date.now();
  const res = await fetch(API_BASE + path, init);
  const txt = await res.text();
  const headers = {};
  res.headers.forEach(function (v, k) { headers[k] = v; });
  return { status: res.status, ms: Date.now() - t0, body: txt, headers: headers };
}

function failDetail(r) {
  return { status: r.status, ms: r.ms, bodyLength: r.body.length, raw: r.body.slice(0, 400), headers: r.headers };
}

const BAR = '===============================================================';

console.log(BAR);
console.log(' Verif France Travail v3 — bac a sable + canari prod (corp_ext)');
console.log(' client_id : ' + fingerprint);
console.log(BAR);

console.log(NL + '-- 1. Canari prod : GET /rome-metiers/v1/metiers/metier --');
try {
  const r = await apiCall('/rome-metiers/v1/metiers/metier', 'api_rome-metiersv1 nomenclatureRome');
  const ok = r.status === 200;
  let nb = null; let first = null;
  if (ok) {
    const j = JSON.parse(r.body);
    nb = (j && j.length) || null;
    if (nb) first = j[0].code + ' - ' + j[0].libelle;
  }
  step('PROD canari /rome-metiers/v1/metiers/metier', Object.assign({ ok: ok, nb: nb, first: first }, ok ? {} : { detail: failDetail(r) }));
  console.log(ok ? '  OK prod - ' + nb + ' metiers, premier : ' + first : '  ECHEC prod : HTTP ' + r.status + (r.body ? ' - ' + r.body.slice(0, 120) : ' (corps vide)'));
} catch (e) {
  step('PROD canari /rome-metiers/v1/metiers/metier', { ok: false, err: e.message });
  console.log('  ECHEC prod : ' + e.message);
}
await sleep(1100);

console.log(NL + '-- 2. Tokens bac a sable (memes identifiants, scopes api_test...) --');
const tokenCandidates = [
  { key: 'testromeo', scope: 'api_testromeov2' },
  { key: 'testlbb', scope: 'api_testlabonneboitev2' },
  { key: 'testromeMetiers-a', scope: 'api_testrome-metiersv1 nomenclatureTestRome' },
  { key: 'testromeMetiers-b', scope: 'api_testrome-metiersv1 nomenclatureRome' },
  { key: 'testromeMetiers-c', scope: 'api_testrome-metiersv1' },
  { key: 'testromeFiches-a', scope: 'api_testrome-fiches-metiersv1 nomenclatureTestRome' },
  { key: 'testromeFiches-b', scope: 'api_testrome-fiches-metiersv1 nomenclatureRome' }
];
const working = {};
for (const c of tokenCandidates) {
  const fam = c.key.split('-')[0];
  try {
    const tok = await getToken(c.scope);
    if (!working[fam]) working[fam] = c.scope;
    step('SBX token ' + c.key, { ok: true, scope: c.scope, sample: tok.slice(0, 12) + '...' });
    console.log('  OK token ' + c.key + ' (scope ' + c.scope + ')');
  } catch (e) {
    step('SBX token ' + c.key, { ok: false, scope: c.scope, err: e.message });
    console.log('  ECHEC token ' + c.key + ' : ' + e.message);
  }
  await sleep(300);
}

console.log(NL + '-- 3. Bac a sable : ROMEO POST /testromeo/v2/predictionMetiers --');
if (working.testromeo) {
  try {
    const r = await apiCall('/testromeo/v2/predictionMetiers', working.testromeo, { method: 'POST', body: { appellations: [{ intitule: 'intelligence artificielle', identifiant: '1' }], options: { nbResultats: 10, nomAppelant: 'openfrance', toggleScorePrediction: true } } });
    const ok = r.status === 200;
    let top = [];
    if (ok) {
      const j = JSON.parse(r.body);
      const preds = (j && j[0] && j[0].metiersRome) || [];
      top = preds.slice(0, 5).map(function (m) { return m.codeRome + ' - ' + m.libelleRome + ' (' + (m.scorePrediction || '?') + ')'; });
    }
    step('SBX ROMEO predictionMetiers', Object.assign({ ok: ok, nbPredictions: top.length, top: top }, ok ? {} : { detail: failDetail(r) }));
    console.log(ok ? '  OK ROMEO bac a sable - top : ' + top.join(' | ') : '  ECHEC ROMEO bac a sable : HTTP ' + r.status + (r.body ? ' - ' + r.body.slice(0, 120) : ' (corps vide)'));
  } catch (e) {
    step('SBX ROMEO predictionMetiers', { ok: false, err: e.message });
    console.log('  ECHEC ROMEO bac a sable : ' + e.message);
  }
} else {
  step('SBX ROMEO predictionMetiers', { ok: false, err: 'scope api_testromeov2 indisponible' });
  console.log('  (saute : pas de token test ROMEO)');
}
await sleep(400);

console.log('-- Bac a sable : GET /testrome-metiers/v1/metiers/metier --');
if (working.testromeMetiers) {
  try {
    const r = await apiCall('/testrome-metiers/v1/metiers/metier', working.testromeMetiers);
    const ok = r.status === 200;
    let nb = null;
    if (ok) { const j = JSON.parse(r.body); nb = (j && j.length) || null; }
    step('SBX ROME metiers liste', Object.assign({ ok: ok, nbMetiers: nb }, ok ? {} : { detail: failDetail(r) }));
    console.log(ok ? '  OK ROME metiers bac a sable - ' + nb + ' metiers' : '  ECHEC ROME metiers bac a sable : HTTP ' + r.status + (r.body ? ' - ' + r.body.slice(0, 120) : ' (corps vide)'));
  } catch (e) {
    step('SBX ROME metiers liste', { ok: false, err: e.message });
    console.log('  ECHEC ROME metiers bac a sable : ' + e.message);
  }
} else {
  step('SBX ROME metiers liste', { ok: false, err: 'scope test rome-metiers indisponible' });
  console.log('  (saute : pas de token test ROME metiers)');
}
await sleep(1100);

console.log('-- Bac a sable : La Bonne Boite /testlabonneboite/v2/company/ puis v1 --');
if (working.testlbb) {
  const qs = '?rome_codes=M1806&latitude=43.6045&longitude=1.4442&distance=10';
  for (const ver of ['v2', 'v1']) {
    try {
      const r = await apiCall('/testlabonneboite/' + ver + '/company/' + qs, working.testlbb);
      const ok = r.status === 200;
      let nb = null; let first = [];
      if (ok) {
        const j = JSON.parse(r.body);
        const comps = Array.isArray(j) ? j : ((j && j.companies) || []);
        nb = comps.length;
        first = comps.slice(0, 3).map(function (c) { return (c.name || '?') + ' (' + (c.city || '?') + ')'; });
      }
      step('SBX LBB ' + ver + ' company', Object.assign({ ok: ok, nb: nb, first: first }, ok ? {} : { detail: failDetail(r) }));
      console.log(ok ? '  OK LBB ' + ver + ' bac a sable - ' + nb + ' entreprises : ' + first.join(' | ') : '  ECHEC LBB ' + ver + ' : HTTP ' + r.status + (r.body ? ' - ' + r.body.slice(0, 120) : ' (corps vide)'));
    } catch (e) {
      step('SBX LBB ' + ver + ' company', { ok: false, err: e.message });
      console.log('  ECHEC LBB ' + ver + ' : ' + e.message);
    }
    await sleep(600);
  }
} else {
  step('SBX LBB v2 company', { ok: false, err: 'scope api_testlabonneboitev2 indisponible' });
  step('SBX LBB v1 company', { ok: false, err: 'scope api_testlabonneboitev2 indisponible' });
  console.log('  (saute : pas de token test LBB)');
}

const out = JSON.stringify(report, null, 2);
let written = 'tools/ft-report.json';
try { writeFileSync(written, out); } catch (e) { written = 'ft-report.json'; writeFileSync(written, out); }
const nbOk = report.steps.filter(function (s) { return s.ok; }).length;
console.log(NL + BAR);
console.log(' Termine : ' + nbOk + '/' + report.steps.length + ' etapes OK - rapport : ' + written + ' (ne pas committer)');
console.log(' Coller le contenu de ' + written + " a l'agent.");
console.log(BAR);
