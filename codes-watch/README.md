# Codes Watch (étapes 1 à 3 : moteur + tableau de bord)

Surveille des sources publiques, détecte les nouveaux codes cadeaux, les enregistre (anti-doublons, historique,
statuts honnêtes) dans `site/data/*.json` et notifie (Discord / Telegram / ntfy). 100 % gratuit : tourne sur GitHub Actions.

- `config/games.json` : jeux et sources (types : `html`, `rss`, `youtube`, `reddit`).
- `config/settings.json` : fréquence, seuils, notifications.
- `npm test` : 19 tests (extraction, statuts, pannes de sources, persistance).
- `node src/run.js` : un passage de surveillance (`FORCE=1` pour ignorer les fréquences, `DRY_RUN=1` pour ne rien écrire).

- `site/` : tableau de bord statique (GitHub Pages), il relit `site/data/*.json` toutes les 45 s tout seul.

Le guide d'installation pas à pas arrive à l'étape finale.
