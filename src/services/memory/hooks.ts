/**
 * Auto-tracing hooks: convenience wrappers that emit trace events
 * for key operations (archive, read, delete, etc.).
 */

import crypto from 'crypto';
import type { Surface, TraceEvent } from '../../types/knowledge';
import { appendTrace } from './trace';

/** Emit a trace event for archiving an article. */
async function traceArchive(fileName: string, metadata: Record<string, unknown>): Promise<void> {
  const event: TraceEvent = {
    traceId: crypto.randomUUID(),
    surface: 'articles',
    eventType: 'archive',
    payload: {
      fileName,
      ...metadata,
    },
    timestamp: Date.now(),
  };
  await appendTrace(event);
}

/** Emit a trace event for reading an article. */
async function traceRead(fileName: string): Promise<void> {
  const event: TraceEvent = {
    traceId: crypto.randomUUID(),
    surface: 'articles',
    eventType: 'read',
    payload: { fileName },
    timestamp: Date.now(),
  };
  await appendTrace(event);
}

/** Emit a trace event for deleting an article. */
async function traceDelete(fileName: string): Promise<void> {
  const event: TraceEvent = {
    traceId: crypto.randomUUID(),
    surface: 'articles',
    eventType: 'read',
    payload: { fileName, action: 'delete' },
    timestamp: Date.now(),
  };
  await appendTrace(event);
}

export { traceArchive, traceRead, traceDelete };
