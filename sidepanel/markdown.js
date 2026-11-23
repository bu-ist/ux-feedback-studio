// Generates and parses AI-agent-friendly Markdown feedback files

function escapeYaml(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

export function slugify(text, fallback = 'feedback') {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

export function buildFeedbackMarkdown(id, payload) {
  const createdAt = payload.createdAt || new Date().toISOString();
  const title = (payload.title || '').trim() || `Feedback ${id}`;
  const summary = (payload.summary || '').trim();
  const pins = Array.isArray(payload.pins) ? payload.pins : [];
  const textCallouts = Array.isArray(payload.textCallouts) ? payload.textCallouts : [];
  const consoleErrors = Array.isArray(payload.consoleErrors) ? payload.consoleErrors : [];
  const meta = payload.pageMetadata || {};
  const metaTags = meta.metaTags || {};
  const dataAttrs = meta.dataAttrs || {};
  const themeClasses = Array.isArray(meta.themeClasses) ? meta.themeClasses : [];
  const redactedCount = Number(payload.redactedCount || 0);

  // Pull build/user tags into frontmatter if present
  const buildEntry = Object.entries(metaTags).find(([k]) => /build|version|commit|release/i.test(k));
  const userEntry = Object.entries(metaTags).find(([k]) => /user|role/i.test(k));

  const lines = [
    '---',
    `id: "${escapeYaml(id)}"`,
    `title: "${escapeYaml(title)}"`,
    `status: open`,
    ...(payload.author ? [`author: "${escapeYaml(payload.author)}"`] : []),
    `created_at: "${escapeYaml(createdAt)}"`,
    `url: "${escapeYaml(payload.url || '')}"`,
    `page_title: "${escapeYaml(payload.pageTitle || '')}"`,
    `viewport: "${payload.viewport?.width || 0}x${payload.viewport?.height || 0}"`,
    `pins: ${pins.length}`,
    ...(buildEntry ? [`build: "${escapeYaml(`${buildEntry[0]}=${buildEntry[1]}`)}"`] : []),
    ...(userEntry ? [`signed_in_user: "${escapeYaml(userEntry[1])}"`] : []),
    ...(consoleErrors.length > 0 ? [`console_errors: ${consoleErrors.length}`] : []),
    ...(redactedCount > 0 ? [`redacted_regions: ${redactedCount}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    '![Annotated screenshot](./annotated.png)',
    ''
  ];

  if (summary) {
    lines.push('## Summary', '', summary, '');
  }

  lines.push(
    '## Page Context & Environment',
    '',
    ...(payload.author ? [`- **Author:** ${payload.author}`] : []),
    `- **URL:** ${payload.url || 'N/A'}`,
    `- **Page Title:** ${payload.pageTitle || 'N/A'}`,
    `- **Viewport:** \`${payload.viewport?.width || 0}x${payload.viewport?.height || 0}\` (DPR: ${payload.viewport?.dpr || 1})`,
    `- **Color Scheme:** \`${meta.prefersColorScheme || 'unknown'}\`${themeClasses.length ? ` (classes: \`${themeClasses.join(' ')}\`)` : ''}`,
    `- **Captured:** ${createdAt}`
  );

  const metaTagEntries = Object.entries(metaTags);
  if (metaTagEntries.length > 0) {
    lines.push('- **App Meta Tags:**');
    for (const [k, v] of metaTagEntries) {
      lines.push(`  - \`${k}\`: \`${v}\``);
    }
  }

  const dataAttrEntries = Object.entries(dataAttrs);
  if (dataAttrEntries.length > 0) {
    lines.push('- **Root Data Attributes (Theme / Variant):**');
    for (const [k, v] of dataAttrEntries) {
      lines.push(`  - \`${k}\`: \`${v}\``);
    }
  }

  lines.push('');

  if (pins.length > 0) {
    lines.push('## Pinned Annotations', '');
    pins.forEach((pin, idx) => {
      const num = pin.number || idx + 1;
      const kind = (pin.kind || 'bug').toUpperCase();
      const sev = (pin.severity || 'med').toUpperCase();
      const note = (pin.note || '').trim() || '(No note added)';
      lines.push(`### ${num}. [${kind} · ${sev}] ${note}`, '');

      if (pin.cropFilename) {
        lines.push(`![Pin ${num} zoomed crop](./${pin.cropFilename})`, '');
      }

      if (pin.element) {
        const el = pin.element;
        if (el.selector) {
          lines.push(`- **Selector:** \`${el.selector}\``);
        }
        if (el.tagSummary) {
          lines.push(`- **Element:** \`${el.tagSummary}\``);
        }
        if (el.text) {
          lines.push(`- **Text:** "${el.text.replace(/\r?\n/g, ' ').trim()}"`);
        }
        if (el.rect) {
          lines.push(
            `- **Bounding Box:** \`x: ${el.rect.x}, y: ${el.rect.y}, w: ${el.rect.width}, h: ${el.rect.height}\``
          );
        }
        if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
          const stylePairs = Object.entries(el.computedStyles)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
          lines.push(`- **Computed Styles:** \`${stylePairs}\``);
        }
        if (el.htmlSnippet) {
          lines.push('- **DOM Snippet (`outerHTML`):**', '  ```html', `  ${el.htmlSnippet}`, '  ```');
        }
      } else {
        lines.push(`- **Coordinates:** \`x: ${Math.round(pin.x)}, y: ${Math.round(pin.y)}\``);
      }

      lines.push('');
    });
  }

  if (textCallouts.length > 0) {
    lines.push('## On-Canvas Text Callouts', '');
    textCallouts.forEach((t, idx) => {
      lines.push(`${idx + 1}. "${t.text}" _(at \`x: ${Math.round(t.x)}, y: ${Math.round(t.y)}\`)_`);
    });
    lines.push('');
  }

  if (consoleErrors.length > 0) {
    lines.push('## Console Errors at Capture Time', '');
    consoleErrors.forEach((err, idx) => {
      lines.push(`${idx + 1}. **[${err.type}]** \`${err.message}\` _(${err.time})_`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

export function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {
    id: '',
    title: 'Untitled Feedback',
    status: 'open',
    author: '',
    created_at: '',
    url: '',
    pins: 0
  };
  if (!match) return meta;

  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    if (key === 'pins') {
      meta.pins = parseInt(val, 10) || 0;
    } else if (key in meta) {
      meta[key] = val;
    }
  }
  return meta;
}

export function updateFrontmatterStatus(markdown, newStatus) {
  if (/^---\r?\n[\s\S]*?^status:\s*\S+/m.test(markdown)) {
    return markdown.replace(
      /(^---\r?\n[\s\S]*?^status:\s*)\S+/m,
      `$1${newStatus}`
    );
  }
  return markdown;
}

export function buildFolderReadme() {
  return `# UI Feedback Queue

This folder is populated by **Local Feedback Studio** (a local-first Chrome extension). Each subfolder represents one visual feedback capture for an AI coding agent or developer to review and resolve.

## Git Tracking Recommendation

* **Default (Personal / Local Loop):** Add \`ui-feedback/\` to your project's \`.gitignore\` so screenshots and ephemeral review notes stay strictly local and out of git history.
* **Shared / Committed to Repo:** If your team commits \`ui-feedback/\` for shared QA or async design reviews, set your **Author** name in the Local Feedback Studio side panel. Each \`feedback.md\` records \`author:\` in its YAML frontmatter so anyone opening the repo can immediately see who filed each item.

## Folder Structure

\`\`\`text
ui-feedback/
├── README.md                  # This guide (auto-generated once; safe to customize)
├── 001-short-slug/            # Open feedback item
│   ├── feedback.md            # Structured notes, author, metadata, CSS selectors, styles & DOM
│   ├── annotated.png          # Full viewport screenshot with annotations & redactions
│   └── pin-1.png              # Zoomed crop for Pin #1 (one per pin)
└── done-002-another-slug/     # Completed feedback item
\`\`\`

## Instructions for AI Agents

1. **Find open items:** Look for subfolders that do **not** have a \`done-\` prefix (or \`-complete\` / \`-finished\` suffix) and whose \`feedback.md\` frontmatter has \`status: open\`.
2. **Inspect full context:** For each open item, read \`feedback.md\` and view \`annotated.png\` plus every \`pin-N.png\` zoomed crop referenced in the file.
   - Pay attention to each pin's \`[TYPE · SEVERITY]\` tag (\`BUG\`, \`POLISH\`, \`FEATURE\` and \`LOW\`, \`MED\`, \`HIGH\`).
   - Check the \`Page Context & Environment\` section for author, build info, theme/variant \`data-*\` attributes, viewport size, and any captured console errors.
3. **Mark items complete when done:**
   - Update \`status: open\` to \`status: resolved\` in \`feedback.md\` YAML frontmatter.
   - Optionally append a brief \`## Resolution\` section noting the files changed or commit hash.
   - Optionally rename the folder with a \`done-\` prefix (e.g., \`001-fix-nav/\` → \`done-001-fix-nav/\`) so open items stay grouped at the top.
`;
}

