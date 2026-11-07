#!/usr/bin/env node
// OpenFrance — build « essences par commune » (structurel, pour le mode Pollens).
//
// Construit UNE FOIS POUR TOUTES des données statiques PAR COMMUNE (croisement à
// faire sur votre machine — trop volumineux pour un build en ligne) :
//
//   1. BD Forêt V2 (IGN, licence ouverte) : superficies par essence forestière
//      (boulaie, aulnaie, chênaies, …) par commune — la donnée officielle qui
//      manque à l'agrégat IFN par département (pollens-essences.js).
//      Téléchargement : https://data.geopf.fr/telechargement/resource/BDFORET
//      (attention : le catalogue s'appelle « BDFORET », pas « BDFORET-V2 »).
//      Fichiers SHP Lambert-93 par département, millésimes 2015-2017 selon les
//      départements (c'est le dernier référentiel complet publié).
//
//   2. RPG (Registre Parcellaire Graphique, ASP/IGN, licence ouverte) :
//      surfaces de céréales et de prairies (proxy graminées, cf. TACCT par EPCI
//      du niveau département) MAIS au niveau de la commune.
//      Téléchargement : https://data.geopf.fr/telechargement/resource/RPG
//      Fichiers SHP Lambert-93 PAR RÉGION (R11…R94), millésime 2023 — piège
//      n°41(k) : depuis l'édition 2024 le RPG est scindé en produits et les
//      archives GPKG régionales « RPG_4-0 » (2024/2025) ne contiennent que des
//      îlots anonymes (fid, geom, num_ilot : aucune culture) + SNA + ZDH ; les
//      parcelles avec CODE_CULTURE n'existent que dans les éditions SHP
//      2015-2023 (on prend la dernière : 2023, ~2,6 Go compressés au total).
//      Référentiel cultures : REF_CULTURES_GROUPES_CULTURES_<année>.csv
//      (https://data.geopf.fr/annexes/ressources/documentation/).
//
// Méthode (approximation documentée, piège n°41) :
//   - chaque polygone (forêt / parcelle RPG) est affecté à la commune contenant
//     son centroïde (ray-casting) ; les polygones à cheval sur deux communes
//     sont donc affectés à la commune dominante du centroïde ;
//   - les superficies sont les aires planaires Lambert-93 (m²), converties en
//     hectares (2 décimales) dans le JSON de sortie ;
//   - les contours communaux utilisés sont ceux du proxy /geo/communes/* de
//     l'app (france-geojson, raw.githubusercontent) : les codes INSEE de sortie
//     matcheront l'application par construction (piège n°41(g)).
//
// Sortie (dossier data/, embarqué dans le repo — style naf.js, aucune requête
// réseau au chargement de l'app) :
//   data/essences-foret/d<dep>.json   { meta, communes: { "<insee>": { <groupe>: ha, …, _foret: ha } } }
//   data/essences-rpg/d<dep>.json     { meta, communes: { "<insee>": { cereales: ha, prairies: ha, _rpg: ha } } }
//
// Prérequis (Node.js ≥ 18, paquets 100 % JS — plus AUCUN module natif ni
// SQLite depuis le passage du RPG aux parcelles SHP 2023, cf. piège n°41(k)) :
//   npm install --save-dev shapefile proj4
//   + un exécutable 7z dans le PATH (paquet p7zip-full / p7zip, brew install
//     p7zip, ou 7-Zip.org ; les archives IGN sont des .7z, parfois multi-part
//     .7z.001/.002 — 7z les extrait directement).
//   Historique piège n°41(j) : la lecture des GPKG RPG passait par better-sqlite3
//   puis node:sqlite (segfaults connus au premier new Database() selon le couple
//   Node/version) — caduc, le RPG lu est désormais en SHP.
//
// Usage :
//   node tools/build-essences-communes.mjs --list            # entrées disponibles
//   node tools/build-essences-communes.mjs --foret           # BD Forêt, tous départements
//   node tools/build-essences-communes.mjs --foret --dep 01,69
//   node tools/build-essences-communes.mjs --rpg            # RPG, toutes régions métropole
//   node tools/build-essences-communes.mjs --rpg --dep 01,69 # régions nécessaires
//   node tools/build-essences-communes.mjs --all            # les deux
//   Options : --millesime 2023 (RPG ; BD Forêt prend toujours le dernier)
//             --from-dir tools/.cache/essences/…  (déjà téléchargé/extrait)
//             --force (retélécharger), --clean (supprimer le cache après)
//             --diag  (BD Forêt et/ou RPG : instrumentation complète — entrée,
//                      .shp, encodage DBF, propriétés de la 1re entité,
//                      histogramme TFV/cultures, entonnoir « où les surfaces
//                      se perdent » ; n'écrit PAS les JSON dans data/)
//             --limite N (avec --diag : lire au plus N entités par .shp,
//                      défaut 200000 — pour un diagnostic rapide sans lire
//                      les ~10 millions de parcelles d'une grande région)
//
// Le portail data.geopf.fr limite en débit (HTTP 429 si on pagine en rafale) :
// le script espace ses requêtes (~2/s max) et réessaie automatiquement avec
// backoff exponentiel + Retry-After (5 tentatives) — pas de relance à la main.
//
// 🤖 Généré avec Vibe — données sous licence ouverte (IGN/ASP) ; les JSON de
// sortie sont des agrégats statistiques (superficies par essence × commune).

'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'tools', '.cache', 'essences');
const OUT_FORET = path.join(ROOT, 'data', 'essences-foret');
const OUT_RPG = path.join(ROOT, 'data', 'essences-rpg');
const GEO_DIR = path.join(ROOT, 'geo', 'communes', 'departements');

