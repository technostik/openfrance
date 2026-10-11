// Sonde temporaire (à supprimer après validation).
// GET /api/probe?nom=...&ville=...[&site=...][&type=ent|asso]  → chaîne describe de email.js (ddg → tavily → meta)
// GET /api/probe?raw=1&nom=...&ville=...                       → debug : parse Bing HTML + RSS
module.exports = async function (req, res) {
  const q = (req && req.query) || {};

  function strip(h) {
    return String(h).replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/\s+/g, ' ').trim();
  }
  function bingDecode(href) {
    let s = String(href || '').replace(/&amp;/g, '&');
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.hostname.indexOf('bing.com') === -1 || u.pathname.indexOf('/ck/') !== 0) return s;
    const v = u.searchParams.get('u') || '';
    if (!v || v.length < 4) return null;
    let b = v.replace(/^a[0-9]/, '').replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    try { const d = Buffer.from(b, 'base64').toString('utf8'); return /^https?:\/\//i.test(d) ? d : null; }
    catch (e) { return null; }
  }

  if (q.raw) {
    const nom = q.nom || 'IKTOS';
    const query = encodeURIComponent([nom, q.ville || '', 'entreprise'].filter(Boolean).join(' '));
    const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; OpenFrance/1.0; +https://github.com/johannoriel/openfrance)', 'Accept-Language': 'fr-FR,fr;q=0.9' };
    const out = { ok: true };
    try {
      const fr = await fetch('https://www.bing.com/search?q=' + query + '&setlang=fr&cc=fr', { headers: UA });
      const html = (await fr.text()).slice(0, 300000);
      out.html = { status: fr.status, len: html.length, b_algo: (html.match(/b_algo/g) || []).length, items: [] };
      const reLi = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = reLi.exec(html)) !== null && out.html.items.length < 5) {
        out.html.items.push({ url: bingDecode(m[1]), title: strip(m[2]).slice(0, 90) });
      }
    } catch (e) { out.html = { error: String((e && e.message) || e) }; }
    try {
      const fr2 = await fetch('https://www.bing.com/search?q=' + query + '&format=rss&count=10', { headers: UA });
      const xml = (await fr2.text()).slice(0, 200000);
      out.rss = { status: fr2.status, len: xml.length, isRss: xml.indexOf('<rss') !== -1 || xml.indexOf('<item>') !== -1, items: [] };
      const reI = /<item>([\s\S]*?)<\/item>/g;
      let m2;
      while ((m2 = reI.exec(xml)) !== null && out.rss.items.length < 5) {
        const it = m2[1];
        const t = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const l = it.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
        const d = it.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        out.rss.items.push({ title: t ? strip(t[1]).slice(0, 90) : null, link: l ? strip(l[1]).slice(0, 120) : null, desc: d ? strip(d[1]).slice(0, 120) : null });
      }
    } catch (e) { out.rss = { error: String((e && e.message) || e) }; }
    return res.status(200).json(out);
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
