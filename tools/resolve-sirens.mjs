#!/usr/bin/env node
// tools/resolve-sirens.mjs — Résout des noms de lauréats French Tech en SIREN puis upsert Supabase.
//
// Usage : node tools/resolve-sirens.mjs [--in /tmp/opencode/laureats.json] [--apply]
//
// Entrée : [{ nom, programmes: ["Next40 2026", "FT120 2025", ...], site, ville }]
//   (produit par tools/collect-numeum.mjs + listes manuelles — voir docs/ETAT-PROJET.md).
// Résolution via l'API Recherche d'entreprises (DINUM, gratuite, sans clé) :
//   GET https://recherche-entreprises.api.gouv.fr/search?q=<nom>&per_page=5&minimal=true
//   Score : égalité normalisée (suffixes SAS/SARL… ignorés) = 3, préfixe = 2,
//   inclusion = 1 (+0,5 si active). Requêtes : nom nettoyé (descripteurs ' - ', ' by '…,
//   ' France'… retirés), variante espacée (DentalMonitoring → Dental Monitoring), brut.
//   Accepté si score ≥ 2, inclusion sur total ≤ 3, ou résultat unique (marque vs
//   raison sociale, ex. BlaBlaCar → COMUTO — confiance 'unique', à contrôler).
// Sans --apply : DRY-RUN (rapport + /tmp/opencode/resolution.json, rien n'est écrit).
// Avec --apply : upsert public.entreprises (on_conflict=siren, union des listes +
//   'French Tech' + labels programme, source='laureats-frenchtech-officiels',
//   nom/ville/site_web complétés seulement si vides en base).
// Secrets : SUPABASE_URL + SUPABASE_ANON_KEY (lecture existant, env ou .env) et
//   SUPABASE_SERVICE_KEY (clé service_role, dashboard Supabase → .env local UNIQUEMENT
//   pour --apply : la clé ANON n'a qu'une policy SELECT et reçoit 42501 en écriture).
//   Jamais de secret en dur ; la clé service ne va JAMAIS sur Netlify (fonctions
//   curated.js = lecture seule par construction).
// --reuse : reprend /tmp/opencode/resolution.json sans réinterroger l'API.

import { readFileSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
function argVal(n) {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const IN = argVal('--in') || '/tmp/opencode/laureats.json';
const APPLY = args.includes('--apply');
const REUSE = args.includes('--reuse'); // reprend /tmp/opencode/resolution.json sans réinterroger l'API
const FT_LABEL = 'French Tech';
const SOURCE = 'laureats-frenchtech-officiels';
// Surcharges manuelles vérifiées (marque ≠ raison sociale introuvable par l'API) :
// /tmp/opencode/overrides.json = { "Nom fiche": "siren", ... }
let OVERRIDES = {};
try {
  OVERRIDES = JSON.parse(readFileSync('/tmp/opencode/overrides.json', 'utf8'));
} catch (e) { /* aucune */ }
// Noms de fiches à ne JAMAIS résoudre auto (homonymes vérifiés : la bonne
// entité n'est pas identifiable via l'API — pas de badge plutôt qu'un faux).
const BLOCKED = new Set(['agryco', 'vrroom']);
// SIREN écartés manuellement (homonymes / holdings / véhicules / EI radiées) :
// jamais d'auto-accept, même si l'API les propose.
const EXCLUS = new Set([
  '882314974', // ASARLE (conseil, Azay-sur-Cher) ≠ Pharmedigroup
  '840062947', // SOWEFUNDED AGRILOOPS (fonds parisien) ≠ Agriloops (aquaponie)
  '100284843', // WARREN AMI LABS 1 (véhicule d'investissement) ≠ AMI Labs
  '977866854', // HOLDING OKAMAC 2023 (holding) — SIREN d'exploitation à vérifier
  '952138766', // 1001PACT PHOENIX MOBILITY (véhicule) — à vérifier
  '953895018', // 1001PACT POLYTOPOLY (véhicule) — à vérifier
  '840673255', // SAMUEL COHEN (CERTIDEAL) — EI radiée, pas CertiDeal SAS
  '930753702', // FOODLE (Paris, conseil, 2024) ≠ Foodles (cantine, 2015)
  '323035287', // MANO (Mérignac, quincaillerie, 1981) ≠ ManoMano (voir override COLIBRI)
  '993001270', // MEEROR (Caen, 2025) ≠ Meero (Paris, 2014)
  '881018717', // C12 BTP (Labastide) ≠ C12 Quantum (voir override)
  '892547811', // CONTENTSQUARE FOUNDATION (fonds) ≠ CONTENT SQUARE (voir override)
  '999234222', // GREENLY DISTRIBUTION (Vaudreuil, 2025) ≠ Greenly (Paris, 2019)
  '929926095', // SCINTILLE (Grenoble, immo) ≠ Scintil Photonics
  '948157532', // ADDGUESTS MAX (Le Mans) ≠ Campings.com (voir override)
  '841603350', // AFYREN NEOXY (usine) ≠ A.F.Y.R.E.N. (voir override)
  '988727178', // PAPERNEST GLOBAL (holding 2025) ≠ FLASH CONTRACT (voir override)
  '991680828', // STYCH ACADEMIE (2025) — entité trop récente, pas Stych (2019)
  '788479657', // KOV (Venelles, immo) ≠ Kovers Santé
  '843875204', // EKIMETRICS FRANCE (filiale ?) — société mère non identifiée
  '981538275', // MEDADOM MEDICAL (2023) — entité trop récente, pas Medadom (2017)
  '828235564', // XXII-X (Angers, auto) ≠ XXII (vision par ordinateur, Paris)
  '422197434', // GOUACH (Paris, ciné) ≠ Gouach (batteries)
  '913584991', // INOCEL DEVELOPMENT (St-Egrève) — siège ≠ Belfort, non confirmé
  '892036864', // DESCARTES (St-Jean-de-Védas, détail) ≠ Descartes Underwriting (Paris, assurance)
  '102197332', // LOFT (Aix, coiffure, 2026) ≠ Loft Orbital (Toulouse, spatial)
  '801246810', // LUKO (Toulouse, restauration) ≠ Luko (Paris, assurance, radiée)
  '878054139', // SCI TALLANO (Calvi, immo) ≠ Tallano Technologies (freins)
  '414616425', // ULTRA (Paris, design, 1997) ≠ Ultra Premium Direct (2009)
  '501009997', // URBAN (Vieux-Boucau, loc) ≠ Urban Canopee (Paris, végétal)
  '415134949', // VESTIAIRE (Pamiers, 1998) ≠ Vestiaire Collective (voir override)
  '105492714', // BEYOND (Paris, conseil, 2026) ≠ Beyond Aerospace (Toulouse, hydrogène)
  '932812894', // BEACON (Aix, holding, 2024) ≠ Beacon Biosignals (US, pas de SIREN)
  '831025440', // SAFRAN (géant aéro) ≠ Safran.AI ex-Preligens (voir override)
  '794849208', // POSITIVE (Bretagne, restauration) ≠ Positive (tech)
  '839442779', // TOOTILA (Guadeloupe, e-commerce) ≠ Tootila (Nantes, tech)
  '517673224', // SWAP (générique) ≠ Swap Food (recommerce mobile)
  '108075144', // INFINITE (générique) ≠ Infinite Battery
  '483686911', // SCI LABELLEVIE (immo) ≠ La Belle Vie (courses)
  '504909128', // ABYS NAVIGATION ≠ Abys by OneOrtho (dentaire)
  '892972878', // LES (générique) ≠ Les Fermes Debout
  '945210243', // COOL (générique) ≠ Cool Roof France
  '983757493', // ENERGY (St-Barthélemy, immo) ≠ Energy Pool (voir override)
  '933175473', // MISTER FLY (Les Choux, immo, 2024) ≠ MisterFly (voir override DIGITRIPS)
  '803825025'  // VISIPERF (Audincourt, pub) — lien Orixa non confirmé
]);

try {
  const txt = readFileSync('.env', 'utf8');
  for (const line of txt.split(NL)) {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      if (k && !process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  }
} catch (e) { /* env seul */ }

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ',).replace(/\s+/g, ' ').trim()
    .replace(/\b(sasu|sas|sarl|eurl|sci|selarl|sa)\b/g, '').replace(/\s+/g, ' ').trim();
}

function scoreNom(query, cand) {
  const q = norm(query);
  if (!q) return 0;
  const names = [cand.denomination, cand.nom_complet, cand.nom_raison_sociale].filter(Boolean).map(norm);
  let best = 0;
  for (const n of names) {
    if (!n) continue;
    if (n === q) best = Math.max(best, 3);
    else if (n.indexOf(q) === 0 || q.indexOf(n) === 0) best = Math.max(best, 2);
    else if (n.indexOf(q) !== -1 || q.indexOf(n) !== -1) best = Math.max(best, 1);
  }
  if (best > 0 && etatActif(cand)) best += 0.5;
  return best;
}

function etatActif(cand) {
  const e = String((cand && cand.etat_administratif) || '').toUpperCase();
  return e === 'A' || e.indexOf('EN ACTIV') === 0;
}

// Nettoie un nom de fiche (descripteurs marketing) pour la requête : tout ce qui
// suit ' - ', ' | ', ' / ', ',', ' by ', ' for ', ' (', les ®™⭕ et TLD (.com…),
// et un ' France|Paris|Group(e)' final.
function cleanQuery(nom) {
  let s = String(nom || '').split(' - ')[0].split(' | ')[0].split('/')[0].split(',')[0];
  s = s.replace(/\s+by\s+.*$/i, '').replace(/\s+for\s+.*$/i, '').replace(/\s*\(.*$/, '');
  s = s.replace(/[®™⭕]/g, '').replace(/\.(com|fr|ai|io|co|eu|net|org|alsace)$/i, '');
  s = s.replace(/\s+(france|paris|groupe|group|energy|energies|hydrogen|hydrogene|technologies|technology|technologie|labs|laboratories|lab|digital|systems|systemes|solutions|user|users|ai|foods|food)$/i, '').replace(/\s+/g, ' ').trim();
  return s;
}

// Ancien nom après renommage : 'Les Fermes Debout (ex-NeoFarm)' -> 'NeoFarm',
// 'HSL Technologies (HySiLabs)' -> 'HySiLabs' (variante de repli).
function exVariant(nom) {
  const m = String(nom || '').match(/\(\s*ex-([^)]+)\)/i);
  if (m) return cleanQuery(m[1]);
  const p = String(nom || '').match(/\(([^)]+)\)/);
  if (p && !/^(20\d\d|next40|ft)/i.test(p[1].trim())) return cleanQuery(p[1]);
  return '';
}

// Variante avec espaces (noms collés type DentalMonitoring -> Dental Monitoring).
function spacedQuery(nom) {
  return String(nom || '').replace(/([a-zà-ÿ])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(nom) {
  // Mode complet (pas minimal) : il faut nom_complet/siege/etat pour arbitrer.
  const url = 'https://recherche-entreprises.api.gouv.fr/search?per_page=5&page=1&est_association=false&q=' + encodeURIComponent(nom);
  const r = await fetch(url);
  if (!r.ok) throw new Error('API entreprises HTTP ' + r.status);
  const j = await r.json();
  return { results: j.results || [], total: j.total_results || 0 };
}

// Arbitre les variantes de requête (nom nettoyé, espacé, brut) : meilleur score,
// puis longueur la plus proche (ex. Brevo -> SENDINBLUE plutôt que FONDS DE DOTATION).
function pickBest(e, searches) {
  let best = null, bestScore = -1, bestLenDiff = Infinity, bestTotal = 0;
  for (const s of searches) {
    const hit = s.hit || s;
    for (const c of hit.results) {
      // Siège à l'étranger (filiale/succursale) : écarté sauf si rien d'autre
      // (ex. BackMarket matchait BACK MARKET GERMANY GMBH au lieu de JUNG SAS).
      const abroad = !!((c.siege && (c.siege.libelle_pays_etranger || c.siege.code_pays_etranger)));
      // Score contre le nom fiche ET contre la variante ayant produit le résultat
      // (ex. résultats de 'Dental Monitoring' scorés aussi avec cette variante).
      const sc = Math.max(scoreNom(e.nom, c), s.q ? scoreNom(s.q, c) : 0) - (abroad ? 2 : 0);
      const ld = Math.abs(norm(c.denomination || c.nom_complet || '').length - norm(e.nom).length);
      if (sc > bestScore || (sc === bestScore && ld < bestLenDiff)) {
        bestScore = sc; best = c; bestLenDiff = ld; bestTotal = hit.total;
      }
    }
    // Résultat unique : l'API a tranché (ex. BlaBlaCar -> COMUTO, marque vs raison
    // sociale) — accepté si actif et requête distinctive, confiance 'unique'.
    if (hit.total === 1 && hit.results.length === 1 && bestScore < 1) {
      const c = hit.results[0];
      if (e.nom.replace(/[^a-zA-Z]/g, '').length >= 4 && etatActif(c)) {
        best = c; bestScore = 0.5; bestTotal = 1;
      }
    }
  }
  return { cand: best, score: bestScore, total: bestTotal };
}

async function supa(path, opts) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  const res = await fetch(base + path, Object.assign({
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  }, opts || {}));
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase HTTP ' + res.status + ' : ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

function uniq(a) {
  const s = {};
  return a.filter((x) => x && !s[x] && (s[x] = 1));
}

const seed = JSON.parse(readFileSync(IN, 'utf8'));
console.log(seed.length + ' noms en entrée.');
// Déduplique par nom normalisé (union des programmes).
const byName = {};
for (const e of seed) {
  const k = norm(e.nom);
  if (!k) continue;
  if (!byName[k]) byName[k] = { nom: e.nom, programmes: [], site: e.site || '', ville: e.ville || '' };
  byName[k].programmes = uniq(byName[k].programmes.concat(e.programmes || []));
  if (!byName[k].site && e.site) byName[k].site = e.site;
  if (!byName[k].ville && e.ville) byName[k].ville = e.ville;
}
const names = Object.values(byName);
console.log(names.length + ' noms uniques après déduplication.');

let resolved, review;
if (REUSE) {
  const prev = JSON.parse(readFileSync('/tmp/opencode/resolution.json', 'utf8'));
  resolved = prev.resolved;
  review = prev.review;
  console.log('Résolution reprise (' + resolved.length + ' résolus, ' + review.length + ' à relire) — API non interrogée.');
} else {
const resolved = [];
const review = [];
let n = 0;
for (const e of names) {
  if (BLOCKED.has(norm(e.nom))) {
    review.push({ nom: e.nom, raison: 'nom bloqué manuellement (homonyme non arbitrable)', programmes: e.programmes });
    n++;
    continue;
  }
  // Surcharge manuelle vérifiée (prioritaire, confiance 'override').
  if (OVERRIDES[e.nom]) {
    try {
      const chk = await search(OVERRIDES[e.nom]);
      const found = (chk.results || [])[0];
      resolved.push({
        nom: e.nom, siren: OVERRIDES[e.nom], score: 4, confiance: 'override',
        denomination: (found && (found.denomination || found.nom_complet)) || '',
        villeApi: (found && found.siege && (found.siege.libelle_commune || found.siege.commune)) || '',
        programmes: e.programmes, site: e.site, ville: e.ville
      });
    } catch (err) {
      review.push({ nom: e.nom, raison: 'override ' + OVERRIDES[e.nom] + ' invérifiable : ' + err.message, programmes: e.programmes });
    }
    await sleep(250);
    n++;
    continue;
  }
  let searches = [];
  try {
    const clean = cleanQuery(e.nom);
    const queries = uniq([clean, spacedQuery(clean), exVariant(e.nom), clean.replace(/\./g, ' '), clean.split(' ')[0], e.nom]);
    for (const q of queries) {
      if (!q) continue;
      searches.push({ q: q, hit: await search(q) });
      await sleep(250);
    }
  } catch (err) {
    review.push({ nom: e.nom, raison: 'erreur API : ' + err.message, programmes: e.programmes });
    continue;
  }
  const picked = pickBest(e, searches);
  const best = picked.cand, bestScore = picked.score;
  // Garde-fous inclusion : la requête doit être le contenu d'une parenthèse
  // (ex. SENDINBLUE (BREVO)) ou la ville fiche doit matcher le siège — sinon
  // c'est souvent une autre société qui cite la marque (ex. SAS AGRICONOMIE
  // (AGRYCO) n'est pas Agryco).
  let inclusionOk = false;
  if (best && bestScore >= 1 && bestScore < 2 && picked.total <= 3) {
    const nc = norm(best.denomination || best.nom_complet || '');
    const q = norm(e.nom);
    const parens = [...nc.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
    const parenEq = parens.some((p) => p === q);
    let villeOk = false;
    if (e.ville) {
      const sv = norm(e.ville), lv = norm((best.siege && (best.siege.libelle_commune || '')) || '');
      villeOk = sv && lv && (lv.indexOf(sv) !== -1 || sv.indexOf(lv) !== -1);
    }
    inclusionOk = parenEq || villeOk;
  }
  // Accepté : exact/préfixe (≥2), inclusion validée, ou résultat unique —
  // mais JAMAIS une entité fermée (F/C) ni un SIREN écarté manuellement.
  const closed = best && !etatActif(best);
  const exclu = best && EXCLUS.has(best.siren);
  const ok = best && best.siren && !closed && !exclu &&
    (bestScore >= 2 || inclusionOk || bestScore === 0.5);
  if (ok) {
    const conf = bestScore >= 3 ? 'exact' : (bestScore >= 2 ? 'prefix' : (bestScore >= 1 ? 'inclusion' : 'unique'));
    resolved.push({
      nom: e.nom, siren: best.siren, score: bestScore, confiance: conf,
      denomination: best.denomination || best.nom_complet || '',
      villeApi: (best.siege && (best.siege.libelle_commune || best.siege.commune)) || '',
      programmes: e.programmes, site: e.site, ville: e.ville
    });
  } else {
    const total = searches.length ? (searches[0].hit || searches[0]).total : 0;
    let raison;
    if (!best) raison = total ? 'aucun candidat retenant' : '0 candidat';
    else if (closed) raison = 'entité fermée (' + best.etat_administratif + ' : ' + (best.denomination || best.nom_complet || '?') + ')';
    else if (exclu) raison = 'SIREN écarté manuellement (' + best.siren + ' ' + (best.denomination || best.nom_complet || '?') + ')';
    else raison = 'meilleur score ' + bestScore + ' (' + ((best && (best.denomination || best.nom_complet)) || '?') + ')';
    review.push({ nom: e.nom, raison: raison, programmes: e.programmes });
  }
  n++;
  if (n % 50 === 0) console.log(n + '/' + names.length + ' (résolus : ' + resolved.length + ')');
  await sleep(300);
}
console.log('Résolus : ' + resolved.length + ' · À relire : ' + review.length);
writeFileSync('/tmp/opencode/resolution.json', JSON.stringify({ resolved: resolved, review: review }, null, 1));
for (const r of review.slice(0, 40)) console.log('  RELIRE : ' + r.nom + ' — ' + r.raison);
if (review.length > 40) console.log('  … +' + (review.length - 40) + ' autres (voir /tmp/opencode/resolution.json)');
} // fin du bloc résolution (mode --reuse : reprend le fichier existant)

if (!APPLY) {
  console.log('DRY-RUN : rien écrit. Relancez avec --apply pour upserter les ' + resolved.length + ' résolus.');
  process.exit(0);
}
// Écriture : la clé ANON n'a qu'une policy SELECT (lecture publique) — l'upsert
// exige la clé service_role (SUPABASE_SERVICE_KEY, dashboard Supabase → .env local
// UNIQUEMENT, jamais commitée ni déployée sur Netlify).
const WRITE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!process.env.SUPABASE_URL || !WRITE_KEY) {
  console.error('Écriture impossible : SUPABASE_URL / SUPABASE_SERVICE_KEY requis ' +
    '(la clé ANON est en lecture seule — voir l’en-tête du script).');
  process.exit(1);
}
// Fusion avec l'existant (une lecture complète, table de quelques milliers de lignes).
const existing = {};
for (let from = 0; ; from += 1000) {
  const rows = await supa('/rest/v1/entreprises?select=siren,listes,domaines,site_web,ville,nom,source&order=siren&limit=1000&offset=' + from);
  if (!rows || !rows.length) break;
  for (const r of rows) if (r && r.siren) existing[String(r.siren)] = r;
  if (rows.length < 1000) break;
}
console.log('Déjà en base : ' + Object.keys(existing).length);
let created = 0, merged = 0;
const body = resolved.map((e) => {
  const ex = existing[e.siren];
  if (ex) merged++; else created++;
  // Ligne COMPLÈTE obligatoire : avec Prefer merge-duplicates, PostgREST fait
  // ON CONFLICT DO UPDATE sur TOUTES les colonnes — une colonne absente du
  // payload est écrasée à NULL (perte de données / 23502 sur nom NOT NULL).
  // On ne met null que si base ET graine sont vides (nom/siren toujours renseignés).
  const rec = {
    nom: ((ex && ex.nom) || e.nom || '').trim() || ('Entreprise ' + e.siren),
    siren: e.siren,
    listes: uniq(((ex && ex.listes) || []).concat([FT_LABEL], e.programmes)),
    domaines: uniq(((ex && ex.domaines) || []).concat(e.domaines || [])),
    ville: ((ex && ex.ville) || e.ville || e.villeApi || '') || null,
    site_web: ((ex && ex.site_web) || e.site || '') || null,
    source: (ex && ex.source) || SOURCE
  };
  return rec;
});
console.log('Nouveaux SIREN : ' + created + ' · fusions : ' + merged);
// Deux noms peuvent résoudre le même SIREN (ex. Brevo/Sendinblue) : on fusionne
// par SIREN (union des listes, premier nom/ville/site non vide) — sinon Postgres
// refuse le lot (21000 : même SIREN deux fois dans la commande).
const bySiren = {};
for (const rec of body) {
  const ex = bySiren[rec.siren];
  if (!ex) { bySiren[rec.siren] = rec; continue; }
  ex.listes = uniq((ex.listes || []).concat(rec.listes || []));
  if ((!ex.nom || ex.nom.indexOf('Entreprise ') === 0) && rec.nom) ex.nom = rec.nom;
  if (!ex.ville && rec.ville) ex.ville = rec.ville;
  if (!ex.site_web && rec.site_web) ex.site_web = rec.site_web;
}
const dedup = Object.values(bySiren);
console.log('Après fusion par SIREN : ' + dedup.length + ' lignes (doublons : ' + (body.length - dedup.length) + ').');
// PostgREST (PGRST102) exige des clés IDENTIQUES dans un même lot : on groupe
// les lignes par signature de clés (les colonnes nom/ville/site_web ne sont
// envoyées que si renseignées — jamais de null qui écraserait l'existant).
const groups = {};
let written = 0;
for (const rec of dedup) {
  const sig = Object.keys(rec).sort().join(',');
  (groups[sig] = groups[sig] || []).push(rec);
}
for (const sig of Object.keys(groups)) {
  const rows = groups[sig];
  for (let i = 0; i < rows.length; i += 200) {
    const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/entreprises?on_conflict=siren', {
      method: 'POST',
      headers: {
        apikey: WRITE_KEY, Authorization: 'Bearer ' + WRITE_KEY,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows.slice(i, i + 200))
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('Supabase HTTP ' + res.status + ' : ' + txt.slice(0, 300));
    }
  }
  written += rows.length;
  console.log('Écrits : ' + written + '/' + dedup.length + ' (lot ' + sig + ')');
}
console.log('Terminé.');
