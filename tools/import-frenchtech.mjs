#!/usr/bin/env node
// tools/import-frenchtech.mjs — Import du fichier Salesdorado French Tech (~5 000 lignes) vers Supabase.
//
// Usage (racine du repo) :
//   node tools/import-frenchtech.mjs [--file /tmp/frenchtech.csv] [--apply] [--batch 200]
//
//   Sans --apply : DRY-RUN (parse + normalise + affiche ce qui serait fait, n'écrit rien).
//   Avec --apply : upsert réel dans public.entreprises via l'API REST (PostgREST).
//
// Le CSV vient de https://salesdorado.com/fichiers-prospection/frenchtech/ (téléchargement
// manuel : le fichier est un export Google Sheet / Excel à convertir en CSV UTF-8).
// Emplacement attendu par défaut : /tmp/frenchtech.csv (surchargéable via --file ou
// la variable d'environnement FRENCHTECH_CSV). Le fichier source ne vit JAMAIS dans le repo.
//
// Secrets : SUPABASE_URL + SUPABASE_ANON_KEY lus dans l'environnement ou dans .env
// (racine du repo, gitignoré) — JAMAIS en dur ici.
//
// Règles d'import :
//   - SIREN normalisé à 9 chiffres (espaces/tirets/points retirés ; SIRET 14 chiffres →
//     9 premiers ; lignes sans SIREN/SIRET exploitable ignorées et comptées) ;
//   - upsert sur conflit siren (Prefer: resolution=merge-duplicates, onConflict=siren) ;
//   - listes = union des listes existantes + 'French Tech' (dédupliquée) ;
//   - source = 'salesdorado-frenchtech' ;
//   - site_web conservé s'il existe déjà, sinon colonne site web du CSV, sinon URL LinkedIn ;
//   - domaines : colonne industrie/tags du CSV si présente (sinon existant conservé).
//
// Pièges du CSV Salesdorado (constatés / à prévoir, fichier éditorial non normalisé) :
//   - En-têtes en français variables selon l'export (ex. « SIREN », « Siren », « N° SIREN »)
//     → détection par mots-clés insensibles casse/accents, mapping affiché avant import ;
//   - SIREN parfois stocké en nombre par Excel (zéro initial perdu, format scientifique
//     type 8.21E+08) → bourrage à gauche à 9 chiffres + rejet si ≠ 9 chiffres ;
//   - Séparateur `;` ou `,` selon l'export, BOM UTF-8, guillemets → parseur maison tolérant ;
//   - Doublons possibles sur le SIREN dans le fichier → dédupliqué (1re occurrence gardée).

import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

// ---------- args / env ----------
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const FILE = argVal('--file') || process.env.FRENCHTECH_CSV || '/tmp/frenchtech.csv';
const APPLY = args.includes('--apply');
const BATCH = Math.max(1, parseInt(argVal('--batch') || '200', 10) || 200);
const FT_LABEL = 'French Tech';
const SOURCE = 'salesdorado-frenchtech';

try {
  const txt = readFileSync('.env', 'utf8');
  for (const line of txt.split(NL)) {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      if (k && !process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  }
} catch (e) { /* pas de .env : env seul */ }

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;

// ---------- CSV tolérant (BOM, séparateur ;/,, guillemets) ----------
function splitLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(function (s) { return s.trim(); });
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
  if (!lines.length) throw new Error('CSV vide');
  const sep = (lines[0].split(';').length >= lines[0].split(',').length) ? ';' : ',';
  const header = splitLine(lines[0], sep);
  const rows = lines.slice(1).map(function (l) { return splitLine(l, sep); });
  return { header: header, rows: rows, sep: sep };
}

