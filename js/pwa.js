/**
 * Progressive-web-app plumbing: service worker registration and the
 * "an update is ready" prompt.
 *
 * Installation is left entirely to the browser's own affordance (the address
 * bar icon, or the menu). `beforeinstallprompt` is deliberately never
 * intercepted -- calling preventDefault on it is what would suppress that
 * built-in offer.
 *
 * All of this is optional. On a browser without service workers, or on an
 * insecure origin, every entry point here quietly no-ops and the app runs
 * exactly as it did before.
 */

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
 * @param {(message: string, opts?: object) => void} [options.onToast]
 */
export function initPwa({ onToast } = {}) {
  return registerServiceWorker(onToast);
}
