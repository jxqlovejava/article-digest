import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRefusal } from './translate';

describe('looksLikeRefusal', () => {
  it('catches the four real apology variants from the 2026-08 incident', () => {
    assert.ok(looksLikeRefusal('抱歉，我无法访问该链接的内容。如果你把文章文本粘贴到这里，我可以帮你翻译。'));
    assert.ok(looksLikeRefusal('抱歉，我无法访问该链接的内容。如果你把文章正文粘贴过来，我可以帮你翻译。'));
    assert.ok(looksLikeRefusal('抱歉，我无法访问该链接的内容。请将文章正文粘贴到对话中，我来为你翻译。'));
    assert.ok(looksLikeRefusal('很抱歉，我无法为您翻译该链接的内容。'));
  });

  it('catches english refusals', () => {
    assert.ok(looksLikeRefusal("I'm sorry, I cannot access the content of this link."));
    assert.ok(looksLikeRefusal("Sorry, I can't open external URLs. Please paste the text."));
    assert.ok(looksLikeRefusal('Unable to access the link provided.'));
  });

  it('does not flag real translations', () => {
    assert.ok(!looksLikeRefusal('我每天工作 16 小时，坚持了 6 个月，最终辞掉了工作。'));
    assert.ok(!looksLikeRefusal('以下是我的做法：首先，建立晨间惯例。'));
    assert.ok(!looksLikeRefusal('The quick brown fox jumps over the lazy dog.'));
  });

  it('does not flag legitimate content mentioning links mid-body', () => {
    // 合法译文正文中间提到"无法访问链接"不算道歉(只查开头 300 字符且需命中模式)
    const body = '第一段是正常的翻译内容。\n\n'.repeat(20) + '有些人说抱歉，这个故事无法访问链接之外的真相。';
    assert.ok(!looksLikeRefusal(body));
  });
});
