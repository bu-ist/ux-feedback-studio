// Local Feedback Studio — Side Panel Controller

import { loadDirectoryHandle, saveDirectoryHandle } from './db.js';
import {
  FEEDBACK_DIR_NAME,
  deleteFeedbackItem,
  listFeedbackItems,
  pickProjectFolder,
  queryFolderPermission,
  requestFolderPermission,
  saveFeedbackToFolder,
  toggleFeedbackStatus
} from './fs.js';

const els = {
  folderName: document.getElementById('folderName'),
  bindFolderBtn: document.getElementById('bindFolderBtn'),
  reconnectBanner: document.getElementById('reconnectBanner'),
  reconnectBtn: document.getElementById('reconnectBtn'),
  authorInput: document.getElementById('authorInput'),
  pendingBanner: document.getElementById('pendingBanner'),
  pendingMeta: document.getElementById('pendingMeta'),
  savePendingBtn: document.getElementById('savePendingBtn'),
  discardPendingBtn: document.getElementById('discardPendingBtn'),
  annotateBtn: document.getElementById('annotateBtn'),
  statusToast: document.getElementById('statusToast'),
  openCount: document.getElementById('openCount'),
  copyPromptBtn: document.getElementById('copyPromptBtn'),
  filterTabs: document.getElementById('filterTabs'),
  feedbackList: document.getElementById('feedbackList'),
  refreshBtn: document.getElementById('refreshBtn')
};

let boundHandle = null;
let folderPerm = 'none';
let allItems = [];
let activeFilter = 'open';
let pendingPayload = null;
let toastTimer = null;

function showToast(message, isError = false) {
  els.statusToast.textContent = message;
  els.statusToast.classList.remove('hidden', 'error');
  if (isError) els.statusToast.classList.add('error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.statusToast.classList.add('hidden');
  }, 4500);
}

function revokeThumbUrls() {
  for (const item of allItems) {
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }
}

async function refreshFolderState() {
  if (!boundHandle) {
    els.folderName.textContent = 'Not bound yet';
    els.bindFolderBtn.textContent = 'Bind Folder';
    els.reconnectBanner.classList.add('hidden');
    revokeThumbUrls();
    allItems = [];
    renderList();
    return;
  }

  folderPerm = await queryFolderPermission(boundHandle);
  els.folderName.textContent = `📁 ${boundHandle.name}`;
  els.bindFolderBtn.textContent = 'Change';

  if (folderPerm === 'granted') {
    els.reconnectBanner.classList.add('hidden');
    revokeThumbUrls();
    allItems = await listFeedbackItems(boundHandle);
    renderList();
    // Auto-flush pending capture if one was queued
    if (pendingPayload) {
      await flushPendingFeedback();
    }
  } else {
    els.reconnectBanner.classList.remove('hidden');
    revokeThumbUrls();
    allItems = [];
    renderList();
  }
}

function renderPendingBanner() {
  if (!pendingPayload) {
    els.pendingBanner.classList.add('hidden');
    return;
  }
  const title = pendingPayload.title || 'Untitled capture';
  const pinCount = pendingPayload.pins?.length || 0;
  els.pendingMeta.textContent = `"${title}" (${pinCount} pin${pinCount === 1 ? '' : 's'}) ready to write.`;
  els.pendingBanner.classList.remove('hidden');
}

async function flushPendingFeedback() {
  if (!pendingPayload) return;
  if (!boundHandle) {
    showToast('Bind a project folder first to save your pending capture.', true);
    return;
  }
  if (folderPerm !== 'granted') {
    const res = await requestFolderPermission(boundHandle);
    folderPerm = res;
    if (res !== 'granted') {
      showToast('Write permission is required to save.', true);
      return;
    }
  }

  try {
    const payloadWithAuthor = {
      ...pendingPayload,
      author: pendingPayload.author || els.authorInput.value.trim()
    };
    const saved = await saveFeedbackToFolder(boundHandle, payloadWithAuthor);
    pendingPayload = null;
    await chrome.storage.session.remove('pendingFeedback');
    renderPendingBanner();
    showToast(`Saved to ${saved.relativePath}/`);
    await refreshFolderState();
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, true);
  }
}

