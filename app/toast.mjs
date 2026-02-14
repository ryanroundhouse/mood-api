const TOAST_CONTAINER_ID = 'toastContainer';
const DEFAULT_DURATION_MS = 3000;
const MAX_TOASTS = 3;

function ensureToastContainer() {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (container) return container;

  container = document.createElement('div');
  container.id = TOAST_CONTAINER_ID;
  container.className = 'toast-container';
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-relevant', 'additions text');

  document.body.appendChild(container);
  return container;
}

function dismissToast(toastEl) {
  if (!toastEl) return;
  if (toastEl.classList.contains('toast--hide')) return;

  toastEl.classList.add('toast--hide');
  const removeAfterMs = 200;
  setTimeout(() => {
    toastEl.remove();
  }, removeAfterMs);
}

/**
 * Show a toast message.
 *
 * @param {string} message
 * @param {{ variant?: 'success'|'error'|'info', durationMs?: number }} [options]
 */
export function showToast(message, options = {}) {
  const variant = options.variant || 'success';
  const durationMs =
    typeof options.durationMs === 'number' ? options.durationMs : DEFAULT_DURATION_MS;

  const container = ensureToastContainer();

  // Keep the stack compact and non-obtrusive
  while (container.children.length >= MAX_TOASTS) {
    container.removeChild(container.firstElementChild);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const msg = document.createElement('div');
  msg.className = 'toast__message';
  msg.textContent = String(message ?? '');

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(toast));

  toast.appendChild(msg);
  toast.appendChild(close);
  container.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(() => dismissToast(toast), durationMs);
  }
}

