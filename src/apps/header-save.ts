// A Save button in the window's title bar, which turns amber with a leading dot once anything on the
// form has been touched.
//
// Deliberately a second copy of `noodlr`'s `apps/header-save.ts` rather than a shared import: neither
// module depends on the other and that is the whole architecture, so the ten lines are cheaper than the
// coupling. Behaviour and class name are kept identical on purpose — a GM moving between the two
// settings surfaces should not be able to tell which module drew the window.

/** Resolve the form element for an app whose root is (or contains) a <form>. */
function findForm(root: HTMLElement): HTMLFormElement | null {
  if (root.tagName === "FORM") return root as HTMLFormElement;
  return root.querySelector<HTMLFormElement>("form");
}

/**
 * Ensure a header Save button exists and is wired to the current form. Idempotent: call from
 * `_onRender`, which runs again after every re-render.
 */
export function installHeaderSaveButton(app: unknown, label: string): void {
  const root = (app as { element?: HTMLElement | null })?.element ?? null;
  if (!root) return;
  const header =
    root.querySelector<HTMLElement>(".window-header") ??
    root.closest?.(".application")?.querySelector<HTMLElement>(".window-header") ??
    null;
  const form = findForm(root);
  if (!header || !form) return;

  let btn = header.querySelector<HTMLButtonElement>(".noodlr-header-save");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "noodlr-header-save";
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i><span>${label}</span>`;
    btn.setAttribute("aria-label", label);
    // Sit just before the first window control, at the right edge.
    const firstControl = header.querySelector<HTMLElement>(
      '.header-control, [data-action="close"], .window-controls',
    );
    if (firstControl) header.insertBefore(btn, firstControl);
    else header.appendChild(btn);
    btn.addEventListener("click", () => findForm(root)?.requestSubmit());
  }
  const saveBtn = btn;
  const setDirty = (dirty: boolean) => saveBtn.classList.toggle("is-dirty", dirty);

  // Re-wire the CURRENT form each render: a PART re-render replaces the inner content, so a fresh
  // render starts pristine. The dataset guard is what stops a second listener stacking up per render.
  if (!form.dataset.noodlrSaveWired) {
    form.dataset.noodlrSaveWired = "1";
    form.addEventListener("input", () => setDirty(true));
    form.addEventListener("change", () => setDirty(true));
    form.addEventListener("submit", () => setDirty(false));
  }
  setDirty(false);
}
