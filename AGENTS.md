# AGENTS.md — Guide pour les agents LLM sur ce repo

Ce fichier explique **où trouver l'information** dans ce repo et **comment maintenir la documentation à jour**. Il ne documente pas le projet lui-même.

## 📍 Où trouver quoi

| Besoin | Où regarder |
|---|---|
| **État du projet, architecture, sources de données, bugs résolus, backlog** | [`docs/ETAT-PROJET.md`](docs/ETAT-PROJET.md) — **TOUJOURS lire ce fichier EN PREMIER** avant toute intervention |
| URLs exactes des proxys/sources (data.gouv etc.) | `netlify.toml` (la seule source de vérité des URLs) |
| Logique applicative (indicateurs, parsers, caches, rendu) | `app.js` — organisé en sections commentées : utilitaires → délinquance → économie → politique → registre → rendu → UI |
| Cache disque persistant | `sw.js` (Service Worker, stratégie + TTL par prefix d'URL) |
| Structure UI | `index.html`, `style.css` |
| Historique des changements | `git log` (messages de commit détaillés en français) |

## 🔧 Règles d'intervention

1. **Lire `docs/ETAT-PROJET.md` avant de coder.** Il résume tout ce qu'un précédent agent a appris (bugs résolus, formats de données, pièges de l'API tabulaire). Ne pas le lire = répéter des erreurs déjà corrigées.
2. **Jamais de push direct sur `main`** : chaque push déclenche un deploy Netlify (quota limité ~20/mois). Travailler sur une branche dédiée, l'utilisateur teste en local (`netlify dev`) et merge lui-même.
3. **Pas de clé API, pas de service payant, pas de copie de données dans le repo** : tout passe par les proxys `netlify.toml` vers les sources originales (elles restent ainsi à jour automatiquement).
4. **Tester la syntaxe JS avant tout push** (les erreurs ne sont visibles qu'en production).

## 📝 Maintenance de la documentation (OBLIGATOIRE)

**À CHAQUE nouvelle fonctionnalité, correction de bug ou changement d'architecture**, le même commit (ou le commit qui suit immédiatement) doit mettre à jour [`docs/ETAT-PROJET.md`](docs/ETAT-PROJET.md) :

- **Nouvelle source de donnée** → section « Données & sources » (ET ajouter le proxy dans `netlify.toml`)
- **Nouvel indiceur/catégorie** → section architecture + sources
- **Bug corrigé** → l'ajouter à « Bugs résolus » (une ligne : symptôme → solution) pour éviter toute régression
- **Changement de workflow/deploy** → section « Deploys & workflow »
- **Fonctionnalité livrée issue du backlog** → la retirer du backlog

Si l'information existe déjà ailleurs dans le repo (URLs dans `netlify.toml`, code dans `app.js`), la doc **pointe vers** cette source plutôt que de la dupliquer — une info dupliquée finit désynchronisée.

## ⚠️ Pièges connus (détails dans ETAT-PROJET.md)

- API tabulaire : `page_size` max 200, **ne pas suivre `links.next`** (hors proxy → 404)
- Les fichiers statiques data.gouv ne sont PAS lisibles par certains outils d'agents → utiliser l'API tabulaire (`tabular-api.data.gouv.fr/api/resources/<id>/data/`) pour explorer les colonnes
- GeoJSON communes : `raw.githubusercontent.com`, pas le site github.io (mort)
