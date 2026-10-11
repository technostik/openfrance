// Sonde temporaire (à supprimer après validation).
// GET /api/probe?nom=...&ville=...[&site=...][&type=ent|asso]  → chaîne describe de email.js
// GET /api/probe?raw=1&nom=...&ville=...                       → debug : 5 premiers résultats Bing (URL décodée, titre, snippet)
module.exports = async function (req, res) {
  const q = (req && req.query) || {};

  function strip(h) {
    return String(h).replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
  }
  function bingDecode(href) {
    let u;
    try { u = new URL(href); } catch (e) { return href; }
    if (u.hostname.indexOf('bing.com') === -1 || u.pathname.indexOf('/ck/') !== 0) return href;
    const v = u.searchParams.get('u') || '';
    if (!v || v.length < 4) return null;
    let b = v.replace(/^a[0-9]/, '').replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    try { const d = Buffer.from(b, 'base64').toString('utf8'); return /^https?:\/\//i.test(d) ? d : null; }
    catch (e) { return null; }
  }

  // Mode debug : parse brut des résultats Bing
  if (q.raw) {
    const nom = q.nom || 'IKTOS';
    const query = encodeURIComponent([nom, q.ville || '', 'entreprise'].filter(Boolean).join(' '));
    try {
      const fr = await fetch('https://www.bing.com/search?q=' + query + '&setlang=fr&cc=fr', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenFrance/1.0; +https://github.com/johannoriel/openfrance)', 'Accept-Language': 'fr-FR,fr;q=0.9' }
      });
      const html = (await fr.text()).slice(0, 300000);
      const items = [];
      const reLi = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = reLi.exec(html)) !== null && items.length < 5) {
        items.push({ raw: m[1].slice(0, 80), url: bingDecode(m[1]), title: strip(m[2]).slice(0, 100) });
      }
      return res.status(200).json({ ok: true, status: fr.status, htmlLen: html.length, b_algoCount: (html.match(/b_algo/g) || []).length, items: items });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
  }

  const email = require('./email.js');
  const entity = {
    type: q.type || 'ent',
    nom: q.nom || 'IKTOS',
    siren: q.siren || '',
    insee: q.insee || '',
    ville: q.ville || 'Paris',
    dep: q.dep || '',
    siteWeb: q.site || ''
  };
  const mock = {
    _status: 0, _body: null,
    status: function (s) { this._status = s; return this; },
    json: function (o) { this._body = o; return this; }
  };
  const t0 = Date.now();
  try {
    await email({ method: 'POST', body: { op: 'describe', entity: entity }, query: {} }, mock);
    return res.status(200).json({ ok: true, ms: Date.now() - t0, status: mock._status, response: mock._body });
  } catch (e) {
    return res.status(200).json({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) });
  }
};
