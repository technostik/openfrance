// OpenFrance — Fonction Vercel (port de netlify/functions/email.js) : recherche email & site web des favoris (branche get_email)
//
// Endpoint (POST, paramètre op) :
//   POST /ft/email  { op:'lookup', entity:{ type:'ent'|'asso'|'commune', nom, siren, siret,
//                                            insee, ville, dep, siteWeb },
//                     engines:[ 'officiel'|'tavily'|'scrape'|'prospector' ] }
//   → { ok:true, best:{ email, website, source, confidence }, results:[{ engine, ... }] }
//   POST /ft/email  { op:'describe', entity:{ type, nom, siren, ville, siteWeb } }
//   → { ok:true, best:{ description, source, confidence, siteUrl }, results:[{ engine, ... }] }
//   Moteurs describe : ddg (snippets DuckDuckGo + découverte du site officiel, annuaires/
//   agrégateurs exclus) puis meta du site (og:description / meta description / JSON-LD),
//   toujours tentée — fusion par confiance, la meta du site prime. Budget 9 s, dégradation en note.

//
// Chaîne de moteurs (système de plugins : ajouter un moteur = une fonction engXxx +
// une entrée dans opLookup ; le front déclare les moteurs dans FAV_ENGINES de favoris.js
// et n'envoie que ceux cochés) :
//   officiel   : Annuaire de l'administration (DILA, API ODS v2.1) — mairies : email + site
//                officiels par code INSEE. Gratuit, sans clé.
//   tavily     : découverte du site web (TAVILY_API_KEY en variable d'environnement
//                Netlify, optionnelle — moteur désactivé proprement si absente).
//   scrape     : extraction depuis le site trouvé : mailto, regex, JSON-LD, déobfuscation
//                [at]/(at)/[dot], protection email Cloudflare, pages contact ; contrôle MX
//                via dns.promises (emails d'un domaine sans MX écartés). Inspiré des
//                6 couches de dataforge (github.com/Nuclear-Marmalade/dataforge), réécrit
//                minimal pour du serverless Node.
//   prospector : prospector-mcp (github.com/JosieBot26/prospector-mcp-email-finder — npm
//                prospector-mcp, MIT) lancé en sous-processus MCP stdio, outil find_emails
//                (scraping + candidats à motifs + vérification DNS/SMTP sans envoi).
//                Tier gratuit : 50 vérifs/jour (PROSPECTOR_TIER). Opt-in côté front ;
//                dégrade proprement si le package n'est pas installé.
//
// Budget : fonctions Netlify synchrones ~10 s → budget total 9 s, chaque moteur reçoit
// le temps restant ; les suivants sont sautés si le temps manque. Erreurs applicatives
// en HTTP 200 {ok:false} (convention du repo, voir ft.js) ; une erreur de moteur ne casse
// jamais la réponse : elle devient une note dans results[].

const dnsPromises = require('dns').promises;
const { spawn } = require('child_process');

const DEADLINE_MS = 9000;
const PAGE_TIMEOUT = 4500;
const FETCH_UA = 'Mozilla/5.0 (compatible; OpenFrance/1.0; +https://github.com/johannoriel/openfrance)';

const ANNUAIRE_BASE = 'https://api-lannuaire.service-public.gouv.fr/api/explore/v2.1/catalog/datasets/api-lannuaire-administration/records';

// Domaines jamais proposés comme « site officiel » (annuaires, réseaux sociaux, agrégateurs)
const TAVILY_BLOCK = /wikipedia\.|wikidata|facebook\.|linkedin\.|twitter\.|x\.com|instagram\.|youtube\.|google\.|annuaire-entreprises|data\.gouv|societe\.com|pappers|societe\.ninja|pagesjaunes|infogreffe|bodacc|verif\.com|manageo|netpme|tiktok|discord\.|medium\.com|glassdoor|indeed|hellowork|regionsjob|welcomekit|malt\.fr/;

