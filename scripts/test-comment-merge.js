// Test: comment-merge feature against a real tweet (run in app container with env)
// Layout: test.js + dist/ + prompts/ are siblings under /app/comment-test/
const { parseTweetUrl } = require('../dist/utils/url');
const { fetchTweet } = require('../dist/services/fetcher');

(async () => {
  const url = process.argv[2] || 'https://x.com/shizhiang1/status/2086067311476355438';
  const parsed = parseTweetUrl(url);
  if (!parsed) { console.error('FAIL: cannot parse URL', url); process.exit(1); }
  console.log('parsed:', JSON.stringify(parsed));
  const t0 = Date.now();
  const tweet = await fetchTweet(parsed);
  console.log(`elapsed: ${Date.now() - t0}ms`);
  console.log('title:', tweet.title);
  console.log('author:', tweet.author?.screen_name, '| replies:', tweet.replies);
  console.log('=== MERGED TEXT ===');
  console.log(tweet.text);
  console.log('=== MEDIA ===');
  console.log('photos:', tweet.media?.photos?.length || 0, 'videos:', tweet.media?.videos?.length || 0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