// ---------- Dossier du repo par code département (mappé sur DEP_FOLDERS d'app.js) ----------
const DEP_FOLDERS = {
  '01':'01-ain','02':'02-aisne','03':'03-allier','04':'04-alpes-de-haute-provence','05':'05-hautes-alpes',
  '06':'06-alpes-maritimes','07':'07-ardeche','08':'08-ardennes','09':'09-ariege','10':'10-aube',
  '11':'11-aude','12':'12-aveyron','13':'13-bouches-du-rhone','14':'14-calvados','15':'15-cantal',
  '16':'16-charente','17':'17-charente-maritime','18':'18-cher','19':'19-correze','21':'21-cote-d-or',
  '22':'22-cotes-d-armor','23':'23-creuse','24':'24-dordogne','25':'25-doubs','26':'26-drome',
  '27':'27-eure','28':'28-eure-et-loir','29':'29-finistere','2A':'2A-corse-du-sud','2B':'2B-haute-corse',
  '30':'30-gard','31':'31-haute-garonne','32':'32-gers','33':'33-gironde','34':'34-herault',
  '35':'35-ille-et-vilaine','36':'36-indre','37':'37-indre-et-loire','38':'38-isere','39':'39-jura',
  '40':'40-landes','41':'41-loir-et-cher','42':'42-loire','43':'43-haute-loire','44':'44-loire-atlantique',
  '45':'45-loiret','46':'46-lot','47':'47-lot-et-garonne','48':'48-lozere','49':'49-maine-et-loire',
  '50':'50-manche','51':'51-marne','52':'52-haute-marne','53':'53-mayenne','54':'54-meurthe-et-moselle',
  '55':'55-meuse','56':'56-morbihan','57':'57-moselle','58':'58-nievre','59':'59-nord',
  '60':'60-oise','61':'61-orne','62':'62-pas-de-calais','63':'63-puy-de-dome','64':'64-pyrenees-atlantiques',
  '65':'65-hautes-pyrenees','66':'66-pyrenees-orientales','67':'67-bas-rhin','68':'68-haut-rhin','69':'69-rhone',
  '70':'70-haute-saone','71':'71-saone-et-loire','72':'72-sarthe','73':'73-savoie','74':'74-haute-savoie',
  '75':'75-paris','76':'76-seine-maritime','77':'77-seine-et-marne','78':'78-yvelines','79':'79-deux-sevres',
  '80':'80-somme','81':'81-tarn','82':'82-tarn-et-garonne','83':'83-var','84':'84-vaucluse',
  '85':'85-vendee','86':'86-vienne','87':'87-haute-vienne','88':'88-vosges','89':'89-yonne',
  '90':'90-territoire-de-belfort','91':'91-essonne','92':'92-hauts-de-seine','93':'93-seine-saint-denis',
  '94':'94-val-de-marne','95':'95-val-d-oise'
};

// Départements métropole → région du flux RPG (SHP par région, cf. pièges n°41/41(k)).
const DEP_TO_R = {
  '75':'R11','77':'R11','78':'R11','91':'R11','92':'R11','93':'R11','94':'R11','95':'R11',
  '18':'R24','28':'R24','36':'R24','37':'R24','41':'R24','45':'R24',
  '21':'R27','25':'R27','39':'R27','58':'R27','70':'R27','71':'R27','89':'R27','90':'R27',
  '14':'R28','27':'R28','50':'R28','61':'R28','76':'R28',
  '02':'R32','59':'R32','60':'R32','62':'R32','80':'R32',
  '08':'R44','10':'R44','51':'R44','52':'R44','54':'R44','55':'R44','57':'R44','88':'R44',
  '44':'R52','49':'R52','53':'R52','72':'R52','85':'R52',
  '22':'R53','29':'R53','35':'R53','56':'R53',
  '16':'R75','17':'R75','19':'R75','23':'R75','24':'R75','33':'R75','40':'R75','47':'R75','79':'R75','86':'R75',
  '09':'R76','11':'R76','12':'R76','30':'R76','31':'R76','32':'R76','46':'R76','48':'R76','65':'R76','66':'R76','81':'R76','82':'R76',
  '01':'R84','03':'R84','07':'R84','15':'R84','26':'R84','38':'R84','42':'R84','43':'R84','63':'R84','69':'R84','73':'R84','74':'R84',
  '04':'R93','05':'R93','06':'R93','13':'R93','83':'R93','84':'R93',
  '2A':'R94','2B':'R94'
};

// ---------- Mapping TFV (BD Forêt V2) → groupes d'essences ----------
// Le libellé TFV (type de formation végétale, ~53 valeurs) est normalisé (accents
// NFD supprimés, minuscules) puis matché par mot-clé. Les formations « mélange »
// ne sont pas attribuées (ambiguës) ; elles restent dans le total forestier.
const TFV_MAP = [
  ['boulaie', 'bouleau'],
  ['aulnaie', 'aulne'],
  ['chenaie', 'chene'],          // sessile/pédonculée/pubescente/verte/(autre)
  ['hetraie', 'hetre'],
  ['charmaie', 'charme'],
  ['chataigneraie', 'chataignier'],
  ['frenaie', 'frene'],
  ['pineraie', 'pins'],         // maritime, sylvestre, noir…
  ['sapiniere', 'sapin'],
  ['pessiere', 'epicea'],
  ['douglaseraie', 'douglas'],
  ['melezin', 'meleze'],
  ['cedraie', 'cedre'],
  ['peupleraie', 'peuplier'],
  ['robinieraie', 'robinier']
];

// ---------- Groupes de cultures RPG retenus (proxy graminées, cf. TACCT) ----------
// Piège n°41(h) : on matche sur CODE_GROUPE_CULTURE (colonne numérique), PAS sur
// le libellé — les labels sont accentués (« Autres céréales » : /cereale/ ne
// matche pas) et surtout ÉCLATÉS (1=Blé tendre, 2=Maïs, 3=Orge, 14=Riz : aucun
// ne contient « céréales »). Groupes officiels : céréales = 1,2,3,4,14 ;
// prairies (permanentes+temporaires) = 18,19.
const RPG_CEREALES_GROUPS = [1, 2, 3, 4, 14];
const RPG_PRAIRIES_GROUPS = [18, 19];
// Repli statique embarqué (REF_CULTURES_GROUPES_CULTURES, IGN/ASP, licence
// ouverte) si le CSV est injoignable depuis votre machine (CDN/WAF) :
const RPG_CEREALES_CODES = ['AVH', 'AVP', 'BDH', 'BDP', 'BTH', 'BTP', 'CAG', 'MCR', 'MID', 'MIS', 'MLT', 'ORH', 'ORP', 'RIZ', 'SGH', 'SGP', 'SOG', 'SRS', 'TTH', 'TTP', 'CAH', 'MCS'];
const RPG_PRAIRIES_CODES = ['PPH', 'PTR'];