// Normalise un en-tête : minuscules, sans accents, alphanumérique seul.
function normKey(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Trouve l'index de la 1re colonne dont la clé normalisée contient un des mots-clés.
function findCol(keys, words) {
  for (let i = 0; i < keys.length; i++) {
    for (const w of words) {
      if (keys[i].indexOf(w) !== -1) return i;
    }
  }
  return -1;
}

function detectMapping(header) {
  const keys = header.map(normKey);
  // SIRET avant SIREN : « siret » contient… non, « siret » ne contient pas « siren ».
  // Attention : normKey('SIRET') = 'siret', normKey('SIREN') = 'siren' — pas de collision.
  const siret = findCol(keys, ['siret']);
  const siren = findCol(keys, ['siren', 'sirenentreprise', 'nosiren']);
  const nom = findCol(keys, ['raisonsociale', 'nomcommercial', 'entreprise', 'societe', 'company', 'name', 'nom']);
  const site = findCol(keys, ['siteweb', 'siteinternet', 'website', 'urlsite', 'web']);
  const linkedin = findCol(keys, ['linkedin']);
  const ville = findCol(keys, ['ville', 'city', 'commune', 'localite', 'adresse']);
  const naf = findCol(keys, ['naf', 'ape', 'activiteprincipale', 'codeape']);
  const tags = findCol(keys, ['industrie', 'industry', 'secteur', 'tags', 'categorie', 'vertical', 'marche']);
  return { siret: siret, siren: siren, nom: nom, site: site, linkedin: linkedin, ville: ville, naf: naf, tags: tags };
}

// Normalise un SIREN : garde les chiffres, prend les 9 premiers (SIRET → SIREN),
// bourre à gauche (zéro perdu par Excel), valide 9 chiffres exactement.
function normSiren(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  if (s === '') return '';
  // Notation scientifique d'Excel (ex. 8.21E+08) → nombre entier.
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!isFinite(n)) return '';
    s = String(Math.round(n));
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 14 || digits.length === 15) return digits.slice(0, 9); // SIRET → SIREN
  if (digits.length < 9) return digits.padStart(9, '0').length === 9 ? digits.padStart(9, '0') : '';
  if (digits.length === 9) return digits;
  if (digits.length > 9 && digits.length < 14) return ''; // ambigu → rejet
  return digits.slice(0, 9);
}

function uniq(arr) {
  const seen = {};
  return arr.filter(function (x) {
    if (!x || seen[x]) return false;
    seen[x] = 1;
    return true;
  });
}

async function supa(path, opts) {
  const res = await fetch(BASE + path, Object.assign({
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }
  }, opts || {}));
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase HTTP ' + res.status + ' : ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

async function fetchExisting() {
  // Table petite (~5 000 lignes après import) : lecture complète paginée.
  const all = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = await supa('/rest/v1/entreprises?select=siren,listes,site_web&order=siren&limit=' + page + '&offset=' + from);
    if (!rows || !rows.length) break;
    for (const r of rows) all.push(r);
    if (rows.length < page) break;
  }
  const map = {};
  for (const r of all) {
    if (r && r.siren) map[String(r.siren)] = r;
  }
  return map;
}

