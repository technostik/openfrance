// OpenFrance — probe.js : sonde diagnostique TEMPORAIRE (à supprimer).
// Teste la joignabilité des moteurs de description depuis le runtime.
async function tryGet(url, ua) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua || 'Mozilla/5.0 (compatible; OpenFrance/1.0; +https://github.com/johannoriel)' } });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, len: txt.length, excerpt: txt.slice(0, 120).replace(/\s+/g, ' ') };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t0 };
  }
}
module.exports = async (req, res) => {
  const q = encodeURIComponent(req.query.q || 'IKTOS Paris entreprise');
  const tests = {
    ddg_html: await tryGet('https://html.duckduckgo.com/html/?q=' + q),
    ddg_api: await tryGet('https://api.duckduckgo.com/?q=' + q + '&format=json&no_html=1'),
    ddg_lite: await tryGet('https://lite.duckduckgo.com/lite/?q=' + q),
    wikipedia_fr: await tryGet('https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + q + '&format=json&srlimit=3'),
    wikidata_api: await tryGet('https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=fr&limit=3&search=' + q),
    site_direct: await tryGet('https://iktos.ai/'),
    bing: await tryGet('https://www.bing.com/search?q=' + q)
  };
  res.status(200).json(tests);
};
