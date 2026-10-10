// OpenFrance — Fonction Netlify : recherche email & site web des favoris (branche get_email)
//
// Endpoint (POST, paramètre op) :
//   POST /ft/email  { op:'lookup', entity:{ type:'ent'|'asso'|'commune', nom, siren, siret,
//                                            insee, ville, dep, siteWeb },
//                     engines:[ 'officiel'|'tavily'|'scrape'|'prospector' ] }
//   → { ok:true, best:{ email, website, source, confidence }, results:[{ engine, ... }] }
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

function json(obj, status) {
  return { statusCode: status || 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

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
      headers: { 'User-Agent': FETCH_UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5' }
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
  if (!entry) { out.note = 'prospector-mcp non installé (voir netlify/functions/package.json)'; return out; }
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

exports.handler = async function (event) {
  let body = {};
  if (event && (event.httpMethod === 'POST' || event.body)) {
    try { body = JSON.parse((event && event.body) || '{}'); }
    catch (e) { return json({ ok: false, error: 'corps JSON invalide' }, 400); }
  }
  const op = body.op || (event && event.queryStringParameters && event.queryStringParameters.op);
  try {
    if (op === 'lookup') return json(await opLookup(body));
    return json({ ok: false, error: 'op inconnu (lookup)' }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
};
