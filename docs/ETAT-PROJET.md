# OpenFrance — État du projet (octobre 2026)

> **Ce document est la mémoire du projet.** Il doit être mis à jour à CHAQUE nouvelle fonctionnalité, correction ou changement d'architecture. Voir `AGENTS.md` pour les règles de maintenance de cette doc.

## 🎯 Objectif

Application web **100 % statique** (pas de backend) affichant des cartes choroplèthes de données ouvertes françaises (data.gouv.fr). Déployée sur Netlify (branche `main` = production). **Contraintes : gratuit, sans clé API, sans service tiers payant.**

## 🗂️ Structure du repo

```
index.html      — UI : sélecteurs catégorie/indicateur/année, annuaire (recherche/type/catégorie), page cache globale, bandeau d'erreur, bouton retour
style.css       — Thème sombre, filtre CSS sur tuiles OSM, styles annuaire (.ann-*) et cache (.cache-*)
app.js          — Logique générale (registre d'indicateurs, parsers CSV, requêtes API, rendu choroplèthe, UI)
annuaire.js     — Mode Annuaire : associations RNA + entreprises, recherche multi-opérateurs, caches IndexedDB, page de gestion du cache
score31.js      — Mode Composeur de critères : indice ad hoc généralisé, département + ville cible + critères cumulables/pondérables (branche de test `score31`)
sw.js           — Service Worker : cache disque persistant (stale-while-revalidate)
netlify.toml    — Proxys redirects (same-origin → pas de CORS) : /data/*, /geo/*, /api/assos, /api/nomen, /api/entreprises
```

## 🏗️ Architecture

### app.js — flux général
1. Au chargement : CSV délinquance + GeoJSON départements sont fetchés (via proxy)
2. `REGISTRY` : registre d'indicateurs, chacun avec `{ cat, label, unit, type, hasCommunes, ensure, france(), communes() }`
   - `type: 'num'` → dégradé vert→rouge ; `type: 'cat'` → couleur par catégorie (hash de la clé), légende = clé + décompte
3. Catégories : **Délinquance** / **Économie** / **Politique** / **Annuaire**
4. Vue France (départements) → clic sur un département → zoom communes + bouton « ← France »
5. **Le département est conservé au changement de catégorie** (`selectIndicator(label, keepDep)`) : on change d'indicateur, pas de territoire
6. Erreurs : bandeau rouge (`showError`) + détails console F12 ; erreurs de parsing nomment la colonne manquante

