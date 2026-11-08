#!/usr/bin/env node
// OpenFrance — build « chorologie des essences » (niveau DÉPARTEMENT, mode Pollens).
//
// Objectif : remplacer la chorologie INDICATIVE GBIF (piège n°37 : biais
// d'échantillonnage — naturalistes, zones urbaines sur-observées) par des
// sources d'inventaire, pour les essences que ni la BD Forêt V2 (piège
// n°41(n) : bouleau, aulne non distingués) ni l'IFN superficies (piège
// n°38 : noyés dans « Autres feuillus ») ne cartographient :
//
//   1. dataIFN — « Données brutes de l'inventaire forestier » (IGN, licence
//      Ouverte Etalab 2.0) : FLORE.csv = relevé floristique COMPLET de chaque
//      placette (disque de 15 m de rayon — taxons TAXREF, y compris les
//      ARBUSTES : le NOISETIER y figure, ce qu'aucune carte de forêt ne
//      fournit). Indicateur = part des placettes du département où l'essence
//      est présente (chorologie d'inventaire, non biaisée par l'effort
//      naturaliste). Placettes = milieux BOISÉS uniquement : les essences
//      ornementales (cyprès, platane) ou agricoles (olivier) y sont quasi
//      absentes -> source 2.
//      Page de téléchargement : https://inventaire-forestier.ign.fr/dataIFN/
//      (lien « Pour télécharger toutes les données brutes depuis 2005 » ;
//      l'archive fait plusieurs centaines de Mo — le script la télécharge
//      une fois dans tools/.cache/chorologie/ ; ou --from-zip si vous
//      l'avez déjà posée).
//      Avertissement IGN : coordonnées floutées (maille kilométrique), poids
//      statistique non communiqué -> PARTS DE PLACETTES = indicateur de
//      présence, PAS un résultat officiel d'inventaire.
//
//   2. EUFORGEN — cartes de chorologie de l'« European Atlas of Forest Tree
//      Species » (Caudullo, Welk & San-Miguel-Ayanz 2017, figshare,
//      licence CC-BY 4.0) : aires de présence (shapefiles polygones +
//      points) intersectées avec les départements. COMPLÉMENT pour les
//      essences hors forêt : cyprès (Cupressus sempervirens), olivier
//      (Olea europaea), platane (Platanus orientalis — NB : les platanes
//      urbains français sont surtout × hispanica, l'aire « orientalis »
//      n'est qu'un proxy inférieur).
//
// Sortie : data/chorologie-essences.json (committé, servi par l'app —
// pollens-essences.js le charge au vol et l'utilise EN PRIORITÉ ; repli
// GBIF embarqué sinon) :
//   { meta: {…}, essences: {
//       betula:    { "31": { src:"ifn-flore", pct:12.34, n:156, np:1266 }, … },
//       cupressus: { "13": { src:"euforgen", present:1 }, … } } }
//
// Prérequis : Node ≥ 18 ; npm install --save-dev shapefile proj4 ;
//   un exécutable 7z dans le PATH (déjà requis par build-essences-communes.mjs).
//
// Usage :
//   node tools/build-chorologie-essences.mjs --diag        # instrumenté, n'écrit RIEN
//   node tools/build-chorologie-essences.mjs --ifn        # dataIFN (flore des placettes)
//   node tools/build-chorologie-essences.mjs --euforgen   # aires EUFORGEN (cyprès/olivier/platane…)
//   node tools/build-chorologie-essences.mjs --all        # les deux (recommandé)
//   Options : --from-zip <chemin>  (archive dataIFN déjà téléchargée)
//             --force (retélécharger), --clean (purger le cache après)
//
// Méthode :
//   - dataIFN : placette -> département (colonne DEP si présente, sinon
//     coordonnées + point-in-polygon contre departements-version-simplifiee.geojson,
//     la MÊME source que le proxy /data/departements.json de l'app) ; essence
//     présente sur une placette si au moins un taxon du genre (TAXREF,
//     résolu via metadonnees.csv) figure dans FLORE.csv ; % = n/np des
//     placettes du département (np >= 5 requis).
//   - EUFORGEN : grille de points 0,25° sur la France -> département, puis
//     test contre les polygones/points de l'aire ; département « présent »
//     si l'aire le recouvre. Pas de gradient -> l'app affiche une
//     exposition fixe « modérée » étiquetée « dans l'aire de présence ».
//   - Fusion : ifn-flore prioritaire ; euforgen ne remplit que les
//     essence-départements sans valeur IFN.

