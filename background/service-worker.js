// Local Feedback Studio — Background Service Worker (Manifest V3)
// Zero network requests. Strictly local capture and message routing.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('Failed to set sidePanel behavior:', err));
});

async function startAnnotationOnActiveTab(windowId) {
  const query = windowId
    ? { active: true, windowId }
    : { active: true, currentWindow: true };

  const [tab] = await chrome.tabs.query(query);
  if (!tab || !tab.id) {
    return { ok: false, error: 'No active tab found.' };
  }

  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('https://chromewebstore.google.com/')
  ) {
    return {
      ok: false,
      error: 'Chrome blocks extensions from capturing internal browser or Web Store pages. Switch to any website tab and try again.'
    };
  }

  // Clean up any existing or orphaned overlay from an earlier session/reload before capturing
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const existing = document.getElementById('local-feedback-studio-host');
        if (existing) {
          existing.remove();
          document.documentElement.style.overflow = '';
          return true;
        }
        return false;
      }
    });
    // Give the compositor two frames to repaint cleanly without the old overlay
    await new Promise((r) => setTimeout(r, 80));
  } catch {
    // ignore if cleanup script couldn't run
  }

  let screenshotDataUrl;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });
  } catch (err) {
    return {
      ok: false,
      error: `Screenshot capture failed: ${err.message || err}`
    };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js']
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not inject annotation overlay: ${err.message || err}`
    };
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'INIT_OVERLAY',
      screenshotDataUrl,
      tabUrl: tab.url,
      tabTitle: tab.title || ''
    });
    if (res && res.ok === false) {
      return { ok: false, error: res.error || 'Failed to launch overlay.' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to initialize overlay: ${err.message || err}`
    };
  }
}

// Keyboard shortcut: Alt+Shift+F
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-annotation') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await startAnnotationOnActiveTab(tab.windowId);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_ANNOTATION') {
    startAnnotationOnActiveTab(message.windowId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'SUBMIT_FEEDBACK') {
    (async () => {
      try {
        // Try delegating directly to the open Side Panel
        const result = await chrome.runtime.sendMessage({
          type: 'WRITE_FEEDBACK_TO_DISK',
          payload: message.payload
        });
        if (result && result.ok) {
          sendResponse(result);
          return;
        }
        // Side Panel is open but needs folder binding or permission re-grant
        await chrome.storage.session.set({ pendingFeedback: message.payload });
        sendResponse({
          ok: false,
          queued: true,
          reason: result?.reason || 'Open the side panel to bind or reconnect your folder and finish saving.'
        });
      } catch (_err) {
        // Side Panel is likely closed — queue in session storage
        await chrome.storage.session.set({ pendingFeedback: message.payload });
        sendResponse({
          ok: false,
          queued: true,
          reason: 'Feedback queued. Click the Local Feedback Studio icon to open the side panel and save to disk.'
        });
      }
    })();
    return true;
  }
});