### Rendu choroplèthe — échelle robuste
`scaleBounds(values)` : bornes **P5→P95** (percentiles), pas min/max brut. Une commune de 3 habitants avec 2 faits (666 ‰) ne doit pas écraser la palette — les outliers **saturent** (clamp `min(1, max(0, t))`) et la légende affiche « Échelle écrêtée (P5–P95) ». Communes < 100 hab : infobulle « ⚠️ taux peu significatif ». Le taux reste faits/habitants (méthode officielle Intérieur, pas de pondération par gravité — n'existe pas officiellement).

### annuaire.js — mode Annuaire
- **Associations** : RNA agrégé national (Waldec, resource `91fd139b-...`) via `/api/assos/`, filtres `date_disso__exact=-infinity` + `adrs_codeinsee__in=<codes INSEE du dept>`, pagination par lots de 10 pages de 200. Chargement par département → filtrage **local**.
- **Thèmes** : nomenclature WALDEC (resource `2b618348-...`, 297 codes, 2 pages) via `/api/nomen/` → facette catégorie.
- **Entreprises** : API Recherche d'entreprises (DINUM) via `/api/entreprises/` (`q`, `departement`, `est_association=false`, `per_page` max 25, total_pages plafonné à 4). **L'API ne permet PAS de lister tout un département** : recherche texte obligatoire.
- **Recherche multi-opérateurs** (`parseAnnQuery`) : mots simples = ET · `+mot` = OU (dès qu'il y a un `+`, req+or forment un OU : `a + b` = a OU b) · `-mot` = exclusion · `"mot"` = mot exact (frontières de mot, regex `(^|[^a-z0-9])mot($|[^a-z0-9])`) · espaces autour des `+`/`-` tolérés (token orphelin → `pendingSign`). Interprétation en direct sous le champ (`annQueryExplain`, `#annQueryExp`).
- **Marqueurs par différence** (`annSyncMarkers` + `ANN.markerIndex`) : à chaque frappe, seuls les nouveaux marqueurs sont créés, les disparus retirés — jamais de recréation complète (anti-scintillement). Clés : `a:<id RNA>` / `e:<siren>`.
- Variables globales d'app.js utilisées : `state`, `map`, `geoLayer`, `refresh`, `openDepartment`, `setStatus`, `showError`, `hideError`, `fetchJSONCached`, `fetchCache`, `DEP_FOLDERS`, `catColor`, `ELECAGR`.
- `annEnter`/`annLeave` : **conservent le département courant** (pas de retour forcé à la France).

### score31.js — mode « Composeur de critères » (branche de test `score31`)
- **Généralisation de l'ancien « Score perso (31) »** : indice composite **personnalisable** des communes de **n'importe quel département**, **hors REGISTRY** (`scoreEnter`/`scoreLeave` appelés depuis le listener `#categorySelect` de app.js via `typeof` guards).
- **Département** au choix (select) + **ville cible** avec autocomplete sur les communes du département (recherche insensible aux accents via `normTxt`, dropdown custom `#scTargetDrop`, Entrée = 1er résultat).
- **Critères ajoutables/retirables à volonté** (bouton ＋ / ✕), chacun avec : **sens** (⬆ plus = mieux / ⬇ moins = mieux) et **poids 0–10**. Types : 📍 distance à la ville cible · 🛡 délinquance (indicateur au choix, dernière année) · 💰 loyers (Carte des loyers 2025) · 💶 niveau de vie médian (Filosofi) · 🏠 prix m² DVF (appartements/maisons) · 🥋 associations RNA (requête multi-opérateurs) · 🗳 politique par commune (indicateurs numériques du REGISTRY : abstentions, voix candidat/nuance/liste).
- Normalisation P5–P95 avec saturation par critère (`scBounds`) ; score = Σ poids×part / Σ poids ; **donnée absente → part neutre 0,5** ; critère non chargé → neutre également.
- **Temps réel** : `scDraw` recalcule puis `setStyle` en place (jamais de recréation de couche) ; les chargements de données sont paresseux, par critère, avec dédoublonnage (`SC.valCache[key].promise`).
- Couleurs : `colorFor(1 − score)` (vert = bon score) ; **meilleure commune en bleu** (#2563eb, bordure blanche, 🏆 infobulle/légende/top 10) ; infobulle détaillée = valeur de chaque critère.
- Au premier passage, critères par défaut = reproduction de l'ancien score perso (distance Toulouse, délinquance ensemble, loyers, assos « mma + systema + ninjutsu » ; poids 5/5/5/3).
- Mode isolé : retire `geoLayer`, couche propre `SC.layer`, ne remplace pas `refresh`, réutilise les caches existants (IndexedDB assos, `state.communesGeo`/`communesCache`, SW `/data/` et `/api/`).

### Caches (3 niveaux, page de gestion unifiée 🗂)
- **En RAM** (vidés au rechargement) : `fetchCache`/`inFlight`, `state.communesGeo`, `state.communesCache`, `ELECAGR.byDepElection`, `ANN.assos`, `ANN.entCache`
- **IndexedDB** (`openfrance-annuaire`, store `assos`) : clés `assos-<dep>` ({v, date, rows}), `nomen` ({child}), `ent-<dep|terms|section>` (résultats de recherche entreprises) — **persistant entre sessions**
- **Cache disque Service Worker** (`openfrance-v1` + TTL `openfrance-meta-v1`) : `/geo/` 30 j, `/data/` 24 h, `/api/` 7 j. Le SW ne met PAS en cache .js/.html/.css.
- La page 🗂 Cache (`renderCachePage`, `annCacheButtonAction`) réunit les 3 niveaux avec actions 🔄 rafraîchir / 🗑 purger par entrée.

### Parsing CSV maison (robuste)
`csvRows(text)` : BOM, séparateur auto (`;` vs `,`), guillemets doubles. `num()` gère `%`, espaces et virgules décimales. `colIdx(header, regex)` trouve les colonnes par regex. `normDep()` normalise `1` → `01`, accepte `2A`/`2B`/`97x`.

## 📊 Données & sources

Toutes via proxys `netlify.toml` (URLs exactes dedans). Les sources restent à jour automatiquement (on pointe vers les originaux, jamais de copies dans le repo).

### Délinquance
- Départements : CSV (~1,9 Mo) via `/data/delinquance-dep.csv`
- Communes : **API tabulaire** data.gouv (resource `44ef4323-...`) via `/api/communes/`, filtre `CODGEO_2026__in=...&annee__exact=...`

### Économie
- Revenus : Filosofi 2021 par commune (Geoptis, ~4,8 Mo), médiane `[DISP]`/`[DEC]`, agrégation dept pondérée par ménages fiscaux
- Prix m² : DVF stats (~29 Mo, `data-pipeline-open` S3), colonnes `code_geo`/`echelle_geo` (`departement`|`commune`), `moy_prix_m2_whole_appartement/maison`

### Politique
- **Présidentielle 2022** (dept) : fichiers Ministère T1/T2 via `/data/pres2022-*.txt` (format long, 1 ligne dept×candidat)
- **Législatives 2024** : T1 (1 ligne circo×candidat, nuances) + T2 (format large, `Elu N`) via `/data/leg2024-*.csv` → sièges par nuance/dept, voix T1 par nuance, abstention
- **Européennes 2024** (dept) : CSV format large (38 listes en colonnes) via `/data/euro2024-dep.csv`
- **Niveau commune (toutes élections)** : dataset **« Données des élections agrégées »** (id `6481e741d4cf002ec0efec9d`) via l'API tabulaire :
  - `/api/elect-gen/` → resource `b8703c69-...` : inscrits/abstentions/exprimés par **bureau de vote**
  - `/api/elect-cand/` → resource `52a11762-...` : voix par candidat/liste et BV
  - `id_election` : `2022_pres_t1`, `2022_pres_t2`, `2024_legi_t1`, `2024_euro_t1` — BV **sommés par commune** dans le navigateur

### Annuaire
- Associations : RNA agrégé national (Waldec) — voir architecture ci-dessus
- Entreprises : API Recherche d'entreprises (DINUM) — gratuit, sans clé, résultats cachés IndexedDB pour économiser le quota

### Composeur de critères
- Loyers d'annonce prédits par commune : « Carte des loyers » 2025 (Ministère de la Transition écologique, dataset `693aa2feed1bf4da603faa49`), resource `55b34088-...` (colonnes `INSEE_C`, `loypredm2`) via `/api/loyers/`, filtre `DEP__exact=<dept>` (généralisé à tout département) — une valeur par commune, même pour les petites (prédiction par maille).
- Tous les autres critères réutilisent les sources existantes (france-geojson, délinquance communale, Filosofi, DVF, élections agrégées, RNA) — aucune copie de données.

## 🐛 Bugs résolus (NE PAS RÉGRESSER)

1. Parser CSV naïf → années NaN → maintenant regex robuste
2. `page_size` > 200 sur l'API tabulaire → HTTP 400 → **max 200**
3. `links.next` de l'API tabulaire pointe **hors proxy** (404 page 2) → **pagination manuelle via `&page=N`**
4. `r.zone` vs `r.dep` dans les agrégats délinquance → corrélé
5. `france-geojson.github.io` mort → utiliser `raw.githubusercontent.com/gregoiredavid/france-geojson`
6. Indicateurs politique enregistrés AVANT chargement des données (listes vides) → charger d'abord, enregistrer ensuite (voir `initUI`)
7. Opérateurs de recherche « cassés » : le parseur exigeait `+mot`/`-mot` **collés** alors que le placeholder montrait des espaces → parseur tolérant (token `+`/`-` orphelin → `pendingSign` pour le token suivant)
8. Sémantique du OU erronée : `a + b` voulait dire « a ET au-moins-b » (0 résultat) → désormais `a + b` = **a OU b** (pool req+or dès qu'il y a un `+`)
9. Scintillement de la carte à chaque frappe : les marqueurs étaient tous supprimés/recréés → **mise à jour par différence** (`annSyncMarkers`)
10. Changement de catégorie : retour forcé à la vue France → `selectIndicator(label, keepDep)` conserve le département ; `annEnter`/`annLeave` aussi
11. Échelle choroplèthe écrasée par les outliers (commune de 3 hab à 666 ‰) → bornes **P5–P95** avec saturation + mention dans la légende
12. Connector GitHub : `get_file_contents` exige `ref: "refs/heads/work"` (PAS `branch`) ; `read_file` retourne un objet `{content, was_truncated…}` — **toujours** vérifier `was_truncated === false` avant un push (sinon fichier corrompu, incident réparé en 471da2d)

## 🚀 Deploys & workflow

- **`main`** = production Netlify. **CHAQUE push sur `main` déclenche un deploy** (plan gratuit Netlify : ~20 deploys/mois en crédits → les économiser !)
- **Workflow** : travailler sur une branche dédiée (`work`), tester en local avec `netlify dev`, merger vers `main` seulement quand stable = 1 seul deploy
- Branche de test **`score31`** (fork de `work`) : fonctionnalité « Composeur de critères » (généralisation du score perso). Tester en local (`netlify dev`, les proxys `/api/loyers/` y sont actifs), merger vers `work`/`main` ou abandonner librement.
- Migration Vercel envisagée (100 deploys/jour) : traduire `netlify.toml` → `vercel.json` (rewrites), rien d'autre à changer
- Contours communes : dossier par dept (`DEP_FOLDERS` map complète code→dossier dans `app.js`)

## 💡 Idées backlog (non réalisées)

- Graphique d'évolution par année au clic sur une zone
- Classement complet des 101 départements (pas seulement top 10)
- Cache partagé côté serveur (Netlify Blobs, ~1 Go gratuit)
- Sélecteur de département déroulant dans l'annuaire (au lieu du clic carte)
- Autres jeux de données data.gouv
