const test = require('node:test');
const assert = require('node:assert');

const { parseLegacyVariantResponse, parseVariantResponse, enrichWithPlacements } = require('../src/printfulService');

test('enrichWithPlacements preserves available variant ids as strings', () => {
  const templates = {
    result: {
      templates: [
        {
          style_id: 1,
          title: 'Front',
          available_variant_ids: [4016, '7777'],
          preview_url: 'https://example.com/front.png'
        }
      ]
    }
  };

  const styles = enrichWithPlacements(templates, { result: [] });
  assert.strictEqual(styles.length, 1);
  assert.deepStrictEqual(styles[0].availableVariantIds, ['4016', '7777']);
});

test('enrichWithPlacements backfills variant mapping data', () => {
  const templates = {
    result: {
      variant_mapping: [
        {
          variant_id: 4016,
          templates: [
            {
              placement: 'front',
              template_id: 123
            }
          ]
        }
      ],
      templates: [
        {
          template_id: 123,
          image_url: 'https://example.com/front.png'
        }
      ]
    }
  };

  const styles = enrichWithPlacements(templates, { result: [] });
  assert.strictEqual(styles.length, 1);
  assert.deepStrictEqual(styles[0].availableVariantIds, ['4016']);
  assert.deepStrictEqual(styles[0].placements, ['front']);
  assert.strictEqual(styles[0].previewUrl, 'https://example.com/front.png');
});

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

test('parseVariantResponse returns catalog product id from v2 payload', () => {
  const payload = {
    data: {
      id: 4016,
      catalog_product_id: 71,
      name: 'Example Item',
      color: 'Black',
      size: 'S'
    }
  };

  const details = parseVariantResponse(payload);

  assert.strictEqual(details.variantId, 4016);
  assert.strictEqual(details.productId, 71);
  assert.deepStrictEqual(details.variant, payload.data);
  assert.deepStrictEqual(details.product, {});
});

test('parseVariantResponse prefers nested product data when present', () => {
  const payload = {
    data: {
      id: '999',
      sync_product_id: 1234,
      product: {
        id: 5678,
        title: 'Store listing title'
      }
    }
  };

  const details = parseVariantResponse(payload);

  assert.strictEqual(details.variantId, '999');
  assert.strictEqual(details.productId, 5678);
  assert.deepStrictEqual(details.product, payload.data.product);
});

test('parseVariantResponse supports result payloads', () => {
  const payload = {
    result: {
      variant: {
        id: 888,
        catalog_product_id: 71
      },
      product: {
        id: 71
      }
    }
  };

  const details = parseVariantResponse(payload);
  assert.strictEqual(details.variantId, 888);
  assert.strictEqual(details.productId, 71);
});

test('parseVariantResponse throws when payload is malformed', () => {
  assert.throws(() => parseVariantResponse(null), /missing "data" payload/);

  assert.throws(
    () =>
      parseVariantResponse({
        data: {
          catalog_product_id: 77
        }
      }),
    /missing variant identifier/
  );

  assert.throws(
    () =>
      parseVariantResponse({
        data: {
          id: '123'
        }
      }),
    /missing product identifier/
  );
});
