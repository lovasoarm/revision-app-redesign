# my-revision-app

Application légère de **révision espacée**, offline-first, en HTML/CSS/JS vanilla, avec une couche **Tauri 2** prête pour Windows.

Le produit reste volontairement simple : pas de framework frontend, pas de serveur, pas de compte, pas de synchronisation cloud et aucune dépendance réseau nécessaire pour travailler.

## Principes

- Révisions espacées : J+1 / J+7 / J+21 / J+60.
- Reprise J+3 lorsqu'une révision est évaluée « Non ».
- Maîtrise continue de 0 à 100 %, indépendante du simple statut.
- Arbre récursif de profondeur illimitée : catégorie → module → sous-module → leçon.
- Une catégorie est un univers d'apprentissage distinct.
- Les détails riches restent repliés pour éviter une interface empilée lorsque le curriculum devient massif.
- L'application privilégie la lisibilité et la vitesse d'action plutôt que la multiplication de fonctionnalités.

## Modèle de données

```text
node = {
  id,
  parentId,          // null uniquement pour une catégorie
  isCategory,
  name,
  description,
  keyTakeaway,
  start,
  duration,
  createdAt,
  status,            // learned | review | unset
  mastery,           // 0..100 pour les modules
  reviews,
  childrenIds
}
```

Les catégories n'ont pas de maîtrise éditable : leur maîtrise est calculée à partir des **feuilles réelles** de leur sous-arbre. Une grosse branche pèse donc proportionnellement à son nombre de leçons, au lieu de donner artificiellement le même poids à chaque conteneur intermédiaire.

## Architecture

```text
my-revision-app/
├── src/
│   ├── index.html
│   ├── styles.css
│   ├── script.js
│   ├── service-worker.js
│   ├── register-service-worker.js
│   ├── core/
│   │   ├── storage.js
│   │   └── validation.js
│   ├── ui/
│   │   └── modal.js
│   └── manifest.webmanifest
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── src/main.rs
│   ├── capabilities/default.json
│   └── icons/
├── scripts/
│   └── smoke-test.mjs
├── package.json
└── README.md
```

Le découpage sépare notamment la persistance, la validation d'import et le dialogue accessible du cœur de l'application. `script.js` reste le point d'orchestration principal, sans transformer le projet en architecture de framework.

## Stockage offline

La hiérarchie de priorité est :

```text
Tauri desktop
    ↓
tauri-plugin-store → revision-data.json dans le dossier de données de l'application

Navigateur
    ↓
IndexedDB
    ↓
localStorage uniquement comme secours/migration
```

Tous les accès au stockage sont centralisés dans `src/core/storage.js`.

Les écritures sont sérialisées afin que plusieurs actions très rapides ne s'écrasent pas mutuellement. Les anciennes données `localStorage` sont migrées automatiquement vers IndexedDB lors du premier accès.

## Import robuste

L'import est bloqué avant tout remplacement si l'une des conditions suivantes échoue :

- JSON invalide ;
- IDs dupliqués ;
- nom de nœud invalide ;
- parent introuvable ;
- catégorie placée sous un parent ;
- maîtrise hors de 0–100 ;
- cycle dans la hiérarchie.

Les anciennes données plates sont migrées vers le modèle récursif. Les historiques qui pointent vers des nœuds disparus sont également nettoyés afin d'éviter les événements fantômes dans les statistiques et l'onglet Historique.

## Interface et gros curriculums

L'interface est conçue pour rester lisible quand le nombre de modules augmente :

- cartes condensées par défaut ;
- détail riche sur demande ;
- densité adaptative à partir de 60 puis 120 nœuds ;
- colonnes pour les premiers niveaux lorsque l'espace le permet ;
- recherche qui conserve le chemin hiérarchique lorsqu'un descendant correspond ;
- index de recherche calculé une fois par requête au lieu de parcourir les descendants de chaque carte ;
- rendu progressif des gros arbres avec chargement automatique à l'approche du bas de la liste, afin d'éviter un DOM massif en une seule passe.