async function main() {
  console.log('Import French Tech Salesdorado → Supabase' + (APPLY ? ' (ÉCRITURE RÉELLE)' : ' (DRY-RUN, ajoutez --apply pour écrire)'));
  console.log('Fichier : ' + FILE);
  if (!BASE || !KEY) {
    console.error('SUPABASE_URL / SUPABASE_ANON_KEY introuvables (ni env, ni .env).');
    process.exit(1);
  }
  let text;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch (e) {
    console.error('Impossible de lire ' + FILE + ' : ' + e.message);
    console.error('Téléchargez le fichier depuis https://salesdorado.com/fichiers-prospection/frenchtech/ puis convertissez-le en CSV UTF-8 à cet emplacement (ou passez --file <chemin>).');
    process.exit(1);
  }
  const parsed = parseCsv(text);
  console.log('En-tête (' + parsed.rows.length + ' lignes, séparateur "' + parsed.sep + '") : ' + parsed.header.join(' | ').slice(0, 500));
  const map = detectMapping(parsed.header);
  console.log('Mapping détecté : ' + JSON.stringify(map));
  const sirenCol = map.siren !== -1 ? map.siren : map.siret;
  if (sirenCol === -1) {
    console.error('Aucune colonne SIREN/SIRET détectée — import impossible. Colonnes : ' + parsed.header.join(' | '));
    process.exit(1);
  }

  const seen = {};
  const stats = { rows: parsed.rows.length, noSiren: 0, dup: 0, kept: 0 };
  const payloads = [];
  for (const row of parsed.rows) {
    const siren = normSiren(row[sirenCol]);
    if (!/^\d{9}$/.test(siren)) { stats.noSiren++; continue; }
    if (seen[siren]) { stats.dup++; continue; }
    seen[siren] = 1;
    const nom = map.nom !== -1 ? (row[map.nom] || '').trim() : '';
    const siteCsv = map.site !== -1 ? (row[map.site] || '').trim() : '';
    const liCsv = map.linkedin !== -1 ? (row[map.linkedin] || '').trim() : '';
    const ville = map.ville !== -1 ? (row[map.ville] || '').trim() : '';
    let domaines = [];
    if (map.tags !== -1 && row[map.tags]) {
      domaines = uniq(String(row[map.tags]).split(/[,;|/]/).map(function (s) { return s.trim(); }).filter(Boolean)).slice(0, 10);
    }
    payloads.push({
      siren: siren,
      nom: nom || ('Entreprise ' + siren),
      listes: [FT_LABEL],
      domaines: domaines,
      ville: ville,
      site_web: siteCsv || liCsv || '',
      source: SOURCE,
      _siteCsv: siteCsv, _liCsv: liCsv
    });
    stats.kept++;
  }
  console.log('Lignes : ' + stats.rows + ' → exploitables : ' + stats.kept + ', sans SIREN : ' + stats.noSiren + ', doublons fichier : ' + stats.dup);

  // Fusion avec l'existant : union des listes (+ 'French Tech'), site_web conservé
  // s'il est déjà renseigné, domaines conservés si le CSV n'en apporte pas.
  const existing = await fetchExisting();
  console.log('Déjà en base : ' + Object.keys(existing).length + ' entreprises.');
  let alreadyFT = 0, merged = 0;
  const body = payloads.map(function (p) {
    const ex = existing[p.siren];
    const exListes = (ex && Array.isArray(ex.listes)) ? ex.listes : [];
    if (exListes.indexOf(FT_LABEL) !== -1) alreadyFT++;
    if (ex) merged++;
    const listes = uniq(exListes.concat([FT_LABEL]));
    let site = (ex && ex.site_web) ? ex.site_web : '';
    if (!site) site = p._siteCsv || p._liCsv || '';
    const rec = { siren: p.siren, source: SOURCE, listes: listes };
    if (p.nom && p.nom !== 'Entreprise ' + p.siren) rec.nom = p.nom;
    else if (!ex) rec.nom = p.nom;
    if (site) rec.site_web = site;
    if (p.domaines.length) rec.domaines = p.domaines;
    if (p.ville) rec.ville = p.ville;
    return rec;
  });
  console.log('Dont déjà marquées "French Tech" : ' + alreadyFT + ' · SIREN déjà en base (fusion) : ' + merged + ' · nouveaux SIREN : ' + (body.length - merged));

  if (!APPLY) {
    console.log('DRY-RUN : rien n\'a été écrit. Exemple (3 premiers) : ' + JSON.stringify(body.slice(0, 3)));
    console.log('Relancez avec --apply pour écrire en base (lots de ' + BATCH + ').');
    return;
  }
  let written = 0;
  for (let i = 0; i < body.length; i += BATCH) {
    const chunk = body.slice(i, i + BATCH).map(function (r) {
      const c = Object.assign({}, r);
      delete c._siteCsv; delete c._liCsv;
      return c;
    });
    await supa('/rest/v1/entreprises?on_conflict=siren', {
      method: 'POST',
      headers: {
        apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    written += chunk.length;
    console.log('Écrits : ' + written + '/' + body.length);
  }
  console.log('Terminé : ' + written + ' lignes upsertées (source=' + SOURCE + ', label="' + FT_LABEL + '").');
}

main().catch(function (e) { console.error('Échec : ' + (e && e.message)); process.exit(1); });
