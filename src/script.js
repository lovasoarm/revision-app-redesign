// Onboarding show-once logic : utilise le même backdrop/modal que le reste de l'app.
(function () {
  try {
    var key = "onboarding:v11";
    var modal = document.getElementById("onboarding");
    var done = document.getElementById("onboarding-done");
    var dont = document.getElementById("onboarding-dontshow");
    if (!modal) return;
    function closeOnboarding(hideForever) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      if (hideForever) localStorage.setItem(key, "1");
    }
    function openOnboarding() {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      if (done) done.focus();
    }
    if (!localStorage.getItem(key)) openOnboarding();
    if (done) done.addEventListener("click", function () { closeOnboarding(false); });
    if (dont) dont.addEventListener("click", function () { closeOnboarding(true); });
    modal.addEventListener("click", function (event) { if (event.target === modal) closeOnboarding(false); });
  } catch (e) { console.warn("onboarding failed", e); }
})();

import { createStorage } from "./core/storage.js";
import { validateImportPayload } from "./core/validation.js";
import { createConfirmModal } from "./ui/modal.js";

/* Révision Espacée : vanilla JS pour Tauri
   Aucune dépendance réseau, aucun accès direct à localStorage hors de `storage`.

   MODÈLE DE DONNÉES (v2 : arbre récursif)
   ----------------------------------------
   Un module est un NŒUD. Un nœud peut avoir des enfants (sous-modules), qui
   peuvent eux-mêmes avoir des enfants, sans limite de profondeur. Chaque nœud,
   qu'il ait des enfants ou non, porte son propre suivi (maîtrise, statut,
   échéances de révision) : un dossier "en cours de découpage" et une leçon
   terminale se suivent de la même façon.

   node = {
     id, parentId (null = racine), name, note,
     start, duration, createdAt,
     status: "review" | "learned" | "unset",   -- rouge / vert / neutre
     mastery: 0..100,                            -- jauge continue
     reviews: [{ id, label, offset, due, doneAt, rating }],
     childrenIds: [id, ...]                       -- ordre d'affichage
   }
*/
(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. COUCHE DE STOCKAGE
  ---------------------------------------------------------------- */
  var storage = createStorage();

  var KEYS = { nodes: "nodes", history: "history", schema: "schemaVersion", theme: "themePreference" };
  var SCHEMA_VERSION = 5; // v5 : données nettoyées + stockage/Tauri consolidés
  var OFFSETS = [1, 7, 21, 60];
  var REDO_OFFSET = 3;
  var MASTERY_STEP = 10; // pourcentage par clic sur "j'ai progressé"
  var CRITICAL_THRESHOLD = 40; // en dessous : nœud "critique"

  function toISO(d) {
    var y = d.getFullYear(),
      m = d.getMonth() + 1,
      day = d.getDate();
    return (
      y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day
    );
  }
  function fromISO(iso) {
    var p = iso.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function addDays(iso, n) {
    var d = fromISO(iso);
    d.setDate(d.getDate() + n); // gère mois/années/bissextiles
    return toISO(d);
  }
  function todayISO() {
    return toISO(new Date());
  }
  function fmt(iso) {
    var p = iso.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  function nowStamp() {
    var d = new Date();
    return (
      fmt(toISO(d)) +
      " " +
      String(d.getHours()).padStart(2, "0") +
      "h" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------------------------------------------------------
     2. ÉTAT + INDEX
  ---------------------------------------------------------------- */
  var state = { nodes: [], history: [] };
  var dueIndex = new Map(); // "YYYY-MM-DD" -> [{nodeId, revId}]
  var nodeIndex = new Map(); // id -> node
  var childrenIndex = new Map(); // parentId(ou "root") -> [childId,...]
  var masteryCache = new Map();
  var masterySumCache = new Map();
  var leafCountCache = new Map();
  var searchMatchIds = new Set();
  var searchIndexQuery = null;
  var treeRenderLimit = 260;
  var treeRenderObserver = null;
  var searchDebounceTimer = null;
  var saveChain = Promise.resolve();
  var pendingDeletion = null;
  var deleteUndoTimer = null;

  function buildIndex() {
    masteryCache.clear();
    masterySumCache.clear();
    leafCountCache.clear();
    dueIndex = new Map();
    nodeIndex = new Map();
    childrenIndex = new Map();
    for (var i = 0; i < state.nodes.length; i++) {
      nodeIndex.set(state.nodes[i].id, state.nodes[i]);
    }
    // reconstruit childrenIndex depuis parentId (source de vérité), tolère
    // des childrenIds désynchronisés (ex. après import d'un fichier externe)
    for (var j = 0; j < state.nodes.length; j++) {
      var node = state.nodes[j];
      var key = node.parentId || "root";
      var arr = childrenIndex.get(key);
      if (!arr) {
        arr = [];
        childrenIndex.set(key, arr);
      }
      arr.push(node.id);
    }
    // realigne childrenIds sur l'ordre existant si présent, sinon ordre naturel
    childrenIndex.forEach(function (ids, key) {
      var parent = key === "root" ? null : nodeIndex.get(key);
      var order =
        parent && Array.isArray(parent.childrenIds) ? parent.childrenIds : null;
      if (order) {
        var seen = {};
        var sorted = order.filter(function (id) {
          if (!nodeIndex.has(id) || seen[id]) return false;
          seen[id] = true;
          return true;
        });
        ids.forEach(function (id) {
          if (!seen[id]) {
            sorted.push(id);
            seen[id] = true;
          }
        });
        childrenIndex.set(key, sorted);
      }
      if (parent) parent.childrenIds = childrenIndex.get(key);
    });

    for (var k = 0; k < state.nodes.length; k++) {
      var nn = state.nodes[k];
      if (!Array.isArray(nn.reviews)) continue;
      for (var m = 0; m < nn.reviews.length; m++) {
        var r = nn.reviews[m];
        if (r.doneAt) continue;
        var due = dueIndex.get(r.due);
        if (!due) {
          due = [];
          dueIndex.set(r.due, due);
        }
        due.push({ nodeId: nn.id, revId: r.id });
      }
    }
  }

  function buildSearchIndex() {
    searchMatchIds = new Set();
    searchIndexQuery = treeQuery;
    if (!treeQuery) return;
    var q = treeQuery.toLowerCase().trim();
    state.nodes.forEach(function (n) {
      var ownText = [n.name, n.description, n.keyTakeaway]
        .join(" ")
        .toLowerCase();
      if (ownText.indexOf(q) !== -1) searchMatchIds.add(n.id);
    });
    // Un résultat dans un descendant rend visibles tous ses ancêtres : une
    // seule passe remplace les descendantsOf() répétés pendant le rendu.
    state.nodes.forEach(function (n) {
      if (!searchMatchIds.has(n.id)) return;
      var parentId = n.parentId;
      while (
        parentId &&
        nodeIndex.has(parentId) &&
        !searchMatchIds.has(parentId)
      ) {
        searchMatchIds.add(parentId);
        parentId = nodeIndex.get(parentId).parentId;
      }
    });
  }

  function childrenOf(idOrNull) {
    var ids = childrenIndex.get(idOrNull || "root") || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var n = nodeIndex.get(ids[i]);
      if (n) out.push(n);
    }
    return out;
  }

  function rootNodes() {
    return childrenOf(null);
  }

  // Nombre de catégories déjà présentes dans state.nodes : sert à assigner
  // un accentIndex stable à la prochaine catégorie créée (voir makeCategory).
  // Compte sur state.nodes directement plutôt que rootNodes()/nodeIndex,
  // qui peuvent être temporairement désynchronisés juste avant un
  // buildIndex() (ex. pendant une migration en cours).
  function countCategories() {
    var n = 0;
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].isCategory) n++;
    }
    return n;
  }

  function descendantsOf(id) {
    // tous les descendants, profondeur illimitée, incluant les feuilles
    var out = [];
    var stack = childrenOf(id).slice();
    while (stack.length) {
      var n = stack.pop();
      out.push(n);
      var kids = childrenOf(n.id);
      for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return out;
  }

  function pathOf(id) {
    // ex : ["02-CONSTRUCTION", "DATA-STRUCTURES", "hash_table"]
    var parts = [];
    var n = nodeIndex.get(id);
    while (n) {
      parts.unshift(n.name);
      n = n.parentId ? nodeIndex.get(n.parentId) : null;
    }
    return parts;
  }

  // Remonte l'arbre depuis n'importe quel nœud jusqu'à sa catégorie
  // ancêtre (toujours à la racine), et renvoie son accentIndex : ou null
  // si aucune catégorie n'est trouvée (ne devrait pas arriver en usage
  // normal, la hiérarchie étant forcée, mais reste défensif face à des
  // données corrompues ou un état transitoire pendant une migration).
  function categoryAccentOf(id) {
    var n = nodeIndex.get(id);
    while (n) {
      if (n.isCategory)
        return typeof n.accentIndex === "number" ? n.accentIndex : null;
      n = n.parentId ? nodeIndex.get(n.parentId) : null;
    }
    return null;
  }

  function findReview(n, revId) {
    for (var i = 0; i < n.reviews.length; i++)
      if (n.reviews[i].id === revId) return n.reviews[i];
    return null;
  }

  function nextReview(n) {
    var best = null;
    for (var i = 0; i < n.reviews.length; i++) {
      var r = n.reviews[i];
      if (r.doneAt) continue;
      if (!best || r.due < best.due) best = r;
    }
    return best;
  }

  function nodeStatus(n) {
    var r = nextReview(n);
    var t = todayISO();
    if (!r)
      return { key: "done", label: "Fait", cls: "badge-done", next: null };
    if (r.due < t)
      return { key: "late", label: "En retard", cls: "badge-late", next: r };
    if (r.due === t)
      return {
        key: "today",
        label: "À réviser aujourd'hui",
        cls: "badge-due",
        next: r,
      };
    return { key: "todo", label: "À faire", cls: "badge-todo", next: r };
  }

  // Agrégat de maîtrise pondéré par le nombre réel de feuilles : une grosse
  // branche ne pèse pas moins qu’une branche contenant une seule leçon.
  function masterySumOf(n) {
    if (masterySumCache.has(n.id)) return masterySumCache.get(n.id);
    var kids = childrenOf(n.id);
    var sum;
    if (!kids.length) sum = typeof n.mastery === "number" ? n.mastery : 0;
    else {
      sum = 0;
      for (var i = 0; i < kids.length; i++) sum += masterySumOf(kids[i]);
    }
    masterySumCache.set(n.id, sum);
    return sum;
  }

  function aggregatedMastery(n) {
    if (masteryCache.has(n.id)) return masteryCache.get(n.id);
    var count = leafCountOf(n);
    var value = count ? Math.round(masterySumOf(n) / count) : 0;
    masteryCache.set(n.id, value);
    return value;
  }

  function leavesOf(n) {
    var kids = childrenOf(n.id);
    if (!kids.length) return [n];
    var out = [];
    for (var i = 0; i < kids.length; i++) out = out.concat(leavesOf(kids[i]));
    return out;
  }

  function leafCountOf(n) {
    if (leafCountCache.has(n.id)) return leafCountCache.get(n.id);
    var kids = childrenOf(n.id);
    var count = 0;
    if (!kids.length) count = 1;
    else for (var i = 0; i < kids.length; i++) count += leafCountOf(kids[i]);
    leafCountCache.set(n.id, count);
    return count;
  }

  function allLeaves() {
    var out = [];
    state.nodes.forEach(function (n) {
      if (!childrenOf(n.id).length) out.push(n);
    });
    return out;
  }

  function pendingDue(uptoISO) {
    var keys = [];
    dueIndex.forEach(function (_v, k) {
      if (k <= uptoISO) keys.push(k);
    });
    keys.sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var list = dueIndex.get(keys[i]);
      for (var j = 0; j < list.length; j++) {
        var n = nodeIndex.get(list[j].nodeId);
        if (!n) continue;
        var r = findReview(n, list[j].revId);
        if (r && !r.doneAt) out.push({ node: n, review: r });
      }
    }
    return out;
  }

  function makeNode(name, parentId, start, duration) {
    var reviews = OFFSETS.map(function (o) {
      return {
        id: uid(),
        label: "J+" + o,
        offset: o,
        due: addDays(start, o),
        doneAt: null,
      };
    });
    return {
      id: uid(),
      parentId: parentId || null,
      isCategory: false,
      name: name,
      note: "",
      description: "",
      keyTakeaway: "",
      start: start,
      duration: duration,
      createdAt: todayISO(),
      status: "unset",
      mastery: 0,
      reviews: reviews,
      childrenIds: [],
    };
  }

  // Une catégorie est un nœud toujours à la racine (parentId=null), qui
  // regroupe des univers d'apprentissage complètement séparés (ex.
  // "Informatique", "Psychologie"). Conteneur pur : pas de date de début,
  // pas de durée, pas d'échéances de révision propres : sa maîtrise
  // affichée est TOUJOURS la moyenne agrégée de son sous-arbre
  // (aggregatedMastery), jamais une valeur qu'on modifie directement.
  //
  // accentIndex fixe la couleur d'accent de la catégorie (voir
  // CATEGORY_ACCENTS) selon son RANG DE CRÉATION, pas son nom ni sa
  // position d'affichage : donc stable même après renommage ou tri
  // alphabétique. L'appelant le calcule (nombre de catégories déjà
  // présentes) pour garder cette fonction indépendante de state.nodes.
  function makeCategory(name, accentIndex) {
    return {
      id: uid(),
      parentId: null,
      isCategory: true,
      accentIndex: accentIndex || 0,
      name: name,
      note: "",
      description: "",
      keyTakeaway: "",
      start: todayISO(),
      duration: 0,
      createdAt: todayISO(),
      status: "unset",
      mastery: 0,
      reviews: [],
      childrenIds: [],
    };
  }

  function attachChild(parentId, childId) {
    if (!parentId) return;
    var p = nodeIndex.get(parentId);
    if (!p) return;
    if (!Array.isArray(p.childrenIds)) p.childrenIds = [];
    if (p.childrenIds.indexOf(childId) === -1) p.childrenIds.push(childId);
    var arr = childrenIndex.get(parentId);
    if (!arr) {
      arr = [];
      childrenIndex.set(parentId, arr);
    }
    if (arr.indexOf(childId) === -1) arr.push(childId);
  }

  function save() {
    // Serialise les écritures : plusieurs actions rapides ne peuvent plus
    // s'écraser mutuellement (ex. double clic sur une jauge + export).
    // Une suppression en attente d'annulation bloque uniquement la
    // persistance destructive jusqu'à sa résolution.
    var deletionBarrier = pendingDeletion
      ? pendingDeletion.promise
      : Promise.resolve();
    saveChain = saveChain.then(function () {
      return deletionBarrier;
    }).then(function () {
      var snapshotNodes = JSON.parse(JSON.stringify(state.nodes));
      var snapshotHistory = JSON.parse(JSON.stringify(state.history));
      return storage.setMany([
        [KEYS.nodes, snapshotNodes],
        [KEYS.history, snapshotHistory],
        [KEYS.schema, SCHEMA_VERSION],
      ]);
    });
    return saveChain.catch(function (e) {
      console.error("Persistance impossible", e);
      toast("Attention : sauvegarde impossible sur cet appareil");
      throw e;
    });
  }

  // migre l'ancien format plat { modules:[{...,reviews}], history } vers le
  // nouveau schéma arbre, en conservant tel quel tout ce qui est déjà valide
  function migrateLegacy(rawModules) {
    return rawModules.map(function (m) {
      return {
        id: m.id || uid(),
        parentId: null,
        name: m.name || "Sans nom",
        note: "",
        start: m.start || todayISO(),
        duration: m.duration || 0,
        createdAt: m.createdAt || todayISO(),
        status: "unset",
        mastery: 0,
        reviews: Array.isArray(m.reviews) ? m.reviews : [],
        childrenIds: [],
      };
    });
  }

  // Garde-fous communs à load() et importData() : complète les champs
  // manquants sur un enregistrement provenant d'une version antérieure de
  // l'app (v1 plate, v2 sans catégories, ou un fichier importé partiel).
  // Ne migre PAS la hiérarchie elle-même (parentId orphelin) : ça reste
  // la responsabilité de l'appelant, car load() et importData() gèrent
  // ce cas différemment (l'un migre silencieusement, l'autre valide
  // avant tout remplacement).
  function normalizeNode(node) {
    if (typeof node.mastery !== "number") node.mastery = 0;
    if (!node.status) node.status = "unset";
    if (!Array.isArray(node.reviews)) node.reviews = [];
    if (!Array.isArray(node.childrenIds)) node.childrenIds = [];
    if (node.parentId === undefined) node.parentId = null;
    if (typeof node.note !== "string") node.note = "";
    if (typeof node.description !== "string") node.description = "";
    if (typeof node.keyTakeaway !== "string") node.keyTakeaway = "";
    if (typeof node.isCategory !== "boolean") node.isCategory = false;
    if (typeof node.accentIndex !== "number") node.accentIndex = -1; // à réassigner par assignMissingAccents()
  }

  // Donne un accentIndex séquentiel (0, 1, 2…) à toute catégorie qui n'en a
  // pas encore (nouvelles ou migrées depuis une version antérieure à ce
  // concept), en respectant l'ordre déjà utilisé par les catégories qui en
  // ont déjà un. Appelée après normalizeNode(), qui pose -1 comme valeur à
  // corriger : jamais l'inverse (normalizeNode ne connaît pas les autres
  // nœuds, cette passe si).
  function assignMissingAccents(nodes) {
    var used = nodes
      .filter(function (n) {
        return n.isCategory && n.accentIndex >= 0;
      })
      .map(function (n) {
        return n.accentIndex;
      });
    var next = used.length ? Math.max.apply(null, used) + 1 : 0;
    nodes.forEach(function (n) {
      if (n.isCategory && n.accentIndex < 0) {
        n.accentIndex = next;
        next++;
      }
    });
  }

  async function load() {
    var schema = await storage.get(KEYS.schema);
    var n = await storage.get(KEYS.nodes);
    var h = await storage.get(KEYS.history);

    if (Array.isArray(n)) {
      state.nodes = n;
    } else {
      // pas de v2 trouvé : tenter une migration depuis l'ancienne clé "modules"
      var legacy = await storage.get("modules");
      state.nodes = Array.isArray(legacy) ? migrateLegacy(legacy) : [];
    }
    state.history = Array.isArray(h) ? h : [];

    // garde-fous : champs manquants sur d'anciens enregistrements
    state.nodes.forEach(normalizeNode);
    assignMissingAccents(state.nodes);

    // migration v3 : avant cette version, les modules pouvaient exister
    // directement à la racine. Désormais la racine n'accueille QUE des
    // catégories (Informatique, Psychologie…), donc tout module orphelin
    // trouvé à la racine est rattaché sous une catégorie "Non classé"
    // créée à la volée : une seule fois, sans jamais toucher aux
    // catégories déjà présentes ni aux modules déjà bien rattachés.
    if (schema !== SCHEMA_VERSION) {
      var orphanRoots = state.nodes.filter(function (n) {
        return !n.parentId && !n.isCategory;
      });
      if (orphanRoots.length) {
        var uncategorized = makeCategory("Non classé", countCategories());
        state.nodes.push(uncategorized);
        orphanRoots.forEach(function (n) {
          n.parentId = uncategorized.id;
        });
      }
    }

    buildIndex();
    var historyBefore = state.history.length;
    state.history = state.history.filter(function (entry) {
      return !entry.nodeId || nodeIndex.has(entry.nodeId);
    });
    if (schema !== SCHEMA_VERSION || historyBefore !== state.history.length)
      await save();
  }

  /* ---------------------------------------------------------------
     3. HELPERS DOM
  ---------------------------------------------------------------- */
  var $ = function (id) {
    return document.getElementById(id);
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  var toastTimer = null;
  function toast(msg, action) {
    var t = $("toast");
    t.textContent = "";
    var content = el("span", "toast-content");
    content.appendChild(el("span", "toast-message", msg));

    if (action && action.label && typeof action.onClick === "function") {
      var actionButton = el("button", "toast-action", action.label);
      actionButton.type = "button";
      actionButton.addEventListener("click", function () {
        clearTimeout(toastTimer);
        t.hidden = true;
        action.onClick();
      }, { once: true });
      content.appendChild(actionButton);
    }

    t.appendChild(content);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, action && action.duration ? action.duration : 2600);
  }

  var confirmModal = createConfirmModal($, toast);

  var THEME_COLORS = {
    dark: "#0a0a0f",
    light: "#f5ede4",
  };

  function getPreferredTheme() {
    // Light mode is the product default; an explicit saved choice still wins.
    return "light";
  }

  function applyTheme(theme, withTransition) {
    var next = theme === "light" ? "light" : "dark";
    var root = document.documentElement;
    if (withTransition) root.classList.add("theme-transitioning");
    root.dataset.theme = next;

    var meta = $("themeColorMeta");
    if (meta) meta.setAttribute("content", THEME_COLORS[next]);

    var toggle = $("themeToggle");
    var icon = $("themeToggleIcon");
    if (toggle) {
      var actionLabel = next === "dark"
        ? "Passer au thème clair"
        : "Passer au thème sombre";
      toggle.setAttribute("aria-label", actionLabel);
      toggle.setAttribute("title", actionLabel);
    }
    if (icon) icon.textContent = next === "dark" ? "☀" : "☾";

    if (withTransition) {
      window.setTimeout(function () {
        root.classList.remove("theme-transitioning");
      }, Math.max(180, parseFloat(getComputedStyle(root).getPropertyValue("--speed")) * 1000 + 30));
    }
  }

  async function initTheme() {
    var savedTheme = null;
    try {
      savedTheme = await storage.get(KEYS.theme);
    } catch (error) {
      console.warn("Préférence de thème indisponible, préférence système utilisée", error);
    }
    applyTheme(savedTheme || getPreferredTheme(), false);
  }

  var currentView = "dashboard";
  var expandedNodes = new Set(); // ids des nœuds dépliés dans l'arbre (affiche les ENFANTS)
  var detailExpanded = new Set(); // ids des modules dont le DÉTAIL de la carte est déplié (description, jauge complète, timeline) : indépendant du dépliage de l'arbre
  var selectedParentId = null; // parent choisi pour le prochain ajout
  var currentCategoryId = null; // catégorie ouverte dans le Dashboard
  var treeQuery = "";
  var treeFilterStatus = ""; // "", "learned", "review", "unset"
  var editingField = { node: null, field: null }; // édition inline description/à-retenir en cours

  /* ---------------------------------------------------------------
     4. RENDU
  ---------------------------------------------------------------- */
  function renderAll() {
    // Les mutations peuvent changer la maîtrise sans reconstruire les index.
    // Invalider ces caches à chaque rendu garantit des agrégats toujours justes.
    masteryCache.clear();
    masterySumCache.clear();
    leafCountCache.clear();
    renderAlertBanner();
    renderDashboardOverview();
    renderDashboardFirstRun();
    renderCategoryChips();
    renderParentSelect();
    renderCategoryWorkspace();
    renderTree();
    renderToday();
    renderHistory();
    renderStats();
  }

  // Calcule le nombre de jours de retard d'une révision par rapport à
  // aujourd'hui (0 si elle n'est pas en retard : due aujourd'hui ou dans
  // le futur). Repose sur la même arithmétique de dates que le reste de
  // l'app (fromISO gère déjà mois/années/bissextiles).
  function daysLate(dueISO) {
    var t = todayISO();
    if (dueISO >= t) return 0;
    var ms = fromISO(t).getTime() - fromISO(dueISO).getTime();
    return Math.round(ms / 86400000);
  }

  // Système d'alerte à gravité progressive (point demandé explicitement) :
  // plus le retard accumulé est important, plus le bandeau doit se
  // remarquer. Calculé sur le PIRE cas (le retard maximum trouvé), pas une
  // moyenne : c'est la leçon la plus négligée qui doit tirer la sonnette
  // d'alarme, pas une moyenne qui la dilue avec des révisions à jour.
  var ALERT_THRESHOLDS = { light: 1, moderate: 3, severe: 7 };

  function computeAlertLevel() {
    var due = pendingDue(todayISO());
    var late = due.filter(function (d) {
      return d.review.due < todayISO();
    });
    if (!late.length) return null;
    var maxDays = 0;
    late.forEach(function (d) {
      var days = daysLate(d.review.due);
      if (days > maxDays) maxDays = days;
    });
    var level;
    if (maxDays >= ALERT_THRESHOLDS.severe) level = "severe";
    else if (maxDays >= ALERT_THRESHOLDS.moderate) level = "moderate";
    else level = "light";
    return { level: level, maxDays: maxDays, count: late.length };
  }

  function renderAlertBanner() {
    var box = $("alertBanner");
    var alert = computeAlertLevel();
    if (!alert) {
      box.hidden = true;
      box.textContent = "";
      box.className = "alert-banner";
      return;
    }
    box.hidden = false;
    box.className = "alert-banner alert-" + alert.level;

    var messages = {
      light: "à jour de près : ",
      moderate: "commence à s'accumuler : ",
      severe: "urgent, ça fait un moment : ",
    };
    var icon = { light: "○", moderate: "◐", severe: "●" }[alert.level];

    box.textContent = "";
    box.appendChild(el("span", "alert-icon", icon));
    var text = el("span", "alert-text");
    var count = alert.count;
    text.appendChild(
      document.createTextNode(
        messages[alert.level] +
          count +
          (count > 1 ? " révisions en retard" : " révision en retard") +
          " (jusqu'à " +
          alert.maxDays +
          (alert.maxDays > 1 ? " jours" : " jour") +
          ").",
      ),
    );
    box.appendChild(text);
    var goBtn = el("button", "btn btn-sm alert-goto", "Voir");
    goBtn.type = "button";
    goBtn.addEventListener("click", function () {
      var tab = document.querySelector('.tab[data-view="today"]');
      if (tab) tab.click();
    });
    box.appendChild(goBtn);
  }

  // ---- grille de catégories : le Dashboard reste volontairement compact.
  function renderCategoryChips() {
    var box = $("categoryChips");
    box.textContent = "";
    var cats = rootNodes().filter(function (n) { return n.isCategory; });
    var panel = box.closest(".panel-category");
    if (panel) panel.classList.toggle("has-categories", cats.length > 0);
    if (!cats.length) { box.appendChild(el("span", "category-chip-empty", "Aucune catégorie pour l'instant : créez-en une pour commencer.")); return; }
    var today = todayISO();
    cats.slice().sort(function (a,b) { return a.name.localeCompare(b.name); }).forEach(function (c) {
      var card = el("button", "category-overview-card", ""); card.type = "button";
      var accentIdx = typeof c.accentIndex === "number" ? c.accentIndex % 8 : 0;
      card.appendChild(el("span", "category-overview-accent accent-" + accentIdx));
      var top = el("div", "category-overview-top"); top.appendChild(el("span", "category-overview-name", c.name)); top.appendChild(masteryPill(aggregatedMastery(c))); card.appendChild(top);
      var meta = el("div", "category-overview-meta"); meta.appendChild(el("span", "category-overview-stat", leafCountOf(c) + " leçon(s)"));
      var dueCount = pendingDue(today).filter(function (item) { return belongsToCategory(item.node.id,c.id); }).length;
      meta.appendChild(el("span", "category-overview-due", dueCount ? dueCount + " due(s)" : "À jour")); card.appendChild(meta);
      card.appendChild(el("div", "category-overview-foot", "Ouvrir l'univers →"));
      card.addEventListener("click", function () { openCategory(c.id); }); box.appendChild(card);
    });
  }
  function belongsToCategory(nodeId, categoryId) { var n=nodeIndex.get(nodeId); while(n){ if(n.id===categoryId) return true; n=n.parentId?nodeIndex.get(n.parentId):null; } return false; }
  function openCategory(categoryId) {
    var category=nodeIndex.get(categoryId); if(!category || !category.isCategory) return;
    currentCategoryId=categoryId; selectedParentId=categoryId; treeQuery=""; treeFilterStatus=""; treeRenderLimit=260;
    if($("search")) $("search").value=""; if($("statusFilter")) $("statusFilter").value="";
    renderParentSelect(); renderCategoryWorkspace(); renderTree();
    var panel=$("moduleFormPanel"); if(panel){ panel.removeAttribute("open"); panel.dataset.categoryOpen=""; }
    var back=$("categoryBackBtn"); if(back) back.focus();
  }
  function closeCategory() {
    currentCategoryId=null; selectedParentId=null; treeQuery=""; treeFilterStatus=""; treeRenderLimit=260;
    if($("search")) $("search").value=""; if($("statusFilter")) $("statusFilter").value="";
    renderParentSelect(); renderCategoryWorkspace(); renderTree();
  }
  function renderCategoryWorkspace() {
    var workspace=$("categoryWorkspace");
    var category=currentCategoryId?nodeIndex.get(currentCategoryId):null;
    var categoryPanel=document.querySelector(".view-dashboard .panel-category");
    var overview=$("dashboardOverview");
    var firstRun=$("dashboardFirstRun");
    var moduleForm=$("moduleFormPanel");
    if(!workspace) return;
    workspace.hidden=!category;
    if(categoryPanel) categoryPanel.hidden=!!category;
    if(overview) overview.hidden=!!category || !overview.childElementCount;
    if(firstRun && category) firstRun.hidden=true;
    if(moduleForm) {
      moduleForm.hidden=!!category && !moduleForm.dataset.categoryOpen;
      if(!category) delete moduleForm.dataset.categoryOpen;
    }
    if(!category) return;
    var leaves=leafCountOf(category); var count=descendantsOf(category.id).length; var mastery=aggregatedMastery(category);
    $("categoryWorkspaceKicker").textContent=category.name.toUpperCase();
    $("categoryWorkspaceTitle").textContent="Ce qui compose cet univers.";
    $("categoryWorkspaceLede").textContent=leaves+" leçon(s), "+count+" élément(s) dans le sous-arbre, maîtrise agrégée à "+mastery+" %.";
  }

  function openModuleForm(parentId) {
    if(parentId) selectedParentId=parentId;
    var panel=$("moduleFormPanel"); if(!panel) return;
    panel.hidden=false;
    panel.dataset.categoryOpen=currentCategoryId ? "1" : "";
    renderParentSelect();
    panel.open=true;
    panel.scrollIntoView({behavior:"smooth",block:"start"});
  }

  // ---- sélecteur de parent (formulaire d'ajout de module) : liste
  // indentée de tout l'arbre, catégories en tête de chaque groupe racine.
  // Un module n'a JAMAIS "racine" comme option : il doit toujours pointer
  // vers une catégorie ou un module déjà rattaché à une catégorie.
  function renderParentSelect() {
    var sel = $("mParent");
    var search = $("mParentSearch");
    var keep = selectedParentId;
    var searchValue = search ? search.value : "";
    sel.textContent = "";

    var cats = rootNodes().filter(function (n) {
      return n.isCategory;
    });
    if (!cats.length) {
      sel.appendChild(
        new Option("Créez d'abord une catégorie ci-dessus", ""),
      );
      sel.disabled = true;
      selectedParentId = null;
      return;
    }
    sel.disabled = false;
    sel.appendChild(new Option("Choisir une catégorie ou un module", ""));

    function walk(list, prefix) {
      list.forEach(function (n) {
        var label = n.isCategory ? n.name.toUpperCase() : prefix + n.name;
        sel.appendChild(new Option(label, n.id));
        walk(childrenOf(n.id), prefix + "↳ ");
      });
    }
    walk(cats, "");
    sel.value = keep && nodeIndex.has(keep) ? keep : "";
    selectedParentId = sel.value || null;
    filterParentOptions(searchValue);
  }

  function filterParentOptions(query) {
    var sel=$("mParent"); if(!sel) return;
    var q=String(query||"").trim().toLowerCase();
    Array.prototype.forEach.call(sel.options,function(option,index){
      if(index===0){ option.hidden=false; return; }
      option.hidden=!!q && option.textContent.toLowerCase().indexOf(q)===-1 && option.value!==selectedParentId;
    });
  }

  function matchesFilter(n) {
    if (treeFilterStatus && (n.status || "unset") !== treeFilterStatus)
      return false;
    if (treeQuery && !searchMatchIds.has(n.id)) return false;
    return true;
  }

  function renderTree() {
    countRenderedTreeNodes = 0;
    var box = $("moduleList");
    box.textContent = "";
    if (treeQuery !== searchIndexQuery) buildSearchIndex();
    var scopeNodes = currentCategoryId ? descendantsOf(currentCategoryId) : [];
    var allVisible = scopeNodes.filter(matchesFilter);
    var roots = currentCategoryId ? childrenOf(currentCategoryId).filter(matchesFilter) : [];
    var totalVisible = allVisible.length;
    $("moduleCount").textContent = String(totalVisible);
    box.classList.toggle("tree-volume-high", scopeNodes.length >= 120);
    box.classList.toggle("tree-volume-medium", scopeNodes.length >= 60 && scopeNodes.length < 120);

    if (treeRenderObserver) {
      treeRenderObserver.disconnect();
      treeRenderObserver = null;
    }
    if (!roots.length) {
      var emptyBox = el("div", "empty module-empty");
      var hasAnyModule = currentCategoryId ? scopeNodes.some(function(n){ return !n.isCategory; }) : state.nodes.some(function(n){ return !n.isCategory; });
      emptyBox.appendChild(
        el(
          "div",
          "module-empty-title",
          state.nodes.length && hasAnyModule
            ? "Aucun module ne correspond au filtre."
            : "Aucun module pour l'instant.",
        ),
      );
      emptyBox.appendChild(
        el(
          "div",
          "module-empty-copy",
          state.nodes.length && hasAnyModule
            ? "Réinitialisez les filtres pour retrouver tous vos modules."
            : "Créez un premier module après avoir choisi sa catégorie.",
        ),
      );
      var emptyAction = el("button", "btn btn-sm", state.nodes.length && hasAnyModule ? "Réinitialiser les filtres" : "Ouvrir le formulaire");
      emptyAction.type = "button";
      emptyAction.addEventListener("click", function () {
        if (hasAnyModule) {
          treeQuery = "";
          treeFilterStatus = "";
          $("search").value = "";
          $("statusFilter").value = "";
          renderTree();
          return;
        }
        openModuleForm(currentCategoryId || selectedParentId);
        var parent = $("mParent");
        if (parent && !parent.disabled) parent.focus();
      });
      emptyBox.appendChild(emptyAction);
      box.appendChild(emptyBox);
      return;
    }

    var budget = { remaining: treeRenderLimit, truncated: false };
    var frag = document.createDocumentFragment();
    roots.forEach(function (n) {
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      var card = renderNodeCard(n, 0, budget);
      if (card) frag.appendChild(card);
    });
    box.appendChild(frag);

    if (budget.truncated || totalVisible > treeRenderLimit) {
      var remaining = Math.max(0, totalVisible - countRenderedTreeNodes);
      var sentinel = el("div", "tree-more card");
      sentinel.appendChild(
        el(
          "span",
          "muted",
          remaining > 0
            ? remaining +
                " élément(s) non affiché(s) pour garder l’interface fluide."
            : "Suite de l’arbre disponible.",
        ),
      );
      var more = el("button", "btn btn-sm", "Charger la suite");
      more.type = "button";
      more.addEventListener("click", function () {
        treeRenderLimit += scopeNodes.length >= 1000 ? 180 : 260;
        renderTree();
      });
      sentinel.appendChild(more);
      box.appendChild(sentinel);
      if ("IntersectionObserver" in window) {
        treeRenderObserver = new IntersectionObserver(
          function (entries) {
            if (entries[0] && entries[0].isIntersecting) {
              treeRenderLimit += state.nodes.length >= 1000 ? 180 : 260;
              renderTree();
            }
          },
          { rootMargin: "320px" },
        );
        treeRenderObserver.observe(sentinel);
      }
    }
  }

  var countRenderedTreeNodes = 0;

  function statusDot(status) {
    return el("span", "status-dot status-" + (status || "unset"));
  }

  // Bloc de texte éditable inline sur une carte de module (description ou
  // "à retenir vraiment"). En lecture : affiche le texte s'il existe, sinon
  // rien (pas de bruit visuel pour les modules pas encore détaillés) avec un
  // petit bouton discret pour éditer/ajouter. En édition : textarea + valider
  // /annuler. `field` est le nom du champ sur le nœud (description|keyTakeaway).
  function editableTextBlock(n, field, label, placeholder, extraCls) {
    var box = el("div", "text-block" + (extraCls ? " " + extraCls : ""));
    var editing = editingField.node === n.id && editingField.field === field;

    if (!editing) {
      var value = n[field] || "";
      var headRow = el("div", "text-block-head");
      headRow.appendChild(el("span", "text-block-label", label));
      var editBtn = el(
        "button",
        "text-block-edit",
        value ? "Modifier" : "+ ajouter",
      );
      editBtn.type = "button";
      editBtn.addEventListener("click", function () {
        editingField.node = n.id;
        editingField.field = field;
        renderTree();
      });
      headRow.appendChild(editBtn);
      if (!value) {
        // rien à lire : seul le bouton "+ ajouter" reste visible, discret
        box.classList.add("text-block-empty");
        box.appendChild(headRow);
        return box;
      }
      box.appendChild(headRow);
      box.appendChild(el("p", "text-block-value", value));
      return box;
    }

    // mode édition
    var headRow2 = el("div", "text-block-head");
    headRow2.appendChild(el("span", "text-block-label", label));
    box.appendChild(headRow2);

    var ta = document.createElement("textarea");
    ta.value = n[field] || "";
    ta.placeholder = placeholder;
    ta.maxLength = field === "keyTakeaway" ? 300 : 600;
    ta.className = "text-block-input";
    box.appendChild(ta);

    var actionsRow = el("div", "btn-row text-block-actions");
    var saveBtn = el("button", "btn btn-success btn-sm", "Enregistrer");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async function () {
      n[field] = ta.value.trim();
      editingField.node = null;
      editingField.field = null;
      await save();
      renderTree();
      renderStats(); // la description ne change pas les stats, mais garde tout synchro sans coût notable
    });
    var cancelBtn = el("button", "btn btn-sm", "Annuler");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", function () {
      editingField.node = null;
      editingField.field = null;
      renderTree();
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    box.appendChild(actionsRow);
    setTimeout(function () {
      ta.focus();
    }, 20);
    return box;
  }

  function renderNodeCard(n, depth, budget) {
    if (budget && budget.remaining <= 0) {
      budget.truncated = true;
      return null;
    }
    if (budget) {
      budget.remaining--;
      countRenderedTreeNodes = treeRenderLimit - budget.remaining;
    }
    var kids = childrenOf(n.id);
    var hasKids = kids.length > 0;
    var expanded = expandedNodes.has(n.id);
    var st = nodeStatus(n);
    var mastery = aggregatedMastery(n);
    var accentIdx = n.isCategory
      ? typeof n.accentIndex === "number"
        ? n.accentIndex % 8
        : null
      : categoryAccentOf(n.id);
    // le détail complet (description, jauge éditable, timeline) est replié
    // par défaut pour un module : une catégorie reste toujours "ouverte",
    // elle affiche déjà peu de choses (pas de timeline, pas de jauge éditable)
    var detailOpen = n.isCategory || detailExpanded.has(n.id);

    var cardCls =
      "card node-card depth-" +
      Math.min(depth, 4) +
      (n.isCategory ? " category-card" : "") +
      (accentIdx !== null && !n.isCategory
        ? " accent-border-" + accentIdx
        : "");
    var card = el("div", cardCls);

    var head = el("div", "card-head");
    var left = el("div", "node-left");

    var titleRow = el("div", "node-title-row");
    if (hasKids) {
      var toggle = el("button", "tree-toggle", expanded ? "▾" : "▸");
      toggle.type = "button";
      toggle.setAttribute("aria-label", expanded ? "Replier" : "Déplier");
      toggle.addEventListener("click", function () {
        if (expandedNodes.has(n.id)) expandedNodes.delete(n.id);
        else expandedNodes.add(n.id);
        renderTree();
      });
      titleRow.appendChild(toggle);
    } else {
      titleRow.appendChild(el("span", "tree-toggle tree-toggle-leaf", "·"));
    }
    if (n.isCategory && accentIdx !== null) {
      titleRow.appendChild(el("span", "accent-dot accent-" + accentIdx));
    }
    if (!n.isCategory) titleRow.appendChild(statusDot(n.status));
    titleRow.appendChild(el("span", "card-title", n.name));
    if (hasKids)
      titleRow.appendChild(
        el("span", "muted small node-count", "(" + kids.length + ")"),
      );
    left.appendChild(titleRow);

    // ligne condensée toujours visible : l'essentiel en un coup d'œil,
    // sans avoir à déplier le détail (prochaine échéance pour un module,
    // nombre de leçons pour une catégorie)
    if (!n.isCategory) {
      left.appendChild(
        el(
          "div",
          "muted small",
          st.next
            ? "Prochaine échéance " +
                fmt(st.next.due) +
                " (" +
                st.next.label +
                ")"
            : "Révisions programmées terminées",
        ),
      );
    } else {
      var leafCount = leafCountOf(n);
      left.appendChild(
        el(
          "div",
          "muted small",
          leafCount + " leçon(s) au total dans cette catégorie",
        ),
      );
    }
    head.appendChild(left);

    var right = el("div", "node-right");
    var badgeRow = el("div", "btn-row");
    badgeRow.appendChild(
      n.isCategory
        ? el("span", "badge badge-category", "Catégorie")
        : el("span", "badge " + st.cls, st.label),
    );
    badgeRow.appendChild(masteryPill(mastery));
    right.appendChild(badgeRow);
    head.appendChild(right);
    card.appendChild(head);

    // bouton détail : replié par défaut pour un module (le contenu riche :
    // description, jauge éditable, timeline, actions : n'apparaît qu'au
    // clic). Une catégorie n'a pas ce bouton, son contenu reste toujours
    // visible puisqu'il est déjà léger.
    if (!n.isCategory) {
      var detailToggle = el(
        "button",
        "detail-toggle",
        detailOpen ? "▴ Masquer le détail" : "▾ Voir le détail",
      );
      detailToggle.type = "button";
      detailToggle.addEventListener("click", function () {
        if (detailExpanded.has(n.id)) detailExpanded.delete(n.id);
        else detailExpanded.add(n.id);
        renderTree();
      });
      card.appendChild(detailToggle);
    }

    if (detailOpen) {
      var detailBox = el("div", "node-detail");

      // métadonnées complètes (début, durée) : la prochaine échéance est
      // déjà dans la ligne condensée ci-dessus, pas la peine de la répéter
      if (!n.isCategory) {
        var metaBits = ["Début " + fmt(n.start)];
        if (n.duration) metaBits.push(n.duration + " min");
        detailBox.appendChild(el("div", "muted small", metaBits.join(" · ")));
      }

      // description + "à retenir vraiment" : quand les DEUX sont vides et
      // qu'on n'édite ni l'un ni l'autre, un seul petit lien discret les
      // remplace tous les deux (évite de répéter "+ ajouter" deux fois
      // pour rien, surtout visible sur une catégorie où c'est fréquent).
      // Dès que l'un des deux a du contenu, ou qu'on édite l'un d'eux, on
      // repasse à l'affichage normal en deux blocs séparés.
      var editingThis =
        editingField.node === n.id &&
        (editingField.field === "description" ||
          editingField.field === "keyTakeaway");
      var bothEmpty = !n.description && !n.keyTakeaway;
      if (bothEmpty && !editingThis) {
        var mergedBtn = el(
          "button",
          "text-block-edit text-block-merged",
          "+ description / à retenir",
        );
        mergedBtn.type = "button";
        mergedBtn.addEventListener("click", function () {
          editingField.node = n.id;
          editingField.field = "description";
          renderTree();
        });
        detailBox.appendChild(mergedBtn);
      } else {
        detailBox.appendChild(
          editableTextBlock(
            n,
            "description",
            "Description",
            n.isCategory
              ? "Ce que couvre cette catégorie…"
              : "Ce que couvre ce module…",
          ),
        );
        detailBox.appendChild(
          editableTextBlock(
            n,
            "keyTakeaway",
            "À retenir vraiment",
            "Le point clé à ne jamais oublier…",
            "takeaway-block",
          ),
        );
      }

      // jauge de maîtrise : éditable (+/-) pour un module, purement
      // agrégée et en lecture seule pour une catégorie
      if (!n.isCategory) {
        detailBox.appendChild(masteryControls(n));
      } else {
        detailBox.appendChild(aggregatedMasteryReadout(mastery));
      }

      // timeline des échéances J+1/J+7/J+21/J+60 (jamais présente sur une
      // catégorie, puisque makeCategory() initialise reviews à [])
      if (n.reviews.length) {
        var steps = el("div", "steps");
        var t = todayISO();
        n.reviews
          .slice()
          .sort(function (a, b) {
            return a.due < b.due ? -1 : 1;
          })
          .forEach(function (r) {
            var cls = "step";
            if (r.doneAt) cls += " done";
            else if (r.due < t) cls += " late";
            else if (r.due === t) cls += " today";
            var s = el("div", cls);
            var dot = el("div", "step-dot");
            var lab = el("span", "step-label", r.label + " · " + fmt(r.due));
            lab.setAttribute(
              "data-tip",
              r.doneAt
                ? "Révisé le " + fmt(r.doneAt)
                : "Échéance " + fmt(r.due),
            );
            s.appendChild(dot);
            s.appendChild(lab);
            steps.appendChild(s);
          });
        detailBox.appendChild(steps);
      }

      // actions (ajout d'enfant, suppression) déplacées dans le détail
      // déplié : désencombre la vue repliée, qui reste consultative
      var actions = el("div", "btn-row node-actions");
      var addSub = el(
        "button",
        "btn btn-sm",
        n.isCategory ? "+ module" : "+ sous-module",
      );
      addSub.type = "button";
      addSub.addEventListener("click", function () {
        selectedParentId = n.id;
        renderParentSelect();
        openModuleForm(n.id);
        $("mName").focus();
        if (!currentCategoryId) $("view-dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
        else { var workspace=$("categoryWorkspace"); if(workspace) workspace.scrollIntoView({ behavior: "smooth", block: "start" }); }
        toast("Parent réglé sur « " + n.name + " »");
      });
      actions.appendChild(addSub);
      var del = el(
        "button",
        "btn btn-danger btn-sm",
        n.isCategory ? "Supprimer la catégorie" : "Supprimer",
      );
      del.type = "button";
      del.addEventListener("click", function () {
        deleteNode(n);
      });
      actions.appendChild(del);
      detailBox.appendChild(actions);

      card.appendChild(detailBox);
    }

    var wrap = el("div", "node-wrap");
    wrap.appendChild(card);

    if (hasKids && expanded) {
      var childrenBox = el(
        "div",
        "node-children node-children-depth-" + Math.min(depth + 1, 4),
      );
      kids.filter(matchesFilter).forEach(function (c) {
        if (budget && budget.remaining <= 0) {
          budget.truncated = true;
          return;
        }
        var childCard = renderNodeCard(c, depth + 1, budget);
        if (childCard) childrenBox.appendChild(childCard);
      });
      wrap.appendChild(childrenBox);
    }
    return wrap;
  }

  function masteryPill(value) {
    var pill = el("span", "mastery-pill");
    var i = el("i");
    i.style.width = clamp(value, 0, 100) + "%";
    pill.appendChild(i);
    pill.appendChild(el("span", "mastery-pill-label", value + " %"));
    return pill;
  }

  // Version lecture seule de la jauge de maîtrise, pour une catégorie :
  // même piste visuelle que masteryControls, mais sans curseur ni boutons
  // +/- puisque la valeur est TOUJOURS la moyenne agrégée du sous-arbre,
  // jamais une valeur qu'on modifie directement sur la catégorie elle-même.
  function aggregatedMasteryReadout(value) {
    var box = el("div", "mastery-controls mastery-readout");
    var track = el("div", "mastery-track");
    var fill = el("div", "mastery-fill");
    fill.style.width = clamp(value, 0, 100) + "%";
    track.appendChild(fill);
    box.appendChild(track);
    box.appendChild(
      el(
        "div",
        "muted small mastery-readout-label",
        "Maîtrise moyenne de la catégorie : " + value + " %",
      ),
    );
    return box;
  }

  function masteryControls(n) {
    var box = el("div", "mastery-controls");

    var track = el("div", "mastery-track");
    var fill = el("div", "mastery-fill");
    fill.style.width = clamp(n.mastery, 0, 100) + "%";
    track.appendChild(fill);
    var handle = el("div", "mastery-handle");
    handle.style.left = clamp(n.mastery, 0, 100) + "%";
    track.appendChild(handle);
    box.appendChild(track);

    var row = el("div", "mastery-row");
    row.appendChild(el("span", "mastery-value", n.mastery + " %"));

    var btnGroup = el("div", "btn-row");
    var less = el("button", "btn btn-sm", "− à revoir");
    less.type = "button";
    less.title =
      "Réduit la maîtrise de " +
      MASTERY_STEP +
      " points et marque « à revoir »";
    less.addEventListener("click", function () {
      bumpMastery(n, -MASTERY_STEP, "review");
    });
    var more = el("button", "btn btn-success btn-sm", "+ compris");
    more.type = "button";
    more.title = "Augmente la maîtrise de " + MASTERY_STEP + " points";
    more.addEventListener("click", function () {
      bumpMastery(n, MASTERY_STEP, "learned");
    });
    btnGroup.appendChild(less);
    btnGroup.appendChild(more);
    row.appendChild(btnGroup);
    box.appendChild(row);

    return box;
  }

  async function bumpMastery(n, delta, statusHint) {
    var before = n.mastery;
    n.mastery = clamp(n.mastery + delta, 0, 100);
    if (n.mastery >= 100) n.status = "learned";
    else if (n.mastery <= 0) n.status = "review";
    else n.status = statusHint;

    state.history.push({
      id: uid(),
      nodeId: n.id,
      nodeName: n.name,
      path: pathOf(n.id).join(" / "),
      kind: "mastery",
      date: todayISO(),
      ts: Date.now(),
      stamp: nowStamp(),
      from: before,
      to: n.mastery,
      status: n.status,
    });

    await save();
    renderAll();
    toast(
      n.mastery > before
        ? n.name + " : maîtrise " + n.mastery + " %"
        : n.name + " : à revoir (" + n.mastery + " %)",
    );
  }

  // État vide de la vue Aujourd'hui : un simple "Rien à réviser" perdu au
  // milieu d'un grand espace vide donnait une impression de page cassée
  // plutôt que d'état normal et rassurant : surtout sur un écran large.
  // On y ajoute une icône, un ton positif, et la prochaine échéance à
  // venir (si elle existe) pour donner du contexte plutôt qu'un vide sec.
  function renderTodayEmptyState() {
    var wrap = el("div", "today-empty");
    wrap.appendChild(el("div", "today-empty-icon", "✓"));
    wrap.appendChild(
      el("div", "today-empty-title", "Rien à réviser aujourd'hui"),
    );

    // cherche la prochaine échéance future (hors retard, hors aujourd'hui)
    // pour donner un repère temporel plutôt qu'un simple vide
    var next = null;
    state.nodes.forEach(function (n) {
      var r = nextReview(n);
      if (r && r.due > todayISO()) {
        if (!next || r.due < next.review.due) next = { node: n, review: r };
      }
    });
    if (next) {
      wrap.appendChild(
        el(
          "div",
          "today-empty-sub",
          "Prochaine échéance : " +
            fmt(next.review.due) +
            " (" +
            pathOf(next.node.id).join(" / ") +
            ")",
        ),
      );
    } else if (
      state.nodes.some(function (n) {
        return !n.isCategory;
      })
    ) {
      wrap.appendChild(
        el(
          "div",
          "today-empty-sub",
          "Tous vos modules ont terminé leur cycle de révisions.",
        ),
      );
    } else {
      wrap.appendChild(
        el(
          "div",
          "today-empty-sub",
          "Ajoutez un module depuis le Dashboard pour démarrer un premier cycle de révisions.",
        ),
      );
    }
    var action = el("button", "btn btn-sm", next ? "Voir la prochaine échéance" : "Ouvrir le Dashboard");
    action.type = "button";
    action.addEventListener("click", function () {
      $("view-dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
      var dashboardTab = document.querySelector('.tab[data-view="dashboard"]');
      if (dashboardTab) dashboardTab.click();
    });
    wrap.appendChild(action);
    return wrap;
  }

  function renderToday() {
    var box = $("todayList");
    box.textContent = "";
    var t = todayISO();
    $("todayDate").textContent = " :  " + fmt(t);
    var due = pendingDue(t);
    $("todayCount").textContent = String(due.length);
    if (!due.length) {
      box.appendChild(renderTodayEmptyState());
      return;
    }

    var frag = document.createDocumentFragment();
    due.forEach(function (item) {
      var n = item.node,
        r = item.review;
      var card = el("div", "card");
      var head = el("div", "card-head");
      var left = el("div");
      var crumb = pathOf(n.id);
      if (crumb.length > 1)
        left.appendChild(
          el("div", "muted small breadcrumb", crumb.slice(0, -1).join(" / ")),
        );
      left.appendChild(el("div", "card-title", n.name));
      left.appendChild(
        el("div", "muted small", r.label + " · échéance " + fmt(r.due)),
      );
      head.appendChild(left);
      head.appendChild(
        el(
          "span",
          "badge " + (r.due < t ? "badge-late" : "badge-due"),
          r.due < t ? "En retard" : "Aujourd'hui",
        ),
      );
      card.appendChild(head);

      var form = el("form", "rev-form");
      var note = document.createElement("textarea");
      note.placeholder = "Ce que j'ai retenu…";
      form.appendChild(note);

      var choices = el("div", "choices");
      [
        ["yes", "Oui"],
        ["partial", "Partiellement"],
        ["no", "Non"],
      ].forEach(function (c, i) {
        var lab = el("label", "choice");
        var input = document.createElement("input");
        input.type = "radio";
        input.name = "rate-" + r.id;
        input.value = c[0];
        if (i === 0) {
          input.checked = true;
          lab.classList.add("sel-yes");
        }
        lab.appendChild(input);
        lab.appendChild(document.createTextNode("Je maîtrise : " + c[1]));
        input.addEventListener("change", function () {
          Array.prototype.forEach.call(choices.children, function (nd) {
            nd.classList.remove("sel-yes", "sel-partial", "sel-no");
          });
          lab.classList.add("sel-" + c[0]);
        });
        choices.appendChild(lab);
      });
      form.appendChild(choices);

      var actions = el("div", "btn-row");
      var ok = el("button", "btn btn-success", "Marquer comme effectuée");
      ok.type = "submit";
      actions.appendChild(ok);
      form.appendChild(actions);

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var sel = form.querySelector('input[name="rate-' + r.id + '"]:checked');
        completeReview(n, r, sel ? sel.value : "yes", note.value.trim());
      });
      card.appendChild(form);
      frag.appendChild(card);
    });
    box.appendChild(frag);
  }

  // ---- Historique strict : chaque révision ET chaque changement de
  // maîtrise est une ligne d'historique séparée, horodatée, jamais résumée.
  // Regroupe les entrées d'historique par période relative à aujourd'hui,
  // pour remplacer la liste plate infinie par des repères temporels
  // clairs : Aujourd'hui / Hier / Cette semaine / Plus ancien.
  function periodLabelFor(dateISO) {
    var t = todayISO();
    var yesterday = addDays(t, -1);
    var weekAgo = addDays(t, -7);
    if (dateISO === t) return "Aujourd'hui";
    if (dateISO === yesterday) return "Hier";
    if (dateISO >= weekAgo) return "Cette semaine";
    return "Plus ancien";
  }

  function renderHistory() {
    var queryInput = $("historyFilter");
    var query = queryInput ? queryInput.value.trim().toLowerCase() : "";

    var typeSel = $("historyTypeFilter");
    var keepType = typeSel.value;

    var box = $("historyList");
    box.textContent = "";
    var rows = state.history.slice();
    if (query)
      rows = rows.filter(function (h) {
        var haystack = String(h.path || h.nodeName || "").toLowerCase();
        return haystack.indexOf(query) !== -1;
      });
    if (keepType === "reviews")
      rows = rows.filter(function (h) {
        return h.kind !== "mastery";
      });
    if (keepType === "mastery")
      rows = rows.filter(function (h) {
        return h.kind === "mastery";
      });

    rows.sort(function (a, b) {
      return (b.ts || 0) - (a.ts || 0);
    });

    $("historyCount").textContent = String(rows.length);

    if (!rows.length) {
      var historyEmpty = el("div", "empty history-empty");
      historyEmpty.appendChild(
        el(
          "div",
          "module-empty-title",
          state.history.length ? "Aucun évènement ne correspond à ces filtres." : "Aucun évènement enregistré pour l'instant.",
        ),
      );
      historyEmpty.appendChild(
        el(
          "div",
          "module-empty-copy",
          state.history.length ? "Réinitialisez le module ou le type d'évènement pour retrouver l'historique." : "Votre première révision créera automatiquement votre premier évènement.",
        ),
      );
      var historyAction = el("button", "btn btn-sm", state.history.length ? "Réinitialiser les filtres" : "Aller aux révisions");
      historyAction.type = "button";
      historyAction.addEventListener("click", function () {
        if (state.history.length) {
          $("historyFilter").value = "";
          $("historyTypeFilter").value = "";
          renderHistory();
          return;
        }
        var todayTab = document.querySelector('.tab[data-view="today"]');
        if (todayTab) todayTab.click();
      });
      historyEmpty.appendChild(historyAction);
      box.appendChild(historyEmpty);
      return;
    }

    // groupement par période, dans l'ordre où les groupes doivent
    // apparaître (les entrées sont déjà triées du plus récent au plus
    // ancien, donc l'ordre d'apparition des groupes suit naturellement)
    var groups = [];
    var groupIndex = {};
    rows.forEach(function (h) {
      var period = periodLabelFor(h.date);
      if (!(period in groupIndex)) {
        groupIndex[period] = groups.length;
        groups.push({ period: period, rows: [] });
      }
      groups[groupIndex[period]].rows.push(h);
    });

    var reviewLabels = {
      yes: ["Oui, je maîtrise", "badge-done"],
      partial: ["Partiellement", "badge-due"],
      no: ["Non, à revoir", "badge-late"],
    };

    var frag = document.createDocumentFragment();
    groups.forEach(function (group) {
      frag.appendChild(el("h3", "history-period-head", group.period));
      group.rows.forEach(function (h) {
        var isMastery = h.kind === "mastery";
        var card = el(
          "div",
          "card history-row" +
            (isMastery ? " history-mastery" : " history-review"),
        );
        var head = el("div", "card-head");
        var left = el("div");
        var titleLine = el("div", "history-title-line");
        titleLine.appendChild(
          el("span", "history-kind-icon", isMastery ? "◐" : "↻"),
        );
        titleLine.appendChild(
          el("span", "card-title", h.path || h.nodeName || h.moduleName || "?"),
        );
        left.appendChild(titleLine);
        if (isMastery) {
          var trendUp = h.to > h.from;
          var trendIcon = el(
            "span",
            "history-trend " +
              (trendUp ? "history-trend-up" : "history-trend-down"),
            trendUp ? "↑" : "↓",
          );
          var subLine = el("div", "muted small history-sub-line");
          subLine.appendChild(
            document.createTextNode(
              (h.stamp || fmt(h.date)) + " · jauge de maîtrise ",
            ),
          );
          subLine.appendChild(trendIcon);
          subLine.appendChild(
            document.createTextNode(" " + h.from + " % → " + h.to + " %"),
          );
          left.appendChild(subLine);
        } else {
          left.appendChild(
            el(
              "div",
              "muted small",
              fmt(h.date) + " · révision " + (h.label || ""),
            ),
          );
        }
        head.appendChild(left);
        if (isMastery) {
          var statusCls =
            h.status === "learned"
              ? "badge-done"
              : h.status === "review"
                ? "badge-late"
                : "badge-todo";
          head.appendChild(
            el(
              "span",
              "badge " + statusCls,
              h.status === "learned"
                ? "→ Compris"
                : h.status === "review"
                  ? "→ À revoir"
                  : "→ Neutre",
            ),
          );
        } else {
          var l = reviewLabels[h.rating] || reviewLabels.yes;
          head.appendChild(el("span", "badge " + l[1], l[0]));
        }
        card.appendChild(head);
        if (h.note) card.appendChild(el("p", "small", h.note));
        frag.appendChild(card);
      });
    });
    box.appendChild(frag);
  }

  /* ---------------------------------------------------------------
     5. STATISTIQUES
  ---------------------------------------------------------------- */
  function renderStats() {
    var box = $("statsBox");
    box.textContent = "";

    var totalReviews = state.history.filter(function (h) {
      return h.kind !== "mastery";
    }).length;
    var yes = 0,
      partial = 0;
    state.history.forEach(function (h) {
      if (h.kind === "mastery") return;
      if (h.rating === "yes") yes++;
      else if (h.rating === "partial") partial++;
    });

    var leaves = allLeaves();
    var learnedLeaves = leaves.filter(function (l) {
      return l.status === "learned";
    }).length;
    var reviewLeaves = leaves.filter(function (l) {
      return l.status === "review";
    }).length;
    var unsetLeaves = leaves.length - learnedLeaves - reviewLeaves;

    var retention = totalReviews
      ? Math.round(((yes + partial * 0.5) / totalReviews) * 100)
      : 0;

    var avgMastery = leaves.length
      ? Math.round(
          leaves.reduce(function (s, l) {
            return s + (l.mastery || 0);
          }, 0) / leaves.length,
        )
      : 0;

    var critical = leaves.filter(function (l) {
      return (l.mastery || 0) < CRITICAL_THRESHOLD;
    });

    var dueToday = pendingDue(todayISO()).length;

    function stat(val, lbl, bar) {
      var s = el("div", "stat");
      s.appendChild(el("div", "val", val));
      s.appendChild(el("div", "lbl", lbl));
      if (bar !== undefined) {
        var b = el("div", "bar");
        var i = el("i");
        i.style.width = clamp(bar, 0, 100) + "%";
        b.appendChild(i);
        s.appendChild(b);
      }
      return s;
    }

    function sectionHead(title, explanation) {
      var h = el("div", "stats-section-head");
      h.appendChild(el("h2", "stats-subhead", title));
      if (explanation)
        h.appendChild(el("p", "muted small stats-explain", explanation));
      return h;
    }

    if (!leaves.length) {
      box.appendChild(
        el(
          "div",
          "empty",
          "Pas encore de leçon à analyser : les statistiques apparaîtront dès qu'un module aura des sous-modules ou des révisions en cours.",
        ),
      );
      return;
    }

    // ---- section 1 : où j'en suis aujourd'hui ----
    // la question la plus immédiate : sur tout ce que je révise, qu'est-ce
    // qui est vraiment su, qu'est-ce qui doit être revu ? Répartition
    // toujours mise en avant en premier, avant tout chiffre plus abstrait.
    box.appendChild(
      sectionHead(
        "Où j'en suis aujourd'hui",
        "Sur " +
          leaves.length +
          " leçon(s) suivies, voici ce qui est acquis et ce qui reste fragile.",
      ),
    );
    var statusGrid = el("div", "stats-grid");
    statusGrid.appendChild(
      statPill("Compris", learnedLeaves, leaves.length, "learned"),
    );
    statusGrid.appendChild(
      statPill("À revoir", reviewLeaves, leaves.length, "review"),
    );
    statusGrid.appendChild(
      statPill("Non évalué", unsetLeaves, leaves.length, "unset"),
    );
    box.appendChild(statusGrid);

    var todayGrid = el("div", "stats-grid stats-grid-secondary");
    var dueStat = stat(
      String(dueToday),
      dueToday > 1
        ? "révisions à faire aujourd'hui"
        : "révision à faire aujourd'hui",
    );
    dueStat.classList.add("stat-primary");
    todayGrid.appendChild(dueStat);
    todayGrid.appendChild(
      stat(avgMastery + " %", "Maîtrise moyenne globale", avgMastery),
    );
    box.appendChild(todayGrid);

    // ---- section 2 : ce qui a besoin d'attention ----
    // la zone critique n'est plus juste "2 chiffres" mais LA liste
    // concrète des leçons fragiles, avec une explication de ce que le
    // seuil veut dire réellement.
    box.appendChild(
      sectionHead(
        "Ce qui a besoin d'attention",
        "Une leçon passe ici dès que sa maîtrise descend sous " +
          CRITICAL_THRESHOLD +
          " % : le signal qu'elle risque d'être oubliée si elle n'est pas revue bientôt.",
      ),
    );
    if (!critical.length) {
      box.appendChild(
        el("div", "empty", "Rien de critique en ce moment : bon rythme."),
      );
    } else {
      var critList = el("div", "cards critical-list");
      critical
        .slice()
        .sort(function (a, b) {
          return (a.mastery || 0) - (b.mastery || 0);
        })
        .slice(0, 8)
        .forEach(function (l) {
          var row = el("div", "card critical-row");
          var head = el("div", "card-head");
          var left = el("div");
          var crumb = pathOf(l.id);
          if (crumb.length > 1)
            left.appendChild(
              el(
                "div",
                "muted small breadcrumb",
                crumb.slice(0, -1).join(" / "),
              ),
            );
          left.appendChild(el("div", "card-title", l.name));
          head.appendChild(left);
          head.appendChild(masteryPill(l.mastery || 0));
          row.appendChild(head);
          critList.appendChild(row);
        });
      box.appendChild(critList);
      if (critical.length > 8)
        box.appendChild(
          el(
            "p",
            "muted small",
            "+ " +
              (critical.length - 8) +
              " autre(s) leçon(s) critique(s), triées par urgence.",
          ),
        );
    }

    // ---- section 3 : est-ce que je retiens vraiment ----
    // le taux de rétention est la métrique la moins intuitive du lot :
    // elle a besoin d'une vraie explication de comment elle est calculée,
    // pas juste un pourcentage nu.
    box.appendChild(
      sectionHead(
        "Est-ce que je retiens vraiment",
        totalReviews
          ? "Sur les " +
              totalReviews +
              " révisions déjà faites, ce taux compte une réponse « Oui » comme pleinement retenue et « Partiellement » comme à moitié : un indicateur de la solidité de vos acquis dans la durée, pas de la quantité de travail fournie."
          : "Ce taux se calcule à partir de vos auto-évaluations (Oui / Partiellement / Non) lors des révisions. Faites votre première révision dans l'onglet « Aujourd'hui » pour le voir apparaître.",
      ),
    );
    if (totalReviews) {
      var retentionGrid = el("div", "stats-grid");
      retentionGrid.appendChild(
        stat(retention + " %", "Taux de rétention estimé", retention),
      );
      retentionGrid.appendChild(
        stat(String(totalReviews), "Révisions déjà effectuées"),
      );
      box.appendChild(retentionGrid);
    } else {
      box.appendChild(
        el("div", "empty", "Aucune révision effectuée pour l'instant."),
      );
    }

    // ---- section 4 : par domaine ----
    // la racine n'accueille désormais QUE des catégories (Informatique,
    // Psychologie…), donc chaque univers d'apprentissage a sa propre
    // ligne, avec sa maîtrise agrégée et son nombre de leçons : utile dès
    // qu'on jongle entre plusieurs domaines complètement séparés.
    var cats = rootNodes();
    if (cats.length > 1) {
      box.appendChild(
        sectionHead(
          "Par domaine",
          "La maîtrise moyenne de chaque catégorie, pour comparer où porter l'effort entre vos différents univers d'apprentissage.",
        ),
      );
      var branchGrid = el("div", "stats-grid");
      cats.forEach(function (c) {
        var m = aggregatedMastery(c);
        var leafCount = leavesOf(c).length;
        var accentIdx =
          typeof c.accentIndex === "number" ? c.accentIndex % 8 : null;
        var s = stat(m + " %", leafCount + " leçon(s)", m);
        var titleRow = el("div", "stat-category-title");
        if (accentIdx !== null)
          titleRow.appendChild(el("span", "accent-dot accent-" + accentIdx));
        titleRow.appendChild(document.createTextNode(c.name));
        s.insertBefore(titleRow, s.firstChild);
        branchGrid.appendChild(s);
      });
      box.appendChild(branchGrid);
    }
  }

  function statPill(label, count, total, statusKey) {
    var pct = total ? Math.round((count / total) * 100) : 0;
    var s = el("div", "stat stat-" + statusKey);
    var row = el("div", "stat-status-row");
    row.appendChild(statusDot(statusKey));
    row.appendChild(el("div", "val", String(count)));
    s.appendChild(row);
    s.appendChild(el("div", "lbl", label + " (" + pct + " %)"));
    var b = el("div", "bar");
    var i = el("i");
    i.className = "bar-" + statusKey;
    i.style.width = pct + "%";
    b.appendChild(i);
    s.appendChild(b);
    return s;
  }

  /* ---------------------------------------------------------------
     6. INDEX INCRÉMENTAL (révisions)
  ---------------------------------------------------------------- */
  function reindexReview(r, oldDue) {
    if (oldDue && dueIndex.has(oldDue)) {
      var arr = dueIndex.get(oldDue).filter(function (x) {
        return x.revId !== r.id;
      });
      if (arr.length) dueIndex.set(oldDue, arr);
      else dueIndex.delete(oldDue);
    }
  }
  function addToIndex(nodeId, r) {
    var arr = dueIndex.get(r.due);
    if (!arr) {
      arr = [];
      dueIndex.set(r.due, arr);
    }
    arr.push({ nodeId: nodeId, revId: r.id });
  }

  async function completeReview(n, r, rating, note) {
    var t = todayISO();
    var oldDue = r.due;
    r.doneAt = t;
    r.rating = rating;
    reindexReview(r, oldDue);

    state.history.push({
      id: uid(),
      nodeId: n.id,
      nodeName: n.name,
      path: pathOf(n.id).join(" / "),
      kind: "review",
      date: t,
      rating: rating,
      note: note,
      label: r.label,
      ts: Date.now(),
      stamp: nowStamp(),
    });

    if (rating === "no") {
      var baseLabel = r.label.replace(/ \(reprise\)$/, "");
      var extra = {
        id: uid(),
        label: baseLabel + " (reprise)",
        offset: REDO_OFFSET,
        due: addDays(t, REDO_OFFSET),
        doneAt: null,
      };
      n.reviews.push(extra);
      addToIndex(n.id, extra);
      toast("Reprogrammé à J+3 (" + fmt(extra.due) + ")");
    } else {
      toast("Révision enregistrée");
    }
    await save();
    renderAll();
  }

  function takePendingDeletion() {
    if (!pendingDeletion) return null;
    var entry = pendingDeletion;
    pendingDeletion = null;
    clearTimeout(deleteUndoTimer);
    deleteUndoTimer = null;
    return entry;
  }

  async function commitPendingDeletion() {
    var entry = takePendingDeletion();
    if (!entry) return;
    entry.resolve();
    await save();
  }

  async function undoPendingDeletion() {
    var entry = takePendingDeletion();
    if (!entry) return;

    var existingIds = new Set(state.nodes.map(function (node) { return node.id; }));
    entry.nodes.forEach(function (node) {
      if (!existingIds.has(node.id)) {
        state.nodes.push(JSON.parse(JSON.stringify(node)));
        existingIds.add(node.id);
      }
    });

    var existingHistoryIds = new Set(state.history.map(function (item) { return item.id; }));
    entry.history.forEach(function (item) {
      if (!existingHistoryIds.has(item.id)) {
        state.history.push(JSON.parse(JSON.stringify(item)));
      }
    });

    var deletedIds = new Set(entry.nodes.map(function (node) { return node.id; }));
    if (entry.parentId) {
      var parent = state.nodes.find(function (node) { return node.id === entry.parentId; });
      if (parent) {
        var currentChildren = Array.isArray(parent.childrenIds) ? parent.childrenIds.slice() : [];
        var restoredChildren = [];
        entry.parentChildrenIds.forEach(function (id) {
          if (deletedIds.has(id) || nodeIndex.has(id)) restoredChildren.push(id);
        });
        currentChildren.forEach(function (id) {
          if (restoredChildren.indexOf(id) === -1) restoredChildren.push(id);
        });
        parent.childrenIds = restoredChildren;
      }
    }

    expandedNodes.add(entry.rootId);
    buildIndex();
    renderAll();
    entry.resolve();
    await save();
    toast("Suppression annulée : « " + entry.rootName + " » a été restauré.");
  }

  async function deleteNode(n) {
    if (pendingDeletion) await commitPendingDeletion();
    var kids = descendantsOf(n.id);
    var largeCategoryDelete = n.isCategory && kids.length > 10;
    var okc = await confirmModal({
      title: n.isCategory ? "Supprimer cette catégorie ?" : "Supprimer ce module ?",
      text: n.isCategory
        ? "« " + n.name + " » et TOUT son contenu (" + kids.length + " élément(s) : modules, sous-modules, historique lié) seront supprimés définitivement." + (largeCategoryDelete ? " Pour confirmer, retapez exactement le nom « " + n.name + " »." : " Cette action est irréversible.")
        : kids.length
          ? "« " + n.name + " » et ses " + kids.length + " sous-module(s) seront supprimés définitivement."
          : "« " + n.name + " » et ses échéances seront supprimés.",
      requireWord: largeCategoryDelete ? n.name : undefined,
    });
    if (!okc) return;

    var toRemove = new Set(
      [n.id].concat(
        kids.map(function (k) {
          return k.id;
        }),
      ),
    );
    var removedNodes = state.nodes.filter(function (x) { return toRemove.has(x.id); });
    var removedHistory = state.history.filter(function (entry) { return entry.nodeId && toRemove.has(entry.nodeId); });
    var parent = n.parentId ? nodeIndex.get(n.parentId) : null;
    var parentChildrenIds = parent && Array.isArray(parent.childrenIds)
      ? parent.childrenIds.slice()
      : [];

    var barrierResolve;
    var barrierPromise = new Promise(function (resolve) { barrierResolve = resolve; });
    pendingDeletion = {
      rootId: n.id,
      rootName: n.name,
      parentId: n.parentId,
      parentChildrenIds: parentChildrenIds,
      nodes: JSON.parse(JSON.stringify(removedNodes)),
      history: JSON.parse(JSON.stringify(removedHistory)),
      promise: barrierPromise,
      resolve: barrierResolve,
    };

    state.nodes = state.nodes.filter(function (x) { return !toRemove.has(x.id); });
    state.history = state.history.filter(function (entry) { return !entry.nodeId || !toRemove.has(entry.nodeId); });
    if (parent && Array.isArray(parent.childrenIds)) {
      parent.childrenIds = parent.childrenIds.filter(function (id) { return id !== n.id; });
    }
    expandedNodes.delete(n.id);
    detailExpanded.delete(n.id);
    buildIndex();
    renderAll();

    var deleteUndoDuration = n.isCategory && kids.length ? 10000 : 6500;
    deleteUndoTimer = setTimeout(function () {
      commitPendingDeletion().catch(function (error) {
        console.error("Validation finale de suppression impossible", error);
      });
    }, deleteUndoDuration);

    toast(
      n.isCategory ? "Catégorie supprimée" : "Module supprimé" + (kids.length ? " (avec sous-modules)" : ""),
      {
        label: "Annuler",
        duration: deleteUndoDuration,
        onClick: undoPendingDeletion,
      },
    );
  }

  /* ---------------------------------------------------------------
     7. EXPORT / IMPORT
  ---------------------------------------------------------------- */
  function exportPayload() {
    return {
      app: "my-revision-app",
      schema: SCHEMA_VERSION,
      exportedAt: todayISO(),
      nodes: state.nodes,
      history: state.history,
    };
  }

  async function exportData() {
    var payload = exportPayload();
    var json = JSON.stringify(payload, null, 2);
    var filename = "revision-export-" + todayISO() + ".json";

    // en environnement Tauri : dialogue natif "Enregistrer sous" pour que
    // l'emplacement soit un vrai choix, pas une supposition du navigateur
    if (storage.isTauri() && window.__TAURI__) {
      try {
        var api = window.__TAURI__;
        var dialog = api.dialog || (api.plugins && api.plugins.dialog);
        var fs = api.fs || (api.plugins && api.plugins.fs);
        if (dialog && dialog.save && fs && fs.writeTextFile) {
          var path = await dialog.save({
            defaultPath: filename,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (!path) {
            toast("Export annulé");
            return;
          }
          await fs.writeTextFile(path, json);
          toast("Exporté vers " + path);
          return;
        }
      } catch (e) {
        // si l'API Tauri de dialogue/fs n'est pas dispo (plugins non
        // installés côté src-tauri), on retombe sur le téléchargement
        // navigateur ci-dessous plutôt que d'échouer silencieusement
      }
    }

    // fallback navigateur : le fichier part dans le dossier de
    // téléchargements par défaut du système (pas configurable en JS pur) :
    // on le dit explicitement pour ne plus jamais se demander où il est passé
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    toast("Exporté dans votre dossier Téléchargements : " + filename);
  }

  function validateImportShape(data) {
    return validateImportPayload(data);
  }

  async function importData(file) {
    var text;
    try {
      text = await file.text();
    } catch (e) {
      toast("Impossible de lire le fichier");
      return;
    }
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      toast("Fichier JSON invalide : " + e.message);
      return;
    }

    var errors = validateImportShape(data);
    if (errors.length) {
      await confirmModal({
        title: "Import impossible (" + errors.length + " erreur(s))",
        text:
          errors.slice(0, 5).join(" : ") + (errors.length > 5 ? " : …" : ""),
      });
      return;
    }

    var incomingNodes = Array.isArray(data.nodes)
      ? data.nodes
      : migrateLegacy(data.modules);
    var incomingHistory = Array.isArray(data.history) ? data.history : [];

    var okc = await confirmModal({
      title: "Importer et écraser ?",
      text:
        "Le fichier contient " +
        incomingNodes.length +
        " module(s) et " +
        incomingHistory.length +
        " évènement(s) d'historique. Toutes les données actuelles seront remplacées.",
    });
    if (!okc) return;

    state.nodes = incomingNodes;
    state.history = incomingHistory;
    treeRenderLimit = 260;
    state.nodes.forEach(normalizeNode);
    assignMissingAccents(state.nodes);
    // un fichier importé venant d'avant les catégories peut lui aussi
    // contenir des modules orphelins à la racine : même traitement que
    // dans load(), regroupés sous une catégorie "Non classé" dédiée
    var importedOrphans = state.nodes.filter(function (n) {
      return !n.parentId && !n.isCategory;
    });
    if (importedOrphans.length) {
      var importedUncategorized = makeCategory(
        "Non classé (import)",
        countCategories(),
      );
      state.nodes.push(importedUncategorized);
      importedOrphans.forEach(function (n) {
        n.parentId = importedUncategorized.id;
      });
    }
    buildIndex();
    state.history = state.history.filter(function (entry) {
      return !entry.nodeId || nodeIndex.has(entry.nodeId);
    });
    await save();
    renderAll();
    toast(
      "Import réussi : " +
        incomingNodes.length +
        " module(s), " +
        incomingHistory.length +
        " évènement(s)",
    );
  }

  async function resetAll() {
    var first = await confirmModal({
      title: "Tout réinitialiser ?",
      text: "Cette action supprime définitivement modules, historique et statistiques.",
    });
    if (!first) return;
    var second = await confirmModal({
      title: "Confirmation finale",
      text: "Tapez SUPPRIMER en majuscules pour valider la suppression totale.",
      requireWord: "SUPPRIMER",
    });
    if (!second) return;
    state.nodes = [];
    state.history = [];
    expandedNodes.clear();
    detailExpanded.clear();
    treeRenderLimit = 260;
    buildIndex();
    await storage.remove(KEYS.nodes);
    await storage.remove(KEYS.history);
    await storage.remove("modules"); // ancienne clé, si présente
    renderAll();
    toast("Données réinitialisées");
  }

  /* ---------------------------------------------------------------
     8. PRÉ-REMPLISSAGE STRUCTURE (optionnel, un clic)
  ---------------------------------------------------------------- */
  var ARCHITECTE_FANTOME_SKELETON = [
    {
      name: "00-SOCLE",
      description:
        "Bases avant de coder sérieusement : mentalité, méthode de résolution de problèmes, fondamentaux du langage.",
      subs: [
        "Getting started",
        "Prologue",
        "Référentiel",
        "Fundamentals",
        "Problem solving",
        "Mindset",
      ],
    },
    {
      name: "01-CADRAGE",
      description:
        "Cadrer un problème avant de foncer : identifier le vrai besoin, gérer l'asynchrone, déboguer, découper un MVP.",
      subs: [
        "Problem hunt",
        "Async",
        "Debugging",
        "Error handling",
        "MVP split",
      ],
    },
    {
      name: "02-CONSTRUCTION",
      description:
        "Le gros du bâti technique : structures de données, algorithmes, patterns de conception, architecture, refactoring.",
      subs: [
        "User wizard",
        "Mini-projects",
        "Testing",
        "Math basics",
        "Mémoire & perf",
        "Data structures",
        "Algorithmes",
        "Design patterns",
        "Refactoring",
        "TypeScript",
        "Architecture patterns",
      ],
    },
    {
      name: "03-PILOTAGE",
      description:
        "Piloter un projet en prod : qualité, sécurité, observabilité, fiabilité, coûts et fondations cloud.",
      subs: [
        "Roadmap run",
        "Web inclusif",
        "Quality shield",
        "Security",
        "Observability",
        "Fiabilité & SLO",
        "Cloud foundations",
        "Produit, coût, ROI",
      ],
    },
    {
      name: "04-EPREUVE",
      description:
        "Mise à l'épreuve sur des cas concrets : temps réel, outillage IA, lecture de grosses bases de code, projet de synthèse.",
      subs: [
        "Bonus vault",
        "Tool cave",
        "Realtime",
        "AI-native dev",
        "Big app snoop",
        "Capstone arena",
      ],
    },
    {
      name: "05-MAITRISE",
      description:
        "Aller au bout : bases de données, scalabilité, cas limites, agents IA autonomes, autonomie complète au quotidien.",
      subs: [
        "Databases",
        "Scalability",
        "Edge cases",
        "AI agents & autonomie",
        "Day to legend",
      ],
    },
  ];

  async function seedArchitecteFantome() {
    var okc = await confirmModal({
      title: "Créer la structure Architecte Fantôme ?",
      text:
        "Ajoute une catégorie « Informatique » (si elle n'existe pas déjà) contenant " +
        ARCHITECTE_FANTOME_SKELETON.length +
        " blocs racine (avec une courte description de cadrage) et leurs sous-modules (vides, à détailler ensuite). N'écrase rien de ce qui existe déjà.",
    });
    if (!okc) return;
    var start = todayISO();

    // réutilise une catégorie "Informatique" déjà présente plutôt que
    // d'en recréer une à chaque clic : comportement identique à la
    // vérification de doublon du formulaire manuel de création
    var category = rootNodes()
      .filter(function (n) {
        return n.isCategory;
      })
      .find(function (n) {
        return n.name.toLowerCase() === "informatique";
      });
    if (!category) {
      category = makeCategory("Informatique", countCategories());
      state.nodes.push(category);
      nodeIndex.set(category.id, category);
    }

    var createdRoots = 0;
    var createdSubs = 0;
    ARCHITECTE_FANTOME_SKELETON.forEach(function (block) {
      var root = childrenOf(category.id).find(function (n) {
        return (
          !n.isCategory && n.name.toLowerCase() === block.name.toLowerCase()
        );
      });
      if (!root) {
        root = makeNode(block.name, category.id, start, 0);
        root.description = block.description || "";
        state.nodes.push(root);
        nodeIndex.set(root.id, root);
        attachChild(category.id, root.id);
        createdRoots++;
      } else if (!root.description && block.description) {
        root.description = block.description;
      }
      block.subs.forEach(function (subName) {
        var exists = childrenOf(root.id).some(function (n) {
          return n.name.toLowerCase() === subName.toLowerCase();
        });
        if (exists) return;
        var sub = makeNode(subName, root.id, start, 0);
        state.nodes.push(sub);
        attachChild(root.id, sub.id);
        createdSubs++;
      });
    });
    buildIndex();
    expandedNodes.add(category.id);
    await save();
    renderAll();
    toast(
      createdRoots || createdSubs
        ? "Structure Architecte Fantôme synchronisée · " +
            createdRoots +
            " bloc(s), " +
            createdSubs +
            " sous-module(s) ajouté(s)"
        : "Structure Architecte Fantôme déjà complète",
    );
  }

  function activateView(view) {
    if (view !== "dashboard" && currentCategoryId) closeCategory();
    currentView = view;
    Array.prototype.forEach.call(
      document.querySelectorAll(".tab"),
      function (tab) {
        var isActive = tab.getAttribute("data-view") === view;
        tab.classList.toggle("active", isActive);
        if (isActive) tab.setAttribute("aria-current", "page");
        else tab.removeAttribute("aria-current");
      },
    );
    Array.prototype.forEach.call(
      document.querySelectorAll(".view"),
      function (section) {
        section.classList.toggle("active", section.id === "view-" + view);
      },
    );
  }

  function isEditableTarget(target) {
    if (!target) return false;
    var tag = target.tagName && target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  async function showShortcutHelp() {
    if (!$("modal") || !$("modal").hidden) return;
    await confirmModal({
      title: "Raccourcis clavier",
      text: "Alt+1 à Alt+5  Naviguer entre les cinq vues\n/  Placer le focus sur la recherche de la vue active\nEsc  Fermer le formulaire repliable ouvert\n?  Afficher cette aide",
    });
  }

  function installGlobalShortcuts() {
    document.addEventListener("keydown", function (event) {
      if ($("modal") && !$("modal").hidden) return;

      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-5]$/.test(event.key)) {
        if (isEditableTarget(event.target)) return;
        var views = ["dashboard", "today", "history", "stats", "settings"];
        event.preventDefault();
        activateView(views[Number(event.key) - 1]);
        return;
      }

      if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (isEditableTarget(event.target)) return;
        var search = document.querySelector("#view-" + currentView + " input.search[type=search]");
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      if (event.key === "Escape") {
        var openForm = document.querySelector("#view-" + currentView + " details.collapsible-form[open]");
        if (openForm) {
          openForm.open = false;
          event.preventDefault();
        }
        return;
      }

      if (event.key === "?" && !isEditableTarget(event.target)) {
        event.preventDefault();
        showShortcutHelp();
      }
    });
  }

  /* ---------------------------------------------------------------
     9. BOOT
  ---------------------------------------------------------------- */
  async function boot() {
    var mode = await storage.init();
    await initTheme();
    await load();
    $("storageMode").textContent = mode;
    $("mStart").value = todayISO();
    renderAll();

    $("tabs").addEventListener("click", function (e) {
      var b = e.target.closest(".tab");
      if (!b) return;
      activateView(b.getAttribute("data-view"));
    });

    $("themeToggle").addEventListener("click", async function () {
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next, true);
      try {
        await storage.set(KEYS.theme, next);
      } catch (error) {
        console.error("Préférence de thème impossible à enregistrer", error);
        toast("Thème changé, mais préférence impossible à enregistrer");
      }
    });

    installGlobalShortcuts();

    $("categoryBackBtn").addEventListener("click", closeCategory);
    $("categoryAddModuleBtn").addEventListener("click", function(){ openModuleForm(currentCategoryId); });
    $("mParentSearch").addEventListener("input", function(){ filterParentOptions(this.value); });
    $("mParent").addEventListener("change", function(){ selectedParentId=this.value||null; });

    $("categoryForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = $("cName").value.trim();
      if (!name) {
        toast("Nom de catégorie requis");
        return;
      }
      var exists = rootNodes().some(function (n) {
        return n.isCategory && n.name.toLowerCase() === name.toLowerCase();
      });
      if (exists) {
        toast("Cette catégorie existe déjà");
        return;
      }
      var c = makeCategory(name, countCategories());
      state.nodes.push(c);
      buildIndex();
      await save();
      $("cName").value = "";
      selectedParentId = c.id; // pré-sélectionne la nouvelle catégorie pour enchaîner sur un module
      renderAll();
      toast("Catégorie créée");
    });

    $("moduleForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = $("mName").value.trim();
      var start = $("mStart").value;
      var dur = parseInt($("mDuration").value, 10) || 0;
      var parentId = $("mParent").value || null;
      var description = $("mDescription").value.trim();
      var takeaway = $("mTakeaway").value.trim();
      if (!parentId) {
        toast("Choisissez une catégorie ou un module parent");
        return;
      }
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        toast("Nom et date requis");
        return;
      }
      var n = makeNode(name, parentId, start, dur);
      n.description = description;
      n.keyTakeaway = takeaway;
      state.nodes.push(n);
      if (parentId) {
        var p = nodeIndex.get(parentId);
        if (p) {
          if (!Array.isArray(p.childrenIds)) p.childrenIds = [];
          p.childrenIds.push(n.id);
        }
        expandedNodes.add(parentId);
      }
      // reconstruction complète de l'index (nodeIndex/childrenIndex/dueIndex)
      // depuis state.nodes : plus sûr qu'une mise à jour incrémentale pour un
      // évènement peu fréquent comme un ajout, et évite les désync du type
      // "racine jamais ajoutée à childrenIndex.get('root')"
      buildIndex();
      await save();
      $("mName").value = "";
      $("mDescription").value = "";
      $("mTakeaway").value = "";
      renderAll();
      var parentNode = nodeIndex.get(parentId);
      toast(
        parentNode && parentNode.isCategory
          ? "Module ajouté sous « " + parentNode.name + " »"
          : "Sous-module ajouté",
      );
    });

    $("search").addEventListener("input", function () {
      treeQuery = this.value.trim();
      treeRenderLimit = 260;
      clearTimeout(searchDebounceTimer);
      var value = this.value;
      searchDebounceTimer = setTimeout(function () {
        if (value === $("search").value) renderTree();
      }, 180);
    });
    $("statusFilter").addEventListener("change", function () {
      treeFilterStatus = this.value;
      renderTree();
    });
    $("expandAllBtn").addEventListener("click", function () {
      var scope = currentCategoryId ? descendantsOf(currentCategoryId) : [];
      scope.forEach(function (n) { if (childrenOf(n.id).length) expandedNodes.add(n.id); });
      renderTree();
    });
    $("collapseAllBtn").addEventListener("click", function () {
      var scope = currentCategoryId ? descendantsOf(currentCategoryId) : [];
      scope.forEach(function (n) { expandedNodes.delete(n.id); });
      renderTree();
    });

    $("historyFilter").addEventListener("input", renderHistory);
    $("historyTypeFilter").addEventListener("change", renderHistory);
    $("exportBtn").addEventListener("click", exportData);
    $("importBtn").addEventListener("click", function () {
      $("importFile").click();
    });
    $("importFile").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = "";
    });
    $("resetBtn").addEventListener("click", resetAll);
    $("seedBtn").addEventListener("click", seedArchitecteFantome);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