function cleanMail(v) {
  if (!v) return null;
  const m = String(v).trim().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/i);
  const e = m ? m[0].toLowerCase() : null;
  return (e && e.length <= 90) ? e : null;
}

function cleanUrl(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).href; } catch (e) { return null; }
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function fetchText(url, ms, maxLen) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, Math.max(1200, ms || PAGE_TIMEOUT));
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': FETCH_UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5' }
    });
    if (!res.ok) return { ok: false, status: res.status, note: 'HTTP ' + res.status };
    const txt = (await res.text()).slice(0, maxLen || 400000);
    return { ok: true, html: txt, url: res.url };
  } catch (e) {
    const note = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { ok: false, note: note };
  } finally { clearTimeout(t); }
}

async function fetchJsonT(url, ms) {
  const r = await fetchText(url, ms, 200000);
  if (!r.ok) throw new Error(r.note || 'fetch échoué');
  return JSON.parse(r.html);
}

// ---------- Moteur 1 : annuaire service-public (mairies) ----------
async function engOfficiel(ent) {
  const out = { engine: 'officiel', source: 'annuaire-service-public' };
  const insee = String(ent.insee || ent.id || '').trim();
  if (!/^\d{5}$/.test(insee)) { out.note = 'code INSEE absent'; return out; }
  try {
    // 1. mairie directe ; 2. repli sans filtre pivot (champ pivot parfois absent/variant)
    const sel1 = encodeURIComponent('nom,adresse_courriel,site_internet');
    const w1 = encodeURIComponent('pivot="mairie" AND code_insee_commune="' + insee + '"');
    let j = await fetchJsonT(ANNUAIRE_BASE + '?where=' + w1 + '&select=' + sel1 + '&limit=5', 4000);
    let recs = (j && j.results) || [];
    if (!recs.length) {
      const sel2 = encodeURIComponent('nom,pivot,adresse_courriel,site_internet');
      const w2 = encodeURIComponent('code_insee_commune="' + insee + '"');
      j = await fetchJsonT(ANNUAIRE_BASE + '?where=' + w2 + '&select=' + sel2 + '&limit=20', 4000);
      recs = ((j && j.results) || []).filter(function (r) {
        const f = (r.record && r.record.fields) || r;
        const p = String(f.pivot || '');
        return p.indexOf('mairie') !== -1;
      });
    }
    if (!recs.length) { out.note = 'mairie absente de l\'annuaire service-public'; return out; }
    const f = (recs[0].record && recs[0].record.fields) || recs[0];
    out.email = cleanMail(f.adresse_courriel);
    out.website = cleanUrl(f.site_internet);
    out.confidence = 92;
    out.note = (f.nom ? String(f.nom) : 'guichet trouvé') + (out.email ? '' : ' (email non renseigné)');
  } catch (e) {
    out.note = 'annuaire service-public : ' + String((e && e.message) || e).slice(0, 120);
  }
  return out;
}

// ---------- Moteur 2 : Tavily (découverte du site web) ----------
async function engTavily(ent) {
  const out = { engine: 'tavily', source: 'tavily' };
  if (!process.env.TAVILY_API_KEY) { out.note = 'TAVILY_API_KEY absente (variable d\'environnement Netlify)'; return out; }
  const q = [ent.nom, ent.ville || ent.dep || '', 'site officiel'].filter(Boolean).join(' ');
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: String(q).slice(0, 300),
        max_results: 8,
        search_depth: 'basic'
      })
    });
    if (!res.ok) { out.note = 'Tavily HTTP ' + res.status; return out; }
    const j = await res.json();
    const seen = {};
    let best = null;
    const nameTok = String(ent.nom || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    ((j && j.results) || []).forEach(function (r) {
      if (best) return;
      let u;
      try { u = new URL(r.url); } catch (e) { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const host = u.hostname.replace(/^www\./, '');
      if (seen[host]) return;
      seen[host] = 1;
      if (TAVILY_BLOCK.test(host)) return;
      const hostCompact = host.replace(/[^a-z0-9]/g, '');
      const relevant = nameTok && hostCompact.indexOf(nameTok) !== -1;
      // hors cas pertinent (domaine ~ nom), on ne garde que des racines de site
      if (!relevant && u.pathname !== '/' && u.pathname !== '') return;
      best = u.origin + '/';
    });
    if (best) { out.website = best; out.confidence = 45; out.note = 'site trouvé via Tavily'; }
    else out.note = 'aucun site plausible dans les résultats Tavily';
  } catch (e) {
    out.note = 'Tavily : ' + String((e && e.message) || e).slice(0, 120);
  }
  return out;
}

