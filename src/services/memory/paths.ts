import path from 'path';
import fs from 'fs';

/** Root directory for all memory data. */
function memoryRoot(): string {
  return path.resolve(process.cwd(), 'data', 'memory');
}

/** L1 trace file: data/memory/trace/<surface>/<YYYY-MM-DD>.jsonl */
function traceFile(surface: string, date: string): string {
  return path.join(memoryRoot(), 'trace', surface, `${date}.jsonl`);
}

/** L2 consolidated doc: data/memory/L2/<surface>.md */
function l2File(surface: string): string {
  return path.join(memoryRoot(), 'L2', `${surface}.md`);
}

/** L3 synthesis doc: data/memory/L3/<slot>.md */
function l3File(slot: string): string {
  return path.join(memoryRoot(), 'L3', `${slot}.md`);
}

/** Ensure all memory directories exist. */
function ensureDirs(): void {
  const subdirs = ['trace', 'L2', 'L3'];
  for (const sub of subdirs) {
    const dir = path.join(memoryRoot(), sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/** Ensure trace surface subdirectory exists. */
function ensureSurfaceDir(surface: string): void {
  const dir = path.join(memoryRoot(), 'trace', surface);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export { memoryRoot, traceFile, l2File, l3File, ensureDirs, ensureSurfaceDir };
