// Local Feedback Studio — In-Page Shadow DOM Annotation Overlay
// Self-contained, zero external dependencies, zero network calls.

(() => {
  if (window.__LOCAL_FEEDBACK_STUDIO_LOADED__) return;
  window.__LOCAL_FEEDBACK_STUDIO_LOADED__ = true;

  let activeSession = null;

  // --- DOM Inspection Helpers ---
  function buildCssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;

    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;

    const parts = [];
    let current = el;
    let depth = 0;

    while (current && current.nodeType === 1 && depth < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      const classes = Array.from(current.classList || [])
        .filter((c) => c && c.length < 36 && !/^[0-9]/.test(c))
        .slice(0, 2);
      if (classes.length) {
        part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      }

      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName
        );
        if (sameTagSiblings.length > 1) {
          const idx = sameTagSiblings.indexOf(current) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(part);
      if (current.tagName.toLowerCase() === 'body') break;
      current = current.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }

  function extractComputedStyles(el) {
    try {
      const cs = window.getComputedStyle(el);
      const styles = {};
      const pick = (key, prop, ignoreValues = []) => {
        const val = cs.getPropertyValue(prop)?.trim();
        if (!val || ignoreValues.includes(val)) return;
        styles[key] = val;
      };

      pick('color', 'color');
      pick('background', 'background-color', ['rgba(0, 0, 0, 0)', 'transparent']);
      pick('font-size', 'font-size');
      pick('font-weight', 'font-weight');
      pick('line-height', 'line-height', ['normal']);
      pick('font-family', 'font-family');
      pick('padding', 'padding', ['0px']);
      pick('margin', 'margin', ['0px']);
      pick('border', 'border', ['0px none rgb(0, 0, 0)']);
      if (styles.border && styles.border.startsWith('0px none')) {
        delete styles.border;
      }
      pick('border-radius', 'border-radius', ['0px']);
      pick('display', 'display');
      pick('position', 'position', ['static']);
      pick('gap', 'gap', ['normal', '0px']);
      pick('z-index', 'z-index', ['auto']);
      pick('opacity', 'opacity', ['1']);

      return styles;
    } catch {
      return {};
    }
  }

  function extractOuterHtmlSnippet(el, maxLen = 1500) {
    try {
      let html = el.outerHTML || '';
      // Collapse huge inline SVG internals so markup budget goes to real structure
      html = html.replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, '<svg$1>…</svg>');
      html = html.replace(/\s+/g, ' ').trim();
      if (html.length > maxLen) {
        html = html.slice(0, maxLen) + '… <!-- truncated -->';
      }
      return html;
    } catch {
      return '';
    }
  }

  function collectPageMetadata() {
    const metaTags = {};
    const META_PATTERN = /(build|version|commit|branch|release|env|user|role|feedback|app-|git-|generator)/i;

    for (const meta of document.querySelectorAll('meta[name], meta[property]')) {
      const key = (meta.getAttribute('name') || meta.getAttribute('property') || '').trim();
      const content = (meta.getAttribute('content') || '').trim();
      if (!key || !content) continue;
      if (META_PATTERN.test(key)) {
        metaTags[key] = content.length > 300 ? content.slice(0, 300) + '…' : content;
      }
    }

    const dataAttrs = {};
    const EXT_NOISE_RE = /^data-(?:lastpass|grammarly|gr-|new-gr|1password|bitwarden|dashlane|loom|lt-|honey|adblock)/i;
    const readDataAttrs = (node, prefix) => {
      if (!node || !node.attributes) return;
      for (const attr of Array.from(node.attributes)) {
        if (!attr.name.startsWith('data-')) continue;
        if (EXT_NOISE_RE.test(attr.name)) continue;
        if (attr.value.length > 200) continue;
        dataAttrs[`${prefix}.${attr.name}`] = attr.value;
      }
    };
    readDataAttrs(document.documentElement, 'html');
    readDataAttrs(document.body, 'body');

    const themeClasses = [];
    for (const cls of [
      ...Array.from(document.documentElement.classList || []),
      ...Array.from(document.body?.classList || [])
    ]) {
      if (/^(dark|light|theme-|density-|compact|comfortable)/i.test(cls)) {
        if (!themeClasses.includes(cls)) themeClasses.push(cls);
      }
    }

    const prefersColorScheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

    return {
      metaTags,
      dataAttrs,
      themeClasses,
      prefersColorScheme
    };
  }

  function collectConsoleErrors() {
    let errors = [];
    const onResponse = (e) => {
      if (Array.isArray(e.detail)) {
        errors = e.detail;
      }
    };
    window.addEventListener('__lfs_response_errors__', onResponse, { once: true });
    window.dispatchEvent(new CustomEvent('__lfs_request_errors__'));
    window.removeEventListener('__lfs_response_errors__', onResponse);
    return errors;
  }

  function findDeepestElementInRoot(rootEl, clientX, clientY, excludeEl) {
    if (!rootEl) return null;
    let best = null;
    let bestArea = Infinity;
    let bestDepth = -1;

    const walk = (node, depth) => {
      if (!node || node === excludeEl || node.nodeType !== 1) return;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
        return;
      }
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') {
        return;
      }
      const area = r.width * r.height;
      if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
        best = node;
        bestArea = area;
        bestDepth = depth;
      }
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };

    walk(rootEl, 0);
    return best;
  }

  function inspectElementAt(hostEl, clientX, clientY, underlyingModal = null) {
    const prevPointer = hostEl.style.pointerEvents;
    hostEl.style.pointerEvents = 'none';

    let el = null;
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const candidate of stack) {
      if (
        candidate === hostEl ||
        hostEl.contains(candidate) ||
        candidate === document.documentElement ||
        candidate === document.body
      ) {
        continue;
      }
      el = candidate;
      break;
    }

    hostEl.style.pointerEvents = prevPointer || 'auto';

    // When a native <dialog>.showModal() is open, Chromium marks siblings inert and
    // elementsFromPoint skips them — fall back to a fast rect hit-test inside the modal.
    if (!el && underlyingModal) {
      el = findDeepestElementInRoot(underlyingModal, clientX, clientY, hostEl);
    }

    if (!el || el === document.documentElement || el === document.body) {
      return null;
    }

    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const idPart = el.id ? `#${el.id}` : '';
    const classPart = Array.from(el.classList || [])
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('');
    const tagSummary = `<${tag}${idPart}${classPart}>`;

    const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const text = rawText.length > 160 ? rawText.slice(0, 160) + '…' : rawText;

    return {
      selector: buildCssSelector(el),
      tagSummary,
      text,
      htmlSnippet: extractOuterHtmlSnippet(el, 1500) || tagSummary,
      computedStyles: extractComputedStyles(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  // --- Overlay Launcher ---
  function launchOverlay({ screenshotDataUrl, tabUrl, tabTitle }) {
    if (activeSession) {
      activeSession.destroy();
      activeSession = null;
    }

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // Lock page scroll while annotating so DOM coords match the frozen frame
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    // Detect if the page currently has a native modal <dialog> open
    let openAppModal = null;
    try {
      const modals = Array.from(document.querySelectorAll('dialog:modal'));
      if (modals.length > 0) {
        openAppModal = modals[modals.length - 1];
      }
    } catch {
      // :modal pseudo-class fallback
      const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
      if (openDialogs.length > 0) {
        openAppModal = openDialogs[openDialogs.length - 1];
      }
    }

    // Use <dialog>.showModal() ONLY when an app <dialog> is already open (to avoid
    // inert blocking our overlay). Otherwise use popover="manual" so we sit in the
    // Top Layer without making the underlying page inert to elementsFromPoint().
    const useDialogHost = Boolean(openAppModal);
    const host = document.createElement(useDialogHost ? 'dialog' : 'div');
    host.id = 'local-feedback-studio-host';
    if (!useDialogHost) {
      host.setAttribute('popover', 'manual');
    }
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      maxWidth: 'none',
      maxHeight: 'none',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      overflow: 'visible',
      zIndex: '2147483647',
      pointerEvents: 'auto'
    });
    if (useDialogHost) {
      host.addEventListener('cancel', (e) => {
        e.preventDefault();
      });
    }
    document.documentElement.appendChild(host);
    try {
      if (useDialogHost && typeof host.showModal === 'function') {
        host.showModal();
      } else if (!useDialogHost && typeof host.showPopover === 'function') {
        host.showPopover();
      }
    } catch {
      // Fallback to z-index if Top Layer API is unavailable
    }

    // Mount Shadow DOM on an inner <div> (works identically for both <dialog> and <div>)
    const shadowMount = document.createElement('div');
    Object.assign(shadowMount.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh'
    });
    host.appendChild(shadowMount);
    const shadow = shadowMount.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host::backdrop { background: transparent; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
      .root {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        user-select: none;
      }
      canvas {
        position: absolute;
        inset: 0;
        width: 100vw;
        height: 100vh;
        display: block;
        cursor: crosshair;
      }
      .toolbar {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 17, 23, 0.94);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        padding: 6px 8px;
        display: flex;
        align-items: center;
        gap: 4px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        z-index: 20;
        color: #eef0f6;
      }
      .divider {
        width: 1px;
        height: 22px;
        background: rgba(255, 255, 255, 0.14);
        margin: 0 4px;
      }
      .tool-btn {
        background: transparent;
        border: 1px solid transparent;
        color: #cbd5e1;
        border-radius: 8px;
        padding: 6px 9px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
      }
      .tool-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }
      .tool-btn.active {
        background: #6366f1;
        color: #fff;
        border-color: rgba(255, 255, 255, 0.2);
      }
      .swatch {
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
      }
      .swatch.active {
        border-color: #fff;
        transform: scale(1.12);
      }
      .bottom-bar {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 17, 23, 0.95);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        padding: 8px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
        z-index: 20;
        width: min(760px, calc(100vw - 32px));
        color: #eef0f6;
      }
      .input {
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        color: #fff;
        padding: 7px 10px;
        font-size: 12.5px;
        outline: none;
      }
      .input:focus {
        border-color: #6366f1;
      }
      .title-input {
        width: 210px;
        flex-shrink: 0;
      }
      .summary-input {
        flex: 1;
        min-width: 140px;
      }
      .save-btn {
        background: #22c55e;
        color: #052e16;
        border: none;
        border-radius: 8px;
        padding: 7px 14px;
        font-size: 12.5px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }
      .save-btn:hover { background: #4ade80; }
      .save-btn:disabled { opacity: 0.6; cursor: wait; }
      .cancel-btn {
        background: rgba(255, 255, 255, 0.09);
        color: #e2e8f0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 7px 11px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .cancel-btn:hover { background: rgba(239, 68, 68, 0.25); color: #fecaca; }

      /* Inline Popover for Pins & Text Callouts */
      .popover {
        position: fixed;
        background: #131620;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        padding: 10px;
        width: 270px;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
        z-index: 30;
        color: #eef0f6;
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .popover-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        font-weight: 600;
      }
      .popover-selector {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        color: #a5b4fc;
        background: rgba(99, 102, 241, 0.14);
        padding: 3px 6px;
        border-radius: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .popover textarea, .popover input[type="text"] {
        width: 100%;
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 7px;
        color: #fff;
        padding: 7px 8px;
        font-size: 12.5px;
        resize: vertical;
        outline: none;
      }
      .popover textarea:focus, .popover input[type="text"]:focus {
        border-color: #6366f1;
      }
      .popover-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      .pop-btn {
        border: none;
        border-radius: 6px;
        padding: 5px 10px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .pop-btn-primary { background: #6366f1; color: #fff; }
      .pop-btn-danger { background: rgba(239, 68, 68, 0.18); color: #fca5a5; margin-right: auto; }
      .pop-btn-ghost { background: rgba(255, 255, 255, 0.08); color: #cbd5e1; }
      .pill-row {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .pill-group {
        display: flex;
        gap: 3px;
        flex: 1;
      }
      .pill-opt {
        flex: 1;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #94a3b8;
        border-radius: 5px;
        padding: 3px 5px;
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .pill-opt:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }
      .pill-opt.active { background: #6366f1; border-color: #818cf8; color: #fff; }
      .pill-opt.sev-high.active { background: #dc2626; border-color: #f87171; }
      .pill-opt.sev-med.active { background: #d97706; border-color: #fbbf24; }
      .pill-opt.sev-low.active { background: #0284c7; border-color: #38bdf8; }

      .toast {
        position: fixed;
        top: 66px;
        left: 50%;
        transform: translateX(-50%);
        background: #111827;
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #fff;
        padding: 8px 14px;
        border-radius: 9px;
        font-size: 12.5px;
        font-weight: 500;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        z-index: 40;
      }
      .hidden { display: none !important; }
    `;

    const root = document.createElement('div');
    root.className = 'root';

    const canvas = document.createElement('canvas');
    root.appendChild(canvas);

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = `
      <button class="tool-btn" data-tool="select" title="Select / Move / Resize (V)">↖ Select</button>
      <button class="tool-btn active" data-tool="pin" title="Numbered Pin + DOM Selector (1)">📍 Pin</button>
      <button class="tool-btn" data-tool="box" title="Rectangle (2)">▭ Box</button>
      <button class="tool-btn" data-tool="arrow" title="Arrow (3)">↗ Arrow</button>
      <button class="tool-btn" data-tool="text" title="Text Callout (4)">T Text</button>
      <button class="tool-btn" data-tool="pen" title="Freehand Pen (5)">✎ Pen</button>
      <button class="tool-btn" data-tool="blur" title="Blur / Redact Region (6)">▦ Blur</button>
      <div class="divider"></div>
      <button class="swatch active" data-color="#ef4444" style="background:#ef4444" title="Red"></button>
      <button class="swatch" data-color="#f59e0b" style="background:#f59e0b" title="Amber"></button>
      <button class="swatch" data-color="#3b82f6" style="background:#3b82f6" title="Blue"></button>
      <button class="swatch" data-color="#22c55e" style="background:#22c55e" title="Green"></button>
      <button class="swatch" data-color="#a855f7" style="background:#a855f7" title="Purple"></button>
      <div class="divider"></div>
      <button class="tool-btn" id="undoBtn" title="Undo (Cmd+Z)">↶</button>
      <button class="tool-btn" id="redoBtn" title="Redo (Cmd+Shift+Z)">↷</button>
      <button class="tool-btn" id="clearBtn" title="Clear all annotations">Clear</button>
    `;
    root.appendChild(toolbar);

    // Bottom save bar
    const bottomBar = document.createElement('div');
    bottomBar.className = 'bottom-bar';
    bottomBar.innerHTML = `
      <input type="text" id="titleInput" class="input title-input" placeholder="Feedback title (e.g. Fix nav overlap)" />
      <input type="text" id="summaryInput" class="input summary-input" placeholder="Optional overall summary for the AI agent..." />
      <button id="saveBtn" class="save-btn">Save Feedback</button>
      <button id="cancelBtn" class="cancel-btn" title="Cancel (Esc)">Cancel</button>
    `;
    root.appendChild(bottomBar);

    const toastEl = document.createElement('div');
    toastEl.className = 'toast hidden';
    root.appendChild(toastEl);

    shadow.append(style, root);

    // --- State ---
    const ctx = canvas.getContext('2d');
    let baseBitmap = null;
    let scaleX = dpr;
    let scaleY = dpr;

    function dataUrlToBlob(dataUrl) {
      const commaIdx = dataUrl.indexOf(',');
      const base64 = dataUrl.slice(commaIdx + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: 'image/png' });
    }

    let currentTool = 'pin';
    let currentColor = '#ef4444';
    let items = [];
    let undoStack = [];
    let redoStack = [];
    let selectedIndex = -1;
    let dragAction = null;
    let draftItem = null;
    let hoverElement = null;
    let activePopover = null;
    let commitActivePopover = null;

    function cloneItems(list) {
      return JSON.parse(JSON.stringify(list));
    }

    function pushUndoSnapshot(snapshot = cloneItems(items)) {
      undoStack.push(snapshot);
      if (undoStack.length > 60) undoStack.shift();
      redoStack = [];
    }

    function showToast(msg, duration = 3000) {
      toastEl.textContent = msg;
      toastEl.classList.remove('hidden');
      setTimeout(() => toastEl.classList.add('hidden'), duration);
    }

    function renumberPins() {
      let n = 1;
      for (const item of items) {
        if (item.type === 'pin') {
          item.number = n++;
        }
      }
    }

    function closePopover(shouldCommit = false) {
      if (shouldCommit && typeof commitActivePopover === 'function') {
        const fn = commitActivePopover;
        commitActivePopover = null;
        fn();
        return;
      }
      commitActivePopover = null;
      if (activePopover) {
        activePopover.remove();
        activePopover = null;
      }
    }

    function clampPopoverPos(x, y, width = 270, height = 165) {
      const left = Math.max(12, Math.min(x + 16, viewportW - width - 12));
      const top = Math.max(66, Math.min(y - 16, viewportH - height - 74));
      return { left, top };
    }

    function openPinPopover(pinItem, isNew = false) {
      closePopover();
      pinItem.kind = pinItem.kind || 'bug';
      pinItem.severity = pinItem.severity || 'med';

      const pop = document.createElement('div');
      pop.className = 'popover';
      const pos = clampPopoverPos(pinItem.x, pinItem.y, 280, 225);
      pop.style.left = `${pos.left}px`;
      pop.style.top = `${pos.top}px`;

      const selectorHtml = pinItem.element?.selector
        ? `<div class="popover-selector" title="${pinItem.element.selector.replace(/"/g, '&quot;')}">${pinItem.element.selector}</div>`
        : '';

      pop.innerHTML = `
        <div class="popover-head">
          <span>Pin #${pinItem.number}</span>
        </div>
        ${selectorHtml}
        <div class="pill-row">
          <div class="pill-group" data-group="kind">
            <button type="button" class="pill-opt ${pinItem.kind === 'bug' ? 'active' : ''}" data-val="bug">Bug</button>
            <button type="button" class="pill-opt ${pinItem.kind === 'polish' ? 'active' : ''}" data-val="polish">Polish</button>
            <button type="button" class="pill-opt ${pinItem.kind === 'feature' ? 'active' : ''}" data-val="feature">Feature</button>
          </div>
        </div>
        <div class="pill-row">
          <div class="pill-group" data-group="severity">
            <button type="button" class="pill-opt sev-low ${pinItem.severity === 'low' ? 'active' : ''}" data-val="low">Low</button>
            <button type="button" class="pill-opt sev-med ${pinItem.severity === 'med' ? 'active' : ''}" data-val="med">Med</button>
            <button type="button" class="pill-opt sev-high ${pinItem.severity === 'high' ? 'active' : ''}" data-val="high">High</button>
          </div>
        </div>
        <textarea rows="3" placeholder="Describe what needs to change here..."></textarea>
        <div class="popover-actions">
          <button class="pop-btn pop-btn-danger" id="delPin">Delete</button>
          <button class="pop-btn pop-btn-primary" id="donePin">Done</button>
        </div>
      `;

      pop.addEventListener('click', (e) => {
        const opt = e.target.closest('.pill-opt');
        if (!opt) return;
        const group = opt.closest('.pill-group')?.dataset.group;
        if (group === 'kind') pinItem.kind = opt.dataset.val;
        if (group === 'severity') pinItem.severity = opt.dataset.val;
        for (const sibling of opt.parentElement.querySelectorAll('.pill-opt')) {
          sibling.classList.toggle('active', sibling === opt);
        }
      });

      const textarea = pop.querySelector('textarea');
      textarea.value = pinItem.note || '';

      const commit = () => {
        const nextNote = textarea.value.trim();
        if (!isNew && nextNote !== pinItem.note) {
          pushUndoSnapshot();
        }
        pinItem.note = nextNote;
        closePopover();
        render();
      };

      pop.querySelector('#donePin').addEventListener('click', commit);
      pop.querySelector('#delPin').addEventListener('click', () => {
        pushUndoSnapshot();
        items = items.filter((i) => i !== pinItem);
        selectedIndex = -1;
        renumberPins();
        closePopover();
        render();
      });

      textarea.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          if (isNew && !textarea.value.trim()) {
            items = items.filter((i) => i !== pinItem);
            renumberPins();
          }
          closePopover();
          render();
        }
      });

      root.appendChild(pop);
      activePopover = pop;
      commitActivePopover = commit;
      setTimeout(() => textarea.focus(), 0);
    }

    function openTextPopover(x, y, existingItem = null) {
      closePopover();
      const pop = document.createElement('div');
      pop.className = 'popover';
      const pos = clampPopoverPos(x, y, 260, 125);
      pop.style.left = `${pos.left}px`;
      pop.style.top = `${pos.top}px`;

      pop.innerHTML = `
        <div class="popover-head"><span>${existingItem ? 'Edit Text Callout' : 'Text Callout'}</span></div>
        <input type="text" placeholder="Type callout label..." />
        <div class="popover-actions">
          ${existingItem ? '<button class="pop-btn pop-btn-danger" id="delTxt">Delete</button>' : ''}
          <button class="pop-btn pop-btn-ghost" id="cancelTxt">Cancel</button>
          <button class="pop-btn pop-btn-primary" id="addTxt">${existingItem ? 'Save' : 'Place'}</button>
        </div>
      `;

      const input = pop.querySelector('input');
      if (existingItem) input.value = existingItem.text || '';

      const commit = () => {
        const val = input.value.trim();
        if (existingItem) {
          if (val && val !== existingItem.text) {
            pushUndoSnapshot();
            existingItem.text = val;
          } else if (!val) {
            pushUndoSnapshot();
            items = items.filter((i) => i !== existingItem);
            selectedIndex = -1;
          }
        } else if (val) {
          pushUndoSnapshot();
          items.push({
            type: 'text',
            x,
            y,
            text: val,
            color: currentColor
          });
        }
        closePopover();
        render();
      };

      pop.querySelector('#addTxt').addEventListener('click', commit);
      pop.querySelector('#cancelTxt').addEventListener('click', () => {
        closePopover();
        render();
      });
      const delBtn = pop.querySelector('#delTxt');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          pushUndoSnapshot();
          items = items.filter((i) => i !== existingItem);
          selectedIndex = -1;
          closePopover();
          render();
        });
      }

      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          closePopover();
          render();
        }
      });

      root.appendChild(pop);
      activePopover = pop;
      commitActivePopover = commit;
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    }

    // --- Drawing Helpers ---
    function drawPixelatedBlur(targetCtx, item, sx, sy) {
      const rx = Math.min(item.x1, item.x2);
      const ry = Math.min(item.y1, item.y2);
      const rw = Math.abs(item.x2 - item.x1);
      const rh = Math.abs(item.y2 - item.y1);
      if (rw < 4 || rh < 4) return;

      const srcX = Math.max(0, Math.round(rx * sx));
      const srcY = Math.max(0, Math.round(ry * sy));
      const srcW = Math.min(baseBitmap.width - srcX, Math.round(rw * sx));
      const srcH = Math.min(baseBitmap.height - srcY, Math.round(rh * sy));
      if (srcW <= 0 || srcH <= 0) return;

      const block = Math.max(10, Math.round(12 * sx));
      const smallW = Math.max(1, Math.ceil(srcW / block));
      const smallH = Math.max(1, Math.ceil(srcH / block));

      const off = document.createElement('canvas');
      off.width = smallW;
      off.height = smallH;
      const octx = off.getContext('2d');
      octx.drawImage(baseBitmap, srcX, srcY, srcW, srcH, 0, 0, smallW, smallH);

      targetCtx.save();
      targetCtx.imageSmoothingEnabled = false;
      targetCtx.drawImage(off, 0, 0, smallW, smallH, rx, ry, rw, rh);
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.strokeStyle = 'rgba(255,255,255,0.45)';
      targetCtx.lineWidth = 1.5;
      targetCtx.setLineDash([4, 3]);
      targetCtx.strokeRect(rx, ry, rw, rh);
      targetCtx.restore();
    }

    function drawItem(targetCtx, item, sx, sy) {
      targetCtx.save();
      if (item.type === 'blur') {
        drawPixelatedBlur(targetCtx, item, sx, sy);
        targetCtx.restore();
        return;
      }

      if (item.type === 'box') {
        const x = Math.min(item.x1, item.x2);
        const y = Math.min(item.y1, item.y2);
        const w = Math.abs(item.x2 - item.x1);
        const h = Math.abs(item.y2 - item.y1);
        targetCtx.strokeStyle = item.color;
        targetCtx.lineWidth = 3;
        targetCtx.fillStyle = item.color + '1a';
        targetCtx.fillRect(x, y, w, h);
        targetCtx.strokeRect(x, y, w, h);
      } else if (item.type === 'arrow') {
        const dx = item.x2 - item.x1;
        const dy = item.y2 - item.y1;
        const angle = Math.atan2(dy, dx);
        const headLen = 14;

        targetCtx.strokeStyle = item.color;
        targetCtx.fillStyle = item.color;
        targetCtx.lineWidth = 3.5;
        targetCtx.lineCap = 'round';

        targetCtx.beginPath();
        targetCtx.moveTo(item.x1, item.y1);
        targetCtx.lineTo(item.x2, item.y2);
        targetCtx.stroke();

        targetCtx.beginPath();
        targetCtx.moveTo(item.x2, item.y2);
        targetCtx.lineTo(
          item.x2 - headLen * Math.cos(angle - Math.PI / 6),
          item.y2 - headLen * Math.sin(angle - Math.PI / 6)
        );
        targetCtx.lineTo(
          item.x2 - headLen * Math.cos(angle + Math.PI / 6),
          item.y2 - headLen * Math.sin(angle + Math.PI / 6)
        );
        targetCtx.closePath();
        targetCtx.fill();
      } else if (item.type === 'pen') {
        if (item.points.length < 2) {
          targetCtx.restore();
          return;
        }
        targetCtx.strokeStyle = item.color;
        targetCtx.lineWidth = 3.2;
        targetCtx.lineCap = 'round';
        targetCtx.lineJoin = 'round';
        targetCtx.beginPath();
        targetCtx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i++) {
          targetCtx.lineTo(item.points[i].x, item.points[i].y);
        }
        targetCtx.stroke();
      } else if (item.type === 'text') {
        targetCtx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const metrics = targetCtx.measureText(item.text);
        const padX = 9;
        const padY = 5;
        const boxW = metrics.width + padX * 2;
        const boxH = 26;

        targetCtx.fillStyle = item.color;
        targetCtx.beginPath();
        targetCtx.roundRect(item.x, item.y - boxH / 2, boxW, boxH, 6);
        targetCtx.fill();

        targetCtx.fillStyle = '#ffffff';
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText(item.text, item.x + padX, item.y);
      } else if (item.type === 'pin') {
        // Shadow
        targetCtx.shadowColor = 'rgba(0,0,0,0.4)';
        targetCtx.shadowBlur = 8;
        targetCtx.shadowOffsetY = 2;

        // Circle
        targetCtx.fillStyle = item.color;
        targetCtx.beginPath();
        targetCtx.arc(item.x, item.y, 14, 0, Math.PI * 2);
        targetCtx.fill();

        targetCtx.shadowColor = 'transparent';
        targetCtx.lineWidth = 2.5;
        targetCtx.strokeStyle = '#ffffff';
        targetCtx.stroke();

        // Number
        targetCtx.fillStyle = '#ffffff';
        targetCtx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        targetCtx.textAlign = 'center';
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText(String(item.number), item.x, item.y + 0.5);

        // Compact label preview next to pin if note exists
        if (item.note) {
          const snippet = item.note.length > 34 ? item.note.slice(0, 34) + '…' : item.note;
          targetCtx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          const tw = targetCtx.measureText(snippet).width;
          const lx = item.x + 18;
          const ly = item.y - 12;
          targetCtx.fillStyle = 'rgba(15, 17, 23, 0.88)';
          targetCtx.beginPath();
          targetCtx.roundRect(lx, ly, tw + 14, 24, 6);
          targetCtx.fill();
          targetCtx.strokeStyle = 'rgba(255,255,255,0.22)';
          targetCtx.lineWidth = 1;
          targetCtx.stroke();
          targetCtx.fillStyle = '#f8fafc';
          targetCtx.textAlign = 'left';
          targetCtx.textBaseline = 'middle';
          targetCtx.fillText(snippet, lx + 7, item.y);
        }
      }

      targetCtx.restore();
    }

    function render(forExport = false) {
      if (!baseBitmap) return;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(baseBitmap, 0, 0, canvas.width, canvas.height);

      ctx.scale(scaleX, scaleY);

      // Draw DOM hover highlight (only during interactive Pin mode, never in export)
      if (!forExport && currentTool === 'pin' && hoverElement && !activePopover) {
        const r = hoverElement.rect;
        ctx.save();
        ctx.strokeStyle = '#6366f1';
        ctx.fillStyle = 'rgba(99, 102, 241, 0.10)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.strokeRect(r.x, r.y, r.width, r.height);

        // Selector pill above element
        const label = hoverElement.tagSummary || hoverElement.selector;
        if (label) {
          ctx.setLineDash([]);
          ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          const lw = ctx.measureText(label).width + 12;
          const ly = Math.max(60, r.y - 22);
          const lx = Math.max(6, Math.min(r.x, viewportW - lw - 6));
          ctx.fillStyle = '#4f46e5';
          ctx.beginPath();
          ctx.roundRect(lx, ly, lw, 19, 4);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, lx + 6, ly + 9.5);
        }
        ctx.restore();
      }

      // Draw blurs first so annotations can sit cleanly above them
      for (const item of items) {
        if (item.type === 'blur') drawItem(ctx, item, scaleX, scaleY);
      }
      if (draftItem && draftItem.type === 'blur') {
        drawItem(ctx, draftItem, scaleX, scaleY);
      }

      // Draw all other annotations
      for (const item of items) {
        if (item.type !== 'blur') drawItem(ctx, item, scaleX, scaleY);
      }
      if (draftItem && draftItem.type !== 'blur') {
        drawItem(ctx, draftItem, scaleX, scaleY);
      }

      // Draw selection box & resize handles (never in exported PNG)
      if (!forExport && selectedIndex >= 0 && items[selectedIndex]) {
        drawSelection(ctx, items[selectedIndex]);
      }

      ctx.restore();
    }

    // --- Hit-Testing & Selection Helpers ---
    function distToSegment(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return Math.hypot(px - x1, py - y1);
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function getTextBounds(item) {
      ctx.save();
      ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const w = ctx.measureText(item.text || '').width + 18;
      ctx.restore();
      const h = 26;
      return { x: item.x, y: item.y - h / 2, width: w, height: h };
    }

    function getPenBounds(item) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of item.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX - 4, y: minY - 4, width: maxX - minX + 8, height: maxY - minY + 8 };
    }

    function getHandles(item) {
      if (!item) return [];
      if (item.type === 'box' || item.type === 'blur') {
        const minX = Math.min(item.x1, item.x2);
        const maxX = Math.max(item.x1, item.x2);
        const minY = Math.min(item.y1, item.y2);
        const maxY = Math.max(item.y1, item.y2);
        return [
          { id: 'nw', x: minX, y: minY, cursor: 'nwse-resize' },
          { id: 'ne', x: maxX, y: minY, cursor: 'nesw-resize' },
          { id: 'sw', x: minX, y: maxY, cursor: 'nesw-resize' },
          { id: 'se', x: maxX, y: maxY, cursor: 'nwse-resize' }
        ];
      }
      if (item.type === 'arrow') {
        return [
          { id: 'start', x: item.x1, y: item.y1, cursor: 'pointer' },
          { id: 'end', x: item.x2, y: item.y2, cursor: 'pointer' }
        ];
      }
      return [];
    }

    function hitTestHandle(item, x, y) {
      for (const h of getHandles(item)) {
        if (Math.hypot(h.x - x, h.y - y) <= 9) return h;
      }
      return null;
    }

    function getPinLabelBounds(item) {
      if (!item.note) return null;
      const snippet = item.note.length > 34 ? item.note.slice(0, 34) + '…' : item.note;
      ctx.save();
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const tw = ctx.measureText(snippet).width;
      ctx.restore();
      return { x: item.x + 18, y: item.y - 12, width: tw + 14, height: 24 };
    }

    function hitTestItem(item, x, y, boxBorderOnly = false) {
      if (item.type === 'pin') {
        if (Math.hypot(item.x - x, item.y - y) <= 18) return true;
        const lb = getPinLabelBounds(item);
        if (lb && x >= lb.x && x <= lb.x + lb.width && y >= lb.y && y <= lb.y + lb.height) {
          return true;
        }
        return false;
      }
      if (item.type === 'text') {
        const b = getTextBounds(item);
        return x >= b.x - 4 && x <= b.x + b.width + 4 && y >= b.y - 4 && y <= b.y + b.height + 4;
      }
      if (item.type === 'box' || item.type === 'blur') {
        const minX = Math.min(item.x1, item.x2);
        const maxX = Math.max(item.x1, item.x2);
        const minY = Math.min(item.y1, item.y2);
        const maxY = Math.max(item.y1, item.y2);
        const inOuter = x >= minX - 8 && x <= maxX + 8 && y >= minY - 8 && y <= maxY + 8;
        if (!inOuter) return false;
        if (boxBorderOnly && item.type === 'box') {
          const inInner = x > minX + 10 && x < maxX - 10 && y > minY + 10 && y < maxY - 10;
          return !inInner;
        }
        return true;
      }
      if (item.type === 'arrow') {
        return distToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= 10;
      }
      if (item.type === 'pen') {
        for (let i = 1; i < item.points.length; i++) {
          const p0 = item.points[i - 1];
          const p1 = item.points[i];
          if (distToSegment(x, y, p0.x, p0.y, p1.x, p1.y) <= 10) return true;
        }
      }
      return false;
    }

    function findTopItemAt(x, y, typeFilter = null) {
      if (typeFilter) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].type === typeFilter && hitTestItem(items[i], x, y)) return i;
        }
        return -1;
      }
      // Pass 1: foreground items (pins, text, arrows, pen) & box borders
      for (let i = items.length - 1; i >= 0; i--) {
        const t = items[i].type;
        if (t !== 'blur' && hitTestItem(items[i], x, y, true)) return i;
      }
      // Pass 2: box interiors & blur regions
      for (let i = items.length - 1; i >= 0; i--) {
        const t = items[i].type;
        if ((t === 'box' || t === 'blur') && hitTestItem(items[i], x, y, false)) return i;
      }
      return -1;
    }

    function drawSelection(targetCtx, item) {
      targetCtx.save();
      targetCtx.strokeStyle = '#38bdf8';
      targetCtx.lineWidth = 1.5;
      targetCtx.setLineDash([4, 3]);

      if (item.type === 'pin') {
        targetCtx.beginPath();
        targetCtx.arc(item.x, item.y, 19, 0, Math.PI * 2);
        targetCtx.stroke();
      } else if (item.type === 'text') {
        const b = getTextBounds(item);
        targetCtx.strokeRect(b.x - 3, b.y - 3, b.width + 6, b.height + 6);
      } else if (item.type === 'box' || item.type === 'blur') {
        const minX = Math.min(item.x1, item.x2);
        const minY = Math.min(item.y1, item.y2);
        const w = Math.abs(item.x2 - item.x1);
        const h = Math.abs(item.y2 - item.y1);
        targetCtx.strokeRect(minX - 2, minY - 2, w + 4, h + 4);
      } else if (item.type === 'arrow') {
        targetCtx.beginPath();
        targetCtx.moveTo(item.x1, item.y1);
        targetCtx.lineTo(item.x2, item.y2);
        targetCtx.stroke();
      } else if (item.type === 'pen') {
        const b = getPenBounds(item);
        targetCtx.strokeRect(b.x, b.y, b.width, b.height);
      }

      // Draw crisp circular handles
      targetCtx.setLineDash([]);
      for (const h of getHandles(item)) {
        targetCtx.beginPath();
        targetCtx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
        targetCtx.fillStyle = '#ffffff';
        targetCtx.fill();
        targetCtx.lineWidth = 2;
        targetCtx.strokeStyle = '#0284c7';
        targetCtx.stroke();
      }

      targetCtx.restore();
    }

    function normalizeRectItem(item) {
      const minX = Math.min(item.x1, item.x2);
      const maxX = Math.max(item.x1, item.x2);
      const minY = Math.min(item.y1, item.y2);
      const maxY = Math.max(item.y1, item.y2);
      item.x1 = minX;
      item.y1 = minY;
      item.x2 = maxX;
      item.y2 = maxY;
    }

    // --- Canvas Pointer Events ---
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x = e.clientX;
      const y = e.clientY;

      if (activePopover) {
        closePopover(true);
        return;
      }

      // Select / Move / Resize Mode
      if (currentTool === 'select') {
        if (selectedIndex >= 0 && items[selectedIndex]) {
          const handle = hitTestHandle(items[selectedIndex], x, y);
          if (handle) {
            const item = items[selectedIndex];
            if (item.type === 'box' || item.type === 'blur') {
              normalizeRectItem(item);
            }
            dragAction = {
              mode: 'resize',
              index: selectedIndex,
              handleId: handle.id,
              moved: false,
              beforeSnapshot: cloneItems(items)
            };
            canvas.setPointerCapture(e.pointerId);
            return;
          }
        }

        const hitIdx = findTopItemAt(x, y);
        selectedIndex = hitIdx;
        if (hitIdx >= 0) {
          dragAction = {
            mode: 'move',
            index: hitIdx,
            startX: x,
            startY: y,
            origItem: JSON.parse(JSON.stringify(items[hitIdx])),
            moved: false,
            beforeSnapshot: cloneItems(items)
          };
          canvas.setPointerCapture(e.pointerId);
        }
        render();
        return;
      }

      // In drawing modes: clicking an existing pin always opens its edit popover
      const existingPinIdx = findTopItemAt(x, y, 'pin');
      if (existingPinIdx >= 0) {
        selectedIndex = existingPinIdx;
        render();
        openPinPopover(items[existingPinIdx], false);
        return;
      }

      // In text mode: clicking an existing text callout edits it
      if (currentTool === 'text') {
        const existingTxtIdx = findTopItemAt(x, y, 'text');
        if (existingTxtIdx >= 0) {
          selectedIndex = existingTxtIdx;
          render();
          openTextPopover(items[existingTxtIdx].x, items[existingTxtIdx].y, items[existingTxtIdx]);
          return;
        }
        openTextPopover(x, y);
        return;
      }

      selectedIndex = -1;

      if (currentTool === 'pin') {
        const element = inspectElementAt(host, x, y, openAppModal);
        pushUndoSnapshot();
        const pinItem = {
          type: 'pin',
          number: items.filter((i) => i.type === 'pin').length + 1,
          kind: 'bug',
          severity: 'med',
          x,
          y,
          color: currentColor,
          note: '',
          element
        };
        items.push(pinItem);
        render();
        openPinPopover(pinItem, true);
        return;
      }

      canvas.setPointerCapture(e.pointerId);
      if (currentTool === 'pen') {
        draftItem = { type: 'pen', color: currentColor, points: [{ x, y }] };
      } else {
        draftItem = {
          type: currentTool,
          color: currentColor,
          x1: x,
          y1: y,
          x2: x,
          y2: y
        };
      }
      render();
    });

    canvas.addEventListener('pointermove', (e) => {
      const x = e.clientX;
      const y = e.clientY;

      if (dragAction) {
        const item = items[dragAction.index];
        if (!item) return;

        if (dragAction.mode === 'resize') {
          dragAction.moved = true;
          if (item.type === 'box' || item.type === 'blur') {
            if (dragAction.handleId === 'nw') { item.x1 = x; item.y1 = y; }
            else if (dragAction.handleId === 'ne') { item.x2 = x; item.y1 = y; }
            else if (dragAction.handleId === 'sw') { item.x1 = x; item.y2 = y; }
            else if (dragAction.handleId === 'se') { item.x2 = x; item.y2 = y; }
          } else if (item.type === 'arrow') {
            if (dragAction.handleId === 'start') { item.x1 = x; item.y1 = y; }
            else if (dragAction.handleId === 'end') { item.x2 = x; item.y2 = y; }
          }
          render();
          return;
        }

        if (dragAction.mode === 'move') {
          const dx = x - dragAction.startX;
          const dy = y - dragAction.startY;
          if (!dragAction.moved && Math.hypot(dx, dy) < 3) return;
          dragAction.moved = true;
          canvas.style.cursor = 'grabbing';

          const orig = dragAction.origItem;
          if (item.type === 'pin' || item.type === 'text') {
            item.x = orig.x + dx;
            item.y = orig.y + dy;
          } else if (item.type === 'box' || item.type === 'blur' || item.type === 'arrow') {
            item.x1 = orig.x1 + dx;
            item.y1 = orig.y1 + dy;
            item.x2 = orig.x2 + dx;
            item.y2 = orig.y2 + dy;
          } else if (item.type === 'pen') {
            item.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          }
          render();
          return;
        }
      }

      if (draftItem) {
        if (draftItem.type === 'pen') {
          draftItem.points.push({ x, y });
        } else {
          draftItem.x2 = x;
          draftItem.y2 = y;
        }
        render();
        return;
      }

      if (currentTool === 'select') {
        if (selectedIndex >= 0 && items[selectedIndex]) {
          const handle = hitTestHandle(items[selectedIndex], x, y);
          if (handle) {
            canvas.style.cursor = handle.cursor;
            return;
          }
        }
        canvas.style.cursor = findTopItemAt(x, y) >= 0 ? 'grab' : 'default';
        return;
      }

      canvas.style.cursor = 'crosshair';

      if (currentTool === 'pin' && !activePopover) {
        hoverElement = inspectElementAt(host, x, y, openAppModal);
        render();
      } else if (hoverElement) {
        hoverElement = null;
        render();
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (dragAction) {
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        const action = dragAction;
        dragAction = null;
        const item = items[action.index];

        if (action.moved) {
          pushUndoSnapshot(action.beforeSnapshot);
          if (item && item.type === 'pin') {
            // Re-inspect DOM at the new pin position so selector & styles stay accurate
            item.element = inspectElementAt(host, item.x, item.y, openAppModal);
            showToast(`Updated Pin #${item.number} position & DOM target`, 1800);
          }
        } else if (item && item.type === 'pin') {
          // Clean click on a pin in Select mode opens its popover
          openPinPopover(item, false);
        }
        canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
        render();
        return;
      }

      if (!draftItem) return;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }

      let valid = true;
      if (draftItem.type === 'pen') {
        valid = draftItem.points.length >= 2;
      } else {
        const dist = Math.hypot(draftItem.x2 - draftItem.x1, draftItem.y2 - draftItem.y1);
        valid = dist >= 6;
      }

      if (valid) {
        pushUndoSnapshot();
        items.push(draftItem);
      }
      draftItem = null;
      render();
    });

    // Clear any in-flight drag/draft if pointer capture is interrupted
    function resetPointerInteraction() {
      if (dragAction) {
        if (dragAction.moved) {
          pushUndoSnapshot(dragAction.beforeSnapshot);
        }
        dragAction = null;
      }
      draftItem = null;
      canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
      render();
    }

    canvas.addEventListener('pointercancel', resetPointerInteraction);
    canvas.addEventListener('lostpointercapture', () => {
      if (dragAction || draftItem) resetPointerInteraction();
    });

    // Double-click to quickly edit Text callouts or Pins
    canvas.addEventListener('dblclick', (e) => {
      const x = e.clientX;
      const y = e.clientY;
      const pinIdx = findTopItemAt(x, y, 'pin');
      if (pinIdx >= 0) {
        selectedIndex = pinIdx;
        render();
        openPinPopover(items[pinIdx], false);
        return;
      }
      const txtIdx = findTopItemAt(x, y, 'text');
      if (txtIdx >= 0) {
        selectedIndex = txtIdx;
        render();
        openTextPopover(items[txtIdx].x, items[txtIdx].y, items[txtIdx]);
      }
    });

    // --- Toolbar Events ---
    function setTool(tool) {
      closePopover(true);
      dragAction = null;
      draftItem = null;
      currentTool = tool;
      hoverElement = null;
      if (tool !== 'select') selectedIndex = -1;
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
      for (const btn of toolbar.querySelectorAll('[data-tool]')) {
        btn.classList.toggle('active', btn.dataset.tool === tool);
      }
      render();
    }

    toolbar.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) {
        setTool(toolBtn.dataset.tool);
        return;
      }
      const swatch = e.target.closest('[data-color]');
      if (swatch) {
        currentColor = swatch.dataset.color;
        for (const s of toolbar.querySelectorAll('[data-color]')) {
          s.classList.toggle('active', s === swatch);
        }
        // Recolor currently selected annotation (if applicable)
        if (selectedIndex >= 0 && items[selectedIndex] && items[selectedIndex].type !== 'blur') {
          pushUndoSnapshot();
          items[selectedIndex].color = currentColor;
          render();
        }
      }
    });

    function undo() {
      if (undoStack.length === 0) return;
      closePopover();
      redoStack.push(cloneItems(items));
      items = undoStack.pop();
      selectedIndex = -1;
      renumberPins();
      render();
    }

    function redo() {
      if (redoStack.length === 0) return;
      closePopover();
      undoStack.push(cloneItems(items));
      items = redoStack.pop();
      selectedIndex = -1;
      renumberPins();
      render();
    }

    toolbar.querySelector('#undoBtn').addEventListener('click', undo);
    toolbar.querySelector('#redoBtn').addEventListener('click', redo);
    toolbar.querySelector('#clearBtn').addEventListener('click', () => {
      if (items.length === 0) return;
      closePopover();
      pushUndoSnapshot();
      items = [];
      selectedIndex = -1;
      render();
    });

    // --- Save & Cancel ---
    const titleInput = bottomBar.querySelector('#titleInput');
    const summaryInput = bottomBar.querySelector('#summaryInput');
    const saveBtn = bottomBar.querySelector('#saveBtn');
    const cancelBtn = bottomBar.querySelector('#cancelBtn');

    [titleInput, summaryInput].forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          handleSave();
        } else if (e.key === 'Escape') {
          inp.blur();
        }
      });
    });

    function buildRedactedBaseCanvas() {
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const octx = off.getContext('2d');
      if (baseBitmap) {
        octx.drawImage(baseBitmap, 0, 0, off.width, off.height);
      }
      octx.save();
      octx.scale(scaleX, scaleY);
      for (const item of items) {
        if (item.type === 'blur') {
          drawItem(octx, item, scaleX, scaleY);
        }
      }
      octx.restore();
      return off;
    }

    function generatePinCrop(redactedCanvas, pin) {
      const pad = 56;
      let rx, ry, rw, rh;

      if (pin.element?.rect && pin.element.rect.width > 0 && pin.element.rect.height > 0) {
        const r = pin.element.rect;
        rx = r.x - pad;
        ry = r.y - pad;
        rw = r.width + pad * 2;
        rh = r.height + pad * 2;
      } else {
        rw = 360;
        rh = 240;
        rx = pin.x - rw / 2;
        ry = pin.y - rh / 2;
      }

      // Clamp dimensions so crops are readable without being full-screen
      const minW = 280;
      const minH = 180;
      const maxW = 720;
      const maxH = 520;

      if (rw < minW) {
        rx -= (minW - rw) / 2;
        rw = minW;
      }
      if (rh < minH) {
        ry -= (minH - rh) / 2;
        rh = minH;
      }
      if (rw > maxW) {
        rx = pin.x - maxW / 2;
        rw = maxW;
      }
      if (rh > maxH) {
        ry = pin.y - maxH / 2;
        rh = maxH;
      }

      // Keep inside viewport bounds
      rx = Math.max(0, Math.min(rx, viewportW - rw));
      ry = Math.max(0, Math.min(ry, viewportH - rh));
      rw = Math.min(rw, viewportW - rx);
      rh = Math.min(rh, viewportH - ry);

      const srcX = Math.round(rx * scaleX);
      const srcY = Math.round(ry * scaleY);
      const srcW = Math.max(1, Math.round(rw * scaleX));
      const srcH = Math.max(1, Math.round(rh * scaleY));

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = srcW;
      cropCanvas.height = srcH;
      const cctx = cropCanvas.getContext('2d');
      cctx.drawImage(redactedCanvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

      // Draw a subtle dashed outline around the target element & small crosshair at pin
      cctx.save();
      cctx.scale(scaleX, scaleY);
      if (pin.element?.rect) {
        const r = pin.element.rect;
        cctx.strokeStyle = pin.color || '#ef4444';
        cctx.lineWidth = 1.5;
        cctx.setLineDash([4, 3]);
        cctx.strokeRect(r.x - rx, r.y - ry, r.width, r.height);
        cctx.setLineDash([]);
      }
      const px = pin.x - rx;
      const py = pin.y - ry;
      cctx.beginPath();
      cctx.arc(px, py, 6, 0, Math.PI * 2);
      cctx.strokeStyle = pin.color || '#ef4444';
      cctx.lineWidth = 2;
      cctx.stroke();
      cctx.restore();

      return cropCanvas.toDataURL('image/png');
    }

    async function handleSave() {
      closePopover(true);
      selectedIndex = -1;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        if (!baseBitmap) {
          throw new Error('Screenshot is still loading. Please try saving again.');
        }

        // Re-render cleanly without hover highlight before exporting PNG
        render(true);
        const annotatedImageDataUrl = canvas.toDataURL('image/png');

        // Build redacted base once for crisp, ZDR-safe zoomed pin crops
        const redactedBase = buildRedactedBaseCanvas();

        const pins = items
          .filter((i) => i.type === 'pin')
          .map((p) => ({
            number: p.number,
            kind: p.kind || 'bug',
            severity: p.severity || 'med',
            x: p.x,
            y: p.y,
            note: p.note,
            element: p.element,
            cropDataUrl: generatePinCrop(redactedBase, p)
          }));

        const textCallouts = items
          .filter((i) => i.type === 'text')
          .map((t) => ({ x: t.x, y: t.y, text: t.text }));

        const redactedCount = items.filter((i) => i.type === 'blur').length;
        const pageMetadata = collectPageMetadata();
        const consoleErrors = collectConsoleErrors();

        const payload = {
          title: titleInput.value.trim(),
          summary: summaryInput.value.trim(),
          url: tabUrl || window.location.href,
          pageTitle: tabTitle || document.title,
          createdAt: new Date().toISOString(),
          viewport: { width: viewportW, height: viewportH, dpr },
          pageMetadata,
          consoleErrors,
          pins,
          textCallouts,
          redactedCount,
          annotatedImageDataUrl
        };

        const res = await chrome.runtime.sendMessage({
          type: 'SUBMIT_FEEDBACK',
          payload
        });
        if (res?.ok) {
          showToast(`Saved to ${res.relativePath}/`);
          setTimeout(() => destroy(), 550);
        } else if (res?.queued) {
          showToast(res.reason || 'Queued! Open the side panel to finish saving.', 3500);
          setTimeout(() => destroy(), 1600);
        } else {
          showToast(res?.error || 'Could not save feedback.', 3500);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Feedback';
        }
      } catch (err) {
        console.error('[Local Feedback Studio] Save failed:', err);
        showToast(`Save failed: ${err.message || err}`, 4500);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Feedback';
      }
    }

    saveBtn.addEventListener('click', handleSave);
    cancelBtn.addEventListener('click', () => destroy());

    // Keyboard shortcuts
    function onKeyDown(e) {
      const target = e.composedPath()[0];
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.key === 'Escape') {
        if (activePopover) {
          closePopover();
          render();
        } else if (selectedIndex >= 0) {
          selectedIndex = -1;
          render();
        } else {
          destroy();
        }
        return;
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIndex >= 0 && items[selectedIndex]) {
        e.preventDefault();
        pushUndoSnapshot();
        items.splice(selectedIndex, 1);
        selectedIndex = -1;
        renumberPins();
        render();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
        return;
      }

      const keyMap = {
        v: 'select',
        '0': 'select',
        '1': 'pin',
        '2': 'box',
        '3': 'arrow',
        '4': 'text',
        '5': 'pen',
        '6': 'blur'
      };
      const k = e.key.toLowerCase();
      if (keyMap[k]) {
        setTool(keyMap[k]);
      }
    }

    window.addEventListener('keydown', onKeyDown, true);

    // Decode frozen screenshot via createImageBitmap (immune to strict page img-src CSP)
    createImageBitmap(dataUrlToBlob(screenshotDataUrl))
      .then((bmp) => {
        baseBitmap = bmp;
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        scaleX = bmp.width / viewportW;
        scaleY = bmp.height / viewportH;
        render();
      })
      .catch((err) => {
        console.error('[Local Feedback Studio] Failed to decode screenshot:', err);
        showToast(`Failed to load screenshot: ${err.message || err}`, 4000);
      });

    function destroy() {
      window.removeEventListener('keydown', onKeyDown, true);
      document.documentElement.style.overflow = prevOverflow;
      if (baseBitmap && typeof baseBitmap.close === 'function') {
        baseBitmap.close();
        baseBitmap = null;
      }
      try {
        if (useDialogHost && typeof host.close === 'function' && host.open) {
          host.close();
        } else if (!useDialogHost && typeof host.hidePopover === 'function') {
          host.hidePopover();
        }
      } catch {
        // ignore if already closed/hidden
      }
      host.remove();
      if (activeSession?.host === host) {
        activeSession = null;
      }
    }

    activeSession = { host, destroy };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'INIT_OVERLAY') {
      try {
        launchOverlay(message);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Local Feedback Studio] Failed to launch overlay:', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return true;
    }
  });
})();
