/**
 * Optional Microsoft MarkItDown (Python) side-path for HTML → Markdown.
 * Used as an A/B candidate alongside turndown; never hard-required.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 20000;

function resolvePython(): string {
  return (
    process.env.MARKITDOWN_PYTHON ||
    process.env.MARKITDOWN_BIN ||
    'python3'
  );
}

function resolveScript(): string {
  if (process.env.MARKITDOWN_SCRIPT) return process.env.MARKITDOWN_SCRIPT;
  // dist/services → ../../scripts  OR  src/services when running via ts-node
  const candidates = [
    path.join(__dirname, '..', '..', 'scripts', 'markitdown_html.py'),
    path.join(process.cwd(), 'scripts', 'markitdown_html.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export type MarkitdownResult =
  | { ok: true; markdown: string; ms: number }
  | { ok: false; error: string; code?: number };

/**
 * Convert HTML string with MarkItDown subprocess.
 * Returns ok:false if Python/markitdown missing or conversion fails.
 */
export function convertHtmlWithMarkitdown(
  html: string,
  opts: { timeoutMs?: number } = {}
): Promise<MarkitdownResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const python = resolvePython();
  const script = resolveScript();

  if (!html || !html.trim()) {
    return Promise.resolve({ ok: false, error: 'empty html' });
  }
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ok: false, error: `script missing: ${script}` });
  }

  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: MarkitdownResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', err => {
      finish({ ok: false, error: err.message });
    });

    child.on('close', code => {
      const ms = Date.now() - started;
      if (code === 0 && stdout.trim()) {
        finish({ ok: true, markdown: stdout.trim(), ms });
        return;
      }
      if (code === 2) {
        finish({
          ok: false,
          error: 'markitdown not installed',
          code: 2,
        });
        return;
      }
      finish({
        ok: false,
        error: (stderr || stdout || `exit ${code}`).trim().slice(0, 400),
        code: code ?? undefined,
      });
    });

    try {
      child.stdin.write(html, 'utf8');
      child.stdin.end();
    } catch (err) {
      finish({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Quick probe: is markitdown available? Cached for process lifetime. */
let _available: boolean | null = null;

export async function isMarkitdownAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  const probe = await convertHtmlWithMarkitdown(
    '<html><body><h1>t</h1><p>hi</p></body></html>',
    { timeoutMs: 8000 }
  );
  _available = probe.ok;
  if (!probe.ok) {
    console.warn(`[markitdown] unavailable: ${probe.error}`);
  }
  return _available;
}
