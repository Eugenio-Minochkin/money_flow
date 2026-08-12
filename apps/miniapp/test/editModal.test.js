import test from "node:test";
import assert from "node:assert/strict";
import { createEditModalController, runEditModalSave } from "../src/editModal.js";

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

function element({ classes = [] } = {}) {
  const attributes = new Map();
  return {
    children: [],
    classList: classList(classes),
    parentNode: null,
    textContent: "",
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
    appendChild(child) {
      child.parentNode?.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, reference) {
      child.parentNode?.removeChild(child);
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
  };
}

test("expense editor opens over its current screen and cancel restores the exact scroll position", () => {
  const modal = element({ classes: ["hidden"] });
  const backdrop = element({ classes: ["hidden"] });
  const modalBody = element();
  const title = element();
  const documentBody = element();
  const pageRoot = element();
  const source = element();
  const form = element({ classes: ["hidden"] });
  const marker = element();
  source.appendChild(form);
  source.appendChild(marker);
  const restored = [];
  let closed = 0;
  const controller = createEditModalController({
    modal,
    backdrop,
    modalBody,
    title,
    documentBody,
    pageRoot,
    getScrollY: () => 684,
    restoreScroll: (value) => restored.push(value)
  });

  controller.open({ form, titleText: "Expense: Cinema", onClose: () => { closed += 1; } });

  assert.equal(title.textContent, "Expense: Cinema");
  assert.equal(form.parentNode, modalBody);
  assert.equal(form.classList.contains("hidden"), false);
  assert.equal(modal.classList.contains("hidden"), false);
  assert.equal(backdrop.classList.contains("hidden"), false);
  assert.equal(documentBody.classList.contains("edit-modal-open"), true);
  assert.equal(pageRoot.hasAttribute("inert"), true);

  controller.close();

  assert.deepEqual(source.children, [form, marker]);
  assert.equal(form.classList.contains("hidden"), true);
  assert.equal(modal.classList.contains("hidden"), true);
  assert.equal(backdrop.classList.contains("hidden"), true);
  assert.equal(documentBody.classList.contains("edit-modal-open"), false);
  assert.equal(pageRoot.hasAttribute("inert"), false);
  assert.deepEqual(restored, [684]);
  assert.equal(closed, 1);
});

test("successful edit closes at the mutation boundary and restores context after refresh", async () => {
  const calls = [];

  await runEditModalSave({
    save: async () => calls.push("save"),
    refresh: async () => calls.push("refresh"),
    close: () => calls.push("close"),
    restore: () => calls.push("restore")
  });

  assert.deepEqual(calls, ["save", "close", "refresh", "restore"]);
});

test("failed edit keeps the modal open and does not refresh the current view", async () => {
  const calls = [];

  await assert.rejects(() => runEditModalSave({
    save: async () => { calls.push("save"); throw new Error("save_failed"); },
    refresh: async () => calls.push("refresh"),
    close: () => calls.push("close")
  }), /save_failed/);

  assert.deepEqual(calls, ["save"]);
});

test("planned editor uses the same modal controller and restores its inline form host", () => {
  const modal = element({ classes: ["hidden"] });
  const backdrop = element({ classes: ["hidden"] });
  const modalBody = element();
  const title = element();
  const documentBody = element();
  const plannedHost = element();
  const plannedForm = element({ classes: ["form-stack", "hidden"] });
  plannedHost.appendChild(plannedForm);
  const controller = createEditModalController({ modal, backdrop, modalBody, title, documentBody });

  controller.open({ form: plannedForm, titleText: "Edit planned payment" });
  assert.equal(controller.isOpen(), true);
  assert.equal(plannedForm.parentNode, modalBody);

  controller.close();
  assert.equal(controller.isOpen(), false);
  assert.equal(plannedForm.parentNode, plannedHost);
  assert.equal(plannedForm.classList.contains("hidden"), true);
});
