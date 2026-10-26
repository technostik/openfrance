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
//      Fichiers GPKG Lambert-93 PAR RÉGION (R11…R94), millésimes 2024/2025.
//      Référentiel cultures : REF_CULTURES_GROUPES_CULTURES_<année>.csv
//      (https://data.geopf.fr/annexes/ressources/documentation/).
//
// Méthode (approximation documentée, piège n°41) :
//   - chaque polygone (forêt / parcelle RPG) est affecté à la commune contenant
//     son centroïde (ray-casting) ; les polygones à cheval sur deux communes
//     sont donc affectés à la commune dominante du centroïde ;
//   - les superficies sont les aires planaires Lambert-93 (m²), converties en
//     hectares (2 décimales) dans le JSON de sortie ;
//   - les contours communaux utilisés sont CEUX DU REPO
//     (geo/communes/departements/<dossier>/communes-<dossier>.geojson) :
//     les codes INSEE de sortie matcheront l'application par construction.
//
// Sortie (dossier data/, embarqué dans le repo — style naf.js, aucune requête
// réseau au chargement de l'app) :
//   data/essences-foret/d<dep>.json   { meta, communes: { "<insee>": { <groupe>: ha, …, _foret: ha } } }
//   data/essences-rpg/d<dep>.json     { meta, communes: { "<insee>": { cereales: ha, prairies: ha, _rpg: ha } } }
//
// Prérequis (Node.js ≥ 18) :
//   npm install --save-dev shapefile proj4 better-sqlite3
//   + un exécutable 7z dans le PATH (paquet p7zip-full / p7zip, brew install
//     p7zip, ou 7-Zip.org ; les archives IGN sont des .7z, parfois multi-part
//     .7z.001/.002 — 7z les extrait directement).
//
// Usage :
//   node tools/build-essences-communes.mjs --list            # entrées disponibles
//   node tools/build-essences-communes.mjs --foret           # BD Forêt, tous départements
//   node tools/build-essences-communes.mjs --foret --dep 01,69
//   node tools/build-essences-communes.mjs --rpg            # RPG, toutes régions métropole
//   node tools/build-essences-communes.mjs --rpg --dep 01,69 # régions nécessaires
//   node tools/build-essences-communes.mjs --all            # les deux
//   Options : --millesime 2024 (RPG ; BD Forêt prend toujours le dernier)
//             --from-dir tools/.cache/essences/…  (déjà téléchargé/extrait)
//             --force (retélécharger), --clean (supprimer le cache après)
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

// Départements métropole → région du flux RPG (GPKG par région, cf. piège n°41).
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
const RPG_GROUPS = [
  [/cereale/i, 'cereales'],
  [/prairie\s*permanente/i, 'prairies'],
  [/prairie\s*temporaire/i, 'prairies']
];

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

// ---------- Lecture du GeoPackage binary (gpkg geometry blob -> rings L93) ----------
// Spec GeoPackage : magic 'GP', version, flags (bit0 = byteOrder, bits1-3 = envelope),
// envelope (0/4/6/8 doubles), puis la géométrie WKB standard.
function gpkgRings(buf) {
  if (!buf || buf.length < 8 || buf[0] !== 0x47 || buf[1] !== 0x50) return [];
  const flags = buf[3];
  const little = (flags & 1) === 1;
  const envCode = (flags >> 1) & 7;
  const envDoubles = [0, 4, 4, 6, 6, 8, 8, 0][envCode] || 0; // 1=XY(4),2=XYZ(6? non: XYZ=6 doubles -> code 2 => 6),3=XYM,4=XYZM(8)
  let off = 8 + envDoubles * 8;
  try {
    return wkbRings(buf, off, little);
  } catch (e) {
    return [];
  }
}

function wkbRings(buf, off, little) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rd32 = (o, le) => le ? dv.getUint32(o, true) : dv.getUint32(o, false);
  const rdD = (o, le) => le ? dv.getFloat64(o, true) : dv.getFloat64(o, false);
  let o = off;
  let bom = rd32(o, little); o += 4;
  if (bom !== 0 && bom !== 1) bom = rd32(o - 4, !little); // tolérance : header et WKB d'endianness distincts
  const le = bom === 1; // le BOM WKB fait foi : 1 = little, 0 = big
  const typeRaw = rd32(o, le); o += 4;
  const baseType = typeRaw % 1000; // 3 = Polygon, 6 = MultiPolygon
  const hasZ = typeRaw >= 1000 && typeRaw < 2000;
  const hasM = typeRaw >= 2000 && typeRaw < 3000;
  const stride = 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0); // pas des points (Z/M ignorés)
  const readRing = (oo, le2) => {
    const n = rd32(oo, le2); oo += 4;
    const ring = [];
    for (let i = 0; i < n; i++) { ring.push([rdD(oo, le2), rdD(oo + 8, le2)]); oo += stride; }
    return { ring, o: oo };
  };
  const readPolygon = (oo, le2) => { // lit un WKB Polygon à oo, renvoie {polys:[ring…], o}
    const b2 = rd32(oo, le2); oo += 4; // byteOrder sous-géométrie
    const le3 = b2 === 1;
    const t2 = rd32(oo, le3); oo += 4; // type (supposé Polygon)
    const stride2 = 16 + (t2 >= 1000 && t2 < 2000 ? 8 : 0) + (t2 >= 2000 && t2 < 3000 ? 8 : 0);
    const nR = rd32(oo, le3); oo += 4;
    const polys = [];
    for (let i = 0; i < nR; i++) {
      const n = rd32(oo, le3); oo += 4;
      const ring = [];
      for (let k = 0; k < n; k++) { ring.push([rdD(oo, le3), rdD(oo + 8, le3)]); oo += stride2; }
      polys.push(ring);
    }
    return { polys, o: oo };
  };
  const rings = [];
  if (baseType === 3) { // Polygon
    const p = readPolygon(o - 8, le); // -8 : relit le byteOrder+type du polygone courant
    rings.push({ outer: p.polys[0] || [], holes: p.polys.slice(1) });
  } else if (baseType === 6) { // MultiPolygon
    const nP = rd32(o, le); o += 4;
    for (let i = 0; i < nP; i++) {
      const p = readPolygon(o, le);
      rings.push({ outer: p.polys[0] || [], holes: p.polys.slice(1) });
      o = p.o;
    }
  }
  return rings;
}

