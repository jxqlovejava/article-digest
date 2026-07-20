/**
 * L2/L3 document CRUD: read/write structured markdown docs with
 * sectioned entries and footnote citations.
 */

import fs from 'fs';
import path from 'path';
import type { L2Document, L2Entry, L3Document, L3Slot, Surface } from '../../types/knowledge';
import { l2File, l3File, ensureDirs } from './paths';
import { parseL2Doc, serializeL2Doc, parseL3Doc, serializeL3Doc, generateEntryId } from './document';

/** Overview entry for listing all docs with entry count. */
interface L2L3Overview {
  path: string;
  type: 'L2' | 'L3';
  name: string;
  entryCount: number;
  updatedAt: number;
}

/** Read an L2 document for a surface. Returns a default if no file exists. */
async function readL2Doc(surface: Surface): Promise<L2Document> {
  const filePath = l2File(surface);
  if (!fs.existsSync(filePath)) {
    return {
      surface,
      title: surface.charAt(0).toUpperCase() + surface.slice(1),
      sections: [],
      updatedAt: Date.now(),
    };
  }
  const md = await fs.promises.readFile(filePath, 'utf-8');
  const doc = parseL2Doc(md);
  doc.surface = surface;
  return doc;
}

/** Write an L2 document to disk. */
async function writeL2Doc(doc: L2Document): Promise<void> {
  ensureDirs();
  doc.updatedAt = Date.now();
  const md = serializeL2Doc(doc);
  await fs.promises.writeFile(l2File(doc.surface), md, 'utf-8');
}

/** Add one entry to an L2 document. Returns the entry with generated id. */
async function addL2Entry(surface: Surface, entry: Omit<L2Entry, 'id'> & { id?: string }): Promise<L2Entry> {
  const doc = await readL2Doc(surface);
  const newEntry: L2Entry = {
    ...entry,
    id: entry.id || generateEntryId(),
    createdAt: entry.createdAt || Date.now(),
    updatedAt: entry.updatedAt || Date.now(),
  };

  // Find or create the section
  let section = doc.sections.find(s => s.name === entry.section);
  if (!section) {
    section = { name: entry.section, entries: [] };
    doc.sections.push(section);
  }
  section.entries.push(newEntry);
  await writeL2Doc(doc);
  return newEntry;
}

/** Read an L3 document for a slot. Returns a default if no file exists. */
async function readL3Doc(slot: L3Slot): Promise<L3Document> {
  const filePath = l3File(slot);
  if (!fs.existsSync(filePath)) {
    return {
      slot,
      title: slot.charAt(0).toUpperCase() + slot.slice(1),
      sections: [],
      updatedAt: Date.now(),
    };
  }
  const md = await fs.promises.readFile(filePath, 'utf-8');
  const doc = parseL3Doc(md);
  doc.slot = slot;
  return doc;
}

/** Write an L3 document to disk. */
async function writeL3Doc(doc: L3Document): Promise<void> {
  ensureDirs();
  doc.updatedAt = Date.now();
  const md = serializeL3Doc(doc);
  await fs.promises.writeFile(l3File(doc.slot), md, 'utf-8');
}

/** Add one entry to an L3 document. Returns the entry with generated id. */
async function addL3Entry(slot: L3Slot, entry: Omit<L2Entry, 'id'> & { id?: string }): Promise<L2Entry> {
  const doc = await readL3Doc(slot);
  const newEntry: L2Entry = {
    ...entry,
    id: entry.id || generateEntryId(),
    createdAt: entry.createdAt || Date.now(),
    updatedAt: entry.updatedAt || Date.now(),
  };

  let section = doc.sections.find(s => s.name === entry.section);
  if (!section) {
    section = { name: entry.section, entries: [] };
    doc.sections.push(section);
  }
  section.entries.push(newEntry);
  await writeL3Doc(doc);
  return newEntry;
}

/** List all L2 and L3 docs with metadata. */
function overview(): L2L3Overview[] {
  ensureDirs();
  const result: L2L3Overview[] = [];

  const memRoot = path.resolve(process.cwd(), 'data', 'memory');

  // L2 docs
  const l2Dir = path.join(memRoot, 'L2');
  if (fs.existsSync(l2Dir)) {
    for (const file of fs.readdirSync(l2Dir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(l2Dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const entryCount = (content.match(/^-\s+/gm) || []).length;
        const stat = fs.statSync(filePath);
        result.push({
          path: filePath,
          type: 'L2',
          name: file.replace('.md', ''),
          entryCount,
          updatedAt: stat.mtimeMs,
        });
      } catch (err) {
        console.error('[store] Failed to read L2 doc:', file, err instanceof Error ? err.message : err);
      }
    }
  }

  // L3 docs
  const l3Dir = path.join(memRoot, 'L3');
  if (fs.existsSync(l3Dir)) {
    for (const file of fs.readdirSync(l3Dir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(l3Dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const entryCount = (content.match(/^-\s+/gm) || []).length;
        const stat = fs.statSync(filePath);
        result.push({
          path: filePath,
          type: 'L3',
          name: file.replace('.md', ''),
          entryCount,
          updatedAt: stat.mtimeMs,
        });
      } catch (err) {
        console.error('[store] Failed to read L3 doc:', file, err instanceof Error ? err.message : err);
      }
    }
  }

  return result;
}

export { readL2Doc, writeL2Doc, addL2Entry, readL3Doc, writeL3Doc, addL3Entry, overview };
export type { L2L3Overview };
