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

## Stack

Site statique sans build : HTML + CSS + JS, [Leaflet](https://leafletjs.com) + fond de carte OSM/CARTO. Les données sont chargées directement dans le navigateur depuis data.gouv.fr (proxy Netlify, aucun serveur requis). Service worker pour le cache disque persistant (stale-while-revalidate).

## Développement local

`netlify dev` sert le site avec les redirections `/api/*` actives (nécessaire pour l'annuaire : associations, nomenclature, entreprises).

## Déploiement

Le dépôt est connecté à Netlify : chaque push sur `main` déploie automatiquement le site.
