// OpenFrance — Fonction Netlify : listes curatées d'entreprises (Airtable)
//
// GET /ft/airtable → { ok, records: [{ siren, nom, listes, domaines, ville, site }] }
//
// Base personnelle (AIRTABLE_BASE_ID, PAT scope data.records:read — secrets en
// variables d'environnement Netlify, jamais dans le repo). Table Entreprises
// (tblYNSodXZlbygKN4) : listes curatées de signaux certains — ex. French Tech 2030
// promotion 2025 (80 lauréats, 72 SIREN résolus ; les 8 sans SIREN sont exclus du
// croisement, voir le champ Notes de la base). On ne stocke JAMAIS les résultats de
// recherche ici : seules les listes curatées (limite free Airtable : 1000/base).
// Cache 1 h par instance chaude (les listes évoluent rarement).

const TABLE_ID = 'tblYNSodXZlbygKN4';
const CACHE_TTL_MS = 60 * 60 * 1000;
let CACHE = null;

function json(obj, status) {
  return { statusCode: status || 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function pickSelect(v) { // multipleSelects : tableau de chaînes (tolère les objets)
  return (v || []).map(function (x) { return typeof x === 'string' ? x : (x && x.name) || ''; }).filter(Boolean);
}

async function fetchAll() {
  const out = [];
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + process.env.AIRTABLE_BASE_ID + '/' + TABLE_ID + '?pageSize=100';
    if (offset) url += '&offset=' + encodeURIComponent(offset);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_API_KEY } });
    const txt = await res.text();
    if (!res.ok) throw new Error('Airtable HTTP ' + res.status + ' : ' + txt.slice(0, 200));
    const j = JSON.parse(txt);
    (j.records || []).forEach(function (rec) {
      const f = rec.fields || {};
      const siren = String(f['SIREN'] || '').trim();
      if (!siren) return; // lauréat sans SIREN résolu : hors croisement
      out.push({
        siren: siren,
        nom: f['Nom'] || '',
        listes: pickSelect(f['Listes']),
        domaines: pickSelect(f['Domaines']),
        ville: f['Ville'] || '',
        site: f['Site web'] || ''
      });
    });
    offset = j.offset || null;
  } while (offset);
  return out;
}

exports.handler = async function () {
  try {
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
      return json({ ok: false, error: "AIRTABLE_API_KEY / AIRTABLE_BASE_ID manquants (variables d'environnement Netlify)" }, 500);
    }
    if (CACHE && Date.now() < CACHE.exp) return json({ ok: true, records: CACHE.records, cached: true });
    const records = await fetchAll();
    CACHE = { records: records, exp: Date.now() + CACHE_TTL_MS };
    return json({ ok: true, records: records, cached: false });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
};