// ---------- Moteur 3 : scraping du site (extraction email) ----------
const BAD_LOCAL = /^(noreply|no-?reply|donotreply|do-?not-?reply|example|test|sentry|wix|godaddy|user|foo|bar|abuse|postmaster|root|spam)/i;
const GOOD_LOCAL = /^(contact|info|bonjour|accueil|mairie|secretariat|secretaire|communication|bureau|office|hello|admin|devis|commercial|sales|team|support|service|direction|rh|recrut)/i;
const BAD_DOMAIN = /(sentry|wixpress|example\.com|domain\.com|email\.com|yourdomain|yoursite|localhost|sample|template|mailchimp|mandrill|sendgrid|hubspot|brevo|sendinblue)/i;

function cfEmails(html) {
  // Protection email Cloudflare : data-cfemail="hex" (1er octet = clé XOR)
  const out = [];
  const re = /data-cfemail="([0-9a-f]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hex = m[1];
    if (!hex || hex.length < 4) continue;
    const key = parseInt(hex.slice(0, 2), 16);
    let s = '';
    for (let i = 2; i + 1 < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    out.push(s);
  }
  return out;
}

function harvestEmails(html, extra, emails, siteDomain) {
  function add(raw, score) {
    const e = cleanMail(raw);
    if (!e) return;
    const at = e.indexOf('@');
    if (at < 1) return;
    const local = e.slice(0, at);
    const dom = e.slice(at + 1);
    if (BAD_LOCAL.test(local) || BAD_DOMAIN.test(dom)) return;
    if (/\d{6,}/.test(local)) return; // identifiant de tracking
    if (/\.(png|jpe?g|gif|webp|svg|css|js|pdf)$/i.test(dom)) return;
    let sc = score;
    if (GOOD_LOCAL.test(local)) sc += 18;
    const sd = (siteDomain || '').replace(/^www\./, '');
    if (sd && (dom === sd || dom.indexOf('.' + sd) !== -1 || sd.indexOf('.' + dom) !== -1)) sc += 10;
    else sc -= 8; // hors domaine du site : souvent un prestataire
    if (emails[e] === undefined || emails[e] < sc) emails[e] = sc;
  }
  let m;
  const reM = /mailto:([^"'?>\s]+)/gi;
  while ((m = reM.exec(html)) !== null) add(m[1], 25 + extra);
  const deob = html
    .replace(/\[(at|arobase)\]/gi, '@').replace(/\((at|arobase)\)/gi, '@')
    .replace(/\[(dot|point)\]/gi, '.').replace(/\((dot|point)\)/gi, '.')
    .replace(/\s(at|arobase)\s/gi, '@');
  const reE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  while ((m = reE.exec(deob)) !== null) add(m[0], 5 + extra);
  const reJ = /"email"\s*:\s*"([^"]{3,80})"/gi;
  while ((m = reJ.exec(html)) !== null) add(m[1], 20 + extra);
  cfEmails(html).forEach(function (s) { add(s, 25 + extra); });
}