function renderList() {
  const openItems = allItems.filter((i) => i.status !== 'resolved');
  els.openCount.textContent = `${openItems.length} open`;

  if (!boundHandle) {
    els.feedbackList.innerHTML =
      '<div class="empty-state">Bind a project folder above to save and browse feedback items.</div>';
    return;
  }

  if (folderPerm !== 'granted') {
    els.feedbackList.innerHTML =
      `<div class="empty-state">Click <strong>Reconnect</strong> above to view saved feedback in <code>${FEEDBACK_DIR_NAME}/</code>.</div>`;
    return;
  }

  const filtered = allItems.filter((item) => {
    if (activeFilter === 'open') return item.status !== 'resolved';
    if (activeFilter === 'resolved') return item.status === 'resolved';
    return true;
  });

  if (filtered.length === 0) {
    const msg =
      activeFilter === 'open'
        ? 'No open feedback items. Capture a page to create one!'
        : 'No feedback items in this view.';
    els.feedbackList.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  els.feedbackList.innerHTML = '';
  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = `item-card ${item.status === 'resolved' ? 'resolved' : ''}`;

    if (item.thumbUrl) {
      const img = document.createElement('img');
      img.className = 'item-thumb';
      img.src = item.thumbUrl;
      img.alt = item.title;
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'item-body';

    const top = document.createElement('div');
    top.className = 'item-top';

    const titleEl = document.createElement('div');
    titleEl.className = 'item-title';
    titleEl.textContent = `#${item.id} ${item.title}`;

    const badge = document.createElement('span');
    badge.className = `status-badge ${item.status === 'resolved' ? 'resolved' : 'open'}`;
    badge.textContent = item.status;

    top.append(titleEl, badge);

    const pathEl = document.createElement('div');
    pathEl.className = 'item-path';
    pathEl.textContent = `${item.relativePath}/feedback.md`;
    pathEl.title = `${item.relativePath}/feedback.md`;

    const footer = document.createElement('div');
    footer.className = 'item-footer';

    const meta = document.createElement('span');
    meta.className = 'item-meta';
    const pinLabel = `${item.pins} pin${item.pins === 1 ? '' : 's'}`;
    meta.textContent = item.author ? `${item.author} · ${pinLabel}` : pinLabel;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = item.status === 'resolved' ? 'Reopen' : 'Resolve';
    toggleBtn.addEventListener('click', async () => {
      const next = item.status === 'resolved' ? 'open' : 'resolved';
      await toggleFeedbackStatus(boundHandle, item.folderName, next);
      await refreshFolderState();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-secondary btn-sm';
    delBtn.textContent = '×';
    delBtn.title = 'Delete feedback folder';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete ${item.relativePath}/?`)) return;
      await deleteFeedbackItem(boundHandle, item.folderName);
      await refreshFolderState();
    });

    actions.append(toggleBtn, delBtn);
    footer.append(meta, actions);
    body.append(top, pathEl, footer);
    card.appendChild(body);
    els.feedbackList.appendChild(card);
  }
}

// Event Listeners
els.bindFolderBtn.addEventListener('click', async () => {
  try {
    const handle = await pickProjectFolder();
    boundHandle = handle;
    await saveDirectoryHandle(handle);
    await refreshFolderState();
    showToast(`Bound folder: ${handle.name}`);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Could not bind folder: ${err.message}`, true);
    }
  }
});

els.reconnectBtn.addEventListener('click', async () => {
  if (!boundHandle) return;
  const res = await requestFolderPermission(boundHandle);
  if (res === 'granted') {
    await refreshFolderState();
    showToast(`Reconnected to ${boundHandle.name}`);
  } else {
    showToast('Permission was not granted.', true);
  }
});

