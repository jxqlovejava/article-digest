import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWechatCodeSnippets } from './fetcher';

describe('normalizeWechatCodeSnippets', () => {
  it('removes line-index bullets and joins multi-code lines with newlines', () => {
    const input = `
<section class="code-snippet__fix code-snippet__js">
  <ul class="code-snippet__line-index code-snippet__js"><li></li><li></li><li></li></ul>
  <pre class="code-snippet__js" data-lang="bash">
    <code><span leaf="">skill-name/</span></code>
    <code><span leaf="">├── SKILL.md          <span class="code-snippet__comment"># 必需</span></span></code>
    <code><span leaf="">└── assets/</span></code>
  </pre>
</section>`;
    const out = normalizeWechatCodeSnippets(input);
    assert.ok(!/code-snippet__line-index/.test(out));
    assert.ok(!/<li>/.test(out));
    assert.match(out, /<pre[^>]*data-lang="bash"[^>]*>/);
    assert.ok(out.includes('skill-name/'));
    assert.ok(out.includes('├── SKILL.md'));
    assert.ok(out.includes('# 必需'));
    assert.match(out, /skill-name\/\n├── SKILL\.md/);
    assert.match(out, /SKILL\.md[^\n]*\n└── assets\//);
  });

  it('is a no-op when there is no code-snippet markup', () => {
    const input = '<p>hello</p><pre><code>a\nb</code></pre>';
    assert.equal(normalizeWechatCodeSnippets(input), input);
  });

  it('escapes HTML specials in code text', () => {
    const input = `
<section class="code-snippet__fix">
  <ul class="code-snippet__line-index"><li></li></ul>
  <pre data-lang="html"><code><span leaf="">&lt;div class="x"&gt;</span></code></pre>
</section>`;
    const out = normalizeWechatCodeSnippets(input);
    assert.ok(out.includes('&lt;div class="x"&gt;'));
    assert.ok(!/code-snippet__fix/.test(out));
  });

  it('preserves empty lines from empty code children', () => {
    const input = `
<section class="code-snippet__fix">
  <ul class="code-snippet__line-index"><li></li><li></li><li></li></ul>
  <pre><code><span leaf="">a</span></code><code><span leaf=""></span></code><code><span leaf="">b</span></code></pre>
</section>`;
    const out = normalizeWechatCodeSnippets(input);
    assert.match(out, />a\n\nb</);
  });
});