function contactLinks(html, baseUrl) {
  const baseHost = hostOf(baseUrl);
  const out = [];
  const seen = {};
  const re = /href="([^"#]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 3) {
    const href = m[1].trim();
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch (e) { continue; }
    const h = hostOf(abs);
    if (h !== baseHost && h.indexOf('.' + baseHost) === -1 && baseHost.indexOf('.' + h) === -1) continue;
    if (!/(contact|nous-contacter|contacter|mentions|about|a-propos|apropos|coord|acces)/i.test(abs)) continue;
    if (seen[abs]) continue;
    seen[abs] = 1;
    out.push(abs);
  }
  return out;
}

async function engScrape(siteUrl, budgetMs) {
  const out = { engine: 'scrape', source: 'scraping-site' };
  const domain = hostOf(siteUrl);
  if (!domain) { out.note = 'URL invalide'; return out; }
  const emails = {};
  const home = await fetchText(siteUrl, Math.min(budgetMs - 800, PAGE_TIMEOUT));
  if (!home.ok) { out.note = 'site injoignable (' + home.note + ')'; return out; }
  harvestEmails(home.html, 0, emails, domain);
  const links = contactLinks(home.html, home.url);
  let spent = 0;
  for (let i = 0; i < links.length; i++) {
    if (budgetMs - spent < 2000) break;
    const t0 = Date.now();
    const p = await fetchText(links[i], Math.min(budgetMs - spent, 4000));
    spent += Date.now() - t0;
    if (p.ok) harvestEmails(p.html, 12, emails, domain);
  }
  const found = Object.keys(emails);
  if (!found.length) { out.note = 'aucun email trouvé sur ' + domain; return out; }
  // Contrôle MX : les emails d'un domaine incapable de recevoir du mail sont écartés
  const byDomain = {};
  found.forEach(function (e) {
    const d = e.split('@')[1];
    const arr = byDomain[d] = byDomain[d] || [];
    arr.push(e);
  });
  let best = null, bestScore = -1;
  for (const d in byDomain) {
    let mx = false;
    try {
      mx = await Promise.race([
        dnsPromises.resolveMx(d).then(function () { return true; }),
        new Promise(function (r) { setTimeout(function () { r(false); }, 2000); })
      ]);
    } catch (e) { mx = false; }
    if (!mx) continue;
    byDomain[d].forEach(function (e) {
      if (emails[e] > bestScore) { bestScore = emails[e]; best = e; }
    });
  }
  if (!best) { out.note = 'emails trouvés mais domaine(s) sans MX'; return out; }
  out.email = best;
  out.confidence = Math.max(30, Math.min(85, 35 + bestScore));
  out.note = 'extrait de ' + domain + ' (score ' + bestScore + ')';
  return out;
}

// ---------- Moteur 4 : prospector-mcp (MCP stdio, opt-in) ----------
function mcpCall(entryPath, tool, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let child;
    try { child = spawn(process.execPath, [entryPath], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }
    let buf = '';
    let settled = false;
    function write(o) { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) {} }
    function done(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }
    const timer = setTimeout(function () { done(new Error('timeout MCP (' + timeoutMs + ' ms)')); }, timeoutMs);
    child.on('error', function (e) { done(e); });
    child.stderr.on('data', function () {});
    child.stdout.on('data', function (d) {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id === 1) {
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) done(new Error((msg.error && msg.error.message) || 'erreur MCP'));
          else done(null, msg.result);
        }
      }
    });
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openfrance', version: '1.0' } } });
  });
}

