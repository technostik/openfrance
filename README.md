# OpenFrance 🇫🇷

Application web de visualisation des données ouvertes françaises (data.gouv.fr).

## Visualisations

**Carte de la délinquance par département** (choroplèthe vert → rouge) :
- Données : [Bases statistiques départementales de la délinquance](https://www.data.gouv.fr/fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/) — Ministère de l'Intérieur (police + gendarmerie nationales)
- Indicateurs sélectionnables (homicides, vols, cambriolages, stupéfiants…), toutes les années disponibles (2016 → 2025)
- Taux pour 1 000 habitants, dégradé vert (faible) → rouge (élevé)
- Top 10 des départements, infobulles détaillées au survol

**Annuaire des associations & entreprises** (catégorie « Associations & entreprises ») :
- Associations : [RNA agrégé national (Waldec)](https://www.data.gouv.fr/fr/datasets/rna-agrege-a-lechelle-nationale/) via l'API tabulaire data.gouv — associations actives (`date_disso` vide) du département sélectionné, chargées par lots et mises en cache (IndexedDB + service worker), thème WALDEC (nomenclature [Orléans Métropole](https://www.data.gouv.fr/fr/datasets/repertoire-national-des-associations-nomenclature-waldec/)) comme facette.
- Entreprises : [API Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr/) (DINUM) — recherche texte par département, filtre par section d'activité (NAF).
- Recherche multi-mots-clés locale : `ninjutsu + mma - boxe` → contient « ninjutsu » OU « mma » mais pas « boxe » ; mots simples = tous requis (ET), `+mot` = OU, `-mot` = exclusion, `"expression entre guillemets"` supportée.
- Marqueurs sur la carte (centroïde de la commune pour les assos, coordonnées du siège pour les entreprises) + liste de résultats cliquables.

**Composeur d'entreprises** (catégorie « Composeur d'entreprises ») :
- [API Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr/) (DINUM) en mode **recherche multicritère** : activité (code NAF exact ou section), tranche d'effectifs (min/max), catégorie (PME/ETI/GE), nature juridique, chiffre d'affaires (min/max), labels (ESS, Qualiopi, RGE, bio, spectacle, organisme de formation…), état administratif, recherche texte optionnelle.
- **Ciblage géographique** : rayon configurable autour d'une ville (recherche géographique avec cercle sur la carte) ou, à rayon nul, toutes les entreprises de la commune ; sans ville, tout un département.
- Cercle de rayon sur la carte, marqueurs par établissement dans la zone, pagination par lots (« Charger plus »).
- **Fiche détaillée** au clic sur une entreprise : identité, siège, dirigeants, état/labels, établissements présents dans la zone (cliquables → zoom carte), lien vers la fiche officielle [annuaire-entreprises.data.gouv.fr](https://annuaire-entreprises.data.gouv.fr).

**Recherche étendue d'entreprises** (catégorie « Recherche étendue d'entreprises ») :
- Décrivez un métier en texte libre : [ROMEO](https://francetravail.io) (France Travail) prédit les codes ROME correspondants ; un clic sur un métier affiche sa fiche ROME 4.0 (compétences mobilisées).
- [La Bonne Boite](https://labonneboite.francetravail.io) (France Travail) liste les entreprises qui recrutent sur ces métiers autour d'une ville cible et d'un rayon.
- Les résultats sont croisés avec des listes curatées (table Supabase public.entreprises — ex. lauréats [French Tech 2030](https://lafrenchtech.gouv.fr/fr/programme/french-tech-2030/)) : badge 🏆 sur les entreprises des listes, marqueurs verts/orange sur la carte. Potentiel d'embauche en étoiles (hiring_potential), filtre Taille (salariés min.), et **fiche détaillée complète** au clic (identité, siège, dirigeants, labels, établissements — base Sirene, API Recherche d'entreprises).
- Critère « 🇫🇷 French Tech uniquement » (case à cocher) : vrai filtre de recherche local sur le croisement SIREN avec les lauréats French Tech (programmes officiels : Next40/FT120 2021→2026, Green20/Agri20/DeepNum20/Health20, FT2030 2023/2025 — collectés depuis l'annuaire Numeum et les pages lafrenchtech.gouv.fr, SIREN résolus via l'API Recherche d'entreprises : `node tools/collect-numeum.mjs` puis `node tools/resolve-sirens.mjs --apply`, voir doc). Le bandeau d'état affiche le total French Tech en base ; si le filtre vide la zone, un message explicite propose d'élargir le rayon ou de décocher (jamais de liste vide muette).
- Mode annuaire : champ métier VIDE + case cochée + « Rechercher » → affiche les French Tech elles-mêmes (sans ROMEO/La Bonne Boite) : avec une ville → celles du rayon (tri par distance, marqueurs) ; champ ville effacé → toute la base (tri par nom). Les fiches n'ont qu'une ville en texte : géocodage communal via la Base Adresse Nationale (proxy `/api/adr/`, gratuit sans clé) — positions approximatives, fiche Sirene détaillée au clic.
- Ces APIs passent par des fonctions Netlify (netlify/functions/, servies sous /ft/*) : OAuth client_credentials France Travail côté serveur, secrets en variables d'environnement Netlify. Tant que l'abonnement La Bonne Boite n'est pas provisionné, le mode dégrade proprement (métiers ROME affichés, message explicite).

## Stack

Site statique sans build : HTML + CSS + JS, [Leaflet](https://leafletjs.com) + fond de carte OSM/CARTO. Les données sont chargées directement dans le navigateur depuis data.gouv.fr (proxy Netlify, aucun serveur requis). Service worker pour le cache disque persistant (stale-while-revalidate). Deux fonctions Netlify (netlify/functions/ft.js, netlify/functions/curated.js) proxifient les APIs France Travail et Supabase (listes curatées) pour la recherche étendue (secrets en variables d'environnement, jamais dans le repo).

## Développement local

`netlify dev` sert le site avec les redirections `/api/*` actives (nécessaire pour l'annuaire : associations, nomenclature, entreprises — et pour le composeur d'entreprises : `/api/ent`).

Pour la recherche étendue, les fonctions Netlify et les redirections /ft/* sont actives avec « netlify dev » ; les secrets vont dans .env local (gitignoré) : FT_CLIENT_ID, FT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY — et dans l'interface Netlify pour la production.

Import French Tech (listes curatées) : les lauréats viennent des sources officielles uniquement (annuaire Numeum + pages lafrenchtech.gouv.fr — le « fichier » Salesdorado s'est révélé être un aimant à emails avec lien 404, écarté). Collecte : `node tools/collect-numeum.mjs` (~520 fiches, tags programme + année, sortie locale), fusion avec les listes officielles (promo 2026, Green20/Agri20/DeepNum20), puis résolution SIREN + upsert : `node tools/resolve-sirens.mjs` (dry-run) puis `--apply` (écriture avec la clé service_role `SUPABASE_SERVICE_KEY` en .env local — la clé ANON est en lecture seule). Base actuelle : 449 entreprises (72 FT2030 + ~380 Next40/FT120/thématiques 2021→2026).

## Déploiement

Le dépôt est connecté à Netlify : chaque push sur `main` déploie automatiquement le site.
