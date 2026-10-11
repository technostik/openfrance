// Sonde temporaire (à supprimer après validation) : exécute la chaîne describe de
// email.js côté Vercel pour vérifier DDG vs Bing — GET /api/probe?nom=...&ville=...[&site=...][&type=ent|asso]
module.exports = async function (req, res) {
  const q = (req && req.query) || {};
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