async function engProspector(siteUrl, budgetMs) {
  const out = { engine: 'prospector', source: 'prospector-mcp' };
  const domain = hostOf(siteUrl);
  if (!domain) { out.note = 'URL invalide'; return out; }
  let entry = null;
  const cands = ['prospector-mcp', 'prospector-mcp/src/index.js', 'prospector-mcp/dist/index.js'];
  for (let i = 0; i < cands.length && !entry; i++) {
    try { entry = require.resolve(cands[i]); } catch (e) { entry = null; }
  }
  if (!entry) { out.note = 'prospector-mcp non installé (voir package.json à la racine)'; return out; }
  try {
    const res = await mcpCall(entry, 'find_emails', { domain: domain }, Math.max(3000, Math.min(budgetMs - 500, 8000)));
    let payload = null;
    try {
      const txt = (res && res.content && res.content[0] && res.content[0].text) || '';
      payload = JSON.parse(txt);
    } catch (e) { payload = null; }
    if (payload && payload.best_email) {
      out.email = cleanMail(payload.best_email);
      out.confidence = Math.max(30, Math.min(95, Number(payload.confidence) || 70));
      out.note = 'vérifié par prospector-mcp (DNS/SMTP)';
    } else {
      out.note = 'prospector : aucun email (' + JSON.stringify(res || {}).slice(0, 160) + ')';
    }
  } catch (e) {
    out.note = 'prospector indisponible : ' + String((e && e.message) || e).slice(0, 140);
  }
  return out;
}

// ---------- Moteurs de description (op describe : « que fait cette entreprise ? ») ----------
// DuckDuckGo : endpoint HTML non officiel (html.duckduckgo.com/html), gratuit, sans clé —
// snippets web + découverte du site officiel. Peu de requêtes (1 par clic ✨ Enrich, résultat
// mis en cache côté client) mais rate-limit possible depuis des IP serverless : dégradation
// propre (note), jamais bloquant.

// Snippets d'annuaires/agrégateurs d'entreprises (annuaire-entreprises, societe.com,
// pappers…) : génériques et inutiles (« Retrouvez toutes les informations sur X… »)
// — jamais retenus comme description, on prend le résultat suivant.
const DDG_SNIPPET_BLOCK = /(facebook|linkedin|twitter|x\.com|instagram|tiktok|youtube|pinterest|amazon\.|leboncoin|tripadvisor|glassdoor|indeed|hellowork|regionsjob|welcomekit|malt\.fr|societe\.com|societes\.com|pappers|societe\.ninja|infogreffe|verif\.com|manageo|netpme|bfmtv|usinenouvelle|google\.|bing\.|duckduckgo\.|annuaire-entreprises|data\.gouv|bodacc|lannuaire)/i;

function ddgStrip(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/\s+/g, ' ')
    .trim();
}

// Liens DDG : //duckduckgo.com/l/?uddg=<url encodée>&rut=... (ou URL directe)
function ddgRealUrl(href) {
  let s = String(href || '').replace(/&amp;/g, '&');
  const m = s.match(/[?&]uddg=([^&]+)/);
  if (m) { try { s = decodeURIComponent(m[1]); } catch (e) { return null; } }
  if (s.indexOf('//') === 0) s = 'https:' + s;
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null; }
  catch (e) { return null; }
}