import fs from 'node:fs';
import { promises as fsp, createReadStream } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, 'tools', '.cache', 'chorologie');
const OUT = path.join(ROOT, 'data', 'chorologie-essences.json');
const DATAIFN_PAGE = 'https://inventaire-forestier.ign.fr/dataIFN/index.php';
const DEP_GEO_URL = 'https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/departements-version-simplifiee.geojson';
const FIGSHARE_API = 'https://api.figshare.com/v2/articles/';
const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// ---------- Essences cibles (ids de pollens-essences.js, groupe « choro ») ----------
// noms = préfixes de genre (TAXREF libellé scientifique, normalisé sans accents)
const ESSENCES = {
  betula: { noms: ['betula'] },
  alnus: { noms: ['alnus'] },
  corylus: { noms: ['corylus'] },
  platanus: { noms: ['platanus'] },
  populus: { noms: ['populus'] },
  cedrus: { noms: ['cedrus'] },
  cupressus: { noms: ['cupressus'] },
  olea: { noms: ['olea'] },
  ambrosia: { noms: ['ambrosia'] },
  artemisia: { noms: ['artemisia'] }
};
// EUFORGEN : articles figshare (Atlas européen, Caudullo et al. 2017).
// Cyprès/olivier/platane : essences ornementales agricoles quasi absentes des
// placettes boisées -> l'aire EUFORGEN est la source principale. Les autres ne
// sont PAS repris ici : l'IFN (flore) les couvre avec un vrai gradient.
const EUFORGEN_ESSENCES = {
  cupressus: { article: '5101132', espece: 'Cupressus sempervirens' },
  olea: { article: '5110762', espece: 'Olea europaea' },
  platanus: { article: '11347751', espece: 'Platanus orientalis' }
};

// ============================================================
// Réseau & archives (mêmes recettes que build-essences-communes.mjs)
// ============================================================
async function fetchRetry(url, opts, tries) {
  tries = tries || 5;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      const ra = +(r.headers.get('retry-after') || 0);
      const wait = Math.max(ra * 1000, 2000 * Math.pow(2, i));
      process.stderr.write('  HTTP ' + r.status + ' — nouvelle tentative ' + (i + 2) + '/' + tries + ' dans ' + Math.round(wait / 1000) + ' s\n');
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw new Error('HTTP ' + r.status + ' sur ' + url);
  }
}

async function download(url, dest, force) {
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const r = await fetchRetry(url);
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
    const p = spawnSync(b, [''], { shell: false });
    if (!p.error) return b;
  }
  return null;
}

