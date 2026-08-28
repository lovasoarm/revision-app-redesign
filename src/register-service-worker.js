if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" }).catch(error => {
      console.warn("Service worker indisponible", error);
    });
  });
}
