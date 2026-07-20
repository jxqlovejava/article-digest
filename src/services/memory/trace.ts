/**
 * L1 Trace: append-only JSONL event log per surface per day.
 *
 * Layout: data/memory/trace/<surface>/<YYYY-MM-DD>.jsonl
 */

import fs from 'fs';
import path from 'path';
import type { TraceEvent, Surface } from '../../types/knowledge';
import { traceFile, ensureSurfaceDir } from './paths';

/** Format a Date or timestamp(ms) to YYYY-MM-DD string. */
function dateKey(dateOrTs: Date | number): string {
  const d = typeof dateOrTs === 'number' ? new Date(dateOrTs) : dateOrTs;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Append one JSON line to the trace file for the given surface + date. */
async function appendTrace(event: TraceEvent): Promise<void> {
  ensureSurfaceDir(event.surface);
  const date = dateKey(event.timestamp);
  const filePath = traceFile(event.surface, date);
  const line = JSON.stringify(event) + '\n';
  await fs.promises.appendFile(filePath, line, 'utf-8');
}

/** Read trace events for a surface, optionally filtered by date range. */
async function readTraces(surface: Surface, since?: Date): Promise<TraceEvent[]> {
  const traceDir = path.dirname(traceFile(surface, ''));
  if (!fs.existsSync(traceDir)) return [];

  const events: TraceEvent[] = [];
  const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    // Extract date from filename (YYYY-MM-DD.jsonl)
    const fileDateStr = file.replace('.jsonl', '');
    if (since) {
      const fileDate = new Date(fileDateStr + 'T00:00:00Z');
      if (fileDate < since) continue;
    }

    const filePath = path.join(traceDir, file);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as TraceEvent;
          events.push(event);
        } catch {
          // Skip malformed lines
          console.error('[trace] Skipping malformed trace line:', line.substring(0, 100));
        }
      }
    } catch (err) {
      console.error('[trace] Failed to read trace file:', file, err instanceof Error ? err.message : err);
    }
  }

  // Sort by timestamp ascending
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

export { appendTrace, readTraces, dateKey };
