const test = require('node:test');
const assert = require('node:assert');

const { filterStylesForVariant } = require('../src/handler');

const baseStyle = (overrides = {}) => ({
  styleId: 'style',
  color: 'Black',
  placements: [],
  availableVariantIds: ['4016'],
  previewUrl: 'https://example.com/mockup.png',
  ...overrides
});

test('filterStylesForVariant respects color matching', () => {
  const styles = [
    baseStyle({ styleId: 'variant-style', color: 'Black', availableVariantIds: ['4016'] }),
    baseStyle({ styleId: 'mismatched-color', color: 'White', availableVariantIds: ['4016'] })
  ];

  const result = filterStylesForVariant({
    styles,
    variantId: '4016',
    variantColor: 'Black',
    includeProductWideList: true,
    ignoreColor: false
  });

  assert.deepStrictEqual(
    result.map((style) => style.styleId),
    ['variant-style']
  );
});

test('filterStylesForVariant can ignore color when flag enabled', () => {
  const styles = [
    baseStyle({ styleId: 'variant-style', color: 'Black', availableVariantIds: ['4016'] }),
    baseStyle({
      styleId: 'product-wide',
      color: 'White',
      availableVariantIds: [],
      previewUrl: 'https://example.com/product-wide.png'
    })
  ];

  const result = filterStylesForVariant({
    styles,
    variantId: '4016',
    variantColor: 'Black',
    includeProductWideList: true,
    ignoreColor: true
  });

  assert.deepStrictEqual(
    result.map((style) => style.styleId),
    ['variant-style', 'product-wide']
  );
});
