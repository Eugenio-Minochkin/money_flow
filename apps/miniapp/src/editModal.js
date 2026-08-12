export function createEditModalController({
  modal,
  backdrop,
  modalBody,
  title,
  documentBody,
  pageRoot = null,
  getScrollY = () => globalThis.window?.scrollY ?? 0,
  restoreScroll = (scrollY) => globalThis.window?.scrollTo?.({ top: scrollY, left: 0, behavior: "instant" })
}) {
  let activeForm = null;
  let sourceParent = null;
  let sourceNextSibling = null;
  let sourceWasHidden = true;
  let sourceScrollY = 0;
  let onClose = null;

  function open({ form, titleText, onClose: closeCallback = null }) {
    if (!form || !modal || !backdrop || !modalBody || !title || !documentBody) return false;
    if (activeForm) close();

    activeForm = form;
    sourceParent = form.parentNode;
    const sourceChildren = sourceParent?.children ? Array.from(sourceParent.children) : [];
    const sourceIndex = sourceChildren.indexOf(form);
    sourceNextSibling = form.nextSibling ?? (sourceIndex >= 0 ? sourceChildren[sourceIndex + 1] : null);
    sourceWasHidden = form.classList.contains("hidden");
    sourceScrollY = getScrollY();
    onClose = closeCallback;

    title.textContent = titleText;
    modalBody.appendChild(form);
    form.classList.remove("hidden");
    backdrop.classList.remove("hidden");
    modal.classList.remove("hidden");
    documentBody.classList.add("edit-modal-open");
    pageRoot?.setAttribute?.("inert", "");
    return true;
  }

  function close() {
    if (!activeForm) return false;

    const closedForm = activeForm;
    const closedParent = sourceParent;
    const closedNextSibling = sourceNextSibling;
    const closedWasHidden = sourceWasHidden;
    const closedScrollY = sourceScrollY;
    const closeCallback = onClose;

    activeForm = null;
    sourceParent = null;
    sourceNextSibling = null;
    onClose = null;

    backdrop.classList.add("hidden");
    modal.classList.add("hidden");
    documentBody.classList.remove("edit-modal-open");
    pageRoot?.removeAttribute?.("inert");
    if (closedParent) {
      if (closedNextSibling?.parentNode === closedParent) closedParent.insertBefore(closedForm, closedNextSibling);
      else closedParent.appendChild(closedForm);
    }
    if (closedWasHidden) closedForm.classList.add("hidden");
    else closedForm.classList.remove("hidden");
    closeCallback?.();
    restoreScroll(closedScrollY);
    return true;
  }

  return {
    open,
    close,
    restore: () => restoreScroll(sourceScrollY),
    isOpen: () => Boolean(activeForm)
  };
}

export async function runEditModalSave({ save, refresh, close, restore = null }) {
  const result = await save();
  close();
  try {
    await refresh();
  } finally {
    restore?.();
  }
  return result;
}