function extract7z(archive, destDir) {
  const bin = sevenZipAvailable();
  if (!bin) throw new Error('Exécutable 7z introuvable dans le PATH (déjà requis par build-essences-communes.mjs). Installez-le ou utilisez --from-zip avec une extraction manuelle dans ' + destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(bin, ['x', '-y', '-o' + destDir, archive], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('Extraction 7z échouée (code ' + r.status + ') : ' + archive);
  return destDir;
}

// ---------- CSV : flux ligne à ligne (flore.csv national = centaines de Mo) ----------
function detectSep(line) {
  const counts = { ';': (line.match(/;/g) || []).length, ',': (line.match(/,/g) || []).length, '\t': (line.match(/\t/g) || []).length };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
function parseCsvLine(line, sep) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === sep && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
async function* csvRows(file) { // yield { header, cells } ; header fourni à la 1re ligne utile
  const raw = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: raw, crlfDelay: Infinity });
  let header = null, sep = ';';
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (header === null) { sep = detectSep(line); header = parseCsvLine(line, sep).map(h => h.trim()); continue; }
    yield { header, cells: parseCsvLine(line, sep) };
  }
}
function colOf(header, re) {
  for (let i = 0; i < header.length; i++) if (re.test(header[i])) return i;
  return -1;
}
const norm = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// ---------- Départements : contours WGS84 (MÊME source que le proxy de l'app) ----------
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
async function depIndex() {
  const cache = path.join(CACHE, 'geo', 'departements.geojson');
  let text;
  if (fs.existsSync(cache)) text = await fsp.readFile(cache, 'utf8');
  else {
    const r = await fetchRetry(DEP_GEO_URL);
    text = await r.text();
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    await fsp.writeFile(cache, text);
  }
  const g = JSON.parse(text);
  const index = [];
  for (const f of g.features || []) {
    const code = f.properties && (f.properties.code || f.properties.insee);
    if (!code) continue;
    const geoms = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    for (const poly of geoms) {
      const outer = poly[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of outer) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
      index.push({ code, outer, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return index;
}
function depOfPoint(index, lon, lat) {
  for (const d of index) {
    const b = d.bbox;
    if (lon < b[0] || lat < b[1] || lon > b[2] || lat > b[3]) continue;
    if (pointInRing(lon, lat, d.outer)) return d.code;
  }
  return null;
}

// ============================================================
// Module 1 : dataIFN (flore des placettes)
// ============================================================
async function findDataifnZip(opts) {
  const local = path.join(CACHE, 'dataifn.zip');
  if (opts.fromZip) {
    if (!fs.existsSync(opts.fromZip)) throw new Error('--from-zip : fichier introuvable : ' + opts.fromZip);
    return opts.fromZip;
  }
  if (fs.existsSync(local) && fs.statSync(local).size > 0 && !opts.force) return local;
  const r = await fetchRetry(DATAIFN_PAGE);
  const html = await r.text();
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) links.push(new URL(m[1], DATAIFN_PAGE).href);
  const zips = [...new Set(links.filter(u => /\.(zip|7z)$/i.test(u)))];
  if (!zips.length) throw new Error('Aucun lien .zip trouvé sur ' + DATAIFN_PAGE + ' — téléchargez-y « toutes les données brutes depuis 2005 » manuellement puis relancez : --from-zip <chemin>');
  console.log('  liens .zip trouvés sur la page dataIFN :');
  zips.forEach(u => console.log('    ' + u));
  const full = zips.filter(u => /2005|toute|complet|brutes|_db/i.test(u));
  const url = full[full.length - 1] || zips[zips.length - 1];
  console.log('  retenu (export complet « depuis 2005 ») : ' + url);
  return download(url, local, opts.force);
}

async function locate(dir, re) {
  const found = [];
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (re.test(e.name)) found.push(p);
    }
  };
  await walk(dir);
  return found;
}

// Taxons : codes TAXREF -> genre, via metadonnees.csv (libellés scientifiques)
async function taxonGenres(metaFiles) {
  // { codeTaxon: ['genre1'|…] } — un taxon peut matcher plusieurs essences ? non :
  // on retourne { code: [essenceId…] } via préfixes de genre.
  const codeToEss = new Map();
  let rowsSeen = 0, layoutInfo = '';
  for (const f of metaFiles) {
    let varCol = -1, codeCol = -1, libCol = -1, defCol = -1, first = true;
    for await (const row of csvRows(f)) {
      if (first) {
        first = false;
        layoutInfo = row.header.join(' | ');
        varCol = colOf(row.header, /^(donnee|variable|code_donnee|item|unite)/i);
        codeCol = colOf(row.header, /^code$/i);
        libCol = colOf(row.header, /^(libelle|libelle_court|libellecourt|nom)$/i);
        defCol = colOf(row.header, /^definition$/i);
        if (codeCol === -1 || libCol === -1) throw new Error('metadonnees.csv : colonnes code/libellé introuvables — en-tête = ' + layoutInfo + ' (envoyez ce --diag)');
        continue;
      }
      const variable = varCol >= 0 ? norm(row.cells[varCol] || '') : '';
      if (varCol >= 0 && !/^cd_?ref/i.test(variable)) continue; // seules les modalités de CD_REF
      const code = (row.cells[codeCol] || '').trim();
      const libelle = row.cells[libCol] || (defCol >= 0 ? row.cells[defCol] : '') || '';
      rowsSeen++;
      const n = norm(libelle);
      for (const ess in ESSENCES) {
        if (ESSENCES[ess].noms.some(g => n.startsWith(g) || n.includes(' ' + g))) {
          if (!codeToEss.has(code)) codeToEss.set(code, []);
          codeToEss.get(code).push(ess);
        }
      }
    }
  }
  return { codeToEss, rowsSeen, layoutInfo };
}

async function buildIfn(out, opts, diag) {
  const zipPath = await findDataifnZip(opts);
  const dir = path.join(CACHE, 'ifn');
  const marker = path.join(dir, '.extrait');
  if (!fs.existsSync(marker)) {
    console.log('  extraction de ' + zipPath + ' (7z)…');
    extract7z(zipPath, dir);
    fs.writeFileSync(marker, String(Date.now()));
  }
  const placFiles = await locate(dir, /placette/i);
  const floreFiles = await locate(dir, /flore/i);
  const metaFiles = await locate(dir, /meta/i);
  console.log('  placettes : ' + (placFiles.map(f => path.basename(f)).join(', ') || 'AUCUN ✗'));
  console.log('  flore     : ' + (floreFiles.map(f => path.basename(f)).join(', ') || 'AUCUN ✗'));
  console.log('  meta      : ' + (metaFiles.map(f => path.basename(f)).join(', ') || 'AUCUN ✗'));
  if (!placFiles.length || !floreFiles.length) throw new Error('placettes.csv ou flore.csv introuvables dans ' + dir + ' — vérifiez l\'archive ou utilisez --from-zip');
  if (!metaFiles.length) throw new Error('metadonnees.csv introuvable dans ' + dir + ' (résolution des codes TAXREF impossible)');

  // 1. genres : codes TAXREF -> essences
  const { codeToEss, rowsSeen, layoutInfo } = await taxonGenres(metaFiles);
  console.log('  metadonnees.csv : ' + rowsSeen + ' modalités CD_REF lues (' + layoutInfo.slice(0, 80) + '…)');
  const perEss = {};
  for (const ess in ESSENCES) perEss[ess] = [];
  for (const [code, esss] of codeToEss) esss.forEach(e => perEss[e].push(code));
  for (const ess in ESSENCES) {
    if (!perEss[ess].length) console.log('  ⚠ ' + ess + ' : AUCUN taxon matché (genre « ' + ESSENCES[ess].noms.join(' »/«') + ' » absent des libellés ?) — envoyez le --diag');
    else if (diag) console.log('  ✓ ' + ess + ' : ' + perEss[ess].length + ' taxons');
  }

  // 2. départements WGS84
  const index = await depIndex();

  // 3. placettes : idp -> département (colonne DEP si présente, sinon coordonnées)
  const normDep = (v) => {
    const s = (v || '').trim().replace(/\.0$/, '');
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= 1 && n <= 95) return String(n).padStart(2, '0'); // métropole, zéro initial
      if (s === '201') return '2A'; // Corse (anciennes codifications)
      if (s === '202') return '2B';
      return s; // 971…976 (DOM) : laissé tel quel
    }
    if (/^2[AB]$/i.test(s)) return s.toUpperCase(); // Corse (codes INSEE actuels)
    return null;
  };
  const idpToDep = new Map();
  let nPlac = 0, nDep = 0, nCoord = 0, modeDep = '?';
  for (const f of placFiles) {
    let idpI = -1, xI = -1, yI = -1, depI = -1, isL93 = null, first = true, headerStr = '';
    for await (const row of csvRows(f)) {
      if (first) {
        first = false;
        headerStr = row.header.join(' | ');
        idpI = colOf(row.header, /^idp$/i);
        depI = colOf(row.header, /^(dep|dpt|code_dep|departement)$/i);
        const lonI = colOf(row.header, /^(lon|long|longitude|lonwgs84|x_wgs84)$/i);
        const xlI = colOf(row.header, /^(x|xl93|x_l93|xlamb93)$/i);
        const latI = colOf(row.header, /^(lat|latitude|latwgs84|y_wgs84)$/i);
        const ylI = colOf(row.header, /^(y|yl93|y_l93|ylamb93)$/i);
        if (lonI >= 0 && latI >= 0) { xI = lonI; yI = latI; isL93 = false; }
        else if (xlI >= 0 && ylI >= 0) { xI = xlI; yI = ylI; isL93 = true; }
        if (idpI === -1) throw new Error('placettes : colonne IDP introuvable — en-tête = ' + headerStr + ' (envoyez ce --diag)');
        modeDep = depI >= 0 ? 'colonne DEP' : (isL93 !== null ? ('coordonnées ' + (isL93 ? 'Lambert-93' : 'WGS84')) : 'AUCUNE ✗');
        console.log('  placettes « ' + path.basename(f) + ' » : ' + modeDep + ' [' + headerStr.slice(0, 100) + '…]');
      }
      const idp = (row.cells[idpI] || '').trim();
      if (!idp) continue;
      nPlac++;
      let dep = null;
      if (depI >= 0) dep = normDep(row.cells[depI]);
      if (!dep && xI >= 0 && yI >= 0) {
        const x = parseFloat((row.cells[xI] || '').replace(',', '.')), y = parseFloat((row.cells[yI] || '').replace(',', '.'));
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const [lon, lat] = isL93 ? proj4(L93, 'WGS84', [x, y]) : [x, y];
          dep = depOfPoint(index, lon, lat);
          nCoord++;
        }
      }
      if (dep) { idpToDep.set(idp, dep); nDep++; }
    }
  }
  console.log('  placettes lues : ' + nPlac.toLocaleString('fr-FR') + ' ; rattachées à un département : ' + nDep.toLocaleString('fr-FR') + (nCoord ? ' (dont par coordonnées : ' + nCoord.toLocaleString('fr-FR') + ')' : ''));
  if (nDep < 1000) throw new Error('trop peu de placettes rattachées (' + nDep + ') — vérifiez l\'archive ou envoyez le --diag');

  // 4. flore : idp par essence
  const idpsByEss = {};
  for (const ess in ESSENCES) idpsByEss[ess] = new Set();
  let nFlore = 0, nMatch = 0;
  for (const f of floreFiles) {
    let idpI = -1, cdI = -1, first = true;
    for await (const row of csvRows(f)) {
      if (first) {
        first = false;
        idpI = colOf(row.header, /^idp$/i);
        cdI = colOf(row.header, /^cd_ref$/i);
        if (idpI === -1 || cdI === -1) throw new Error('flore « ' + path.basename(f) + ' » : colonnes IDP/CD_REF introuvables — en-tête = ' + row.header.join(' | ') + ' (envoyez ce --diag)');
        continue;
      }
      nFlore++;
      const esss = codeToEss.get((row.cells[cdI] || '').trim());
      if (!esss) continue;
      const idp = (row.cells[idpI] || '').trim();
      if (!idp) continue;
      nMatch++;
      esss.forEach(e => idpsByEss[e].add(idp));
    }
  }
  console.log('  relevés flore lus : ' + nFlore.toLocaleString('fr-FR') + ' ; lignes des genres cibles : ' + nMatch.toLocaleString('fr-FR'));

  // 5. agrégats par département
  const np = {};
  for (const dep of idpToDep.values()) np[dep] = (np[dep] || 0) + 1;
  for (const ess in ESSENCES) {
    const recs = {};
    for (const idp of idpsByEss[ess]) {
      const dep = idpToDep.get(idp);
      if (!dep) continue;
      recs[dep] = (recs[dep] || 0) + 1;
    }
    const res = {};
    for (const dep in recs) {
      if ((np[dep] || 0) < 5) continue; // échantillon trop faible
      res[dep] = { src: 'ifn-flore', pct: Math.round(recs[dep] / np[dep] * 10000) / 100, n: recs[dep], np: np[dep] };
    }
    out[ess] = res;
    const deps = Object.keys(res).length;
    const nat = idpsByEss[ess].size;
    console.log('  ' + ess + ' : ' + nat.toLocaleString('fr-FR') + ' placettes nationales, ' + deps + ' départements couverts' + (deps ? ' (ex. ' + Object.entries(res).slice(0, 3).map(([d, v]) => d + '=' + v.pct + '%').join(', ') + ')' : ''));
  }
}