// ---------- Communes du repo : index spatial minimal (PIP) ----------
async function loadCommunes(dep) {
  const fold = DEP_FOLDERS[dep];
  if (!fold) throw new Error('Département inconnu (DEP_FOLDERS) : ' + dep);
  const p = path.join(GEO_DIR, fold, 'communes-' + fold + '.geojson');
  const g = JSON.parse(await fsp.readFile(p, 'utf8'));
  const index = [];
  for (const f of g.features || []) {
    const code = f.properties && (f.properties.code || f.properties.insee);
    if (!code) continue;
    for (const r of ringsOfGeometry(f.geometry)) {
      // les communes du repo sont en WGS84 ; on indexe en lon/lat
      index.push({ code, outer: r.outer, holes: r.holes });
    }
  }
  return index;
}

function communeOfPoint(index, x, y) {
  for (const c of index) if (pointInPolygonAnyHole(x, y, c.outer, c.holes)) return c.code;
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
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url);
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
  const r = await fetch(url);
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

// ============================================================
// BD Forêt V2 : SHP par département -> data/essences-foret/d<dep>.json
// ============================================================
async function buildForet(dep, entries, opts) {
  // dernière entrée SHP L93 du département
  const cands = entries.filter(t => new RegExp('BDFORET_2-0__SHP_LAMB93_D' + dep + '_').test(t)).sort();
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
  for (const sf of shpFiles) {
    const reader = await shpMod.open(sf);
    let it;
    while ((it = await reader.read()) && it.geometry) {
      const props = it.properties || {};
      const tfvKey = Object.keys(props).find(k => /^TFV$/i.test(k));
      if (!tfvKey) continue;
      const rings = ringsOfGeometry(it.geometry); // coordonnées L93 (m)
      if (!rings.length) continue;
      const areaM2 = polygonAreaM2(rings);
      if (areaM2 <= 0) continue;
      nPoly++; totalForetM2 += areaM2;
      const code = (() => {
        for (const pt of candidatePoints(rings)) {
          const lonlat = proj4(L93, 'WGS84', pt);
          const c = communeOfPoint(communes, lonlat[0], lonlat[1]);
          if (c) return c;
        }
        return null;
      })();
      if (!code) continue; // hors des contours (simplifiés) du repo
      const g = tfvGroup(props[tfvKey]);
      acc[code] = acc[code] || {};
      acc[code]._foret = (acc[code]._foret || 0) + areaM2;
      if (g) acc[code][g] = (acc[code][g] || 0) + areaM2;
    }
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
// RPG : GPKG par région -> data/essences-rpg/d<dep>.json (pour chaque dép de la région)
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
  // referential CODE_CULTURE -> libellé de groupe ; essayer <millesime> puis 2024
  for (const y of [millesime, 2024]) {
    const url = 'https://data.geopf.fr/annexes/ressources/documentation/REF_CULTURES_GROUPES_CULTURES_' + y + '.csv';
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const rows = parseCsv(await r.text());
      const head = rows[0].map(h => norm(h));
      const iCode = head.findIndex(h => /^code_culture/.test(h) || h === 'code');
      const iGrp = head.findIndex(h => /groupe/.test(h) && /libell|label|^groupe_cultures$/.test(h));
      const iGrp2 = head.findIndex(h => /groupe/.test(h)); // repli
      const use = iGrp !== -1 ? iGrp : iGrp2;
      if (iCode === -1 || use === -1) continue;
      const map = {};
      for (const row of rows.slice(1)) {
        const code = (row[iCode] || '').trim();
        const grp = (row[use] || '').trim();
        if (!code) continue;
        for (const [re, g] of RPG_GROUPS) if (re.test(grp)) { map[code] = g; break; }
      }
      if (Object.keys(map).length) { console.log('Référentiel cultures ' + y + ' : ' + Object.keys(map).length + ' codes'); return map; }
    } catch (e) { /* essayer l'année suivante */ }
  }
  throw new Error('Référentiel des cultures introuvable (REF_CULTURES_GROUPES_CULTURES) — voir piège n°41');
}

