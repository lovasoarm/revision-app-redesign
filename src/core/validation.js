export function validateImportPayload(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return ["Le fichier doit contenir un objet JSON."];
  }
  if (!Array.isArray(data.nodes) && !Array.isArray(data.modules)) {
    errors.push('Champ "nodes" ou "modules" manquant (liste attendue).');
  }
  if (data.history !== undefined && !Array.isArray(data.history)) {
    errors.push('Champ "history" invalide (doit être une liste).');
  }
  const nodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.modules) ? data.modules : []);
  const ids = new Set();
  const byId = new Map();

  nodes.forEach((node, index) => {
    if (!node || typeof node !== "object") {
      errors.push(`Nœud #${index + 1} invalide.`);
      return;
    }
    if (!node.id) {
      if (Array.isArray(data.nodes)) errors.push(`Nœud #${index + 1} : id invalide.`);
    } else if (typeof node.id !== "string") {
      errors.push(`Nœud #${index + 1} : id invalide.`);
    } else if (ids.has(node.id)) {
      errors.push(`ID dupliqué : ${node.id}.`);
    } else {
      ids.add(node.id);
      byId.set(node.id, node);
    }
    if (typeof node.name !== "string" || !node.name.trim()) errors.push(`Nœud ${node.id || `#${index + 1}`} : nom invalide.`);
    if (node.parentId !== undefined && node.parentId !== null && typeof node.parentId !== "string") {
      errors.push(`Nœud ${node.id || `#${index + 1}`} : parentId invalide.`);
    }
    if (node.mastery !== undefined && (typeof node.mastery !== "number" || node.mastery < 0 || node.mastery > 100)) {
      errors.push(`Nœud ${node.id || `#${index + 1}`} : mastery doit être entre 0 et 100.`);
    }
    if (node.isCategory && node.parentId) errors.push(`Catégorie ${node.id} : une catégorie doit être à la racine.`);
  });

  nodes.forEach(node => {
    if (!node || !node.parentId) return;
    if (!byId.has(node.parentId)) errors.push(`Parent introuvable pour ${node.id} : ${node.parentId}.`);
  });

  // Détection de cycles par DFS couleur : blanc=0, gris=1, noir=2.
  const color = new Map();
  for (const id of byId.keys()) color.set(id, 0);
  function visit(id) {
    const c = color.get(id);
    if (c === 1) return true;
    if (c === 2) return false;
    color.set(id, 1);
    const node = byId.get(id);
    if (node && node.parentId && byId.has(node.parentId) && visit(node.parentId)) return true;
    color.set(id, 2);
    return false;
  }
  for (const id of byId.keys()) {
    if (visit(id)) {
      errors.push("Cycle détecté dans la hiérarchie : l'import est bloqué.");
      break;
    }
  }

  return [...new Set(errors)];
}



/**
 * Minimal validateItem helper (keeps compatibility for tests).
 * Adjust business rules as needed.
 */
export function validateItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (!item.id) return false;
  if (!item.name) return false;
  return true;
}
