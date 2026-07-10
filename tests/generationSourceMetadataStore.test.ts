import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/errors.ts';
import { GenerationSourceMetadataStore } from '../src/services/image/generationSourceMetadataStore.ts';

async function tempMetadataPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-source-metadata-'));
  return path.join(root, 'metadata.json');
}

function isAppErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test('generation source metadata store persists and validates rating and user category', async () => {
  const filePath = await tempMetadataPath();
  const sourceId = 'checkpoint:Cartoon/demo.safetensors';
  const store = new GenerationSourceMetadataStore(filePath);

  const saved = await store.update(sourceId, {
    favorite: true,
    notes: 'Existing notes stay intact.',
    rating: 5,
    userCategory: '  Anime  '
  });
  assert.equal(saved.favorite, true);
  assert.equal(saved.notes, 'Existing notes stay intact.');
  assert.equal(saved.rating, 5);
  assert.equal(saved.userCategory, 'Anime');

  const reloaded = await new GenerationSourceMetadataStore(filePath).get(sourceId);
  assert.equal(reloaded.rating, 5);
  assert.equal(reloaded.userCategory, 'Anime');

  await assert.rejects(store.update(sourceId, { rating: -1 }), isAppErrorCode('GENERATION_SOURCE_METADATA_INVALID_RATING'));
  await assert.rejects(store.update(sourceId, { rating: 6 }), isAppErrorCode('GENERATION_SOURCE_METADATA_INVALID_RATING'));
  await assert.rejects(store.update(sourceId, { rating: 2.5 }), isAppErrorCode('GENERATION_SOURCE_METADATA_INVALID_RATING'));
  await assert.rejects(store.update(sourceId, { rating: '5' }), isAppErrorCode('GENERATION_SOURCE_METADATA_INVALID_RATING'));
  await assert.rejects(store.update(sourceId, { userCategory: 42 }), isAppErrorCode('GENERATION_SOURCE_METADATA_INVALID_USER_CATEGORY'));
  await assert.rejects(store.update(sourceId, { userCategory: 'x'.repeat(81) }), isAppErrorCode('GENERATION_SOURCE_METADATA_USER_CATEGORY_TOO_LONG'));

  const afterFailures = await store.get(sourceId);
  assert.equal(afterFailures.rating, 5);
  assert.equal(afterFailures.userCategory, 'Anime');

  const cleared = await store.update(sourceId, { rating: 0, userCategory: '' });
  assert.equal(cleared.rating, 0);
  assert.equal(cleared.userCategory, '');
  assert.equal(cleared.favorite, true);
  assert.equal(cleared.notes, 'Existing notes stay intact.');
});

test('legacy metadata safely defaults malformed ratings and treats categoryOverride as a one-time user-category fallback', async () => {
  const filePath = await tempMetadataPath();
  const sourceId = 'workflow:legacy-source';
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    sources: [{
      sourceId,
      favorite: true,
      notes: 'Legacy note',
      rating: 99,
      categoryOverride: '  Anime  ',
      colorOverride: '#ff00ff',
      promptStyleOverride: 'Legacy style',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z'
    }]
  }), 'utf8');

  const store = new GenerationSourceMetadataStore(filePath);
  const legacy = await store.get(sourceId);
  assert.equal(legacy.rating, 0);
  assert.equal(legacy.userCategory, 'Anime');
  assert.equal(legacy.categoryOverride, 'Anime');
  assert.equal(legacy.colorOverride, '#ff00ff');
  assert.equal(legacy.notes, 'Legacy note');

  const cleared = await store.update(sourceId, { userCategory: '' });
  assert.equal(cleared.userCategory, '');
  assert.equal(cleared.categoryOverride, 'Anime');

  const reloaded = await new GenerationSourceMetadataStore(filePath).get(sourceId);
  assert.equal(reloaded.userCategory, '');
  assert.equal(reloaded.categoryOverride, 'Anime');
  assert.equal(reloaded.rating, 0);
});
