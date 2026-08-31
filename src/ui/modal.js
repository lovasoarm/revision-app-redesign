
/**
 * modal.js - improved accessibility and focus management
 * - traps focus inside modal while open
 * - restores focus on close
 * - toggles aria-hidden on main content
 */

export function createConfirmModal($, toast) {
  let previousFocus = null;
  let keydownHandler = null;

  return function confirmModal(opts) {
    return new Promise(resolve => {
      const back = $("modal");
      const dialog = back.querySelector(".modal");
      const input = $("modalInput");
      const okButton = $("modalOk");
      const cancelButton = $("modalCancel");
      previousFocus = document.activeElement;

      $("modalTitle").textContent = opts.title;
      $("modalText").textContent = opts.text || "";
      input.value = "";
      input.hidden = !opts.requireWord;
      input.placeholder = opts.requireWord || "";
      back.hidden = false;
      back.setAttribute("aria-hidden", "false");
      dialog.setAttribute("aria-labelledby", "modalTitle");
      dialog.setAttribute("aria-describedby", "modalText");

      const focusables = () => Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled])'))
        .filter(node => !node.hidden && node.offsetParent !== null);

      function cleanup(result) {
        back.hidden = true;
        back.setAttribute("aria-hidden", "true");
        okButton.removeEventListener("click", ok);
        cancelButton.removeEventListener("click", cancel);
        back.removeEventListener("click", onBack);
        document.removeEventListener("keydown", keydownHandler);
        if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
        resolve(result);
      }
      function ok() {
        if (opts.requireWord && input.value.trim() !== opts.requireWord) {
          toast("Tapez exactement « " + opts.requireWord + " »");
          input.focus();
          return;
        }
        cleanup(true);
      }
      function cancel() { cleanup(false); }
      function onBack(event) { if (event.target === back) cleanup(false); }
      keydownHandler = event => {
        if (event.key === "Escape") { event.preventDefault(); cleanup(false); return; }
        if (event.key !== "Tab") return;
        const items = focusables();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };

      okButton.addEventListener("click", ok);
      cancelButton.addEventListener("click", cancel);
      back.addEventListener("click", onBack);
      document.addEventListener("keydown", keydownHandler);
      setTimeout(() => (opts.requireWord ? input : cancelButton).focus(), 0);
    });
  };
}
