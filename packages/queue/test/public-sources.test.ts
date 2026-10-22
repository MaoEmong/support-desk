import assert from 'node:assert/strict';
import { test } from 'vitest';
import { projectPublicSources } from '../src/public-sources.js';

test('public source projection maps kbArticleId and excludes internal and future fields', () => {
  const raw = [{ kbArticleId: 'kb-1', title: 'FAQ', excerpt: 'Help', url: 'https://help.example/faq', tenantId: 'private-tenant', score: 0.98, raw: { internal: true }, futureAnalysis: 'secret' }];
  assert.deepEqual(projectPublicSources(raw), [{ id: 'kb-1', title: 'FAQ', excerpt: 'Help', url: 'https://help.example/faq' }]);
  assert.equal(raw[0]!.tenantId, 'private-tenant');
});

test('public DTO id is accepted without copying extra fields', () => {
  assert.deepEqual(projectPublicSources([{ id: 'public-id', kbArticleId: 'old-id', title: 'FAQ', tenantId: 'private' }]), [{ id: 'public-id', title: 'FAQ' }]);
});

test('missing or malformed source input produces an empty list', () => {
  for (const value of [undefined, null, {}, [], [null, false, 'source', { title: 'no id' }, { id: 'no-title' }]]) {
    assert.deepEqual(projectPublicSources(value), []);
  }
});

test('null optional values are omitted and URLs are never derived from raw metadata', () => {
  assert.deepEqual(projectPublicSources([{ id: 'kb-1', title: 'FAQ', excerpt: null, url: null, rawURL: 'https://unapproved.example/raw', raw: { url: 'https://unapproved.example/nested' } }]), [{ id: 'kb-1', title: 'FAQ' }]);
});
