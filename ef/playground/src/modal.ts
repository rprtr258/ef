// modal.ts — the name-prompt modal (new/rename/delete file, new project).
// setupModal wires its own listeners; confirmModal resolves the pending
// callback with the input value.
import {editor} from "./editor.ts";
import {els} from "./state.ts";

export type ModalSpec = {title: string, value: string, ok: string, onOk: (v: string) => void};

let modalOnOk: ((v: string) => void) | null = null;

export function openModal(spec: ModalSpec): void {
  modalOnOk = spec.onOk;
  els.modalTitle.textContent = spec.title;
  els.modalInput.value = spec.value;
  els.modalOk.textContent = spec.ok;
  els.modal.classList.remove("hidden");
  els.modalInput.focus();
  els.modalInput.select();
}

export function closeModal(): void {
  els.modal.classList.add("hidden");
  modalOnOk = null;
  editor?.focus();
}

export function confirmModal(): void {
  const cb = modalOnOk;
  closeModal();
  cb?.(els.modalInput.value);
}

export function setupModal(): void {
  els.modalOk.addEventListener("click", () => confirmModal());
  els.modalCancel.addEventListener("click", () => closeModal());
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });
  els.modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmModal();
    else if (e.key === "Escape") closeModal();
  });
}
