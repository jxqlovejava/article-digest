import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { L2Document, L2Entry } from '../../types/knowledge';
import { parseL2Doc, serializeL2Doc } from './document';

describe('L2 Document parse/serialize round-trip', () => {
  it('preserves entries through serialize -> parse cycle', () => {
    const now = Date.now();
    const entries1: L2Entry[] = [
      {
        id: 'm_a1b2c3d4e5f6g7h8i9j0k1l2m3',
        section: 'Technology',
        text: 'React hooks enable state management in functional components',
        refs: ['react-docs.html', 'article_2024_001'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'm_b2c3d4e5f6g7h8i9j0k1l2m3n4',
        section: 'Technology',
        text: 'Server components reduce client-side JavaScript bundle size',
        refs: ['nextjs-docs.html'],
        createdAt: now,
        updatedAt: now,
      },
    ];
    const entries2: L2Entry[] = [
      {
        id: 'm_c3d4e5f6g7h8i9j0k1l2m3n4o5',
        section: 'Architecture',
        text: 'Microservices decompose monoliths into independent deployable units',
        refs: ['architecture-guide.html', 'article_2024_002'],
        createdAt: now,
        updatedAt: now,
      },
    ];

    const doc: L2Document = {
      surface: 'articles',
      title: 'Knowledge Summary',
      sections: [
        { name: 'Technology', entries: entries1 },
        { name: 'Architecture', entries: entries2 },
      ],
      updatedAt: now,
    };

    // Serialize to markdown
    const md = serializeL2Doc(doc);
    assert.ok(md.includes('# Knowledge Summary'), 'Title should be present');
    assert.ok(md.includes('## Technology'), 'Section heading should be present');
    assert.ok(md.includes('## Architecture'), 'Second section heading should be present');
    assert.ok(md.includes('<!--m_'), 'Entry IDs should be present as HTML comments');
    assert.ok(md.includes('[^ref1]:'), 'Footnote references should be present');
    assert.ok(md.includes('[^ref2]:'), 'Multiple footnotes should be present');
    assert.ok(md.includes('---'), 'Separator should be present');

    // Parse back
    const parsed = parseL2Doc(md);
    parsed.surface = 'articles';

    assert.strictEqual(parsed.title, doc.title, 'Title should round-trip');
    assert.strictEqual(parsed.sections.length, doc.sections.length, 'Section count should match');

    // Check first section
    const techSection = parsed.sections.find(s => s.name === 'Technology');
    assert.ok(techSection, 'Technology section should exist');
    assert.strictEqual(techSection.entries.length, 2, 'Technology should have 2 entries');

    // Check first entry text and refs
    const firstEntry = techSection.entries[0];
    assert.strictEqual(firstEntry.text, entries1[0].text, 'Entry text should round-trip');
    assert.deepStrictEqual(firstEntry.refs.sort(), entries1[0].refs.sort(), 'Entry refs should round-trip');
    assert.strictEqual(firstEntry.id, entries1[0].id, 'Entry ID should round-trip');

    // Check second section
    const archSection = parsed.sections.find(s => s.name === 'Architecture');
    assert.ok(archSection, 'Architecture section should exist');
    assert.strictEqual(archSection.entries.length, 1, 'Architecture should have 1 entry');

    const archEntry = archSection.entries[0];
    assert.strictEqual(archEntry.text, entries2[0].text, 'Architecture entry text should round-trip');
    assert.deepStrictEqual(archEntry.refs.sort(), entries2[0].refs.sort(), 'Architecture entry refs should round-trip');
  });

  it('handles empty sections gracefully', () => {
    const doc: L2Document = {
      surface: 'articles',
      title: 'Empty Doc',
      sections: [],
      updatedAt: Date.now(),
    };

    const md = serializeL2Doc(doc);
    assert.ok(md.includes('# Empty Doc'), 'Title should be present');
    assert.ok(!md.includes('##'), 'No sections should mean no headings');

    const parsed = parseL2Doc(md);
    assert.strictEqual(parsed.title, 'Empty Doc');
    assert.strictEqual(parsed.sections.length, 0);
  });

  it('preserves entry without refs or ID comment', () => {
    const md = `# Simple Doc

## Notes
- Just a note without refs

`;

    const parsed = parseL2Doc(md);
    assert.strictEqual(parsed.title, 'Simple Doc');
    assert.strictEqual(parsed.sections.length, 1);
    assert.strictEqual(parsed.sections[0].name, 'Notes');
    assert.strictEqual(parsed.sections[0].entries.length, 1);
    assert.strictEqual(parsed.sections[0].entries[0].text, 'Just a note without refs');
    assert.deepStrictEqual(parsed.sections[0].entries[0].refs, []);
  });
});
