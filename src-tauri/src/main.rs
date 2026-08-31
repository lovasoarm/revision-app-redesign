// Empêche l'ouverture d'une console Windows en plus de la fenêtre de l'application
// une fois compilé en mode release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // Persistance native : lit/écrit revision-data.json dans le dossier de
        // données de l'application. Utilisé par hasTauri()/init() dans
        // src/core/storage.js, exposé côté front via window.__TAURI__.store.
        .plugin(tauri_plugin_store::Builder::default().build())
        // Dialogue natif « Enregistrer sous » pour l'export JSON.
        // Utilisé par exportData() dans src/script.js.
        .plugin(tauri_plugin_dialog::init())
        // Écriture du fichier exporté à l'emplacement choisi dans le dialogue
        // ci-dessus (fs.writeTextFile dans exportData()).
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
