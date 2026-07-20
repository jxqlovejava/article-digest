/**
 * L2 Consolidation: read L1 traces since last L2 update, use LLM to
 * merge into structured L2 entries, and apply them to the L2 doc.
 */

import type { L2Entry, Surface, TraceEvent } from '../../types/knowledge';
import { readTraces } from './trace';
import { readL2Doc, writeL2Doc } from './store';
import { generateEntryId } from './document';
import { chatWithJson, isLlmEnabled } from '../llm';

/** Result of a consolidation run. */
interface ConsolidateResult {
  surface: Surface;
  newTraces: number;
  newEntries: number;
  skipped: boolean;
  reason?: string;
}

/** The JSON shape expected from the LLM for consolidation. */
interface LlmConsolidationOutput {
  entries: {
    section: string;
    text: string;
    refs: string[];
  }[];
}

/** Consolidate L1 traces into L2 entries using LLM. */
async function consolidateL2(surface: Surface): Promise<ConsolidateResult> {
  const doc = await readL2Doc(surface);

  // Determine cutoff: last updated time of the L2 doc
  const since = new Date(doc.updatedAt);
  const traces = await readTraces(surface, since);

  if (traces.length === 0) {
    return {
      surface,
      newTraces: 0,
      newEntries: 0,
      skipped: true,
      reason: 'No new traces since last consolidation',
    };
  }

  const newEntries: L2Entry[] = [];

  if (isLlmEnabled()) {
    // Use LLM to consolidate traces into structured entries
    const traceSummary = traces.map(t => {
      const time = new Date(t.timestamp).toISOString();
      return `[${time}] ${t.eventType}: ${JSON.stringify(t.payload)}`;
    }).join('\n');

    const systemPrompt = `你是一个知识整理助手。将以下事件记录整合为结构化的知识条目。

每条事件记录可能包含文章标题、作者、摘要等字段。请从中提取出有价值的知识点，
归类到合适的章节下，每一条用简洁的语句描述，并注明来源引用。

返回 JSON 格式：
{
  "entries": [
    {
      "section": "章节名",
      "text": "知识条目文本",
      "refs": ["来源引用url或文件名"]
    }
  ]
}`;

    const userPrompt = `请为 surface "${surface}" 整合以下 ${traces.length} 条事件记录：\n\n${traceSummary}`;

    try {
      const result = await chatWithJson<LlmConsolidationOutput>(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.3 }
      );

      const now = Date.now();
      for (const entry of result.entries || []) {
        newEntries.push({
          id: generateEntryId(),
          section: entry.section || 'General',
          text: entry.text,
          refs: entry.refs || [],
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (err) {
      console.error('[consolidator] LLM consolidation failed:', err instanceof Error ? err.message : err);
      // Fall through to empty result if LLM fails
    }
  }

  // Fallback: if LLM didn't produce entries, create simple entries from traces
  if (newEntries.length === 0) {
    const now = Date.now();
    for (const trace of traces) {
      const text = trace.payload.text
        ? String(trace.payload.text).substring(0, 200)
        : `${trace.eventType} event`;
      newEntries.push({
        id: generateEntryId(),
        section: trace.eventType === 'archive' ? 'Archived' : 'Activity',
        text,
        refs: trace.payload.fileName ? [String(trace.payload.fileName)] : [],
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Apply new entries to the L2 doc
  for (const entry of newEntries) {
    let section = doc.sections.find(s => s.name === entry.section);
    if (!section) {
      section = { name: entry.section, entries: [] };
      doc.sections.push(section);
    }
    section.entries.push(entry);
  }

  await writeL2Doc(doc);

  return {
    surface,
    newTraces: traces.length,
    newEntries: newEntries.length,
    skipped: false,
  };
}

export { consolidateL2 };
export type { ConsolidateResult };
