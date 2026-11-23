// Local File System Access API operations (100% local, zero network)

import {
  buildFeedbackMarkdown,
  buildFolderReadme,
  parseFrontmatter,
  slugify,
  updateFrontmatterStatus
} from './markdown.js';

export const FEEDBACK_DIR_NAME = 'ui-feedback';

const COMPLETED_FOLDER_RE = /^(?:done|complete|completed|finished|resolved)[-_]|[-_](?:done|complete|completed|finished|resolved)$/i;
const FOLDER_ID_RE = /^(?:(?:done|complete|completed|finished|resolved)[-_])?(\d{3,})-/i;

function dataUrlToUint8Array(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Invalid image data URL');
  }
  const base64 = dataUrl.slice(commaIdx + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function pickProjectFolder() {
  return window.showDirectoryPicker({
    id: 'local-feedback-studio-root',
    mode: 'readwrite'
  });
}

export async function queryFolderPermission(handle) {
  if (!handle) return 'none';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

export async function requestFolderPermission(handle) {
  if (!handle) return 'denied';
  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

async function ensureFolderReadme(feedbackDir) {
  try {
    await feedbackDir.getFileHandle('README.md');
    // Already exists — never overwrite user customizations
  } catch {
    const readmeHandle = await feedbackDir.getFileHandle('README.md', { create: true });
    const writable = await readmeHandle.createWritable();
    await writable.write(buildFolderReadme());
    await writable.close();
  }
}

async function getNextFeedbackId(feedbackDir) {
  let maxId = 0;
  for await (const [name, entry] of feedbackDir.entries()) {
    if (entry.kind !== 'directory') continue;
    const match = name.match(FOLDER_ID_RE);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxId) maxId = num;
    }
  }
  return String(maxId + 1).padStart(3, '0');
}

export async function saveFeedbackToFolder(rootHandle, payload) {
  const perm = await queryFolderPermission(rootHandle);
  if (perm !== 'granted') {
    throw new Error('PERMISSION_REQUIRED');
  }

  const feedbackDir = await rootHandle.getDirectoryHandle(FEEDBACK_DIR_NAME, {
    create: true
  });

  await ensureFolderReadme(feedbackDir);

  const id = await getNextFeedbackId(feedbackDir);
  let fallbackSlug = 'feedback';
  try {
    const u = new URL(payload.url || '');
    const pathPart = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
    if (pathPart) fallbackSlug = pathPart;
    else if (u.hostname) fallbackSlug = u.hostname;
  } catch {
    // ignore invalid URL
  }

  const slug = slugify(payload.title, slugify(fallbackSlug, 'feedback'));
  const folderName = `${id}-${slug}`;

  const itemDir = await feedbackDir.getDirectoryHandle(folderName, {
    create: true
  });

  // 1. Write annotated.png
  const pngBytes = dataUrlToUint8Array(payload.annotatedImageDataUrl);
  const imgHandle = await itemDir.getFileHandle('annotated.png', { create: true });
  const imgWritable = await imgHandle.createWritable();
  await imgWritable.write(pngBytes);
  await imgWritable.close();

  // 2. Write zoomed per-pin crops (pin-1.png, pin-2.png, ...)
  const pins = Array.isArray(payload.pins) ? payload.pins : [];
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    if (!pin.cropDataUrl) continue;
    const num = pin.number || i + 1;
    const cropFilename = `pin-${num}.png`;
    const cropBytes = dataUrlToUint8Array(pin.cropDataUrl);
    const cropHandle = await itemDir.getFileHandle(cropFilename, { create: true });
    const cropWritable = await cropHandle.createWritable();
    await cropWritable.write(cropBytes);
    await cropWritable.close();
    pin.cropFilename = cropFilename;
  }

  // 3. Write feedback.md
  const markdown = buildFeedbackMarkdown(id, payload);
  const mdHandle = await itemDir.getFileHandle('feedback.md', { create: true });
  const mdWritable = await mdHandle.createWritable();
  await mdWritable.write(markdown);
  await mdWritable.close();

  return {
    id,
    folderName,
    relativePath: `${FEEDBACK_DIR_NAME}/${folderName}`
  };
}

export async function listFeedbackItems(rootHandle) {
  const perm = await queryFolderPermission(rootHandle);
  if (perm !== 'granted') return [];

  let feedbackDir;
  try {
    feedbackDir = await rootHandle.getDirectoryHandle(FEEDBACK_DIR_NAME);
  } catch {
    return [];
  }

  const items = [];
  for await (const [folderName, entry] of feedbackDir.entries()) {
    if (entry.kind !== 'directory') continue;
    try {
      const mdHandle = await entry.getFileHandle('feedback.md');
      const mdFile = await mdHandle.getFile();
      const mdText = await mdFile.text();
      const meta = parseFrontmatter(mdText);

      let thumbUrl = null;
      try {
        const imgHandle = await entry.getFileHandle('annotated.png');
        const imgFile = await imgHandle.getFile();
        thumbUrl = URL.createObjectURL(imgFile);
      } catch {
        // screenshot missing
      }

      const isRenamedDone = COMPLETED_FOLDER_RE.test(folderName);
      const idMatch = folderName.match(FOLDER_ID_RE);
      const derivedId = meta.id || (idMatch ? idMatch[1] : folderName.slice(0, 3));
      const derivedStatus =
        meta.status === 'resolved' || isRenamedDone ? 'resolved' : 'open';

      items.push({
        folderName,
        relativePath: `${FEEDBACK_DIR_NAME}/${folderName}`,
        id: derivedId,
        title: meta.title || folderName,
        status: derivedStatus,
        author: meta.author || '',
        createdAt: meta.created_at || '',
        url: meta.url || '',
        pins: meta.pins || 0,
        thumbUrl
      });
    } catch {
      // skip non-feedback subfolders
    }
  }

  items.sort((a, b) => Number(b.id) - Number(a.id) || b.folderName.localeCompare(a.folderName));
  return items;
}

export async function toggleFeedbackStatus(rootHandle, folderName, nextStatus) {
  const feedbackDir = await rootHandle.getDirectoryHandle(FEEDBACK_DIR_NAME);
  const itemDir = await feedbackDir.getDirectoryHandle(folderName);
  const mdHandle = await itemDir.getFileHandle('feedback.md');
  const mdFile = await mdHandle.getFile();
  const currentText = await mdFile.text();
  const updated = updateFrontmatterStatus(currentText, nextStatus);

  const writable = await mdHandle.createWritable();
  await writable.write(updated);
  await writable.close();
}

export async function deleteFeedbackItem(rootHandle, folderName) {
  const feedbackDir = await rootHandle.getDirectoryHandle(FEEDBACK_DIR_NAME);
  await feedbackDir.removeEntry(folderName, { recursive: true });
}
