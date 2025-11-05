const test = require('node:test');
const assert = require('node:assert');

const { sanitizeSegment, buildPlacementsSegment, guessExtensionFromUrl, generateObjectKey } = require('../src/naming');

test('sanitizeSegment normalizes text', () => {
  assert.strictEqual(sanitizeSegment(' Hello World! '), 'hello-world');
  assert.strictEqual(sanitizeSegment(''), 'unknown');
  assert.strictEqual(sanitizeSegment(null), 'unknown');
});

test('buildPlacementsSegment joins placements with underscores', () => {
  assert.strictEqual(buildPlacementsSegment(['Front', 'Back']), 'front_back');
  assert.strictEqual(buildPlacementsSegment([]), 'no-placement');
});

test('guessExtensionFromUrl extracts extension', () => {
  assert.strictEqual(guessExtensionFromUrl('https://example.com/file.PNG?foo=bar'), 'png');
  assert.strictEqual(guessExtensionFromUrl('https://example.com/file'), 'png');
});

test('generateObjectKey builds expected file name', () => {
  const key = generateObjectKey({
    variantId: '12345',
    styleId: '12',
    color: 'Black',
    placements: ['Front', 'Back'],
    type: 'Template',
    title: 'Main Mockup',
    extension: 'png'
  });
  assert.strictEqual(
    key,
    '12345_style-12_black_front_back_template-main-mockup.png'
  );
});