// ============================================================
// Helpers géométriques (purs, testés)
// ============================================================
function norm(s) { // minuscule + accents NFD supprimés
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tfvGroup(tfv) {
  const t = norm(tfv);
  if (/melange|galerie/.test(t)) return null; // ambigüe -> non attribuée
  for (const [kw, g] of TFV_MAP) if (t.indexOf(kw) !== -1) return g;
  return null; // « Autre feuillu », « Forêt galerie », etc.
}

// Piège n°41(m) : le paquet npm shapefile décode le DBF en windows-1252 PAR
// DÉFAUT (option encoding) — or les DBF de la BD Forêt V2 sont en UTF-8 :
// « Chênaie pubescente » arrivait en « ChÃªnaie pubescente » et tfvGroup ne
// matchait plus. Seules les formations SANS accent (Peupleraie, Boulaie,
// Aulnaie, Pineraie…) étaient attribuées — d'où « seul le peuplier remonte »
// dans la vue Essences & exposition (Boulaie/Aulnaie quasi absents du 31).
// Correctif : respecter le sidecar .cpg s'il existe ; sinon renifler les
// marqueurs de mojibake (« Ãx »/« Âx » = UTF-8 décodé en windows-1252) sur
// les 500 premières entités puis RELIRE le .dbf en UTF-8.
async function openShpBest(shpMod, sf) {
  const dbf = sf.replace(/\.shp$/i, '.dbf');
  const cpg = sf.replace(/\.shp$/i, '.cpg');
  if (fs.existsSync(cpg)) {
    const enc = (await fsp.readFile(cpg, 'utf8')).trim();
    if (enc) return await shpMod.open(sf, dbf, { encoding: enc });
  }
  let reader = await shpMod.open(sf); // décodage par défaut (windows-1252)
  let suspect = false, n = 0, res;
  while (n < 500 && (res = await reader.read()) && !res.done) {
    const it = res.value || res; n++;
    const props = (it && it.properties) || {};
    for (const k in props) {
      const v = props[k];
      if (typeof v === 'string' && /Ã.|Â./.test(v)) { suspect = true; break; }
    }
    if (suspect) break;
  }
  if (suspect) {
    try {
      const r2 = await shpMod.open(sf, dbf, { encoding: 'utf-8' });
      console.log('  [encodage] mojibake UTF-8 détecté dans ' + path.basename(dbf) + ' — relecture utf-8 (piège n°41(m))');
      return r2;
    } catch (e) {
      console.warn('  ⚠ mojibake détecté mais relecture utf-8 impossible (' + e.message + ')');
    }
  }
  return await shpMod.open(sf); // reprendre du début (le reniflage a consommé)
}

function ringArea(ring) { // aire planaire signée (formule du lacet), unités = coordonnées
  const n = ring.length - 1;
  let a = 0;
  for (let i = 0; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  // ferme le ring si nécessaire (premier ≠ dernier point : segment de fermeture
  // nul si le ring est déjà fermé, donc pas de double comptage)
  a += ring[n][0] * ring[0][1] - ring[0][0] * ring[n][1];
  return a / 2;
}

function ringsOfGeometry(geom) { // renvoie [{outer, holes:[…]}] en coordonnées natives
  if (!geom) return [];
  const out = [];
  const pushPolygon = (p) => { if (p && p.length) out.push({ outer: p[0] || [], holes: p.slice(1) }); };
  if (geom.type === 'Polygon') pushPolygon(geom.coordinates);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(pushPolygon);
  return out;
}

function polygonAreaM2(rings) { // somme des aires absolues des polygons (m² si L93)
  let total = 0;
  for (const { outer, holes } of rings) {
    if (outer.length < 3) continue;
    let a = Math.abs(ringArea(outer));
    for (const h of holes) a -= Math.abs(ringArea(h));
    total += Math.max(a, 0);
  }
  return total;
}

function ringCentroid(ring) { // centroïde du polygone (formule standard), point pas forcément dans le polygone
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const c = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    A += c; cx += (ring[i][0] + ring[i + 1][0]) * c; cy += (ring[i][1] + ring[i + 1][1]) * c;
  }
  if (Math.abs(A) < 1e-9) { // dégénéré : moyenne des sommets
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * A), cy / (3 * A)];
}