async function engDdg(ent, budgetMs) {
  const out = { engine: 'ddg', source: 'duckduckgo' };
  const name = String(ent.nom || '').replace(/[, ]+\s*(SASU|SAS|SARL|EURL|SELAS|SELARL|SCOP|SCI|SNC|GIE|SCA|SA)\s*$/i, '').trim();
  if (!name) { out.note = 'nom absent'; return out; }
  const q = [name, ent.ville || '', 'entreprise'].filter(Boolean).join(' ');
  try {
    const r = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), Math.min(budgetMs, 5000), 200000);
    if (!r.ok) { out.note = 'DuckDuckGo : ' + r.note + ' (endpoint non officiel — peut être rate-limité)'; return out; }
    const html = r.html;
    const reA = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const reS = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const links = [], snippets = [];
    let m;
    while ((m = reA.exec(html)) !== null && links.length < 10) {
      const url = ddgRealUrl(m[1]);
      const title = ddgStrip(m[2]);
      if (url && title) links.push({ url: url, title: title });
    }
    while ((m = reS.exec(html)) !== null && snippets.length < 10) {
      const s = ddgStrip(m[1]);
      if (s && s.length > 30) snippets.push(s);
    }
    if (!links.length) { out.note = 'DuckDuckGo : aucun résultat parsé'; return out; }
    const nameTok = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    let site = null, snippet = null, snippetHost = '';
    for (let i = 0; i < links.length && !site; i++) {
      const host = hostOf(links[i].url);
      const compact = host.replace(/[^a-z0-9]/g, '');
      // site officiel : domaine apparenté au nom, hors annuaires/réseaux sociaux
      if (nameTok && compact.indexOf(nameTok) !== -1 && !TAVILY_BLOCK.test(host)) site = links[i].url;
    }
    // agrégation : on collecte TOUS les snippets exploitables — les annuaires/agrégateurs
    // (annuaire-entreprises, societe.com, pappers…) sont exclus (textes génériques sans
    // valeur) ; priorité aux résultats apparentés au nom (ou Wikipédia), puis à richesse
    // égale le snippet le plus informatif (le plus long).
    const cands = [];
    for (let i = 0; i < links.length; i++) {
      if (!snippets[i]) continue;
      const host = hostOf(links[i].url);
      if (DDG_SNIPPET_BLOCK.test(host)) continue;
      const compact = host.replace(/[^a-z0-9]/g, '');
      cands.push({
        s: snippets[i], host: host,
        related: (nameTok && compact.indexOf(nameTok) !== -1) || host.indexOf('wikipedia') !== -1
      });
    }
    if (cands.length) {
      cands.sort(function (a, b) {
        if (a.related !== b.related) return a.related ? -1 : 1;
        return b.s.length - a.s.length;
      });
      snippet = cands[0].s;
      snippetHost = cands[0].host;
    }
    if (site) { out.website = site; out.note = 'site repéré via DuckDuckGo'; }
    if (snippet) {
      out.description = snippet.slice(0, 320);
      out.descSource = snippetHost || 'duckduckgo';
      out.descConfidence = (snippetHost.indexOf('wikipedia') !== -1) ? 45 : 32;
    }
    if (!site && !snippet) out.note = 'DuckDuckGo : aucun résultat exploitable';
  } catch (e) {
    out.note = 'DuckDuckGo : ' + String((e && e.message) || e).slice(0, 120);
  }
  return out;
}

