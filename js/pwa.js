/**
 * Progressive-web-app plumbing: service worker registration, the install
 * button, and the "an update is ready" prompt.
 *
 * All of it is optional. On a browser without service workers, or on an
 * insecure origin, every entry point here quietly no-ops and the app runs
 * exactly as it did before.
 */

let deferredPrompt = null;

/* --------------------------------------------------------------- installing */

/**
 * Chrome fires `beforeinstallprompt` when the app qualifies for installation.
 * Stashing the event lets us show our own button instead of the browser's
 * omnibox affordance, which is easy to miss.
 */
function bindInstallButton(button, onToast) {
  if (!button) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
  });

  button.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    button.disabled = true;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') button.hidden = true;
    } finally {
      // The event is single-use; a dismissed prompt is re-offered by the
      // browser later with a fresh one.
      deferredPrompt = null;
      button.disabled = false;
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    button.hidden = true;
    onToast?.('Installed. You can now launch the player from your apps list.');
  });

  // Already running as an installed app: nothing to offer.
  if (window.matchMedia('(display-mode: standalone)').matches) button.hidden = true;
}

/* ------------------------------------------------------------- service worker */

function watchForUpdate(registration, onToast) {
  const offerReload = (worker) => {
    onToast?.('A new version is ready.', {
      actionLabel: 'Reload',
      duration: 15000,
      onAction: () => worker.postMessage('skip-waiting'),
    });
  };

  // A worker already waiting means the page was opened after an update landed.
  if (registration.waiting && navigator.serviceWorker.controller) {
    offerReload(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // `controller` is null on the very first install -- that is a fresh
      // cache, not an update, and must not nag the user to reload.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        offerReload(worker);
      }
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

async function registerServiceWorker(onToast) {
  if (!('serviceWorker' in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register('sw.js', {
      scope: './',
    });
    watchForUpdate(registration, onToast);
    return registration;
  } catch {
    // Insecure origin, blocked by policy, or file:// -- the app still works.
    return null;
  }
}

/**
 * @param {object} options
 * @param {HTMLElement|null} options.installButton
 * @param {(message: string, opts?: object) => void} [options.onToast]
 */
export function initPwa({ installButton, onToast } = {}) {
  bindInstallButton(installButton, onToast);
  return registerServiceWorker(onToast);
}
