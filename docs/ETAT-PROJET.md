# OpenFrance — État du projet (octobre 2026)

> **Ce document est la mémoire du projet.** Il doit être mis à jour à CHAQUE nouvelle fonctionnalité, correction ou changement d'architecture. Voir `AGENTS.md` pour les règles de maintenance de cette doc.

## 🎯 Objectif

Application web **100 % statique** (pas de backend) affichant des cartes choroplèthes de données ouvertes françaises (data.gouv.fr). Déployée sur Netlify (branche `main` = production). **Contraintes : gratuit, sans clé API, sans service tiers payant.**

## 🗂️ Structure du repo

```
index.html      — UI : sélecteurs catégorie/indicateur/année, annuaire (recherche/type/catégorie), composeur d'entreprises (ciblage + critères), page cache globale, bandeau d'erreur, bouton retour
style.css       — Thème sombre, filtre CSS sur tuiles OSM, styles annuaire (.ann-*), composeur d'entreprises (.co-*) et cache (.cache-*)
app.js          — Logique générale (registre d'indicateurs, parsers CSV, requêtes API, rendu choroplèthe, UI)
annuaire.js     — Mode Annuaire : associations RNA + entreprises, recherche multi-opérateurs, caches IndexedDB, page de gestion du cache
score31.js      — Mode Composeur de critères : indice ad hoc généralisé, département + ville cible + critères cumulables/pondérables (branche de test `score31`)
corp.js         — Mode Composeur d'entreprises : recherche multicritère (NAF, effectifs, CA, labels…), ciblage ville+rayon / commune / département, fiche détaillée (branche de test `corp_search`)
corp_ext.js     — Mode Recherche étendue : ROMEO → ROME 4.0 → La Bonne Boite → croisement listes curatées Supabase (branche de test corp_ext)
netlify/functions/ft.js, curated.js — Fonctions Netlify : proxy France Travail (OAuth + cache token + throttle) et listes curatées Supabase
sw.js           — Service Worker : cache disque persistant (stale-while-revalidate)
netlify.toml    — Proxys redirects (same-origin → pas de CORS) : /data/*, /geo/*, /api/assos, /api/nomen, /api/entreprises, /api/ent
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
`scaleBounds(values)` : bornes **P5→P95** (percentiles), pas min/max brut. Une commune de 3 habitants avec 2 faits (666 ‰) ne doit pas écraser la palette — les outliers **saturent** (clamp `min(1, max(0, t))`) et la légende affiche « Échelle écrétée (P5–P95) ». Communes < 100 hab : infobulle « ⚠️ taux peu significatif ». Le taux reste faits/habitants (méthode officielle Intérieur, pas de pondération par gravité — n'existe pas officiellement).

### annuaire.js — mode Annuaire
- **Associations** : RNA agrégé national (Waldec, resource `91fd139b-...`) via `/api/assos/`, filtres `date_disso__exact=-infinity` + `adrs_codeinsee__in=<codes INSEE du dept>`, pagination par lots de 10 pages de 200. Chargement par département → filtrage **local**.
- **Thèmes** : nomenclature WALDEC (resource `2b618348-...`, 297 codes, 2 pages) via `/api/nomen/` → facette catégorie.
- **Entreprises** : API Recherche d'entreprises (DINUM) via `/api/entreprises/` (`q`, `departement`, `est_association=false`, `per_page` max 25, total_pages plafonné à 4). Recherche texte obligatoire ici — pour une recherche par critères sans mot-clé, voir le **Composeur d'entreprises** (corp.js).
- **Recherche multi-opérateurs** (`parseAnnQuery`) : mots simples = ET · `+mot` = OU (dès qu'il y a un `+`, req+or forment un OU : `a + b` = a OU b) · `-mot` = exclusion · `"mot"` = mot exact (frontières de mot, regex `(^|[^a-z0-9])mot($|[^a-z0-9])`) · espaces autour des `+`/`-` tolérés (token orphelin → `pendingSign`). Interprétation en direct sous le champ (`annQueryExplain`, `#annQueryExp`).
- **Marqueurs par différence** (`annSyncMarkers` + `ANN.markerIndex`) : à chaque frappe, seuls les nouveaux marqueurs sont créés, les disparus retirés — jamais de recréation complète (anti-scintillement). Clés : `a:<id RNA>` / `e:<siren>`.
- Variables globales d'app.js utilisées : `state`, `map`, `geoLayer`, `refresh`, `openDepartment`, `setStatus`, `showError`, `hideError`, `fetchJSONCached`, `fetchCache`, `DEP_FOLDERS`, `catColor`, `ELECAGR`.
- `annEnter`/`annLeave` : **conservent le département courant** (pas de retour forcé à la France).
- Le SW_API_LABELS de la page cache mentionne `/api/ent` (composeur d'entreprises) et le compteur RAM inclut les résultats du composeur.

### score31.js — mode « Composeur de critères » (branche de test `score31`)
- **Généralisation de l'ancien « Score perso (31) »** : indice composite **personnalisable** des communes de **n'importe quel département**, **hors REGISTRY** (`scoreEnter`/`scoreLeave` appelés depuis le listener `#categorySelect` de app.js via `typeof` guards).
- **Département** au choix (select) + **ville cible** avec autocomplete sur les communes du département (recherche insensible aux accents via `normTxt`, dropdown custom `#scTargetDrop`, Entrée = 1er résultat).
- **Critères ajoutables/retirables à volonté** (bouton ＋ / ✕), chacun avec : **sens** (⬆ plus = mieux / ⬇ moins = mieux) et **poids 0–10**. Types : 📍 distance à la ville cible · 🛡 délinquance (indicateur au choix, dernière année) · 💰 loyers (Carte des loyers 2025) · 💶 niveau de vie médian (Filosofi) · 🏠 prix m² DVF (appartements/maisons) · 🥋 associations RNA (requête multi-opérateurs) · 🗳 politique par commune (indicateurs numériques du REGISTRY : abstentions, voix candidat/nuance/liste).
- Normalisation P5–P95 avec saturation par critère (`scBounds`) ; score = Σ poids×part / Σ poids ; **donnée absente → part neutre 0,5** ; critère non chargé → neutre également.
- **Temps réel** : `scDraw` recalcule puis `setStyle` en place (jamais de recréation de couche) ; les chargements de données sont paresseux, par critère, avec dédoublonnage (`SC.valCache[key].promise`).
- Couleurs : `colorFor(1 − score)` (vert = bon score) ; **meilleure commune en bleu** (#2563eb, bordure blanche, 🏆 infobulle/légende/top 10) ; infobulle détaillée = valeur de chaque critère.
- Au premier passage, critères par défaut = reproduction de l'ancien score perso (distance Toulouse, délinquance ensemble, loyers, assos « "mma" + "systema" + ninjutsu » ; poids 5/5/5/3).
- Mode isolé : retire `geoLayer`, couche propre `SC.layer`, ne remplace pas `refresh`, réutilise les caches existants (IndexedDB assos, `state.communesGeo`/`communesCache`, SW `/data/` et `/api/`).

### corp.js — mode « Composeur d'entreprises » (branche de test `corp_search`)
- **Recherche multicritère d'entreprises** via l'API Recherche d'entreprises (DINUM) `/api/ent/` (proxy vers `recherche-entreprises.api.gouv.fr`), auto-câblé comme annuaire.js (listener propre sur `#categorySelect` → `coEnter`/`coLeave`, **aucune modification d'app.js**).
- **3 modes de ciblage** automatiques :
  - `near` : ville cible + rayon > 0 km → `/near_point` (lat/long du centroïde de la commune, rayon max 50 km) ; cercle dessiné sur la carte ;
  - `commune` : ville cible + rayon 0 → `/search?code_commune=` (toutes les entreprises domiciliées dans la commune) ;
  - `dep` : sans ville → `/search?departement=` (tout le département).
- **Critères serveur** (`/search`) : `activite_principale` (codes NAF **exacts** séparés par virgules, pas de joker) ou `section_activite_principale`, `tranche_effectif_salarie` (liste de tranches, min/max traduits en ensemble), `categorie_entreprise` (PME/ETI/GE, valeur unique), `nature_juridique` (**valeur unique** seulement), `ca_min`/`ca_max`, `resultat_net_min`/`max`, `est_ess`, `est_bio`, `est_qualiopi`, `est_rge`, `est_spectacle`, `est_mission`, `est_siae`, `est_organisme_formation`, `etat_administratif`, `q` (texte optionnel — **`/search` fonctionne sans `q` dès qu'un filtre est présent**).
- **Contraintes API vérifiées empiriquement** : `per_page` max **25** (100 → 0 résultat silencieux) ; `total_results` plafonné à 10 000 ; pagination > 4 pages fonctionne ; `minimal=true` réduit la charge. Sur **`/near_point`**, `q` est **interdit** (« terms not allowed ») et **seuls les filtres d'activité passent côté serveur** — tranche/catégorie/CA/labels/état sont **ignorés silencieusement** : en mode `near`, ces critères sont donc **filtrés localement** sur les pages chargées (q et CA désactivés dans l'UI pour ce mode, indice de mode affiché `#coModeHint`).
- **Pagination** : 25 résultats/page, lots de 4 pages (« Charger plus », max 20 pages = 500 résultats) ; liste plafonnée à 300, marqueurs à 600. Le cache disque SW couvre automatiquement `/api/ent/` (TTL `/api/` 7 j) — pas d'IndexedDB dédié.
- **Ville cible** : autocomplete sur les centroïdes GeoJSON des communes (`annCentroids` d'annuaire.js), dropdown custom, Entrée = 1er résultat ; rayon 0–50 km.
- **Carte** : cercle du rayon (mode near), marqueurs par **établissement dans la zone** (`matching_etablissements`, fallback siège hors mode near), popup avec lien « Fiche détaillée » (`coOpenFiche`).
- **Fiche détaillée** (modal `#coFicheDlg`) : identité (SIREN, NAF, création, catégorie, effectifs), siège (adresse + coordonnées cliquables → zoom), état administratif + labels en chips, dirigeants, établissements dans la zone (cliquables), lien officiel `annuaire-entreprises.data.gouv.fr/entreprise/<siren>`.

### corp_ext.js — mode « Recherche étendue d'entreprises » (branche de test corp_ext)
- **Pipeline** : texte libre métier → **ROMEO v2** (prédiction des codes ROME, POST /romeo/v2/predictionMetiers) → fiche **ROME 4.0** au clic sur un métier (/rome-fiches-metiers/v1/fiches-rome/fiche-metier/<code>) → **La Bonne Boite v2** (GET /labonneboite/v2/recherche + `rome` répétés, latitude/longitude/distance) : entreprises recrutantes autour de la ville cible → croisement avec les **listes curatées Supabase** (ex. French Tech 2030, 80 lauréats, 72 SIREN résolus) → badge 🏆 + marqueurs colorés par potentiel d'embauche (rouge → vert via `colorFor`, bordure orange si curée). **Fiche détaillée complète** au clic (liste et popup) : récupérée à la volée depuis l'API Recherche d'entreprises (q=SIREN, proxy /api/ent) et rendue par coOpenFiche (modal du Composeur réutilisé — identité, siège, dirigeants, labels, établissements, lien officiel). Potentiel d'embauche LBB en étoiles (hiring_potential 0-100 → 0-5) ; filtres **« Taille » et ROME appliqués localement** (headcount_min, champ `rome` par item ; re-render sans nouvel appel API, `extClearMap()` avant reconstruction des marqueurs). **Critère « 🇫🇷 French Tech uniquement »** (case #extFTOnly) : VRAI filtre de recherche local sur le croisement SIREN avec les entreprises curatées portant 'French Tech' dans listes (449 lauréats officiels : Next40/FT120 2021→2026, Green20/Agri20/DeepNum20/Health20, FT2030 2023/2025 — voir Données & sources) — aucun nouvel appel ; le bandeau #extStatus affiche toujours le total French Tech en base (`ftCount` calculé dans `extCurated`, label `EXT_FT_LABEL`) ; si le filtre vide la zone, #extFiche explique (« X French Tech en base, 0 dans ce rayon sur ces métiers — élargissez le rayon ou décochez ») ; tri 🏆 / marqueurs / cartes inchangés. **Fiche métier ROME en modal partagé** #coFicheDlg (compétences groupées + lien source /ft/ft?op=fiche) ; badge 🔖 par entreprise vers sa fiche métier (`extOpenMetier`, `stopPropagation` sur le clic liste) ; lien « La Bonne Boite » → `labonneboite.francetravail.fr/entreprise/<siret>` (unique route fiche du site). **#extFiche = zone d'information** (synthèse succès ou motif exact d'échec) ; champ métier pré-rempli « intelligence artificielle » ; op=lbb avec rome (3 premiers) + rome_all (tous) → retentative auto si 0 résultat (champ 'retried', affiché dans le statut).
- **Fonctions Netlify** (netlify/functions/, servies sous /ft/* via redirects netlify.toml) :
  - ft.js : proxy France Travail. OAuth client_credentials (FT_CLIENT_ID/FT_CLIENT_SECRET), **cache de token par scope** (TTL expires_in−60 s, par instance chaude), **throttle par famille** (ROME 1,1 s ; LBB 550 ms ; ROMEO 350 ms — file séquentielle). Paramètre op : romeo (texte→codes ROME), lbb (entreprises recrutantes normalisées : `rome`+`score` par item, `romes` utilisés, `retried`), lbb_raw (réponse LBB brute tronquée, diagnostic), fiche (fiche métier). Erreurs applicatives en HTTP 200 {ok:false} pour les distinguer des erreurs transport.
  - curated.js : lit la table public.entreprises du projet Supabase openfrance (SUPABASE_URL, SUPABASE_ANON_KEY — API REST PostgREST, RLS policy SELECT publique car données 100 % publiques), cache 1 h par instance. Champs : nom, siren, listes, domaines, ville, site_web.
- **Dégradation gracieuse** : LBB non abonné → {ok:false, code:'lbb_unavailable'} → message + métiers ROME affichés quand même (le mode ne casse pas, s'activera seul dès provisionnement).
- **Auto-câblage** comme corp.js : listener propre sur #categorySelect (extEnter/extLeave), aucune modification d'app.js. Réutilise esc/normTxt/annCentroids (annuaire.js), coDepLabel (corp.js), colorFor (dégradé app.js pour les marqueurs), classes .co-row/.co-badge/.ann-obj/.sc-drop + .ext-* (style.css).
- **Service worker** : /ft/* hors TTL → jamais mis en cache (données dynamiques fraîches) ; pas de bump de CACHE_NAME nécessaire (le SW ne cache pas les .js).

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

### Composeur d'entreprises
- API Recherche d'entreprises (DINUM) : `https://recherche-entreprises.api.gouv.fr` via le proxy `/api/ent/*` (redirect `netlify.toml`). Deux endpoints : `/search` (filtres complets côté serveur, fonctionne sans `q`) et `/near_point` (lat/long/rayon km, seuls les filtres d'activité y passent — le reste filtré localement, voir architecture). Gratuit, sans clé ; cache disque SW `/api/` 7 j. Sources officielles : registre SIRENE + RNE (dirigeants).

### Recherche étendue (corp_ext)
- **France Travail** (francetravail.io, OAuth client_credentials via la fonction Netlify ft.js) : ROMEO v2 (texte→codes ROME), ROME 4.0 fiches métiers (compétences), La Bonne Boite v2 (entreprises recrutantes par zone — v2 : /v2/recherche + scope 'search office api_labonneboitev2', voir pièges n°14-15).
- **Listes curatées** : table public.entreprises du projet Supabase openfrance (SUPABASE_URL, SUPABASE_ANON_KEY — API REST via la fonction curated.js ; RLS : lecture anonyme, données 100 % publiques ; ex. French Tech 2030 promotion 2025, source lafrenchtech.gouv.fr ; 72 SIREN résolus migrés depuis Airtable le 10/10/2026). Seuls les signaux certains y sont stockés ; jamais les résultats de recherche.
- **Lauréats French Tech (~450 entreprises, seul signal « French Tech » en base)** : programmes officiels — Next40/FT120 2021→2026, Green20/Agri20/DeepNum20 (2022), Health20 (2023), FT2030 (2023/2025). Collecte : annuaire Numeum (sitemap ~520 fiches, tags programme + année, `tools/collect-numeum.mjs`) + listes officielles (promo 2026, communiqués Green/Agri/DeepNum) → 522 noms uniques → résolution SIREN via l'API Recherche d'entreprises (`tools/resolve-sirens.mjs` : score exact/préfixe/inclusion, 466 résolus → 441 SIREN après fusion, base 72 → 449 lignes, listes = union + 'French Tech' + labels programme/année, source='laureats-frenchtech-officiels'). Le « fichier FrenchTech 5K » Salesdorado s'est révélé un aimant à emails (lien 404) : écarté, script supprimé. Il n'existe pas de fichier ouvert unique à 5 000 : le label officiel ne couvre que ~120 lauréats/an + promos thématiques (voir piège n°22).

## 🐛 Bugs résolus / pièges connus (NE PAS RÉGRESSER)

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
13. **Pièges API Recherche d'entreprises** (vérifiés empiriquement) : `per_page` max 25 (100 → 0 résultat silencieux) ; `activite_principale` n'accepte **pas** de jokers (`62*` invalide) ; `nature_juridique` = valeur unique ; sur `/near_point` : `q` interdit + filtres non-activité ignorés silencieusement → d'où le filtrage local de corp.js en mode near.
14. **Pièges France Travail** (vérifiés empiriquement le 10/10/2026 via tools/verify-ft.mjs + diagnostic dédié) : fiches ROME → chemin /rome-fiches-metiers/v1/fiches-rome/fiche-metier/<code> (segment /fiches-rome/ obligatoire, sinon 404 ; scope sans nomenclatureRome → 403) ; base sans numéro de version → 401 « TypeAuth invalide » + header errorcause: type_auth_invalide ; scope non souscrit → 400 invalid_scope (signature d'un abonnement absent — idem tous les scopes api_test* : le bac à sable n'est PAS souscrit sur cette app) ; LBB → 403 insufficient_scope si le scope du token est incomplet (v2 exige 'search office api_labonneboitev2') ou si l'abonnement n'est pas provisionné (action portail francetravail.io) ; 429 après ~7 appels référentiels ROME à ~1/s → throttle 1,1 s dans ft.js.
15. **LBB v2 ≠ v1** (vérifié le 10/10/2026, implémentation de référence testée en prod : projet open source cle-avenir, oct. 2026) : endpoint GET /partenaire/labonneboite/v2/recherche (PAS /company/) ; le scope api_labonneboitev2 SEUL ne suffit pas → 403 insufficient_scope, il faut 'search office api_labonneboitev2' ; les codes ROME passent en paramètres répétés (rome=A&rome=B, pas de rome_codes) ; latitude/longitude/distance (API : ]0;200[ km — le proxy borne à 100 km), page/page_size (max 100) ; réponse {hits, items:[{siret, office_name, company_name, naf, naf_label, location{lat,lon}, city, postcode, headcount_min/max, hiring_potential 0-100, rome}]}, 204 = aucun résultat ; plus de filtre contract (dpae/alternance) en v2. SIREN = 9 premiers chiffres du siret (croisement Supabase).
16. **Fonctions Netlify** : secrets uniquement en variables d'environnement (FT_CLIENT_ID, FT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY) — jamais dans le repo ; les erreurs applicatives arrivent en HTTP 200 {ok:false} pour rester distinguables des erreurs transport (502/500).
17. **Regex fiches ROME trop stricte** (`^[A-K]\d{4}$` dans ft.js) : ROMEO prédit des codes ROME 4.0 en M/N/… (« intelligence artificielle » → M1889…) → 6 fiches sur 8 rejetées côté proxy avant même l'appel FT. Passée à `^[A-Z]\d{4}$` (vérifié : M1889/M1805 renvoient leurs fiches ; code inexistant → 404 explicite affiché tel quel).
18. **LBB : 0 résultat avec les 3 premiers codes ROME** (codes très spécialisés type M1889 souvent sans hit alors que les voisins M1805/M1841 en ont des dizaines — vérifié : 0 vs 88 autour de Plaisance-du-Touch) → le front envoie `rome` (3 premiers) + `rome_all` (tous) et le proxy retente AUTOMATIQUEMENT une fois avec tous les codes (`retried:true`, `romes` utilisés). Forme réelle LBB confirmée : `{hits, items:[{siret, office_name/company_name, naf, naf_label, location:{lat,lon}, city, postcode, headcount_min/max, hiring_potential}]}`.
19. **Recherche étendue : score, ROME par entreprise, couleurs** (10/10/2026) : chaque item LBB porte le `rome` ayant matché → le proxy le normalise (`rome` + `score` 0-1 depuis hiring_potential) ; front : marqueurs colorés par score via `colorFor(1-score)` de app.js (rouge → vert, bordure orange si curée), badge 🔖 cliquable (liste + popup) vers la fiche métier (`extOpenMetier`), sous-filtre local par codes ROME (cases Tout/Rien, tout coché par défaut, re-render sans nouvel appel, chaque case affiche son nombre de résultats et les codes à 0 sont décochés/grisés d'office).
20. **Recherche étendue : 3 bugs** (10/10/2026) : re-render local (filtres Taille/ROME) ne retirait pas l'ancien groupe de marqueurs → `extClearMap()` en début de `extRenderResults` ; clic badge 🔖 remontait jusqu'à la ligne (fiche entreprise par-dessus la fiche métier) → `event.stopPropagation()` ; liens « La Bonne Boite » en 404 (`/entreprises/siret/…` inexistant — vérifié dans le bundle JS du site : l'unique route fiche est `entreprise/:siret`) → `https://labonneboite.francetravail.fr/entreprise/<siret>`.
21. **Migration Airtable → Supabase** (10/10/2026) : les listes curatées vivent désormais dans la table Supabase public.entreprises (72 lignes, siren NOT NULL UNIQUE — les 8 lauréats sans SIREN résolu restent exclus du croisement, comme avant). La fonction curated.js interroge l'API REST (PostgREST) avec la seule clé anonyme (publishable) ; RLS activé + policy SELECT FOR ALL to public obligatoire (sans policy, l'anonyme reçoit une erreur 42501 au lieu de la table). Contrat de sortie inchangé ({ok, records:[{nom, siren, listes, domaines, ville, site_web}]}), cache 1 h, erreurs applicatives en HTTP 200 {ok:false}.
22. **Résolution noms → SIREN + upsert Supabase** (tools/resolve-sirens.mjs, 10/2026 — 522 noms → 466 résolus → 441 SIREN, base 72 → 449) :
    - Marque ≠ raison sociale (BlaBlaCar → COMUTO, Back Market → JUNG SAS 804049476, Brevo → SENDINBLUE, ManoMano → COLIBRI, FreelanceRepublik → ODHCOM, Mooncard → MOONGROUP, HelloCSE → SYLARELE) : accepter le résultat unique de l'API (confiance 'unique', à contrôler) + fichier d'overrides vérifiés (`/tmp/opencode/overrides.json`, mentions légales/Pappers comme preuves).
    - Faux positifs systématiques à écarter : filiales étrangères (BACK MARKET GERMANY GMBH → pénalité siège étranger), holdings/véhicules (WARREN AMI LABS, HOLDING OKAMAC, 1001PACT, PAPERNEST GLOBAL), fonds de dotation (CONTENTSQUARE FOUNDATION), homonymes (MANO quincaillerie, FOODLE conseil, SCI LABELLEVIE, LES/COOL/SWAP/INFINITE génériques), EI radiées ; jamais d'entité fermée (état F/C) ; ~40 SIREN en liste d'exclusion + 23 overrides dans le script ; le résidu douteux reste HORS base (pas de badge plutôt qu'un faux).
    - PostgREST : lots homogènes obligatoires (PGRST102 — grouper par signature de clés) ; `merge-duplicates` fait ON CONFLICT DO UPDATE sur TOUTES les colonnes (une colonne absente du payload est écrasée à NULL → envoyer des lignes complètes : nom/domaine/ville/site préservés de l'existant, null seulement si vide des deux côtés) ; doublons intra-lot interdits (21000 — fusionner par SIREN avant, ex. Brevo/Sendinblue) ; clé ANON en lecture seule (42501 en écriture → `SUPABASE_SERVICE_KEY` en .env local uniquement pour --apply, jamais sur Netlify).

## 🚀 Deploys & workflow

- **`main`** = production Netlify. **CHAQUE push sur `main` déclenche un deploy** (plan gratuit Netlify : ~20 deploys/mois en crédits → les économiser !)
- **Workflow** : travailler sur une branche dédiée (`work`), tester en local avec `netlify dev`, merger vers `main` seulement quand stable = 1 seul deploy
- Branche de test **`score31`** (fork de `work`) : fonctionnalité « Composeur de critères » (généralisation du score perso). Tester en local (`netlify dev`, les proxys `/api/loyers/` y sont actifs), merger vers `work`/`main` ou abandonner librement.
- Branche de test **`corp_search`** (fork de `work`) : fonctionnalité « Composeur d'entreprises » (corp.js). Tester en local (`netlify dev`, le proxy `/api/ent/` y est actif), merger vers `work`/`main` ou abandonner librement.
- Branche de test **corp_ext** (fork de work) : fonctionnalité « Recherche étendue d'entreprises » (corp_ext.js + netlify/functions/). Variables d'env Netlify requises (mêmes contextes que FT_CLIENT_ID existant) : FT_CLIENT_ID, FT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY. Test local : clés dans .env puis netlify dev (fonctions + redirects /ft/* actifs).
- Migration Vercel envisagée (100 deploys/jour) : traduire `netlify.toml` → `vercel.json` (rewrites), rien d'autre à changer
- Contours communes : dossier par dept (`DEP_FOLDERS` map complète code→dossier dans `app.js`)

## 💡 Idées backlog (non réalisées)

- Graphique d'évolution par année au clic sur une zone
- Classement complet des 101 départements (pas seulement top 10)
- Cache partagé côté serveur (Netlify Blobs, ~1 Go gratuit)
- Sélecteur de département déroulant dans l'annuaire (au lieu du clic carte)
- Autres jeux de données data.gouv
- **Enrichissement contact entreprises** : récupérer/compléter site web + email (recherche web type Tavily) sur la fiche détaillée du composeur d'entreprises — l'utilisateur a une clé API, fonctionnalité volontairement différée
