# Video Viewer

A local video player with a YouTube-style interface, a persistent library, and
watched-segment tracking. Your videos are read straight off your disk and are
**never uploaded anywhere**.

No build step, no dependencies, no framework — plain HTML, CSS and ES modules.

## Deploying to GitHub Pages

Push this repository to GitHub, then in the repo: **Settings → Pages → Build and
deployment → Deploy from a branch → `main` → `/ (root)`**.

The site appears at `https://<your-user>.github.io/video-viewer/` a minute or so
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

**Picture quality.** The video always decodes at its native resolution. The fit
button (or `R`) cycles three layouts:

| Mode | Behaviour |
| --- | --- |
| Fit | Scaled to the window, nothing cropped (default) |
| Fill | Fills the window, edges cropped |
| Native 1:1 | Exact source pixels, no resampling at all — scroll to pan |

**The library** supports search, sorting, removing a single video (with undo),
and *Clear library*, which asks for confirmation first. Removing or clearing only
forgets entries in this browser — **no file on disk is ever modified or
deleted**.

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere in the app for the full list.

| Key | Action | | Key | Action |
| --- | --- | --- | --- | --- |
| `Space` `K` | Play / pause | | `M` | Mute |
| `J` / `L` | ∓10 seconds | | `↑` / `↓` | Volume ±5% |
| `←` / `→` | ∓5 seconds | | `F` | Fullscreen |
| `,` / `.` | Frame step (paused) | | `T` | Theater mode |
| `<` / `>` | Playback speed | | `I` | Picture-in-picture |
| `0`–`9` | Jump to 0–90% | | `R` | Cycle fit mode |
| `Home` / `End` | Start / end | | `N` / `P` | Next / previous video |
| `Esc` | Exit fullscreen, or back to library | | `?` | Show shortcuts |

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
js/player.js                  playback, controls, shortcuts, fit modes
js/ui.js                      library UI, modals, drag & drop, app wiring
.nojekyll                     tells GitHub Pages to serve the files as-is
```

Data lives in the `video-viewer` IndexedDB database, scoped to whichever origin
you loaded the app from. *Clear library* empties it; clearing the site's data in
Chrome does the same.

`window.videoViewer` is exposed in the console (`state`, `player`, `db`, `lib`,
`reload`, `toast`) if you ever need to inspect or debug the library by hand.