// Bing : repli de engDdg quand DuckDuckGo bloque les IP datacenter (html.duckduckgo.com
// renvoie 403/fetch failed depuis Vercel). Bing accepte les IP serverless — snippets +
// découverte du site officiel, annuaires exclus via DDG_SNIPPET_BLOCK/TAVILY_BLOCK.
async function engBing(ent, budgetMs) {
  const out = { engine: 'bing', source: 'bing' };
  const name = String(ent.nom || '').replace(/[, ]+\s*(SASU|SAS|SARL|EURL|SELAS|SELARL|SCOP|SCI|SNC|GIE|SCA|SA)\s*$/i, '').trim();
  if (!name) { out.note = 'nom absent'; return out; }
  const q = [name, ent.ville || '', 'entreprise'].filter(Boolean).join(' ');
  try {
    const r = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=fr&cc=fr', Math.min(budgetMs, 5000), 300000);
    if (!r.ok) { out.note = 'Bing : ' + r.note; return out; }
    const html = r.html;
    // résultats organiques Bing : <li class="b_algo"><h2><a href="URL">titre</a></h2>…<p>snippet</p>…</li>
    const items = [];
    const reLi = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = reLi.exec(html)) !== null && items.length < 10) {
      let url = m[1];
      if (url.indexOf('http') !== 0) continue;
      const title = ddgStrip(m[2]);
      let snippet = '';
      const mp = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (mp) snippet = ddgStrip(mp[1]);
      if (title) items.push({ url: url, title: title, snippet: snippet });
    }
    if (!items.length) { out.note = 'Bing : aucun résultat parsé'; return out; }
    const nameTok = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    let site = null, snippet = null, snippetHost = '';
    for (let i = 0; i < items.length && !site; i++) {
      const host = hostOf(items[i].url);
      const compact = host.replace(/[^a-z0-9]/g, '');
      if (nameTok && compact.indexOf(nameTok) !== -1 && !TAVILY_BLOCK.test(host)) site = items[i].url;
    }
    const cands = [];
    for (let i = 0; i < items.length; i++) {
      const s = items[i].snippet;
      if (!s || s.length < 30) continue;
      const host = hostOf(items[i].url);
      if (DDG_SNIPPET_BLOCK.test(host)) continue;
      const compact = host.replace(/[^a-z0-9]/g, '');
      cands.push({
        s: s, host: host,
        related: (nameTok && compact.indexOf(nameTok) !== -1) || host.indexOf('wikipedia') !== -1
      });
    }
    if (cands.length) {
      cands.sort(function (a, b) {
        if (a.related !== b.related) return a.related ? -1 : 1;
        return b.s.length - a.s.length;
      });
      snippet = cands[0].s;
      snippetHost = cands[0].host;
    }
    if (site) { out.website = site; out.note = 'site repéré via Bing'; }
    if (snippet) {
      out.description = snippet.slice(0, 320);
      out.descSource = snippetHost || 'bing';
      out.descConfidence = (snippetHost.indexOf('wikipedia') !== -1) ? 45 : 32;
    }
    if (!site && !snippet) out.note = 'Bing : aucun résultat exploitable';
  } catch (e) {
    out.note = 'Bing : ' + String((e && e.message) || e).slice(0, 120);
  }
  return out;
}

// Meta du site : og:description / meta description / JSON-LD — la description que
// l'entreprise écrit elle-même (confiance la plus haute, ~70).
async function engMeta(siteUrl, budgetMs) {
  const out = { engine: 'meta', source: hostOf(siteUrl) || 'site' };
  const r = await fetchText(siteUrl, Math.min(budgetMs, PAGE_TIMEOUT), 300000);
  if (!r.ok) { out.note = 'site injoignable (' + r.note + ')'; return out; }
  const html = r.html;
  let desc = '';
  const mj = html.match(/"description"\s*:\s*"([^"]{25,500})"/i); // JSON-LD (schema.org)
  if (mj) desc = mj[1];
  if (!desc) {
    const m1 = html.match(/<meta[^>]+content="([^"]{25,500})"[^>]+(?:name|property)="(?:og:)?description"/i) ||
      html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]{25,500})"/i);
    if (m1) desc = m1[1];
  }
  desc = ddgStrip(desc);
  if (!desc) { out.note = 'aucune description (meta/JSON-LD) sur ' + out.source; return out; }
  out.description = desc.slice(0, 320);
  out.descConfidence = 68;
  return out;
}

