#!/usr/bin/env node
// tools/collect-numeum.mjs — Collecte l'annuaire Numeum French Tech (fiches publiques).
//
// Usage : node tools/collect-numeum.mjs [--out /tmp/opencode/numeum.json] [--limit 0]
//
// L'annuaire https://frenchtech120.numeum.fr (propulsé Motherbase, suivi officiel
// Next40 / FT120 / Green20 / Agri20 / DeepNum20 / Health20 / FT2030) expose un
// sitemap listant ~520 fiches entreprises publiques (robots.txt : Allow /).
// Chaque fiche donne : nom (h1), site web (itemprop=url), tags programme + année
// (badges, ex. « Next40 (2026) », « Health 20 (2023) » — variantes avec/sans espace),
// ville, effectifs, année de création.
//
// Sortie : [{ nom, site, programmes: ["Next40 2026", ...], ville, anneeCreation, url }]
// Fichier LOCAL uniquement (jamais commité — voir .gitignore tools/*.json) : c'est
// une étape intermédiaire avant résolution SIREN (tools/resolve-sirens.mjs).
// Crawl poli : ~250 ms entre requêtes, pages ~10 Ko.

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argVal(n) {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const OUT = argVal('--out') || '/tmp/opencode/numeum.json';
const LIMIT = parseInt(argVal('--limit') || '0', 10) || 0;
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url);
  return r.text();
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

function parseFiche(html) {
  const hName = html.match(/<h[123][^>]*itemprop=name[^>]*>(.*?)<\/h[123]>/s);
  const hAny = hName || html.match(/<h[12][^>]*>(.*?)<\/h[12]>/s);
  const nom = hAny ? stripTags(hAny[1]) : '';
  const siteM = html.match(/itemprop=url[^>]*href=([^\s>]+)/) || html.match(/href=(https?:\/\/[^ \t\n\r"'>]+)[^>]*itemprop=url/);
  let site = siteM ? siteM[1].replace(/["'>]+$/, '') : '';
  // Badges programme : tout texte contenant (AAAA)
  const tags = [];
  const seen = new Set();
  const text = html.replace(/<script.*?<\/script>/gs, ' ').replace(/<[^>]+>/g, '\n');
  for (const line of text.split('\n')) {
    const t = line.trim();
    const m = t.match(/^(.+?)\s*\((20\d\d)\)$/);
    if (m && t.length < 60 && !seen.has(t)) {
      seen.add(t);
      // Normalise : « Health 20 (2023) » -> label « Health20 2023 »
      const prog = m[1].replace(/\s+/g, '').replace(/^FrenchTech120$/, 'FT120')
        .replace(/^FrenchTech2030$/, 'FT2030').replace(/^FrenchTech120$/, 'FT120');
      const full = m[1].indexOf('French Tech 120') !== -1 || m[1].indexOf('FrenchTech120') !== -1
        ? 'FT120 ' + m[2]
        : prog + ' ' + m[2];
      tags.push(full);
    }
  }
  const villeM = text.match(/Localisation :\s*\n?\s*([^\n•]+)/);
  const creaM = text.match(/Création :\s*\n?\s*([^\n•]+)/);
  return {
    nom: nom,
    site: site,
    programmes: tags,
    ville: villeM ? villeM[1].trim() : '',
    anneeCreation: creaM ? creaM[1].trim() : ''
  };
}

const sm = await get('https://iframe.frenchtech120.numeum.fr/sitemap-company.xml');
const urls = [...sm.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
console.log(urls.length + ' fiches au sitemap.');
const list = LIMIT ? urls.slice(0, LIMIT) : urls;
const out = [];
let n = 0;
for (const u of list) {
  try {
    const html = await get(u);
    const f = parseFiche(html);
    f.url = u;
    out.push(f);
  } catch (e) {
    console.error('Échec ' + u + ' : ' + e.message);
  }
  n++;
  if (n % 50 === 0) console.log(n + '/' + list.length);
  await sleep(250);
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
const withProg = out.filter((f) => f.programmes.length).length;
console.log('Terminé : ' + out.length + ' fiches -> ' + OUT + ' (' + withProg + ' avec tag programme).');