// ============================================================
// Module 2 : EUFORGEN (aires de présence, figshare)
// ============================================================
async function readShp(shpPath, prjPath) { // -> { prj, points: [ [lon,lat] …], polys: [ ring[ [x,y] …] ] }
  let prj = null;
  if (fs.existsSync(prjPath)) prj = (await fsp.readFile(prjPath, 'utf8')).trim();
  const fwd = prj ? proj4(prj, 'WGS84') : null;
  const tr = (pt) => (fwd ? fwd.forward(pt) : pt);
  const points = [], polys = [];
  const src = await shapefile.openShp(shpPath);
  while (true) {
    const r = await src.read();
    if (r.done) break;
    const g = r.value;
    if (g.type === 'Point') points.push(tr(g.coordinates));
    else if (g.type === 'MultiPoint') g.coordinates.forEach(c => points.push(tr(c)));
    else if (g.type === 'Polygon') g.coordinates.forEach((ring, i) => { if (i === 0) polys.push(ring.map(tr)); });
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => polys.push(poly[0].map(tr)));
  }
  return { prj, points, polys };
}

async function buildEuforgen(out, opts, diag) {
  const index = await depIndex();
  // grille de points 0,25° sur la France métropolitaine
  const grid = [];
  for (let lon = -5.75; lon <= 9.75; lon += 0.25) {
    for (let lat = 41.0; lat <= 51.5; lat += 0.25) grid.push([+lon.toFixed(2), +lat.toFixed(2)]);
  }
  const gridDep = new Map(); // dep -> [pts]
  for (const [lon, lat] of grid) {
    const dep = depOfPoint(index, lon, lat);
    if (dep) (gridDep.get(dep) || gridDep.set(dep, []).get(dep)).push([lon, lat]);
  }
  console.log('  grille 0,25° : ' + grid.length + ' points, ' + gridDep.size + ' départements couverts');
  for (const ess in EUFORGEN_ESSENCES) {
    const spec = EUFORGEN_ESSENCES[ess];
    const dir = path.join(CACHE, 'euforgen', ess);
    const marker = path.join(dir, '.extrait');
    if (!fs.existsSync(marker)) {
      const api = await fetchRetry(FIGSHARE_API + spec.article, { headers: { Accept: 'application/json' } });
      const j = await api.json();
      const files = (j.files || []).filter(f => /shp.*\.zip$|\.zip$/i.test(f.name) && /shp/i.test(f.name));
      const file = files[files.length - 1] || (j.files || []).find(f => f.name.endsWith('.zip'));
      if (!file) throw new Error('figshare ' + spec.article + ' (' + spec.espece + ') : aucun *_shp.zip — fichiers = ' + (j.files || []).map(f => f.name).join(', '));
      console.log('  ' + ess + ' (' + spec.espece + ') : ' + file.name + ' <- ' + file.download_url);
      const zip = await download(file.download_url, path.join(CACHE, 'euforgen', ess + '.zip'), opts.force);
      extract7z(zip, dir);
      fs.writeFileSync(marker, String(Date.now()));
    }
    const shps = await locate(dir, /\.shp$/i);
    if (!shps.length) throw new Error('aucun .shp extrait pour ' + ess + ' dans ' + dir);
    const deps = new Set();
    let nPts = 0, nPolys = 0;
    for (const shp of shps) {
      const { points, polys } = await readShp(shp, shp.replace(/\.shp$/i, '.prj'));
      nPts += points.length; nPolys += polys.length;
      // points de l'aire -> département
      for (const [lon, lat] of points) {
        const dep = depOfPoint(index, lon, lat);
        if (dep) deps.add(dep);
      }
      // polygones de l'aire -> grille du département dans le polygone
      for (const ring of polys) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        for (const [dep, pts] of gridDep) {
          for (const [lon, lat] of pts) {
            if (lon < minX || lat < minY || lon > maxX || lat > maxY) continue;
            if (pointInRing(lon, lat, ring)) deps.add(dep);
          }
        }
      }
    }
    console.log('  ' + ess + ' (' + spec.espece + ') : ' + nPolys + ' polygone(s), ' + nPts + ' point(s) -> ' + deps.size + ' départements dans l\'aire : ' + [...deps].sort().join(', '));
    // euforgen ne remplit que les trous (ifn-flore prioritaire)
    const cur = out[ess] || {};
    for (const dep of deps) if (!cur[dep]) cur[dep] = { src: 'euforgen', present: 1 };
    out[ess] = cur;
  }
}

