# OpenFrance — État du projet (octobre 2026)

> **Ce document est la mémoire du projet.** Il doit être mis à jour à CHAQUE nouvelle fonctionnalité, correction ou changement d'architecture. Voir `AGENTS.md` pour les règles de maintenance de cette doc.

## 🎯 Objectif

Application web **100 % statique** (pas de backend) affichant des cartes choroplèthes de données ouvertes françaises (data.gouv.fr). Déployée sur Netlify (branche `main` = production). **Contraintes : gratuit, sans clé API, sans service tiers payant.**

## 🗂️ Structure du repo

```
index.html      — UI : sélecteurs catégorie/indicateur/année, bandeau d'erreur, bouton retour, panneaux carte+légende+top10
style.css       — Thème sombre, filtre CSS sur tuiles OSM
app.js          — TOUTE la logique (registre d'indicateurs, parsers CSV, requêtes API, rendu Leaflet)
sw.js           — Service Worker : cache disque persistant (stale-while-revalidate)
netlify.toml    — Proxys redirects (same-origin → pas de CORS)
```

## 🏗️ Architecture (`app.js`)

### Flux général
1. Au chargement : CSV délinquance + GeoJSON départements sont fetchés (via proxy)
2. `REGISTRY` : registre d'indicateurs, chacun avec `{ cat, label, unit, type, hasCommunes, ensure, france(), communes() }`
   - `type: 'num'` → dégradé vert→rouge ; `type: 'cat'` → couleur par catégorie (hash de la clé), légende = clé + décompte
3. Catégories : **Délinquance** / **Économie** / **Politique**
4. Vue France (départements) → clic sur un département → zoom communes + bouton « ← France »
5. Erreurs : bandeau rouge (`showError`) + détails console F12 ; erreurs de parsing nomment la colonne manquante

### Parsing CSV maison (robuste)
`csvRows(text)` : BOM, séparateur auto (`;` vs `,`), guillemets doubles. `num()` gère `%`, espaces et virgules décimales. `colIdx(header, regex)` trouve les colonnes par regex. `normDep()` normalise `1` → `01`, accepte `2A`/`2B`/`97x`.

### Caches
- **En RAM** (vidés au rechargement) : `fetchCache`/`inFlight` (textes/JSON), `state.communesGeo` (GeoJSON communes), `state.communesCache` (délinquance), `ELECAGR.byDepElection` (élections par commune)
- **Sur disque, persistant** : Service Worker (`sw.js`), TTL stale-while-revalidate : `/geo/` 30 j, `/data/` 24 h, `/api/` 7 j. Cache **par client navigateur** (pas partagé entre visiteurs).

## 📊 Données & sources

Toutes via proxys `netlify.toml` (URLs exactes dedans). Les sources restent à jour automatiquement (on pointe vers les originaux, jamais de copies dans le repo).

### Délinquance
- Départements : CSV (~1,9 Mo) via `/data/delinquance-dep.csv`
- Communes : **API tabulaire** data.gouv (resource `44ef4323-1097-48d5-8719-3c544b55d294`) via `/api/communes/`, filtre `CODGEO_2026__in=...&annee__exact=...`

### Économie
- Revenus : Filosofi 2021 par commune (Geoptis, ~4,8 Mo), médiane `[DISP]`/`[DEC]`, agrégation dept pondérée par ménages fiscaux
- Prix m² : DVF stats (~29 Mo, `data-pipeline-open` S3), colonnes `code_geo`/`echelle_geo` (`departement`|`commune`), `moy_prix_m2_whole_appartement/maison`

### Politique
- **Présidentielle 2022** (dept) : fichiers Ministère T1/T2 via `/data/pres2022-*.txt` (format long, 1 ligne dept×candidat)
- **Législatives 2024** : T1 (1 ligne circo×candidat, nuances) + T2 (format large, `Elu N`) via `/data/leg2024-*.csv` → sièges par nuance/dept, voix T1 par nuance, abstention
- **Européennes 2024** (dept) : CSV format large (38 listes en colonnes) via `/data/euro2024-dep.csv`
- **Niveau commune (toutes élections)** : dataset **« Données des élections agrégées »** (id `6481e741d4cf002ec0efec9d`, data.gouv officiel, mis à jour auto) via l'API tabulaire :
  - `/api/elect-gen/` → resource `b8703c69-...` : inscrits/abstentions/exprimés par **bureau de vote** (`id_election`, `code_commune`)
  - `/api/elect-cand/` → resource `52a11762-...` : voix par candidat/liste et BV
  - `id_election` utilisés : `2022_pres_t1`, `2022_pres_t2`, `2024_legi_t1`, `2024_euro_t1`
  - Les BV sont **sommés par commune** dans le navigateur (`loadElectCommunes`)

## 🐛 Bugs résolus (NE PAS RÉGRESSER)

1. Parser CSV naïf → années NaN → maintenant regex robuste
2. `page_size` > 200 sur l'API tabulaire → HTTP 400 → **max 200**
3. `links.next` de l'API tabulaire pointe **hors proxy** (404 page 2) → **pagination manuelle via `&page=N`**
4. `r.zone` vs `r.dep` dans les agrégats délinquance → corrélé
5. `france-geojson.github.io` mort → utiliser `raw.githubusercontent.com/gregoiredavid/france-geojson`
6. Indicateurs politique enregistrés AVANT chargement des données (listes vides) → charger d'abord, enregistrer ensuite (voir `initUI`)

## 🚀 Deploys & workflow

- **`main`** = production Netlify. **CHAQUE push sur `main` déclenche un deploy** (plan gratuit Netlify : ~20 deploys/mois en crédits → les économiser !)
- **Workflow** : travailler sur une branche dédiée (`work`), tester en local avec `netlify dev`, merger vers `main` seulement quand stable = 1 seul deploy
- Migration Vercel envisagée (100 deploys/jour) : traduire `netlify.toml` → `vercel.json` (rewrites), rien d'autre à changer
- Contours communes : dossier par dept (`DEP_FOLDERS` map complète code→dossier dans `app.js`)

## 💡 Idées backlog (non réalisées)

- Graphique d'évolution par année au clic sur une zone
- Classement complet des 101 départements (pas seulement top 10)
- Cache partagé côté serveur (Netlify Blobs, ~1 Go gratuit)
- Autres jeux de données data.gouv
