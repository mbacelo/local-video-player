# Local Video Player

A local video player with a YouTube-style interface, a persistent library, and
watched-segment tracking. Your videos are read straight off your disk and are
**never uploaded anywhere**.

No build step, no dependencies, no framework — plain HTML, CSS and ES modules.

## Deploying to GitHub Pages

Push this repository to GitHub, then in the repo: **Settings → Pages → Build and
deployment → Deploy from a branch → `main` → `/ (root)`**.

The site appears at `https://<your-user>.github.io/local-video-player/` a minute or so
later. There is no build step — Pages serves these files as they are.

Hosting the app publicly does **not** make your videos public. Only the app's own
HTML, CSS and JS are uploaded. Videos are read from your disk by the browser and
never leave your machine.

## Running it locally (for testing)

From the project folder:

```powershell
python -m http.server 8787 --bind 127.0.0.1
```

Then open **http://127.0.0.1:8787**. Stop it with `Ctrl+C` when you're done.

## Why it needs HTTPS or localhost

Opening `index.html` directly as a `file://` page **breaks the library**. Browsers
treat `file://` as an opaque, insecure origin, which disables IndexedDB and the
File System Access API. Those two are exactly what lets the app remember your
videos: a page is never allowed to reopen a file by path, so the library stores a
*file handle* instead — and handles can only be saved on a secure origin.

Secure origins are `https://` (GitHub Pages qualifies) and `localhost` /
`127.0.0.1`, which browsers exempt. Plain `http://` on a public domain does not.

### Your library does not move between origins

Everything the app remembers — library entries, thumbnails, watch history and
granted file permissions — lives in IndexedDB **keyed to the origin**. Testing on
`http://127.0.0.1:8787` and using the deployed site on `github.io` are two
completely separate databases; nothing transfers between them. Nothing is lost,
but pick one origin for real use and stay on it.

One more difference when hosted: `navigator.storage.persist()` is granted almost
automatically on localhost, but on a remote origin Chrome usually wants signals
like a bookmark or repeat visits first. Until it is granted, the library can be
evicted under disk pressure. Bookmarking the site is enough in practice.

## Using it

**Add videos** by dragging them anywhere onto the page, or with the *Add videos*
/ *Add folder* buttons.

- Drop a **single video** → it starts playing immediately.
- Drop **several files or a folder** → they are added to the library.
- A dropped folder is remembered, so videos you add to it later show up on your
  next visit automatically.

**Watch tracking.** The grey band on the scrub bar shows the parts you have
already seen. Seeking past a section does not mark it watched — only real
playback does. At 90% coverage a video is badged **Watched** in the library, and
reopening a finished video jumps to the first part you never saw.

**Picture quality.** The video always decodes at its native resolution and is
scaled to the window without cropping.

**The library** supports search, sorting, removing a single video (with undo),
and *Clear library*, which asks for confirmation first. Removing or clearing only
forgets entries in this browser — **no file on disk is ever modified or
deleted**.

## Installing it as an app

The app is a PWA, so it can be installed and run in its own window with no
browser chrome, and launched from the Start menu, taskbar or dock.

Install it from the browser, on a secure origin (the deployed GitHub Pages site,
or `localhost`): use the install icon in the address bar, or **⋮ → Cast, save and
share → Install page as app** in Chrome / **⋯ → Apps → Install this site as an
app** in Edge. The app deliberately shows no install button of its own.

The service worker caches the app shell (HTML, CSS, JS, icons), so the installed
app opens instantly and works with no network at all. **Videos are not cached** —
they are read from your disk on demand and never enter the cache. When a new
version is deployed, a *A new version is ready* toast offers to reload.

To uninstall: open the app, then **⋮ → Uninstall**. That removes the window, not
your library — the IndexedDB data belongs to the origin and survives.

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere in the app for the full list.

| Key | Action | | Key | Action |
| --- | --- | --- | --- | --- |
| `Space` | Play / pause | | `M` | Mute |
| `←` / `→` | ∓5 seconds | | `↑` / `↓` | Volume ±5% |
| `Shift` + `←` / `→` | ∓30 seconds | | `F` | Fullscreen |
| `Shift` + `,` / `.` | Playback speed | | `?` | Show shortcuts |
| | | | `Esc` | Exit fullscreen, or back to library |

## Limitations

These come from the browser, not the app:

- **Chrome and Edge only.** Firefox and Safari lack the File System Access API,
  so the library cannot be remembered there.
- **One permission click per session.** The first time you play a video after
  opening the page, Chrome asks for permission to read it. This is a security
  rule that cannot be waived. Adding videos as a **folder** avoids the repetition
   — one grant covers everything inside it.
- **Codecs.** MP4/H.264, WebM and most MOV files play. `.mkv`, `.avi` and HEVC
  usually will not decode, and are flagged *May not play* in the library.
  Converting to MP4 (H.264) or WebM fixes it.
- **Moving or renaming a file** breaks its handle. The entry is marked as moved
  but keeps its watch history; re-add the file to restore playback.

## Layout

```
index.html                    markup for the library and the player
css/styles.css                all styling
js/db.js                      IndexedDB: handles, metadata, watch state
js/library.js                 adding, folder scanning, permissions, thumbnails
js/progress.js                watched-interval math (pure functions)
js/player.js                  playback, controls, shortcuts
js/ui.js                      library UI, modals, drag & drop, app wiring
js/pwa.js                     service worker registration, update prompt
sw.js                         offline cache for the app shell (not videos)
manifest.webmanifest          PWA metadata: name, icons, standalone window
icons/                        app icons (192, 512, maskable, apple-touch)
.nojekyll                     tells GitHub Pages to serve the files as-is
```

Data lives in the `local-video-player` IndexedDB database, scoped to whichever origin
you loaded the app from. *Clear library* empties it; clearing the site's data in
Chrome does the same.

`window.localVideoViewer` is exposed in the console (`state`, `player`, `db`, `lib`,
`reload`, `toast`) if you ever need to inspect or debug the library by hand.
