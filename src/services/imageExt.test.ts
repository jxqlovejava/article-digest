import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectImageExtFromBuffer, guessImageExtFromUrl } from './renderer';

describe('guessImageExtFromUrl', () => {
  it('reads wx_fmt query (WeChat)', () => {
    assert.equal(
      guessImageExtFromUrl('http://mmbiz.qpic.cn/mmbiz_png/xxx/0?wx_fmt=png'),
      '.png'
    );
    assert.equal(
      guessImageExtFromUrl('http://mmbiz.qpic.cn/mmbiz_jpg/xxx/0?wx_fmt=jpeg'),
      '.jpg'
    );
  });

  it('reads mmbiz_TYPE in path', () => {
    assert.equal(
      guessImageExtFromUrl('https://mmbiz.qpic.cn/mmbiz_gif/abc/0'),
      '.gif'
    );
  });
});

describe('detectImageExtFromBuffer', () => {
  it('detects PNG / JPEG / SVG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.equal(detectImageExtFromBuffer(png), '.png');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    assert.equal(detectImageExtFromBuffer(jpg), '.jpg');
    const svg = Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    assert.equal(detectImageExtFromBuffer(svg), '.svg');
  });
});
