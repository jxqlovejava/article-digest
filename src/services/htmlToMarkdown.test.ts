import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToMarkdown,
  cleanWebpageMarkdown,
  contentScore,
  pushPhoto,
  isUsableImageUrl,
  preprocessHtmlForMarkdown,
} from './htmlToMarkdown';

describe('htmlToMarkdown (turndown)', () => {
  it('converts headings, bold, lists, tables', () => {
    const photos: { url: string; width: number; height: number }[] = [];
    const html = `
      <h2>Section</h2>
      <p>Hello <strong>world</strong></p>
      <ul><li>one</li><li>two</li></ul>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    `;
    const md = htmlToMarkdown(html, photos);
    assert.match(md, /##\s+Section/);
    assert.match(md, /\*\*world\*\*/);
    assert.match(md, /-\s+one/);
    assert.match(md, /\|.*A.*\|/);
  });

  it('maps images to [IMG:N] and drops blob:', () => {
    const photos: { url: string; width: number; height: number }[] = [];
    const html = `
      <p><img src="https://cdn.example.com/a.png" alt="a"></p>
      <p><img src="blob:http://localhost/abc" alt="bad"></p>
      <p><img data-origin-src="https://feishucdn.com/x/img" src="data:image/gif;base64,xx"></p>
    `;
    const md = htmlToMarkdown(html, photos);
    assert.equal(photos.length, 2);
    assert.ok(md.includes('[IMG:0]'));
    assert.ok(md.includes('[IMG:1]'));
    assert.ok(!md.includes('blob:'));
  });

  it('promotes Feishu style bold spans', () => {
    const html = preprocessHtmlForMarkdown(
      `<p><span style="font-weight: bold">重要结论</span> 普通</p>`
    );
    assert.match(html, /<strong>重要结论<\/strong>/);
    const md = htmlToMarkdown(html, []);
    assert.match(md, /\*\*重要结论\*\*/);
  });
});

describe('cleanWebpageMarkdown feishu noise', () => {
  it('strips wiki chrome and failed load lines', () => {
    const raw = `
Wiki space inaccessible

# Real Title

Unable to print

Failed to load. Please try again.

正文第一段。
`;
    const cleaned = cleanWebpageMarkdown(raw, { isFeishu: true });
    assert.ok(!/Wiki space inaccessible/i.test(cleaned));
    assert.ok(!/Unable to print/i.test(cleaned));
    assert.ok(!/Failed to load/i.test(cleaned));
    assert.match(cleaned, /正文第一段/);
  });
});

describe('contentScore', () => {
  it('penalizes noise and rewards structure', () => {
    const noisy = contentScore('Wiki space inaccessible\nUnable to print\nshort', 0);
    const good = contentScore('## Intro\n\n- a\n- b\n\nlong body '.repeat(20), 2);
    assert.ok(good > noisy);
  });

  it('pushPhoto dedupes', () => {
    const photos: { url: string; width: number; height: number }[] = [];
    const a = pushPhoto(photos, 'https://x.com/1.png');
    const b = pushPhoto(photos, 'https://x.com/1.png');
    assert.equal(a, '[IMG:0]');
    assert.equal(b, '[IMG:0]');
    assert.equal(photos.length, 1);
    assert.equal(isUsableImageUrl('blob:http://x'), false);
  });
});
