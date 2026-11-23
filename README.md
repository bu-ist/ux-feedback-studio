# UX Feedback Studio

A **100% local, zero-network Chrome Extension (Manifest V3)** that lets you capture screenshots of any webpage or local app, annotate them directly in the browser, and write structured Markdown + zoomed element crops straight into your project folder—ready for AI coding agents or teammates to review and fix.

---

## Why This Exists

Visual UI/UX feedback is slow to describe in plain text, and most third-party annotation extensions upload screenshots to external clouds, require accounts, or run companion servers—creating Zero Data Retention (ZDR) and privacy concerns on internal or staging apps.

**UX Feedback Studio** solves this by keeping everything strictly on your machine:

* **Zero network access:** Extension pages enforce `connect-src 'none'` via Content Security Policy. Chrome itself blocks `fetch`, `XHR`, and `WebSocket` calls from the extension.
* **Zero third-party dependencies:** Pure vanilla HTML, CSS, and ES modules—no build step, no `node_modules`, trivial to audit.
* **Destructive redaction:** Regions covered with the **Blur** tool are pixelated directly into `annotated.png` and every `pin-N.png` crop. No unredacted raw screenshot is ever written to disk.
* **Project-bound local storage:** All feedback lives as plain Markdown and PNG files inside your chosen project directory (`<project>/ui-feedback/`), never in a cloud database.

---

## Architecture & Design

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Active Webpage Tab                                                   │
│                                                                      │
│  content/console-capture.js (MAIN world, document_start)             │
│    └─ In-memory ring buffer of last 20 console.error / uncaught errs │
│                                                                      │
│  content/overlay.js (Injected on demand, Shadow DOM in Top Layer)    │
│    ├─ Freezes viewport via createImageBitmap() (immune to page CSP)  │
│    ├─ Promotes host to Top Layer (popover="manual" or <dialog>       │
│    │  showModal() when an app modal is already open)                 │
│    ├─ Inspects live DOM underneath (CSS selector, computed styles,   │
│    │  outerHTML, root data-* theme attrs, app <meta> tags)           │
│    └─ Exports annotated.png + per-pin zoomed crops (pin-N.png)       │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ chrome.runtime.sendMessage
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ background/service-worker.js (MV3 Service Worker)                    │
│  ├─ Cleans any orphaned overlay, captures visible tab PNG            │
│  ├─ Injects overlay.js and passes frozen screenshot                  │
│  └─ Routes saved payloads to Side Panel (or queues in session RAM)   │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ sidepanel/ (Chrome Side Panel — connect-src 'none')                  │
│  ├─ Binds any local folder via File System Access API                │
│  ├─ Persists FileSystemDirectoryHandle in IndexedDB                  │
│  ├─ Writes <project>/ui-feedback/001-<slug>/feedback.md + PNGs       │
│  └─ Lists open/resolved queue, thumbnails, author, & AI prompt copy  │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions
* **Top Layer Modal Support:** Normal pages use `popover="manual"` + `showPopover()` so the overlay sits above `z-index` modals without making the page `inert` to `document.elementsFromPoint()`. When an app has a native `<dialog>.showModal()` open, the overlay automatically upgrades to `<dialog>.showModal()` and falls back to a fast `getBoundingClientRect()` hit-test inside that modal so you can annotate form popups cleanly.
* **CSP-Proof Screenshot Rendering:** Screenshots are decoded via `createImageBitmap(blob)` rather than `<img src="data:...">`, so websites with strict `img-src` Content Security Policies never block the canvas.
* **Rename-Safe Queue Tracking:** If a developer or AI agent renames `001-fix-nav/` to `done-001-fix-nav/` (or `001-fix-nav-complete/`), the Side Panel still parses `001` to avoid ID collisions and automatically marks the item `resolved`.

---

## Installation (Unpacked in Chrome)

1. Clone this repository to your machine.
2. Open `chrome://extensions` in Google Chrome.
3. Toggle **Developer mode** ON (top-right).
4. Click **Load unpacked** and select this repository folder.
5. Pin **UX Feedback Studio** to your Chrome toolbar and click the icon to open the Side Panel.

---

## How to Use

### 1. Bind a Project Folder
1. In the Side Panel, click **Bind Folder** and select your project repository (or any local folder).
   * After a full browser restart, Chrome requires a one-click **Reconnect** to re-grant write access.
2. *(Optional)* Enter your **Author** name/handle in the Side Panel. It is stored locally in `chrome.storage.local` and written to each `feedback.md` so teammates can see who filed feedback if `ui-feedback/` is committed to git.

### 2. Capture & Annotate Any Page
Click **Capture & Annotate Page** in the Side Panel (or press `Alt+Shift+F`).