Cela ne transforme pas l'application en moteur de virtualisation complexe : elle utilise une stratégie progressive volontairement simple, adaptée à une application locale de révision tout en gardant le code léger.

## Onglets

### Dashboard

Arbre principal, création de catégories et modules, recherche, filtre par statut, progression et alertes de retard.

### Aujourd'hui

Révisions dues et en retard, évaluation de récupération, note libre et reprise J+3 en cas d'échec.

### Historique

Journal événementiel groupé par période, avec distinction entre révision et modification de maîtrise.

### Statistiques

Progression globale, zones critiques, rétention et comparaison des domaines/catégories.

### Réglages

Export/import, reset complet et génération idempotente de la structure Architecte Fantôme.

## Historique et suppression

La suppression d'un module supprime tout son sous-arbre. Elle supprime également tous les événements d'historique dont `nodeId` appartient au sous-arbre supprimé.

Un import, une migration ou un chargement ancien nettoie de la même façon les historiques qui ne correspondent plus à un nœud existant.

## Structure Architecte Fantôme

Le seed crée ou réutilise la catégorie `Informatique` et ajoute seulement les éléments absents de cette structure :

```text
Informatique
├── 00-SOCLE
├── 01-CADRAGE
├── 02-CONSTRUCTION
├── 03-PILOTAGE
├── 04-EPREUVE
└── 05-MAITRISE
```

Le seed est idempotent : le relancer ne crée pas de doublons et ne remplace pas les données déjà personnalisées.

## Accessibilité

La modale de confirmation utilise un vrai rôle dialog, `aria-modal`, des relations ARIA, un retour du focus vers l'élément déclencheur, un piège de focus et la fermeture par `Escape`.

Les scripts sont séparés des éléments HTML inline afin de permettre une CSP Tauri plus restrictive.

## Tauri 2

La couche Tauri est incluse directement dans le projet. Le plugin Store est enregistré côté Rust et autorisé dans `src-tauri/capabilities/default.json`. Les plugins Dialog et FS sont également intégrés pour fournir l'export JSON avec un emplacement natif sous Tauri. Avec `withGlobalTauri`, l'API Store est accessible depuis `window.__TAURI__.store`.

La CSP est explicitement définie dans `tauri.conf.json` au lieu de rester à `null`. Tauri recommande de la rendre aussi restrictive que possible et documente notamment `ipc:` / `http://ipc.localhost` pour les communications internes.

Les capabilities sont définies dans `src-tauri/capabilities/`; Tauri utilise ces fichiers pour autoriser les permissions des plugins. Les permissions `store:default`, `dialog:default` et `fs:default` sont incluses.

### Build Windows

Pré-requis : Node.js, Rust/Cargo, Microsoft C++ Build Tools et WebView2.

```bash
npm install
npm test
npm run tauri:build
```

Les bundles Windows sont ensuite produits dans `src-tauri/target/release/bundle/`, notamment NSIS (`.exe`) et MSI selon la configuration.

## Navigateur

Le front-end peut aussi être exécuté comme application web statique. Le Service Worker met en cache le shell local et utilise une stratégie cache-first pour privilégier l'expérience offline. Les données applicatives restent stockées localement.

Le service worker n'est pas nécessaire au fonctionnement du `.exe` Tauri.

## Vérification locale

```bash
npm test
```

Le test vérifie notamment :

- syntaxe des modules JavaScript ;
- JSON de manifest, Tauri et capabilities ;
- détection de cycles et de parents inexistants dans les imports ;
- présence et enregistrement du plugin Tauri Store ;
- CSP restrictive ;
- absence de script inline résiduel ;
- présence du script principal en module.

## Contraintes volontairement conservées

Pas de framework UI. Pas de backend. Pas de cloud. Pas de tracking. Pas de fonctionnalités sociales. Pas de dépendance CDN. L'objectif est une application de travail personnelle qui reste rapide, portable et compréhensible même après plusieurs années d'utilisation.
