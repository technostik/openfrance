# OpenFrance 🇫🇷

Application web de visualisation des données ouvertes françaises (data.gouv.fr).

## Visualisation actuelle

**Carte de la délinquance par département** (choroplèthe vert → rouge) :
- Données : [Bases statistiques départementales de la délinquance](https://www.data.gouv.fr/fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/) — Ministère de l'Intérieur (police + gendarmerie nationales)
- Indicateurs sélectionnables (homicides, vols, cambriolages, stupéfiants…), toutes les années disponibles (2016 → 2025)
- Taux pour 1 000 habitants, dégradé vert (faible) → rouge (élevé)
- Top 10 des départements, infobulles détaillées au survol

## Stack

Site statique sans build : HTML + CSS + JS, [Leaflet](https://leafletjs.com) + fond de carte CARTO. Les données sont chargées directement dans le navigateur depuis data.gouv.fr (aucun serveur requis).

## Déploiement

Le dépôt est connecté à Netlify : chaque push sur `main` déploie automatiquement le site.