// op=describe : chaîne « que fait cette entreprise ? » — DDG (site + snippet) puis meta
// du site découvert ; le front ajoute Wikidata côté client avant l'appel.
async function opDescribe(body) {
  const ent = (body && body.entity) || {};
  const engines = (Array.isArray(body && body.engines) && body.engines.length)
    ? body.engines : ['ddg', 'meta'];
  const wants = function (id) { return engines.indexOf(id) !== -1; };
  const started = Date.now();
  const left = function () { return DEADLINE_MS - (Date.now() - started); };
  const ctx = { website: cleanUrl(ent.siteWeb) || null, description: null, source: null, confidence: 0 };
  const results = [];
  function absorb(r) {
    if (!r) return;
    results.push(r);
    if (r.website && !ctx.website) ctx.website = r.website;
    if (r.description && (r.descConfidence || 0) > ctx.confidence) {
      ctx.description = r.description;
      ctx.source = r.descSource || r.source || r.engine;
      ctx.confidence = r.descConfidence || 0;
    }
  }
  let metaTried = ''; // URL déjà passée à engMeta (une seule fois par site)
  // 1. site déjà connu -> meta directe ; sinon DDG découvre le site + un snippet
  if (ctx.website && wants('meta') && left() > 2000) { metaTried = ctx.website; absorb(await engMeta(ctx.website, left() - 300)); }
  if (!ctx.description && wants('ddg') && left() > 2500) absorb(await engDdg(ent, Math.min(left() - 800, 5000)));
  // Repli Bing : DDG bloque souvent les IP datacenter (Vercel) -> Bing prend le relais
  if (!ctx.description && !ctx.website && wants('ddg') && left() > 3000) absorb(await engBing(ent, Math.min(left() - 800, 5000)));
  // 2. DDG a repéré un site -> meta de ce site, MÊME si DDG a déjà donné un snippet :
  //    la voix de l'entreprise prime (confiance 68 > snippet 32/45, fusion par absorb())
  if (ctx.website && ctx.website !== metaTried && wants('meta') && left() > 2000) {
    metaTried = ctx.website;
    absorb(await engMeta(ctx.website, left() - 300));
  }
  const best = (ctx.description || ctx.website)
    ? { description: ctx.description, website: ctx.website, source: ctx.source, confidence: ctx.confidence }
    : null;
  return { ok: true, best: best, results: results };
}

// ---------- Orchestration ----------
async function opLookup(body) {
  const ent = (body && body.entity) || {};
  const engines = (Array.isArray(body && body.engines) && body.engines.length)
    ? body.engines : ['officiel', 'tavily', 'scrape', 'prospector'];
  const wants = function (id) { return engines.indexOf(id) !== -1; };
  const started = Date.now();
  const left = function () { return DEADLINE_MS - (Date.now() - started); };
  const ctx = { website: cleanUrl(ent.siteWeb) || null, email: null, source: null, confidence: 0 };
  const results = [];
  function absorb(r) {
    if (!r) return;
    results.push(r);
    if (r.website && !ctx.website) ctx.website = r.website;
    if (r.email && (r.confidence || 0) > ctx.confidence) {
      ctx.email = r.email;
      ctx.source = r.source || r.engine;
      ctx.confidence = r.confidence || 0;
    }
  }
  if (ent.type === 'commune' && wants('officiel')) absorb(await engOfficiel(ent));
  if (!ctx.website && wants('tavily') && left() > 2500) absorb(await engTavily(ent));
  if (ctx.website && wants('scrape') && left() > 2000) absorb(await engScrape(ctx.website, left() - 300));
  if (ctx.website && wants('prospector') && left() > 3000) absorb(await engProspector(ctx.website, left() - 200));
  const best = (ctx.email || ctx.website)
    ? { email: ctx.email, website: ctx.website, source: ctx.source, confidence: ctx.confidence }
    : null;
  return { ok: true, type: ent.type || '', best: best, results: results };
}

// --- Adaptateur Vercel (port de netlify/functions/email.js — logique identique) ---
// Vercel parse automatiquement les corps JSON (req.body objet) ; repli string par sécurité.
module.exports = async function (req, res) {
  const send = function (obj, status) { res.status(status || 200).json(obj); };
  let body = {};
  if (req && (req.method === 'POST' || req.body)) {
    if (typeof req.body === 'string') {
      try { body = JSON.parse(req.body || '{}'); }
      catch (e) { return send({ ok: false, error: 'corps JSON invalide' }, 400); }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }
  }
  const op = body.op || (req && req.query && req.query.op);
  try {
    if (op === 'lookup') return send(await opLookup(body));
    if (op === 'describe') return send(await opDescribe(body));
    return send({ ok: false, error: 'op inconnu (lookup, describe)' }, 400);
  } catch (err) {
    return send({ ok: false, error: String((err && err.message) || err) }, 502);
  }
};