| Shortcut | Tool | What It Does |
| :--- | :--- | :--- |
| `V` or `0` | **↖ Select** | Click any annotation to select, drag to move, drag handles to resize Boxes/Blurs/Arrows, click a color swatch to recolor, or press `Delete`/`Backspace` to remove. Dragging a Pin automatically re-inspects the DOM at its new position. |
| `1` | **📍 Pin** | Hover to highlight DOM elements; click to drop a numbered pin with a note, **Type** (`Bug` / `Polish` / `Feature`), and **Severity** (`Low` / `Med` / `High`). Captures CSS selector, computed styles, `outerHTML`, and a zoomed crop. |
| `2` | **▭ Box** | Draw rectangles around regions. |
| `3` | **↗ Arrow** | Draw directional arrows. |
| `4` | **T Text** | Place high-contrast text callouts directly on the screenshot. Double-click any callout to edit or delete it. |
| `5` | **✎ Pen** | Freehand markup. |
| `6` | **▦ Blur** | Pixelate/redact sensitive data (destructively baked into all saved PNGs). |
| `Cmd/Ctrl + Z` | **Undo** | Undo draws, moves, resizes, recolors, text edits, and deletions. |
| `Cmd/Ctrl + Shift + Z` | **Redo** | Redo undone actions. |
| `Cmd/Ctrl + Enter` | **Save** | Write the capture to `<project>/ui-feedback/00X-<slug>/`. |
| `Esc` | **Close** | Closes open popover → deselects active item → exits overlay. |

### 3. Hand Off to an AI Coding Agent
Click **Copy AI Prompt** in the Side Panel to copy a ready-to-paste prompt listing all open items in `ui-feedback/` and instructing your agent to inspect `feedback.md`, `annotated.png`, and `pin-N.png`, apply fixes, mark `status: resolved`, and prefix completed folders with `done-`.

---

## Output Structure

On first save into a bound folder, the extension creates `ui-feedback/` along with an auto-generated `ui-feedback/README.md` (created once; never overwritten if you customize it):

```text
<bound-project-folder>/
└── ui-feedback/
    ├── README.md                     # Auto-generated agent & git tracking guide
    ├── 001-fix-nav-overlap/          # Open feedback item
    │   ├── feedback.md               # Structured Markdown + YAML frontmatter
    │   ├── annotated.png             # Full viewport screenshot with annotations
    │   ├── pin-1.png                 # Zoomed HiDPI crop for Pin #1
    │   └── pin-2.png                 # Zoomed HiDPI crop for Pin #2
    └── done-002-button-spacing/      # Completed feedback item
        ├── feedback.md
        └── annotated.png
```

### Example `feedback.md`

```markdown
---
id: "001"
title: "Fix nav overlap"
status: open
author: "TCerato"
created_at: "2026-11-23T17:40:54.998Z"
url: "http://localhost:3000/help"
page_title: "Help — My App"
viewport: "1440x900"
pins: 1
build: "app-build=v1.4.2 (main@a1b2c3d)"
---

# Fix nav overlap

![Annotated screenshot](./annotated.png)

## Summary

The primary action button crowds the navigation tabs at 1440px.

## Page Context & Environment

- **Author:** TCerato
- **URL:** http://localhost:3000/help
- **Page Title:** Help — My App
- **Viewport:** `1440x900` (DPR: 2)
- **Color Scheme:** `light`
- **App Meta Tags:**
  - `app-build`: `v1.4.2 (main@a1b2c3d)`
- **Root Data Attributes (Theme / Variant):**
  - `html.data-primary`: `crimson`
  - `html.data-density`: `compact`

## Pinned Annotations

### 1. [BUG · HIGH] Add spacing between Create button and nav tabs

![Pin 1 zoomed crop](./pin-1.png)

- **Selector:** `header.app-header > button.btn-primary`
- **Element:** `<button.btn-primary>`
- **Text:** "Create"
- **Bounding Box:** `x: 1180, y: 14, w: 96, h: 36`
- **Computed Styles:** `color: rgb(255, 255, 255); background: rgb(204, 0, 0); font-size: 14px; font-weight: 600; padding: 8px 16px; border-radius: 6px; display: inline-flex`
- **DOM Snippet (`outerHTML`):**
  ```html
  <button class="btn-primary" type="button">Create</button>
  ```
```

### Optional App Metadata Hooks
Apps don't need any integration to work with UX Feedback Studio, but if your app renders `<meta>` tags matching `build`, `version`, `commit`, `branch`, `release`, `env`, `user`, `role`, or `feedback` (for example `<meta name="app-build" content="1.4.2 main@abc123">` or `<meta name="feedback-user" content="Alex Rivera · Staff">`), they are automatically captured into `feedback.md`.

### Git Tracking Policy
* **Default (Personal local loop):** Add `ui-feedback/` to your project's `.gitignore` so screenshots stay strictly local.
* **Shared team QA:** Commit `ui-feedback/` to the repo and have each reviewer set their **Author** name in the Side Panel so every item is attributed in frontmatter and in the queue UI.

---

## Repository Layout

* `manifest.json` — Manifest V3 configuration, strict CSP (`connect-src 'none'`), Side Panel & command bindings.
* `background/service-worker.js` — Tab screenshot capture, orphaned-overlay cleanup, script injection, and message routing.
* `content/console-capture.js` — Lightweight `MAIN`-world in-memory ring buffer for `console.error`, uncaught errors, and unhandled rejections.
* `content/overlay.js` — Self-contained Shadow DOM annotation studio, DOM inspector, Top Layer modal handling, Select/Move/Resize engine, and HiDPI PNG/crop exporter.
* `sidepanel/index.html`, `styles.css`, `app.js` — Chrome Side Panel UI, folder binding, author setting, queue filters, and AI prompt generator.
* `sidepanel/fs.js` — File System Access API operations, rename-safe ID/status scanning, and auto-generated `ui-feedback/README.md`.
* `sidepanel/markdown.js` — YAML frontmatter and Markdown serializer/parser.
* `sidepanel/db.js` — IndexedDB persistence for `FileSystemDirectoryHandle`.
* `icons/` — Extension icons (`16`, `48`, `128`).
