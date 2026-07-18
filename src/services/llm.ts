import axios, { AxiosRequestConfig } from 'axios';
import { Readable } from 'stream';
import { HttpsProxyAgent } from 'https-proxy-agent';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
/** Default / short-context model (DeepSeek API currently: deepseek-v4-flash | deepseek-v4-pro) */
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
/** Long-context / QA model */
const LLM_MODEL_PRO = process.env.LLM_MODEL_PRO || process.env.LLM_MODEL_QA || 'deepseek-v4-pro';
/** Switch to Pro when estimated prompt chars exceed this */
const LLM_PRO_CONTEXT_CHARS = parseInt(process.env.LLM_PRO_CONTEXT_CHARS || '6000', 10);

/** Non-stream request timeout (ms). */
const LLM_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || '90000', 10);
/**
 * Stream wall-clock timeout (ms). Must cover full RAG generation.
 * (Old 60s default aborted mid-answer.)
 */
// 0 = disable axios total timeout (recommended for streams through proxy).
// Set LLM_STREAM_TIMEOUT=300000 only if you need a hard wall-clock cap.
const LLM_STREAM_TIMEOUT = parseInt(process.env.LLM_STREAM_TIMEOUT || '0', 10);
const LLM_MAX_RETRIES = 3;
/**
 * DeepSeek V4 thinking defaults to ON and streams CoT via reasoning_content.
 * We only surface delta.content — long silent reasoning → proxy/idle aborts
 * and "empty/partial answers". Default OFF for QA reliability.
 * Set LLM_THINKING=1 to enable.
 */
const LLM_THINKING_ENABLED =
  process.env.LLM_THINKING === '1' ||
  process.env.LLM_THINKING === 'true' ||
  process.env.LLM_THINKING === 'enabled';

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  /** Force a model id; otherwise auto-pick flash/pro by context size */
  model?: string;
  /** Prefer pro for this call (QA with RAG) */
  preferPro?: boolean;
}

let enabled = !!LLM_API_KEY;

/**
 * Fresh agent per request — shared HttpsProxyAgent across concurrent streams
 * was observed to mid-abort sibling SSE reads through mihomo.
 */
function createProxyAgent(): HttpsProxyAgent | undefined {
  if (!PROXY_URL) return undefined;
  try {
    return new HttpsProxyAgent(PROXY_URL);
  } catch {
    return undefined;
  }
}

/** Explicit proxy for Docker→mihomo; axios env proxy alone is unreliable for streams. */
function axiosConfig(extra: AxiosRequestConfig = {}): AxiosRequestConfig {
  const agent = createProxyAgent();
  return {
    ...extra,
    // When using custom agent, disable axios's own proxy parsing
    proxy: agent ? false : extra.proxy,
    httpAgent: agent || extra.httpAgent,
    httpsAgent: agent || extra.httpsAgent,
  };
}