function pointInRing(x, y, ring) { // ray-casting, ring = [[x,y]…] (ouvert ou fermé)
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonAnyHole(x, y, outer, holes) {
  if (!pointInRing(x, y, outer)) return false;
  for (const h of holes) if (pointInRing(x, y, h)) return false;
  return true;
}

// ---------- Communes : contours france-geojson (MÊME source que l'app) ----------
// Piège n°41(g) : le repo NE CONTIENT PAS geo/communes/ — l'app les charge via
// le proxy /geo/communes/* (netlify.toml) vers raw.githubusercontent.com
// (gregoiredavid/france-geojson). Le script télécharge exactement les mêmes
// fichiers (codes INSEE identiques à l'app par construction), avec cache
// disque local ; repli sur une copie locale si elle existe.
const GEO_RAW_BASE = 'https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/departements';
async function loadCommunes(dep) {
  const fold = DEP_FOLDERS[dep];
  if (!fold) throw new Error('Département inconnu (DEP_FOLDERS) : ' + dep);
  const cache = path.join(CACHE, 'geo', 'communes-' + fold + '.geojson');
  let text = null;
  if (fs.existsSync(cache)) {
    text = await fsp.readFile(cache, 'utf8');
  } else {
    const local = path.join(GEO_DIR, fold, 'communes-' + fold + '.geojson');
    if (fs.existsSync(local)) text = await fsp.readFile(local, 'utf8');
  }
  if (text === null) {
    const url = GEO_RAW_BASE + '/' + fold + '/communes-' + fold + '.geojson';
    const r = await fetchRetry(url); // même source que le proxy /geo/communes/*
    text = await r.text();
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    await fsp.writeFile(cache, text); // cache disque : une seule fois par dép
  }
  const g = JSON.parse(text);
  const index = [];
  for (const f of g.features || []) {
    const code = f.properties && (f.properties.code || f.properties.insee);
    if (!code) continue;
    for (const r of ringsOfGeometry(f.geometry)) {
      // les communes sont en WGS84 ; on indexe en lon/lat (+ bbox de l'anneau
      // externe pour écarter vite les candidats : le RPG, ce sont des millions
      // de parcelles à tester contre quelques milliers d'anneaux)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of r.outer) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
      index.push({ code, outer: r.outer, holes: r.holes, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return index;
}

function communeOfPoint(index, x, y) {
  for (const c of index) {
    const b = c.bbox;
    if (b && (x < b[0] || y < b[1] || x > b[2] || y > b[3])) continue; // pré-filtre bbox
    if (pointInPolygonAnyHole(x, y, c.outer, c.holes)) return c.code;
  }
  return null;
}

// Point-candidats pour l'affectation : centroïde, puis des sommets (frontières
// simplifiées du repo : un centroïde peut tomber « entre » deux communes).
function candidatePoints(rings) {
  const pts = [];
  const c = ringCentroid(rings[0].outer);
  if (c) pts.push(c);
  if (rings[0].outer && rings[0].outer.length) pts.push(rings[0].outer[0], rings[0].outer[Math.floor(rings[0].outer.length / 2)]);
  return pts;
}

// ============================================================
// Réseau : flux Atom (JSON) + téléchargements .7z + extraction
// ============================================================
// Le portail data.geopf.fr limite en débit (HTTP 429) si on pagine en rafale :
// espacement minimum entre requêtes catalogue + retry exponentiel avec
// Retry-After (constaté à la première exécution : 429 dès la page 9).
const GEOPF_MIN_INTERVAL_MS = 500;
let _geopfLastReq = 0;
async function politeWait() {
  const wait = _geopfLastReq + GEOPF_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(res => setTimeout(res, wait));
  _geopfLastReq = Date.now();
}

async function fetchRetry(url, opts, tries) {
  tries = tries || 5;
  for (let i = 0; i < tries; i++) {
    await politeWait();
    const r = await fetch(url, opts);
    if (r.ok) return r;
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      // backoff exponentiel ; le header Retry-After (secondes) fait foi
      const ra = +(r.headers.get('retry-after') || 0);
      const wait = Math.max(ra * 1000, 2000 * Math.pow(2, i));
      process.stderr.write('  HTTP ' + r.status + ' (' + url + ') — nouvelle tentative ' + (i + 2) + '/' + tries + ' dans ' + Math.round(wait / 1000) + ' s\n');
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw new Error('HTTP ' + r.status + ' sur ' + url);
  }
}

async function fetchJSON(url) {
  const r = await fetchRetry(url, { headers: { Accept: 'application/json' } });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { __xml: t }; }
}

async function feedEntries(resource) {
  // Page 1 pour connaître le total, puis toutes les pages (10 entrées/page).
  const first = await fetchJSON('https://data.geopf.fr/telechargement/resource/' + resource);
  const titles = [];
  const grab = (j) => {
    if (j && Array.isArray(j.entry)) j.entry.forEach(e => titles.push(e.title));
    else if (j && j.__xml) (j.__xml.match(/<title>([^<]+)<\/title>/g) || []).forEach(s => {
      const v = s.replace(/<\/?title>/g, '');
      if (!/^(RPG|BDFORET|This document)/.test(v) || v.indexOf('__') !== -1) titles.push(v);
    });
  };
  grab(first);
  const total = first && first.totalentries ? Math.ceil(first.totalentries / 10) : 1;
  for (let p = 2; p <= total; p++) grab(await fetchJSON('https://data.geopf.fr/telechargement/resource/' + resource + '?page=' + p));
  return [...new Set(titles)];
}

async function entryDownloadLinks(resource, entry) {
  const j = await fetchJSON('https://data.geopf.fr/telechargement/resource/' + resource + '/' + encodeURIComponent(entry));
  const links = [];
  const grab = (o) => {
    if (!o) return;
    if (Array.isArray(o)) { o.forEach(grab); return; }
    if (typeof o !== 'object') return;
    if (typeof o.href === 'string' && o.href.indexOf('/telechargement/download/') !== -1) links.push(o.href);
    Object.values(o).forEach(grab);
  };
  grab(j.entry || j);
  return [...new Set(links)];
}

async function download(url, dest, force) {
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const r = await fetchRetry(url);
  if (!r.ok) throw new Error('Téléchargement HTTP ' + r.status + ' : ' + url);
  const total = +(r.headers.get('content-length') || 0);
  let done = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of r.body) {
    out.write(chunk); done += chunk.length;
    if (total && (done % 50e6) < chunk.length) process.stderr.write('  … ' + (done / 1e6).toFixed(0) + ' / ' + (total / 1e6).toFixed(0) + ' Mo\r');
  }
  await new Promise(res => out.end(res));
  process.stderr.write('\n');
  return dest;
}

function sevenZipAvailable() {
  for (const b of ['7z', '7za', '7zr']) {
    const p = spawnSync(b, [''], { shell: false }); // renvoie un code != 0 mais prouve la présence
    if (!p.error) return b;
  }
  return null;
}

function extract7z(archive, destDir) {
  const bin = sevenZipAvailable();
  if (!bin) throw new Error('Exécutable 7z introuvable dans le PATH (paquet p7zip / 7-Zip). Installez-le ou extrayez manuellement avec --from-dir.');
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(bin, ['x', '-y', '-o' + destDir, archive], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('Extraction 7z échouée (code ' + r.status + ') : ' + archive);
  return destDir;
}

async function ensureExtracted(resource, entry, force) {
  const dir = path.join(CACHE, entry);
  const marker = path.join(dir, '.extracted');
  if (!force && fs.existsSync(marker)) return dir;
  const links = await entryDownloadLinks(resource, entry);
  if (!links.length) throw new Error('Aucun lien de téléchargement pour ' + entry);
  // multi-part : garder l'ordre (.001 d'abord), 7z extrait à partir du .001
  links.sort();
  const first = links.find(l => /\.(7z|zip)$/i.test(l)) || links.find(l => /\.7z\.001$/i.test(l)) || links[0];
  const archives = [];
  for (const l of links) {
    const name = decodeURIComponent(l.split('/').pop());
    archives.push(await download(l, path.join(CACHE, '_dl', entry, name), force));
  }
  const main = archives.find(a => /\.(7z|zip)$/i.test(a)) || archives.find(a => /\.001$/.test(a)) || archives[0];
  extract7z(main, dir);
  await fsp.writeFile(marker, String(Date.now()));
  return dir;
}

function findFiles(dir, re) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function dirSize(d) { // octets, récursif (l'équivalent de « du -sb »)
  let t = 0;
  const walk = (x) => {
    let es;
    try { es = fs.readdirSync(x, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p);
      else { try { t += fs.statSync(p).size; } catch (e2) {} }
    }
  };
  walk(d);
  return t;
}

// ============================================================
// BD Forêt V2 : SHP par département -> data/essences-foret/d<dep>.json
// ============================================================
async function buildForet(dep, entries, opts) {
  // dernière entrée SHP L93 du département — piège n°41(f) : le catalogue
  // code les départements sur 3 caractères (D001 pour l'Ain, D082, D02A/D02B
  // pour la Corse) — regex tolérante D0*<dep>_ (matche aussi un éventuel D<dep>_)
  const cands = entries.filter(t => new RegExp('BDFORET_2-0__SHP_LAMB93_D0*' + dep + '_').test(t)).sort();
  if (!cands.length) { console.warn('⚠ Pas d\'entrée BD Forêt V2 (SHP) pour ' + dep + ' — ignorer ?'); return null; }
  const entry = cands[cands.length - 1];
  console.log('— ' + dep + ' : ' + entry);
  const dir = opts.fromDir || await ensureExtracted('BDFORET', entry, opts.force);
  const shpFiles = findFiles(dir, /\.shp$/i);
  if (!shpFiles.length) throw new Error('Aucun .shp extrait pour ' + entry);
  const shpMod = await import('shapefile');
  const proj4 = (await import('proj4')).default;
  const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs';
  const communes = await loadCommunes(dep);
  const acc = {}; // code -> { essence: m2 }
  let totalForetM2 = 0, nPoly = 0;
  const groupHa = {}; // clé d'essence -> m² (toutes communes, pour le diag)
  // --diag : instrumente l'entonnoir (où les surfaces se perdent)
  const D = opts.diag ? {
    limite: opts.limite > 0 ? opts.limite : 200000,
    premier: null, featuresLus: 0, sansTfv: 0, sansGeom: 0, aireNulle: 0,
    horsContours: 0, affectes: 0, tfvs: {}, exemples: [], perdus: []
  } : null;
  for (const sf of shpFiles) {
    const reader = await openShpBest(shpMod, sf); // piège n°41(m) : encodage DBF
    // Piège n°41(i) : l'API du paquet npm « shapefile » renvoie
    // { done: boolean, value: Feature } — PAS le Feature directement.
    // while ((it = await reader.read()) && it.geometry) sortait dès la 1re
    // lecture (it.geometry === undefined) → sorties VIDES sans aucune erreur.
    let res;
    let lusShp = 0;
    while ((res = await reader.read()) && !res.done) {
      const it = res.value || res;
      lusShp++;
      if (D && lusShp > D.limite) { console.log('  [diag] limite ' + D.limite + ' polygones atteinte dans ' + path.basename(sf)); break; }
      if (!it || !it.geometry) { if (D) D.sansGeom++; continue; }
      const props = it.properties || {};
      if (D && D.premier === null) {
        D.premier = true;
        console.log('  [diag] 1er polygone de ' + path.basename(sf) + ' — propriétés DBF :');
        for (const k of Object.keys(props)) console.log('    ' + k + ' = ' + JSON.stringify(props[k]));
      }
      const tfvKey = Object.keys(props).find(k => /^TFV$/i.test(k));
      if (!tfvKey) { if (D) D.sansTfv++; continue; }
      const rings = ringsOfGeometry(it.geometry); // coordonnées L93 (m)
      if (!rings.length) { if (D) D.sansGeom++; continue; }
      const areaM2 = polygonAreaM2(rings);
      if (areaM2 <= 0) { if (D) D.aireNulle++; continue; }
      nPoly++; totalForetM2 += areaM2;
      const tfv = String(props[tfvKey]);
      const g = tfvGroup(tfv);
      if (D) D.tfvs[tfv] = (D.tfvs[tfv] || 0) + 1;
      if (g) groupHa[g] = (groupHa[g] || 0) + areaM2;
      let code = null, llEx = null;
      for (const pt of candidatePoints(rings)) {
        const lonlat = proj4(L93, 'WGS84', pt);
        llEx = lonlat;
        const c = communeOfPoint(communes, lonlat[0], lonlat[1]);
        if (c) { code = c; break; }
      }
      if (!code) { // hors des contours (simplifiés) du repo
        if (D) {
          D.horsContours++;
          if (D.perdus.length < 3) D.perdus.push({ tfv: tfv, groupe: g || '?', aireHa: Math.round(areaM2 / 100) / 100, centre: [+llEx[0].toFixed(5), +llEx[1].toFixed(5)] });
        }
        continue;
      }
      if (D) {
        D.affectes++;
        if (D.exemples.length < 3) D.exemples.push({ tfv: tfv, groupe: g || '?', aireHa: Math.round(areaM2 / 100) / 100, commune: code, centre: [+llEx[0].toFixed(5), +llEx[1].toFixed(5)] });
      }
      acc[code] = acc[code] || {};
      acc[code]._foret = (acc[code]._foret || 0) + areaM2;
      if (g) acc[code][g] = (acc[code][g] || 0) + areaM2;
    }
    if (D) D.featuresLus += Math.min(lusShp, D.limite);
  }
  if (D) {
    console.log('\n══════════ DIAGNOSTIC BD Forêt ' + dep + ' (' + entry + ') ══════════');
    console.log('  dossier extrait : ' + dir + ' — ' + (dirSize(dir) / 1e6).toFixed(0) + ' Mo ; .shp trouvés : ' + shpFiles.map(p => path.basename(p)).slice(0, 10).join(', '));
    console.log('  polygones lus           : ' + D.featuresLus + (opts.limite > 0 ? ' (limite ' + D.limite + ' par .shp)' : ''));
    console.log('  sans colonne TFV        : ' + D.sansTfv);
    console.log('  géométries vides        : ' + D.sansGeom);
    console.log('  aires nulles            : ' + D.aireNulle);
    console.log('  hors contours communaux : ' + D.horsContours);
    console.log('  affectés à une commune  : ' + D.affectes);
    const top = Object.entries(D.tfvs).sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log('  top TFV (→ groupe attribué) :');
    top.forEach(kv => console.log('    ' + JSON.stringify(kv[0]) + ' -> ' + (tfvGroup(kv[0]) || '?') + ' ×' + kv[1]));
    const tot = Object.entries(groupHa).sort((a, b) => b[1] - a[1]);
    console.log('  ha par clé du JSON : ' + (tot.length ? tot.map(kv => kv[0] + '=' + (Math.round(kv[1] / 100) / 100) + ' ha').join(', ') : 'AUCUNE'));
    const ATTENDUS = ['chene', 'hetre', 'charme', 'chataignier', 'frene', 'pins', 'sapin', 'epicea', 'douglas', 'bouleau', 'aulne', 'peuplier', 'cedre']; // clés lues par pollens-essences.js
    const absents = ATTENDUS.filter(k => !groupHa[k]);
    if (absents.length) console.log('  ⚠ clés attendues par l\'app à 0 ha : ' + absents.join(', '));
    const attribue = Object.values(groupHa).reduce((a, b) => a + b, 0);
    if (totalForetM2 > 0 && attribue < totalForetM2 * 0.7) {
      console.log('  ⚠ ' + Math.round((totalForetM2 - attribue) / 100) / 100 + ' ha (' + Math.round((totalForetM2 - attribue) * 100 / totalForetM2) + ' %) de forêt SANS essence attribuée — libellés TFV non matchés (encodage DBF ? piège n°41(m)) ou formations « mélange » (non attribuées par méthode)');
    }
    D.exemples.forEach(x => console.log('  ✓ ' + x.tfv + ' -> ' + x.groupe + ', ' + x.aireHa + ' ha, commune ' + x.commune + ' @ ' + x.centre.join(',')));
    D.perdus.forEach(x => console.log('  ✗ ' + x.tfv + ' (' + x.groupe + '), ' + x.aireHa + ' ha, AUCUNE commune @ ' + x.centre.join(',')));
    const c0 = communes[0];
    const ct = c0 ? ringCentroid(c0.outer) : null;
    const rt = ct ? communeOfPoint(communes, ct[0], ct[1]) : null;
    console.log('  contours ' + dep + ' : ' + communes.length + ' anneaux ; aller-retour centroïde du 1er anneau -> ' + (rt === c0.code ? 'OK (' + c0.code + ')' : 'ÉCHEC (attendu ' + (c0 && c0.code) + ', trouvé ' + rt + ')'));
    console.log('══════════ mode --diag : aucun JSON écrit dans data/essences-foret/ ══════════');
    return true;
  }
  // conversion m² -> ha (2 décimales) + shape de sortie
  const communesOut = {};
  for (const code in acc) {
    const o = {};
    for (const k in acc[code]) o[k === '_foret' ? '_foret' : k] = Math.round(acc[code][k] / 100) / 100;
    communesOut[code] = o;
  }
  const out = {
    meta: {
      source: 'BD Forêt V2 (IGN, licence ouverte) — ' + entry,
      dep: dep, unite: 'ha', methode: 'centroid de polygone -> commune (ray-casting), aire planaire Lambert-93',
      nPolygones: nPoly, foretHa: Math.round(totalForetM2 / 100) / 100
    },
    communes: communesOut
  };
  await fsp.mkdir(OUT_FORET, { recursive: true });
  await fsp.writeFile(path.join(OUT_FORET, 'd' + dep + '.json'), JSON.stringify(out));
  console.log('  ✓ ' + Object.keys(communesOut).length + ' communes, ' + out.meta.foretHa + ' ha de forêt');
  return out;
}

// ============================================================
// RPG : SHP parcelles par région -> data/essences-rpg/d<dep>.json (pour chaque dép de la région)
// ============================================================
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';' || ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; if (row.some(c => c !== '')) rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadCultureGroups(millesime) {
  // referentiel CODE_CULTURE -> 'cereales' | 'prairies' ; essayer <millesime>,
  // puis 2024/2025 ; en dernier recours REPLI sur le référentiel statique
  // embarqué (piège n°41(h) : matcher sur CODE_GROUPE_CULTURE, pas sur le
  // libellé accentué/éclaté).
  for (const y of [...new Set([millesime, 2024, 2025])]) {
    const url = 'https://data.geopf.fr/annexes/ressources/documentation/REF_CULTURES_GROUPES_CULTURES_' + y + '.csv';
    let r = null;
    try {
      r = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) OpenFrance-build', Accept: 'text/csv' } });
    } catch (e) { continue; }
    const rows = parseCsv(await r.text());
    const head = rows[0].map(h => norm(h));
    const iCode = head.findIndex(h => /^code_culture/.test(h) || h === 'code');
    const iGrpCode = head.findIndex(h => /code_groupe/.test(h)); // CODE_GROUPE_CULTURE fait foi
    if (iCode === -1 || iGrpCode === -1) continue;
    const map = {};
    for (const row of rows.slice(1)) {
      const code = (row[iCode] || '').trim();
      const grp = +((row[iGrpCode] || '').trim());
      if (!code || !grp) continue;
      if (RPG_CEREALES_GROUPS.includes(grp)) map[code] = 'cereales';
      else if (RPG_PRAIRIES_GROUPS.includes(grp)) map[code] = 'prairies';
    }
    if (Object.keys(map).length) { console.log('Référentiel cultures ' + y + ' : ' + Object.keys(map).length + ' codes (céréales + prairies)'); return map; }
  }
  const map = {};
  RPG_CEREALES_CODES.forEach(c => map[c] = 'cereales');
  RPG_PRAIRIES_CODES.forEach(c => map[c] = 'prairies');
  console.log('Référentiel cultures : REPLI statique embarqué (' + Object.keys(map).length + ' codes, REF_CULTURES_GROUPES_CULTURES 2024/2025 — CDN injoignable)');
  return map;
}

async function buildRpg(region, deps, entries, opts) {
  const mil = opts.millesime;
  // Piège n°41(k) : les GPKG « RPG_4-0 » (2024/2025) ne sont que des îlots
  // anonymes (fid, geom, num_ilot) — AUCUNE culture. Les parcelles avec
  // CODE_CULTURE n'existent qu'en SHP (éditions 2015-2023) : on prend 2023.
  const cands = entries.filter(t => new RegExp('RPG_\\d-\\d__SHP_LAMB93_' + region + '_' + mil + '-01-01$').test(t)).sort();
  let entry = cands[cands.length - 1];
  if (!entry) { // repli : dernière édition SHP parcelles de la région
    const all = entries.filter(t => new RegExp('RPG_\\d-\\d__SHP_LAMB93_' + region + '_').test(t)).sort();
    if (!all.length) { console.warn('⚠ Pas d\'entrée RPG (SHP parcelles) pour ' + region); return null; }
    entry = all[all.length - 1];
    console.log('  (repli sur ' + entry + ')');
  }
  const year = (entry.match(/_(\d{4})-01-01$/) || [])[1] || mil;
  console.log('— Région ' + region + ' : ' + entry + ' (départements : ' + deps.join(', ') + ')');
  const dir = opts.fromDir || await ensureExtracted('RPG', entry, opts.force);
  const shpFiles = findFiles(dir, /\.shp$/i);
  if (!shpFiles.length) throw new Error('Aucun .shp extrait pour ' + entry);
  // parcelles uniquement : les éditions 2015-2023 contiennent AUSSI les îlots
  // (géométrie plus grossière, sans culture) — ne pas les compter 2 fois.
  let parcelleShps = shpFiles.filter(p => /parcelle/i.test(p) && !/ilot/i.test(p));
  if (!parcelleShps.length) {
    parcelleShps = shpFiles.filter(p => !/ilot/i.test(p));
    if (!parcelleShps.length) throw new Error('Aucun .shp parcelles dans ' + entry + ' (trouvé : ' + shpFiles.map(p => path.basename(p)).slice(0, 8).join(', ') + ')');
    console.warn('  ⚠ aucun .shp « parcelles » explicite — ' + parcelleShps.length + ' .shp hors îlots retenus');
  }
  if (opts.diag) {
    console.log('  [diag] dossier extrait : ' + dir + ' — ' + (dirSize(dir) / 1e6).toFixed(0) + ' Mo');
    console.log('  [diag] .shp trouvés (' + shpFiles.length + ') : ' + shpFiles.map(p => path.basename(p)).slice(0, 15).join(', ') + (shpFiles.length > 15 ? ', …' : ''));
    console.log('  [diag] .shp retenus comme parcelles (' + parcelleShps.length + ') : ' + parcelleShps.map(p => path.basename(p)).slice(0, 15).join(', ') + (parcelleShps.length > 15 ? ', …' : ''));
  }
  const shpMod = await import('shapefile');
  const groups = await loadCultureGroups(year);
  // index communes de tous les départements de la région (en WGS84)
  const communesByDep = {};
  for (const d of deps) communesByDep[d] = await loadCommunes(d);
  const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs';
  const proj4 = (await import('proj4')).default;
  // accumule { dep -> { code -> { cereales, prairies, _rpg } } } en m²
  const acc = {}; deps.forEach(d => acc[d] = {});
  // --diag : instrumente l'entonnoir complet (où les parcelles se perdent)
  const D = opts.diag ? {
    limite: opts.limite > 0 ? opts.limite : 200000,
    premier: null, featuresLus: 0, sansCle: 0, sansGeom: 0, cultures: {},
    horsGroupes: 0, aireNulle: 0, affectees: 0, horsContours: 0, exemples: [], perdus: []
  } : null;
  let nRows = 0;
  for (const sf of parcelleShps) {
    const reader = await openShpBest(shpMod, sf); // piège n°41(m) : encodage DBF
    // Piège n°41(i) : reader.read() renvoie { done, value } — PAS le Feature
    let res;
    let lusShp = 0;
    while ((res = await reader.read()) && !res.done) {
      const it = res.value || res;
      lusShp++;
      if (D && lusShp > D.limite) { console.log('  [diag] limite ' + D.limite + ' parcelles atteinte dans ' + path.basename(sf)); break; }
      if (!it || !it.geometry) { if (D) D.sansGeom++; continue; }
      const props = it.properties || {};
      if (D && D.premier === null) {
        D.premier = true;
        console.log('  [diag] 1re parcelle de ' + path.basename(sf) + ' — propriétés DBF :');
        for (const k of Object.keys(props)) console.log('    ' + k + ' = ' + JSON.stringify(props[k]));
      }
      // Piège n°41(l) : les noms de colonnes DBF sont tronqués à 10 caractères —
      // la culture s'appelle donc CODE_CULTU (sans « RE » !) : /culture/i ne
      // matche PAS et la sortie était « 0 communes » partout, sans erreur.
      // On matche /code_cult/i d'abord, puis /cult/i en excluant les cultures
      // dérobées (CULTURE_D1/CULTURE_D2, non retenues comme proxy pollens).
      // NB : la surface déclarée SURF_PARC est en HECTARES (piège d'unité :
      // +100× vs m²) — on l'IGNORE et on calcule l'aire planaire Lambert-93,
      // comme pour la BD Forêt.
      const pKeys = Object.keys(props);
      const cKey = pKeys.find(k => /^code_cult/i.test(k))
        || pKeys.find(k => /cult/i.test(k) && !/(_d\d|derob)/i.test(k));
      if (!cKey) { if (D) D.sansCle++; continue; }
      nRows++;
      const cc = String(props[cKey]).trim();
      const g = groups[cc];
      if (D) D.cultures[cc] = (D.cultures[cc] || 0) + 1;
      if (!g) { if (D) D.horsGroupes++; continue; } // hors céréales/prairies
      const rings = ringsOfGeometry(it.geometry); // coordonnées L93 (m)
      if (!rings.length) { if (D) D.sansGeom++; continue; }
      const areaM2 = polygonAreaM2(rings);
      if (areaM2 <= 0) { if (D) D.aireNulle++; continue; }
      let code = null, dep = null, llEx = null;
      for (const pt of candidatePoints(rings)) {
        const ll = proj4(L93, 'WGS84', pt);
        llEx = ll;
        for (const d of deps) {
          const c = communeOfPoint(communesByDep[d], ll[0], ll[1]);
          if (c) { code = c; dep = d; break; }
        }
        if (code) break;
      }
      if (!code) {
        if (D) {
          D.horsContours++;
          if (D.perdus.length < 3) D.perdus.push({ culture: cc, aireHa: Math.round(areaM2 / 100) / 100, centre: [+(llEx || [0, 0])[0].toFixed(5), +(llEx || [0, 0])[1].toFixed(5)] });
        }
        continue;
      }
      if (D) {
        D.affectees++;
        if (D.exemples.length < 3) D.exemples.push({ culture: cc, groupe: g, aireHa: Math.round(areaM2 / 100) / 100, commune: code, centre: [+llEx[0].toFixed(5), +llEx[1].toFixed(5)] });
      }
      const o = acc[dep][code] = acc[dep][code] || { cereales: 0, prairies: 0, _rpg: 0 };
      o[g] += areaM2; o._rpg += areaM2;
    }
    if (D) D.featuresLus += Math.min(lusShp, D.limite);
  }
  if (D) {
    console.log('\n══════════ DIAGNOSTIC RPG ' + region + ' (' + entry + ') ══════════');
    console.log('  parcelles lues          : ' + D.featuresLus + (opts.limite > 0 ? ' (limite ' + D.limite + ' par .shp)' : ''));
    console.log('  sans colonne culture    : ' + D.sansCle);
    console.log('  géométries vides        : ' + D.sansGeom);
    console.log('  hors groupes (ni céréales ni prairies) : ' + D.horsGroupes);
    console.log('  aires nulles            : ' + D.aireNulle);
    console.log('  affectées à une commune : ' + D.affectees);
    const nbDepsRegion = Object.keys(DEP_TO_R).filter(d => DEP_TO_R[d] === region).length;
    console.log('  hors contours communaux : ' + D.horsContours + (nbDepsRegion > deps.length ? '  (attendu : le SHP ' + region + ' couvre les ' + nbDepsRegion + ' départements de la région, on ne matche que ' + deps.join(', ') + ')' : ''));
    const top = Object.entries(D.cultures).sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log('  top cultures : ' + (top.length ? top.map(kv => kv[0] + '(' + (groups[kv[0]] || '?') + ')×' + kv[1]).join(', ') : 'AUCUNE'));
    D.exemples.forEach(x => console.log('  ✓ ' + x.culture + ' -> ' + x.groupe + ', ' + x.aireHa + ' ha, commune ' + x.commune + ' @ ' + x.centre.join(',')));
    D.perdus.forEach(x => console.log('  ✗ ' + x.culture + ', ' + x.aireHa + ' ha, AUCUNE commune @ ' + x.centre.join(',')));
    for (const d of deps) {
      const c0 = communesByDep[d][0];
      const ct = c0 ? ringCentroid(c0.outer) : null;
      const rt = ct ? communeOfPoint(communesByDep[d], ct[0], ct[1]) : null;
      console.log('  contours ' + d + ' : ' + communesByDep[d].length + ' anneaux ; aller-retour centroïde du 1er anneau -> ' + (rt === c0.code ? 'OK (' + c0.code + ')' : 'ÉCHEC (attendu ' + (c0 && c0.code) + ', trouvé ' + rt + ')'));
    }
    console.log('══════════ mode --diag : aucun JSON écrit dans data/essences-rpg/ ══════════');
    return true;
  }
  await fsp.mkdir(OUT_RPG, { recursive: true });
  for (const d of deps) {
    const communesOut = {};
    for (const code in acc[d]) {
      const o = acc[d][code];
      communesOut[code] = {
        cereales: Math.round(o.cereales / 100) / 100,
        prairies: Math.round(o.prairies / 100) / 100,
        _rpg: Math.round(o._rpg / 100) / 100
      };
    }
    const out = {
      meta: {
        source: 'RPG ' + year + ' (ASP/IGN, licence ouverte) — ' + entry,
        dep: d, unite: 'ha',
        methode: 'parcelle RPG -> commune par centroïde (ray-casting) ; groupes Céréales + Prairies (permanentes & temporaires)',
        nParcelles: nRows
      },
      communes: communesOut
    };
    await fsp.writeFile(path.join(OUT_RPG, 'd' + d + '.json'), JSON.stringify(out));
    console.log('  ✓ ' + d + ' : ' + Object.keys(communesOut).length + ' communes');
  }
  return true;
}

// ============================================================
// CLI
// ============================================================
function parseArgs(argv) {
  const o = { deps: [], millesime: 2023, force: false, fromDir: null, list: false, foret: false, rpg: false, all: false, clean: false, diag: false, limite: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--foret') o.foret = true;
    else if (a === '--rpg') o.rpg = true;
    else if (a === '--all') o.all = true;
    else if (a === '--list') o.list = true;
    else if (a === '--force') o.force = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--dep') o.deps = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--millesime') o.millesime = +(argv[++i] || 2023);
    else if (a === '--from-dir') o.fromDir = argv[++i];
    else if (a === '--diag') o.diag = true;
    else if (a === '--limite') o.limite = +(argv[++i] || 0);
    else { console.error('Option inconnue : ' + a); process.exit(1); }
  }
  if (o.all) { o.foret = true; o.rpg = true; }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.foret && !opts.rpg && !opts.list) {
    console.error('Donner --foret, --rpg, --all ou --list (voir en-tête du script).');
    process.exit(1);
  }
  if (opts.list) {
    // SÉQUENTIEL : les deux catalogues en parallèle doublent le rythme -> 429
    const bdf = await feedEntries('BDFORET');
    const rpg = await feedEntries('RPG');
    console.log('BDFORET (échantillon) :'); bdf.slice(-15).forEach(t => console.log('  ' + t));
    console.log('RPG parcelles (SHP, éditions 2015-2023 — la dernière est 2023) :');
    rpg.filter(t => /RPG_\d-\d__SHP_LAMB93_R\d\d_2023/.test(t)).forEach(t => console.log('  ' + t));
    console.log('⚠ les GPKG RPG_4-0 2024/2025 ne sont que des îlots anonymes sans culture (piège n°41(k))');
    return;
  }
  const deps = opts.deps.length ? opts.deps : Object.keys(DEP_FOLDERS);
  for (const d of deps) if (!DEP_FOLDERS[d]) { console.error('Département inconnu : ' + d); process.exit(1); }
  if (opts.foret) {
    const entries = await feedEntries('BDFORET');
    for (const d of deps) {
      if (d === '75' || d === '92' || d === '93' || d === '94') { console.log('— ' + d + ' : quasi sans forêt, ignoré'); continue; }
      try { await buildForet(d, entries, opts); }
      catch (e) { console.error('  ✗ ' + d + ' : ' + e.message); }
    }
  }
  if (opts.rpg) {
    if (opts.diag && !opts.deps.length) console.warn('⚠ --diag : préciser un département (ex. --foret --dep 31 --diag ou --rpg --dep 31 --diag) sinon toute la métropole est instrumentée.');
    if (opts.limite > 0 && !opts.diag) console.warn('⚠ --limite ignorée sans --diag');
    const entries = await feedEntries('RPG');
    const byR = {};
    for (const d of deps) { const r = DEP_TO_R[d]; if (r) (byR[r] = byR[r] || []).push(d); }
    for (const r of Object.keys(byR).sort()) {
      try { await buildRpg(r, byR[r], entries, opts); }
      catch (e) { console.error('  ✗ ' + r + ' : ' + e.message); }
    }
  }
  if (opts.clean) await fsp.rm(CACHE, { recursive: true, force: true });
  console.log('Terminé. Sorties : data/essences-foret/ et data/essences-rpg/');
}

main().catch(e => { console.error(e); process.exit(1); });
