// OpenFrance — probe.js : sonde diagnostique TEMPORAIRE (à supprimer).
// Appelle la fonction email.js en direct avec une entité réelle, pour diagnostiquer
// les moteurs describe (DDG rate-limité ? meta joignable ?) depuis le runtime.
const handler = require('./email.js');

module.exports = async (req, res) => {
  const entity = {
    type: req.query.type || 'ent',
    nom: req.query.nom || 'IKTOS',
    siren: req.query.siren || '',
    insee: req.query.insee || '',
    ville: req.query.ville || 'Paris',
    dep: req.query.dep || '',
    siteWeb: req.query.site || ''
  };
  const t0 = Date.now();
  const mockRes = {
    _c: 200,
    status: function (c) { this._c = c; return this; },
    json: function (j) {
      res.status(200).json({ httpStatus: this._c, ms: Date.now() - t0, payload: j });
    }
  };
  try {
    await handler({ method: 'POST', body: { op: req.query.op || 'describe', entity }, query: {} }, mockRes);
  } catch (e) {
    res.status(200).json({ crash: String((e && e.message) || e), ms: Date.now() - t0 });
  }
};