// ============================================================
// CLI
// ============================================================
function parseArgs(argv) {
  const o = { ifn: false, euforgen: false, all: false, diag: false, force: false, clean: false, fromZip: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ifn') o.ifn = true;
    else if (a === '--euforgen') o.euforgen = true;
    else if (a === '--all') { o.ifn = true; o.euforgen = true; }
    else if (a === '--diag') o.diag = true;
    else if (a === '--force') o.force = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--from-zip') o.fromZip = argv[++i];
    else { console.error('Option inconnue : ' + a); process.exit(1); }
  }
  if (!o.ifn && !o.euforgen) o.ifn = true; // par défaut : dataIFN
  return o;
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('══════════ chorologie des essences — départements (' + (opts.diag ? 'MODE --diag : RIEN n\'est écrit' : 'écrit ' + OUT) + ') ══════════');
  const out = {};
  if (opts.ifn) {
    console.log('\n— dataIFN (flore des placettes IFN) —');
    await buildIfn(out, opts, opts.diag);
  }
  if (opts.euforgen) {
    console.log('\n— EUFORGEN (aires de présence, Atlas européen) —');
    await buildEuforgen(out, opts, opts.diag);
  }
  const essDeps = {};
  for (const ess in out) essDeps[ess] = Object.keys(out[ess]).length;
  console.log('\nRésumé : ' + JSON.stringify(essDeps));
  if (opts.diag) {
    console.log('══════════ mode --diag : AUCUN JSON écrit. Si tout est vert, relancer SANS --diag (ex. --all) pour générer data/chorologie-essences.json, puis le committer et recharger l\'app. ══════════');
    return;
  }
  const doc = {
    meta: {
      genere: new Date().toISOString().slice(0, 10),
      methode: 'ifn-flore : part des placettes IFN (relevé floristique) du département où l\'essence est présente (np>=5) ; euforgen : département intersecté par l\'aire de présence (Atlas européen)',
      sources: {
        ifn: 'IGN — Inventaire forestier national français, Données brutes (dataIFN), licence Ouverte Etalab 2.0 — https://inventaire-forestier.ign.fr/dataIFN/',
        euforgen: 'Caudullo G., Welk E., San-Miguel-Ayanz J. (2017), Chorological maps for the main European woody species (European Atlas of Forest Tree Species), figshare, CC-BY 4.0'
      },
      avertissement: 'dataIFN : coordonnées floutées (maille kilométrique), placettes boisées uniquement, parts indicatives ≠ résultats officiels IGN'
    },
    essences: out
  };
  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  await fsp.writeFile(OUT, JSON.stringify(doc));
  console.log('✓ écrit : ' + OUT + ' (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' Ko) — committer puis recharger l\'app.');
  if (opts.clean) { await fsp.rm(CACHE, { recursive: true, force: true }); console.log('  cache purgé (--clean).'); }
}

main().catch(e => { console.error(e); process.exit(1); });