els.savePendingBtn.addEventListener('click', flushPendingFeedback);

els.discardPendingBtn.addEventListener('click', async () => {
  pendingPayload = null;
  await chrome.storage.session.remove('pendingFeedback');
  renderPendingBanner();
});

els.annotateBtn.addEventListener('click', async () => {
  els.annotateBtn.disabled = true;
  try {
    const currentWin = await chrome.windows.getCurrent();
    const res = await chrome.runtime.sendMessage({
      type: 'START_ANNOTATION',
      windowId: currentWin.id
    });
    if (!res?.ok) {
      showToast(res?.error || 'Failed to start annotation.', true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    els.annotateBtn.disabled = false;
  }
});

els.copyPromptBtn.addEventListener('click', async () => {
  const openItems = allItems.filter((i) => i.status !== 'resolved');
  const folderHint = `${FEEDBACK_DIR_NAME}/`;
  const itemLines =
    openItems.length > 0
      ? openItems.map((i) => `- ${i.relativePath}/feedback.md ("${i.title}")`).join('\n')
      : `- All open items inside ${folderHint}`;

  const prompt = [
    `Review the open visual feedback items in \`${folderHint}\` (see \`${folderHint}README.md\` for conventions):`,
    itemLines,
    '',
    'For each item, read `feedback.md` and inspect `./annotated.png` plus any `./pin-N.png` zoomed crops, implement the fixes, update `status: open` to `status: resolved` in frontmatter, and rename the folder with a `done-` prefix.'
  ].join('\n');

  try {
    await navigator.clipboard.writeText(prompt);
    showToast('Copied AI agent prompt to clipboard!');
  } catch {
    showToast('Could not copy to clipboard.', true);
  }
});

els.refreshBtn.addEventListener('click', refreshFolderState);

els.filterTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  for (const t of els.filterTabs.querySelectorAll('.tab')) {
    t.classList.toggle('active', t === btn);
  }
  renderList();
});

// Listen for incoming feedback from the in-page overlay (routed via service worker)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'WRITE_FEEDBACK_TO_DISK') {
    (async () => {
      if (!boundHandle || folderPerm !== 'granted') {
        pendingPayload = message.payload;
        renderPendingBanner();
        sendResponse({
          ok: false,
          reason: !boundHandle
            ? 'No folder bound yet. Bind a folder in the side panel to save.'
            : 'Folder needs reconnect. Click Reconnect in the side panel to save.'
        });
        return;
      }

      try {
        const payloadWithAuthor = {
          ...message.payload,
          author: message.payload.author || els.authorInput.value.trim()
        };
        const saved = await saveFeedbackToFolder(boundHandle, payloadWithAuthor);
        showToast(`Saved to ${saved.relativePath}/`);
        await refreshFolderState();
        sendResponse({ ok: true, ...saved });
      } catch (err) {
        pendingPayload = message.payload;
        renderPendingBanner();
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }
});

els.authorInput.addEventListener('input', () => {
  chrome.storage.local.set({ feedbackAuthor: els.authorInput.value.trim() });
});

// Boot
async function init() {
  try {
    const localCfg = await chrome.storage.local.get('feedbackAuthor');
    if (localCfg?.feedbackAuthor) {
      els.authorInput.value = localCfg.feedbackAuthor;
    }
  } catch {
    // ignore
  }

  try {
    boundHandle = await loadDirectoryHandle();
  } catch (err) {
    console.error('Failed to load saved directory handle:', err);
  }

  try {
    const stored = await chrome.storage.session.get('pendingFeedback');
    if (stored?.pendingFeedback) {
      pendingPayload = stored.pendingFeedback;
      renderPendingBanner();
    }
  } catch {
    // ignore
  }

  await refreshFolderState();
}

init();
