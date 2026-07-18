# Plan: Full-text search for tweet archive

## Goal
给系统增加一个全文搜索功能，在右上角增加一个搜索输入框，输入搜索词后，能搜出所有命中的帖子。

## UI
- We'll add a search input box in the top-right corner of the index page.
- Search results should update as the user types, or maybe on Enter/click submit.
- Should the search be case-insensitive? We should decide.

## Search scope
- We will search through all archived tweets.
- Should we search only titles and author handles, or also the full article body?
- Do we need to support Chinese full-text segmentation, or simple substring matching is enough?

## Implementation
- We could build the search index at server startup by reading all `data/articles/*.html` files.
- Or we could generate a JSON index file alongside the HTML articles and load that.
- Search can be done server-side via a new `/api/search?q=term` endpoint, or client-side with a preloaded index.

## Performance
- There may be a trade-off between startup index build time and runtime memory.
- If the archive grows large, we might need a real search engine like Fuse.js or sqlite FTS.

## Open questions
- How many articles are there now, and what's the expected size?
- Should search match exact phrases or any word?
- TBD: Where exactly does the search box go relative to existing header controls?
