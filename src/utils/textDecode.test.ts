import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScrapedText, normalizeAuthorField } from './textDecode';

describe('normalizeScrapedText', () => {
  it('decodes single HTML entities', () => {
    assert.equal(normalizeScrapedText('Founder&nbsp;Park'), 'Founder Park');
    assert.equal(normalizeScrapedText('a&amp;b'), 'a&b');
    assert.equal(normalizeScrapedText('&quot;x&quot;'), '"x"');
    assert.equal(normalizeScrapedText('Don&#39;t'), "Don't");
    assert.equal(normalizeScrapedText('Don&#x27;t'), "Don't");
  });

  it('fully undoes double/triple amp encoding', () => {
    assert.equal(normalizeScrapedText('营销&amp;交易技术'), '营销&交易技术');
    assert.equal(normalizeScrapedText('营销&amp;amp;交易技术'), '营销&交易技术');
    assert.equal(normalizeScrapedText('营销&amp;amp;amp;交易技术'), '营销&交易技术');
  });

  it('decodes unicode escapes', () => {
    assert.equal(normalizeScrapedText('\\u4e2d\\u6587'), '中文');
    assert.equal(normalizeScrapedText('hello\\u0026world'), 'hello&world');
  });

  it('strips WeChat .html(false) suffix', () => {
    assert.equal(normalizeScrapedText('标题.html(false)'), '标题');
  });

  it('handles mixed entity + nbsp in author names', () => {
    assert.equal(normalizeAuthorField('小灰&nbsp;&amp;amp;&nbsp;阿咕噜'), '小灰 & 阿咕噜');
    assert.equal(normalizeAuthorField('tin&amp;#39;y'), "tin'y");
  });

  it('decodes JavaScript \\n and \\\\ escapes from source extraction', () => {
    // WeChat sometimes puts literal \n in msg_title (JS source string escapes)
    assert.equal(
      normalizeScrapedText('第一行\\n第二行\\n第三行'),
      '第一行\n第二行\n第三行'
    );
    // escaped backslash (\\\\ in JS source = single literal \)
    assert.equal(
      normalizeScrapedText('path\\\\to\\\\file'),
      'path\\to\\file'
    );
    // \t, \", \' etc. are NOT decoded (only \n and \\ are handled); these
    // stay as literal backslash sequences in the output
    assert.equal(
      normalizeScrapedText('a\\tb'),
      'a\\tb'
    );
    assert.equal(
      normalizeScrapedText('he said \\"hello\\"'),
      'he said \\"hello\\"'
    );
  });
});
