const test = require('node:test');
const assert = require('node:assert');

const { parseLegacyVariantResponse } = require('../src/printfulService');

test('parseLegacyVariantResponse extracts catalog data', () => {
  const payload = {
    result: {
      variant: {
        id: 4016,
        catalog_variant_id: 987654,
        catalog_product_id: 1234,
        color: 'Charcoal',
        size: 'L'
      }
    }
  };

  const details = parseLegacyVariantResponse(payload);
  assert.deepStrictEqual(details, {
    legacyVariantId: 4016,
    catalogVariantId: 987654,
    productId: 1234,
    colorName: 'Charcoal',
    size: 'L'
  });
});

test('parseLegacyVariantResponse tolerates missing fields', () => {
  const payload = {
    result: {
      variant: {
        id: 5555,
        size: 'M'
      },
      product: {
        id: 2222
      }
    }
  };

  const details = parseLegacyVariantResponse(payload);
  assert.deepStrictEqual(details, {
    legacyVariantId: 5555,
    catalogVariantId: null,
    productId: 2222,
    colorName: undefined,
    size: 'M'
  });
});
