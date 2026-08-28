import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateImportPayload } from "../src/core/validation.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const good = { nodes: [
  { id: "cat", parentId: null, isCategory: true, name: "Catégorie" },
  { id: "a", parentId: "cat", isCategory: false, name: "A", mastery: 10 },
  { id: "b", parentId: "cat", isCategory: false, name: "B", mastery: 90 },
], history: [] };
assert(validateImportPayload(good).length === 0, "Valid import rejected");
assert(validateImportPayload({ nodes: [
  { id: "a", parentId: "b", name: "A" },
  { id: "b", parentId: "a", name: "B" },
]}).some(x => x.includes("Cycle")), "Cycle was not rejected");
assert(validateImportPayload({ nodes: [
  { id: "a", parentId: "missing", name: "A" },
]}).some(x => x.includes("Parent introuvable")), "Missing parent was not rejected");

const html = read("src/index.html");
assert(!/<script>(?![\s\S]*<\/script>)/.test(html), "Unexpected inline script tag remains");
assert(html.includes('type="module" src="script.js"'), "Main script is not a module");
assert(html.includes('register-service-worker.js'), "External service-worker registration missing");

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert(typeof conf.app.security.csp === "string" && conf.app.security.csp.includes("default-src 'self'"), "Restrictive CSP missing");
assert(fs.existsSync(path.join(root, "src-tauri/capabilities/default.json")), "Tauri capability file missing");
for (const asset of ["script.js", "register-service-worker.js", "core/storage.js", "core/validation.js", "ui/modal.js"]) assert(fs.existsSync(path.join(root, "src", asset)), `Offline shell asset missing: ${asset}`);
assert(read("src-tauri/Cargo.toml").includes("tauri-plugin-store"), "Tauri Store dependency missing");
assert(read("src-tauri/Cargo.toml").includes("tauri-plugin-dialog") && read("src-tauri/Cargo.toml").includes("tauri-plugin-fs"), "Native export plugins missing");
assert(read("src-tauri/src/main.rs").includes("tauri_plugin_store::Builder") && read("src-tauri/src/main.rs").includes("tauri_plugin_dialog::init") && read("src-tauri/src/main.rs").includes("tauri_plugin_fs::init"), "Tauri plugins are not registered");

console.log("Smoke tests OK");
