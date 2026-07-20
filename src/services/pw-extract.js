// DOM-to-markdown extraction for Playwright page.evaluate().
// Runs in browser context — no Node.js APIs, no ES modules.
(() => {
  function domToMd(el, depth) {
    depth = depth || 0;
    var tag = (el.tagName || '').toLowerCase();
    var role = el.getAttribute('role') || '';
    var testid = el.getAttribute('data-testid') || '';

    // Skip interactive UI elements (NOT role=link — article body links have that)
    if (role === 'button' || role === 'tab' || role === 'menuitem') return '';
    if (tag === 'button' || tag === 'nav' || tag === 'input' || tag === 'select' || tag === 'textarea') return '';

    // Skip social action rows (reply, retweet, like, bookmark, share, analytics)
    if (role === 'group') {
      if (testid === 'reply' || testid === 'retweet' || testid === 'like'
          || testid === 'bookmark' || testid === 'share' || testid === 'analytics'
          || testid === 'unretweet' || testid === 'unlike') return '';
    }

    // Skip known UI containers (sidebar, nav, dropdown, modal)
    if (testid === 'sidebarColumn' || testid === 'GrokDrawer' || testid === 'BottomBar'
        || testid === 'primaryColumn' || testid === 'placementTracking'
        || testid.indexOf('Dropdown') >= 0 || testid.indexOf('caret') >= 0
        || testid.indexOf('Sheet') >= 0) return '';

    if (tag === 'a') {
      var href = el.getAttribute('href') || '';
      // Skip internal nav, hashtag, profile, image, analytics links
      if (href.indexOf('profile_images') >= 0 || href.indexOf('twimg.com') >= 0) return '';
      if (href.indexOf('/hashtag/') === 0 || href.indexOf('/i/') === 0
          || href.indexOf('/search') === 0 || href.indexOf('/home') === 0
          || href.indexOf('/explore') === 0 || href.indexOf('/notifications') === 0
          || href.indexOf('/messages') === 0 || href.indexOf('/settings') === 0
          || href.indexOf('/lists') === 0 || href.indexOf('/communities') === 0
          || href.indexOf('/topics') === 0) return '';
      // Skip analytics links and bare profile links (/Username)
      if (href.indexOf('/analytics') >= 0) return el.textContent || '';
      if (/^\/[A-Za-z0-9_]+$/.test(href)) return el.textContent || '';
      var aText = (el.textContent || '').trim();
      if (!aText || !href || aText.length <= 1) return el.textContent || '';
      // Skip timestamps, bare numbers, @handles
      if (/^\d+$/.test(aText) || /^\d+:\d+/.test(aText)
          || /^\d{1,2}\/\d{1,2}\/\d/.test(aText) || /^@\w+$/.test(aText)) return el.textContent || '';
      return '[' + aText + '](' + href + ')';
    }
    if (tag === 'img' || tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'video') return '';
    if (tag === 'br') return '\n';

    var text = '';
    var children = Array.from(el.childNodes);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) { text += child.textContent || ''; }
      else if (child.nodeType === 1) { text += domToMd(child, depth + 1); }
    }

    text = text.trim();
    if (!text) return '';

    // At depth 1+, div/p act as paragraph wrappers on x.com
    var isBlock = depth > 0 && /^(div|p|section|h[1-6]|li|tr|blockquote|pre|article|header|footer)$/i.test(tag);
    return isBlock ? '\n\n' + text : text;
  }

  // Walk the first substantial article, skip the outer <article> wrapper
  var articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  for (var i = 0; i < articles.length; i++) {
    var article = articles[i];
    if ((article.textContent || '').length < 200) continue;

    var md = domToMd(article, 0).trim();

    // Collapse excessive blank lines and strip UI artifacts
    var lines = md.split('\n');
    var cleaned = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue; // skip blank lines (we re-add spacing below)
      // Skip known UI labels
      if (line === 'Subscribe' || line === 'Follow' || line === 'Following'
          || line === 'Click to Subscribe to TheMarketMemo'
          || line === 'LEI' || line === '@TheMarketMemo') continue;
      // Skip bare numbers / K/M/B stats
      if (/^\d{1,3}[KMB]?$/.test(line)) continue;
      // Skip navigation labels
      if (/^(Home|Explore|Notifications|Messages|Grok|Profile|Premium|More|Bookmarks|Lists|Communities|Verified Orgs)$/i.test(line)) continue;
      cleaned.push(line);
    }
    // Join with single blank line between blocks
    md = cleaned.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

    if (md.length > 100) {
      var rawTitle = document.title || '';
      var title = rawTitle
        .replace(/^\s*\(\d+\)\s*/, '')
        .replace(/ on X: ".*$/, '')
        .replace(/" \/ X/, '')
        .trim();
      return { text: md, title: title };
    }
  }
  return null;
})()