export function isLlmEnabled(): boolean {
  return enabled;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Map axios/node abort noise → stable operator-facing messages. */
export function friendlyLlmError(err: unknown): string {
  const raw = getErrorMessage(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  const lower = raw.toLowerCase();
  if (
    code === 'ECONNABORTED' ||
    code === 'ERR_CANCELED' ||
    lower === 'aborted' ||
    lower === 'canceled' ||
    lower === 'cancelled' ||
    lower.includes('timeout') ||
    lower.includes('aborted') ||
    lower.includes('socket hang up') ||
    lower.includes('econnreset')
  ) {
    return '回答生成超时或连接中断，请重试（可缩短问题或稍后再试）';
  }
  if (lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('network')) {
    return '无法连接模型服务，请检查网络或代理后重试';
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
    return '模型鉴权失败，请检查 LLM_API_KEY';
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return '模型请求过于频繁，请稍后再试';
  }
  return raw || '模型请求失败';
}

function estimateMessagesChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += (m.content || '').length;
  return n;
}

/** Pick model: Pro for long RAG context, Flash otherwise. */
export function pickLlmModel(
  messages: ChatMessage[],
  options: ChatOptions = {}
): string {
  if (options.model) return options.model;
  const chars = estimateMessagesChars(messages);
  if (options.preferPro || chars >= LLM_PRO_CONTEXT_CHARS) {
    return LLM_MODEL_PRO;
  }
  return LLM_MODEL;
}

function extractMessageText(choice: {
  message?: { content?: string | null; reasoning_content?: string | null };
}): string {
  const msg = choice?.message;
  if (!msg) return '';
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.trim()) return content;
  // Some v4 responses put interim text only in reasoning_content
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  return reasoning;
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY not configured');
  }

  const model = pickLlmModel(messages, options);
  const url = `${LLM_BASE_URL}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 4096,
    // DeepSeek V4: thinking defaults to enabled; disable unless explicitly requested
    thinking: { type: LLM_THINKING_ENABLED ? 'enabled' : 'disabled' },
  };

  if (options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        url,
        body,
        axiosConfig({
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${LLM_API_KEY}`,
          },
          timeout: LLM_TIMEOUT,
        })
      );
      const content = extractMessageText(res.data?.choices?.[0] || {});
      if (content.length > 0) {
        return content;
      }
      throw new Error('Empty response from LLM');
    } catch (err) {
      lastError = new Error(friendlyLlmError(err));
      if (attempt < LLM_MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('LLM request failed');
}

interface StreamRunMeta {
  sawDone: boolean;
  finishReason: string | null;
  yielded: number;
  abortedMidway: boolean;
}

async function* chatStreamOnce(
  messages: ChatMessage[],
  options: ChatOptions,
  model: string,
  meta: StreamRunMeta
): AsyncIterable<string> {
  const url = `${LLM_BASE_URL}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 4096,
    stream: true,
    // Critical: default thinking=on with empty content for a long time → mid-stream aborts
    thinking: { type: LLM_THINKING_ENABLED ? 'enabled' : 'disabled' },
  };

  let res;
  try {
    res = await axios.post(
      url,
      body,
      axiosConfig({
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        // 0 = no total-time kill. Wall-clock aborts mid-answer on flaky proxy even with data flowing.
        // Idle safety is handled by Node socket; LLM_STREAM_TIMEOUT kept for non-zero override.
        timeout: LLM_STREAM_TIMEOUT > 0 ? LLM_STREAM_TIMEOUT : 0,
        responseType: 'stream',
        validateStatus: status => status >= 200 && status < 300,
        // Avoid axios cancelling an active stream too aggressively through proxy
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })
    );
  } catch (err) {
    throw new Error(friendlyLlmError(err));
  }

  const stream = res.data as Readable;
  // Prevent idle proxy sockets from sitting forever without progress logs
  try {
    stream.setMaxListeners?.(20);
  } catch { /* ignore */ }

  let buffer = '';
  meta.yielded = 0;
  meta.sawDone = false;
  meta.finishReason = null;
  meta.abortedMidway = false;

  try {
    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          meta.sawDone = true;
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed?.error) {
            const msg =
              typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error?.message || JSON.stringify(parsed.error);
            throw new Error(String(msg));
          }
          const choice = parsed?.choices?.[0] || {};
          if (choice.finish_reason) {
            meta.finishReason = String(choice.finish_reason);
          }
          const delta = choice.delta || {};
          // Only stream visible answer content (not reasoning_content).
          const piece = typeof delta.content === 'string' ? delta.content : '';
          if (piece) {
            meta.yielded += piece.length;
            yield piece;
          }
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) continue;
          throw parseErr;
        }
      }
    }
  } catch (err) {
    if (meta.yielded >= 40) {
      meta.abortedMidway = true;
      console.error(
        '[llm] stream ended after partial output:',
        friendlyLlmError(err),
        `yielded=${meta.yielded}`
      );
      return;
    }
    throw new Error(friendlyLlmError(err));
  }

  if (!meta.sawDone && meta.yielded > 0) {
    meta.abortedMidway = true;
    console.error(
      `[llm] stream closed without [DONE] yielded=${meta.yielded} finish_reason=${meta.finishReason || '-'} aborted=true`
    );
  }
}

export async function* chatStream(
  messages: ChatMessage[],
  options: ChatOptions = {}
): AsyncIterable<string> {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY not configured');
  }

  // Streaming defaults to Flash: Pro + large RAG was frequently mid-cut by proxy.
  // Caller can still force a model via options.model.
  const model = options.model || LLM_MODEL;
  console.error(
    `[llm] stream model=${model} chars≈${estimateMessagesChars(messages)} forcedModel=${!!options.model}`
  );

  let lastErr: Error | null = null;
  let assembled = '';

  const runOnce = async function* (
    runMessages: ChatMessage[]
  ): AsyncGenerator<string, StreamRunMeta, void> {
    const meta: StreamRunMeta = {
      sawDone: false,
      finishReason: null,
      yielded: 0,
      abortedMidway: false,
    };
    for await (const delta of chatStreamOnce(runMessages, options, model, meta)) {
      assembled += delta;
      yield delta;
    }
    return meta;
  };

  // 1) Primary stream
  try {
    const gen = runOnce(messages);
    let step = await gen.next();
    while (!step.done) {
      yield step.value;
      step = await gen.next();
    }
    const meta = step.value;

    if (meta.finishReason === 'length') {
      yield '\n\n> ⚠️ 回答达到长度上限，可回复「请继续」让我接着写。';
      return;
    }
    if (meta.sawDone) return;

    // 2) Partial → finish via non-stream (proxy often kills long SSE; one-shot is stable)
    if (meta.abortedMidway && assembled.length >= 40) {
      console.error(`[llm] stream partial → non-stream continue yielded=${assembled.length}`);
      await new Promise(r => setTimeout(r, 300));
      try {
        const contMessages: ChatMessage[] = [
          ...messages,
          { role: 'assistant', content: assembled },
          {
            role: 'user',
            content:
              '请从上文中断处无缝继续写完剩余内容。不要重复已输出文字，不要提及中断或续写，直接接着写。',
          },
        ];
        const rest = await chat(contMessages, {
          ...options,
          model,
          maxTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.3,
        });
        if (rest && rest.trim()) {
          // Avoid exact overlap if model repeated a trailing sentence
          let add = rest;
          const tail = assembled.slice(-80);
          const idx = rest.indexOf(tail);
          if (idx >= 0 && tail.length >= 20) {
            add = rest.slice(idx + tail.length);
          }
          if (add.trim()) {
            assembled += add;
            yield add;
          }
          return;
        }
      } catch (contErr) {
        console.error(
          '[llm] non-stream continue failed:',
          contErr instanceof Error ? contErr.message : contErr
        );
      }
      yield '\n\n> ⚠️ 连接中断，以上回答可能不完整，可重试或追问「请继续」。';
      return;
    }

    // Empty primary — cold retry once
    if (assembled.length === 0) {
      console.error('[llm] stream retry after empty');
      await new Promise(r => setTimeout(r, 800));
      const gen3 = runOnce(messages);
      let step3 = await gen3.next();
      while (!step3.done) {
        yield step3.value;
        step3 = await gen3.next();
      }
      const meta3 = step3.value;
      if (meta3.sawDone || assembled.length > 0) {
        if (!meta3.sawDone && assembled.length >= 40 && meta3.abortedMidway) {
          yield '\n\n> ⚠️ 连接中断，以上回答可能不完整，可重试或追问「请继续」。';
        }
        return;
      }
      throw new Error('Empty stream from LLM');
    }

    if (!meta.sawDone && assembled.length >= 40) {
      yield '\n\n> ⚠️ 连接中断，以上回答可能不完整，可重试或追问「请继续」。';
    }
    return;
  } catch (err) {
    lastErr = err instanceof Error ? err : new Error(String(err));
    const msg = lastErr.message.toLowerCase();
    const retryable =
      msg.includes('超时') ||
      msg.includes('中断') ||
      msg.includes('abort') ||
      msg.includes('timeout') ||
      msg.includes('hang up') ||
      msg.includes('empty stream');

    if (assembled.length >= 40) {
      // Already showed useful text — soft notice instead of hard fail
      yield '\n\n> ⚠️ 连接中断，以上回答可能不完整，可重试或追问「请继续」。';
      return;
    }

    if (retryable) {
      console.error('[llm] stream retry after:', lastErr.message);
      await new Promise(r => setTimeout(r, 800));
      try {
        const gen = runOnce(messages);
        let step = await gen.next();
        while (!step.done) {
          yield step.value;
          step = await gen.next();
        }
        const meta = step.value;
        if (meta.sawDone || assembled.length > 0) {
          if (!meta.sawDone && assembled.length >= 40) {
            yield '\n\n> ⚠️ 连接中断，以上回答可能不完整，可重试或追问「请继续」。';
          }
          return;
        }
      } catch (err2) {
        throw err2 instanceof Error ? err2 : new Error(String(err2));
      }
    }
    throw lastErr;
  }
}

export async function chatWithJson<T>(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<T> {
  const text = await chat(messages, { ...options, responseFormat: 'json_object' });
  // Strip markdown code fences if present
  const jsonText = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    // If JSON parse fails, try extracting the first JSON object from the text
    const match = jsonText.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(`Failed to parse LLM JSON response: ${text.substring(0, 200)}`);
  }
}
