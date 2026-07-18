import { createServer } from './server';
import { rebuildIndex } from './services/renderer';
import { warmGlobalSuggestions } from './services/synthesize';
import { isLlmEnabled } from './services/llm';

const PORT = process.env.PORT || 3000;

const app = createServer();

async function start() {
  try {
    await rebuildIndex();
    console.log('[init] Index rebuilt successfully');
  } catch (err) {
    console.error('[init] Failed to build index:', err);
  }

  app.listen(PORT, () => {
    console.log(`Tweet Archive server running on http://localhost:${PORT}`);
    // Warm global QA suggested questions so sidebar → /qa shows chips immediately
    if (isLlmEnabled()) {
      warmGlobalSuggestions();
    } else {
      console.warn('[init] LLM not configured — skip warming global QA suggestions');
    }
  });
}

start();
