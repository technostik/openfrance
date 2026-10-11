// OpenFrance — Fonction Vercel (port de netlify/functions/curated.js) : listes curatées d'entreprises (Supabase)
//
// GET /ft/curated → { ok, records: [{ nom, siren, listes, domaines, ville, site_web }] }
//
// Table public.entreprises du projet Supabase openfrance (SUPABASE_URL,
// SUPABASE_ANON_KEY — clé publishable, en variables d'environnement,
// jamais dans le repo). RLS activé avec policy SELECT publique : la table ne
// contient que des données publiques (listes curatées de signaux certains —
// ex. French Tech 2030 promotion 2025 ; 72 SIREN résolus, les 8 sans SIREN
// restent exclus du croisement, comme avec la source Airtable d'origine).
// On ne stocke JAMAIS les résultats de recherche ici.
// Requête GET simple vers l'API REST (PostgREST), fetch natif Node, pas de SDK.
// Cache 1 h par instance chaude (les listes évoluent rarement).

const CACHE_TTL_MS = 60 * 60 * 1000;
let CACHE = null;

async function fetchAll() {
  const url = process.env.SUPABASE_URL + '/rest/v1/entreprises?select=nom,siren,listes,domaines,ville,site_web';
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY
    }
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase HTTP ' + res.status + ' : ' + txt.slice(0, 200));
  const rows = JSON.parse(txt);
  if (!Array.isArray(rows)) throw new Error('Réponse Supabase inattendue (tableau attendu)');
  return rows.map(function (r) {
    const siren = String((r && r.siren) || '').trim();
    if (!siren) return null; // sans SIREN résolu : hors croisement
    return {
      nom: (r && r.nom) || '',
      siren: siren,
      listes: Array.isArray(r.listes) ? r.listes : [],
      domaines: Array.isArray(r.domaines) ? r.domaines : [],
      ville: (r && r.ville) || '',
      site_web: (r && r.site_web) || ''
    };
  }).filter(Boolean);
}

// --- Adaptateur Vercel (port de netlify/functions/curated.js — logique identique) ---
module.exports = async function (req, res) {
  const send = function (obj, status) { res.status(status || 200).json(obj); };
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return send({ ok: false, error: "SUPABASE_URL / SUPABASE_ANON_KEY manquants (variables d'environnement)" });
    }
    if (CACHE && Date.now() < CACHE.exp) return send({ ok: true, records: CACHE.records, cached: true });
    const records = await fetchAll();
    CACHE = { records: records, exp: Date.now() + CACHE_TTL_MS };
    return send({ ok: true, records: records, cached: false });
  } catch (err) {
    return send({ ok: false, error: String((err && err.message) || err) });
  }
};