async function buildRpg(region, deps, entries, opts) {
  const mil = opts.millesime;
  const cands = entries.filter(t => new RegExp('RPG_4-0__GPKG_LAMB93_' + region + '_' + mil + '-01-01$').test(t));
  let entry = cands[0];
  if (!entry) { // repli : dernier millésime disponible pour la région
    const all = entries.filter(t => new RegExp('RPG_\\d-\\d__GPKG_LAMB93_' + region + '_').test(t)).sort();
    if (!all.length) { console.warn('⚠ Pas d\'entrée RPG pour ' + region); return null; }
    entry = all[all.length - 1];
    console.log('  (repli sur ' + entry + ')');
  }
  console.log('— Région ' + region + ' : ' + entry + ' (départements : ' + deps.join(', ') + ')');
  const dir = opts.fromDir || await ensureExtracted('RPG', entry, opts.force);
  const gpkgs = findFiles(dir, /\.gpkg$/i);
  if (!gpkgs.length) throw new Error('Aucun .gpkg extrait pour ' + entry);
  const Database = (await import('better-sqlite3')).default;
  const groups = await loadCultureGroups(mil);
  // index communes de tous les départements de la région (en WGS84)
  const communesByDep = {};
  for (const d of deps) communesByDep[d] = await loadCommunes(d);
  const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs';
  const proj4 = (await import('proj4')).default;
  // accumule { dep -> { code -> { cereales, prairies, _rpg } } } en m²
  const acc = {}; deps.forEach(d => acc[d] = {});
  let nRows = 0;
  for (const gp of gpkgs) {
    const db = new Database(gp, { readonly: true });
    const contents = db.prepare("SELECT table_name FROM gpkg_contents WHERE data_type='features'").all();
    let table = (contents.map(c => c.table_name).find(t => /parcelle/i.test(t)))
      || (contents.map(c => c.table_name).find(t => /ilot/i.test(t)));
    if (!table) { console.warn('  ⚠ ' + path.basename(gp) + ' : aucune table parcelles/îlots'); db.close(); continue; }
    const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(table) + ')').all().map(c => c.name);
    const colGeom = cols.find(c => /geom/i.test(c));
    const colCode = cols.find(c => /^code_culture$/i.test(c)) || cols.find(c => /culture/i.test(c));
    const colSurf = cols.find(c => /surf/i.test(c)); // surfaces déclarées si présentes
    if (!colGeom || !colCode) { console.warn('  ⚠ colonnes inattendues : ' + cols.join(',')); db.close(); continue; }
    const sel = 'SELECT "' + colCode + '" AS cc' + (colSurf ? ', "' + colSurf + '" AS surf' : '') + ', "' + colGeom + '" AS geom FROM "' + table + '"';
    const stmt = db.prepare(sel);
    for (const row of stmt.iterate()) {
      nRows++;
      const g = groups[String(row.cc).trim()];
      if (!g) continue; // hors céréales/prairies
      let rings = gpkgRings(row.geom);
      if (!rings.length) continue;
      const areaM2 = colSurf && row.surf > 0 ? +row.surf : polygonAreaM2(rings);
      if (areaM2 <= 0) continue;
      let code = null, dep = null;
      for (const pt of candidatePoints(rings)) {
        const ll = proj4(L93, 'WGS84', pt);
        for (const d of deps) {
          const c = communeOfPoint(communesByDep[d], ll[0], ll[1]);
          if (c) { code = c; dep = d; break; }
        }
        if (code) break;
      }
      if (!code) continue;
      const o = acc[dep][code] = acc[dep][code] || { cereales: 0, prairies: 0, _rpg: 0 };
      o[g] += areaM2; o._rpg += areaM2;
    }
    db.close();
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
        source: 'RPG ' + (entry.match(/_(\d{4})-01-01$/) || [])[1] + ' (ASP/IGN, licence ouverte) — ' + entry,
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
  const o = { deps: [], millesime: 2024, force: false, fromDir: null, list: false, foret: false, rpg: false, all: false, clean: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--foret') o.foret = true;
    else if (a === '--rpg') o.rpg = true;
    else if (a === '--all') o.all = true;
    else if (a === '--list') o.list = true;
    else if (a === '--force') o.force = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--dep') o.deps = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--millesime') o.millesime = +(argv[++i] || 2024);
    else if (a === '--from-dir') o.fromDir = argv[++i];
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
    const [bdf, rpg] = await Promise.all([feedEntries('BDFORET'), feedEntries('RPG')]);
    console.log('BDFORET (échantillon) :'); bdf.slice(-15).forEach(t => console.log('  ' + t));
    console.log('RPG millésimes récents :'); rpg.filter(t => /RPG_[34]-\d__GPKG_LAMB93_(R\d\d|FXX)_202[45]/.test(t)).forEach(t => console.log('  ' + t));
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
