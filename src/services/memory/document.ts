/**
 * Markdown document parser/serializer for L2 and L3 memory documents.
 *
 * Format:
 *   # Title
 *
 *   ## Section
 *   - entry text [^ref1] [^ref2] <!--m_entryId-->
 *
 *   ---
 *
 *   [^ref1]: source reference URL or filename
 *   [^ref2]: another reference
 */

import crypto from 'crypto';
import type { L2Document, L2Entry, Surface, L3Document, L3Slot } from '../../types/knowledge';

/** Generate a unique entry ID: m_ + 26-char hex string */
function generateEntryId(): string {
  return 'm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 26);
}

/** Parse an L2 document from markdown string. */
function parseL2Doc(md: string): L2Document {
  const lines = md.split('\n');

  // First pass: extract title and footnotes
  let title = '';
  const footnotes = new Map<string, string>();
  const footnoteRe = /^\[([^\]]+)\]:\s*(.+)$/;

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!title && trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      title = trimmed.slice(2).trim();
      continue;
    }
    const fnMatch = trimmed.match(footnoteRe);
    if (fnMatch) {
      footnotes.set(fnMatch[1], fnMatch[2].trim());
    }
  }

  // Second pass: parse sections and entries
  const sections: { name: string; entries: L2Entry[] }[] = [];
  let currentSectionName = '';
  let currentEntries: L2Entry[] = [];
  let foundFirstSection = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();

    // Skip footnotes and separators in second pass
    if (footnoteRe.test(trimmed) || trimmed === '---' || trimmed === '') continue;

    // Section heading
    if (line.startsWith('## ')) {
      if (foundFirstSection && currentSectionName) {
        sections.push({ name: currentSectionName, entries: currentEntries });
      }
      currentSectionName = line.slice(3).trim();
      currentEntries = [];
      foundFirstSection = true;
      continue;
    }

    // List item (entry) — only after first ## heading
    const listItemMatch = line.match(/^-\s+(.+)/);
    if (listItemMatch && foundFirstSection) {
      const content = listItemMatch[1];

      // Extract entry ID from HTML comment <!--m_...-->
      const idMatch = content.match(/<!--(m_[\w]+)-->\s*$/);
      const entryId = idMatch ? idMatch[1] : generateEntryId();

      // Strip the ID comment from text
      let textContent = idMatch ? content.slice(0, idMatch.index!).trimEnd() : content;

      // Extract footnote references [^key]
      const refs: string[] = [];
      const refRe = /\[([^\]]+)\]/g;
      let refMatch;
      while ((refMatch = refRe.exec(textContent)) !== null) {
        const key = refMatch[1];
        if (footnotes.has(key)) {
          refs.push(footnotes.get(key)!);
        }
      }

      // Remove footnote markers from text
      textContent = textContent.replace(/\s*\[[^\]]+\]/g, '').trim();

      currentEntries.push({
        id: entryId,
        section: currentSectionName,
        text: textContent,
        refs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  // Push last section
  if (currentSectionName && currentEntries.length > 0) {
    sections.push({ name: currentSectionName, entries: currentEntries });
  }

  return {
    surface: '' as Surface, // caller should fill this
    title,
    sections,
    updatedAt: Date.now(),
  };
}

/** Serialize an L2 document to markdown string. */
function serializeL2Doc(doc: L2Document): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${doc.title}`);
  lines.push('');

  // Collect all unique references
  const allRefs = new Map<string, string>();
  let refCounter = 0;

  for (const section of doc.sections) {
    lines.push(`## ${section.name}`);
    lines.push('');
    for (const entry of section.entries) {
      const refKeys: string[] = [];
      for (const ref of entry.refs) {
        // Deduplicate refs across entries
        let key = '';
        for (const [k, v] of allRefs.entries()) {
          if (v === ref) { key = k; break; }
        }
        if (!key) {
          refCounter++;
          key = `ref${refCounter}`;
          allRefs.set(key, ref);
        }
        refKeys.push(key);
      }

      const refMarkers = refKeys.map(k => `[^${k}]`).join(' ');
      const refPart = refMarkers ? ` ${refMarkers}` : '';
      lines.push(`- ${entry.text}${refPart} <!--${entry.id}-->`);
    }
    lines.push('');
  }

  // Separator + footnotes
  if (allRefs.size > 0) {
    lines.push('---');
    lines.push('');
    for (const [key, value] of allRefs.entries()) {
      lines.push(`[^${key}]: ${value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Parse an L3 document from markdown string. */
function parseL3Doc(md: string): L3Document {
  const lines = md.split('\n');

  // First pass: extract title and footnotes
  let title = '';
  const footnotes = new Map<string, string>();
  const footnoteRe = /^\[([^\]]+)\]:\s*(.+)$/;

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!title && trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      title = trimmed.slice(2).trim();
      continue;
    }
    const fnMatch = trimmed.match(footnoteRe);
    if (fnMatch) {
      footnotes.set(fnMatch[1], fnMatch[2].trim());
    }
  }

  // Second pass: parse sections and entries
  const sections: { name: string; entries: L2Entry[] }[] = [];
  let currentSectionName = '';
  let currentEntries: L2Entry[] = [];
  let foundFirstSection = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (footnoteRe.test(trimmed) || trimmed === '---' || trimmed === '') continue;

    if (line.startsWith('## ')) {
      if (foundFirstSection && currentSectionName) {
        sections.push({ name: currentSectionName, entries: currentEntries });
      }
      currentSectionName = line.slice(3).trim();
      currentEntries = [];
      foundFirstSection = true;
      continue;
    }

    const listItemMatch = line.match(/^-\s+(.+)/);
    if (listItemMatch && foundFirstSection) {
      const content = listItemMatch[1];
      const idMatch = content.match(/<!--(m_[\w]+)-->\s*$/);
      const entryId = idMatch ? idMatch[1] : generateEntryId();
      let textContent = idMatch ? content.slice(0, idMatch.index!).trimEnd() : content;

      const refs: string[] = [];
      const refRe = /\[([^\]]+)\]/g;
      let refMatch;
      while ((refMatch = refRe.exec(textContent)) !== null) {
        const key = refMatch[1];
        if (footnotes.has(key)) {
          refs.push(footnotes.get(key)!);
        }
      }
      textContent = textContent.replace(/\s*\[[^\]]+\]/g, '').trim();

      currentEntries.push({
        id: entryId,
        section: currentSectionName,
        text: textContent,
        refs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  if (currentSectionName && currentEntries.length > 0) {
    sections.push({ name: currentSectionName, entries: currentEntries });
  }

  return {
    slot: '' as L3Slot,
    title,
    sections,
    updatedAt: Date.now(),
  };
}

/** Serialize an L3 document to markdown string. (Same format as L2) */
function serializeL3Doc(doc: L3Document): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title}`);
  lines.push('');

  const allRefs = new Map<string, string>();
  let refCounter = 0;

  for (const section of doc.sections) {
    lines.push(`## ${section.name}`);
    lines.push('');
    for (const entry of section.entries) {
      const refKeys: string[] = [];
      for (const ref of entry.refs) {
        let key = '';
        for (const [k, v] of allRefs.entries()) {
          if (v === ref) { key = k; break; }
        }
        if (!key) {
          refCounter++;
          key = `ref${refCounter}`;
          allRefs.set(key, ref);
        }
        refKeys.push(key);
      }

      const refMarkers = refKeys.map(k => `[^${k}]`).join(' ');
      const refPart = refMarkers ? ` ${refMarkers}` : '';
      lines.push(`- ${entry.text}${refPart} <!--${entry.id}-->`);
    }
    lines.push('');
  }

  if (allRefs.size > 0) {
    lines.push('---');
    lines.push('');
    for (const [key, value] of allRefs.entries()) {
      lines.push(`[^${key}]: ${value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export { generateEntryId, parseL2Doc, serializeL2Doc, parseL3Doc, serializeL3Doc };
