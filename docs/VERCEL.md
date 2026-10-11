# Déploiement Vercel (port du site Netlify)

Le site est déployable tel quel sur Vercel, sans modifier le front :

- `api/` : ports exacts des fonctions Netlify (`ft`, `curated`, `email`) — même logique, seul l'adaptateur HTTP change (Vercel : `(req, res)`).
- `vercel.json` : rewrites équivalents aux `[[redirects]]` de `netlify.toml` (proxys same-origin des données data.gouv, geojson, API Recherche d'entreprises, BAN + routage `/ft/*` vers les fonctions).
- `package.json` : dépendances des fonctions (`prospector-mcp` pour `api/email.js`).

## Import

1. Vercel → Add New… → Project → importer `johannoriel/openfrance`.
2. Framework Preset : **Other**. Build Command : *(vide)*. Output Directory : *(vide / racine)*.
3. Nommer le projet `openfrance` → domaine `openfrance.vercel.app` (renommable ensuite).

## Variables d'environnement (Settings → Environment Variables)

| Variable | Requise | Rôle |
|---|---|---|
| `FT_CLIENT_ID` | oui (`/ft/ft`) | OAuth France Travail (ROMEO, ROME 4.0, La Bonne Boite) |
| `FT_CLIENT_SECRET` | oui (`/ft/ft`) | OAuth France Travail |
| `SUPABASE_URL` | oui (`/ft/curated`) | API REST du projet Supabase openfrance |
| `SUPABASE_ANON_KEY` | oui (`/ft/curated`) | Clé publishable Supabase |
| `TAVILY_API_KEY` | non (`/ft/email`) | Moteur « tavily » de découverte de site — désactivé proprement si absente |
| `PROSPECTOR_TIER` | non (`/ft/email`) | Tier prospector-mcp (free = 50 vérifications/jour) |

Mêmes valeurs que les variables d'environnement du site Netlify (Site configuration → Environment variables).

## Double déploiement

Les fichiers Netlify (`netlify.toml`, `netlify/functions/`) restent intacts : les deux hébergeurs peuvent servir le repo en parallèle. L'ajout d'un `package.json` racine déclenche un `npm install` (inoffensif) côté build Netlify.
