const { info, debug, overkill } = require('./logger');

const flattenPlacements = (stylePlacements = [], placementLookup = {}) => {
  if (!Array.isArray(stylePlacements) || stylePlacements.length === 0) {
    return [];
  }

  return stylePlacements
    .map((placement) => {
      if (typeof placement === 'string') {
        return placementLookup[placement]?.name || placement;
      }
      if (placement?.placement) {
        const lookup = placementLookup[placement.placement];
        return lookup?.name || placement.placement;
      }
      if (placement?.name) {
        return placement.name;
      }
      return placement;
    })
    .filter(Boolean);
};

const normalizeTemplate = ({ template, placementLookup }) => {
  const styleId = template.style_id || template.template_id || template.id;
  const title = template.title || template.name || template.template_name || `Style ${styleId}`;
  const type = template.type || template.product_type || template.template_type || 'style';
  const color = template.color || template.variant_color || template.options?.color;
  const placements = flattenPlacements(template.placements || template.printfiles, placementLookup);
  const preview = template.preview || template.preview_url || template.image || template.template_image || template.thumbnail;

  return {
    styleId,
    title,
    type,
    color,
    placements,
    previewUrl: preview,
    raw: template
  };
};

const buildPlacementLookup = (printfiles) => {
  if (!printfiles || !printfiles.result) {
    return {};
  }

  const items = Array.isArray(printfiles.result) ? printfiles.result : printfiles.result.printfiles || [];
  return items.reduce((acc, printfile) => {
    const key = printfile.placement || printfile.type || printfile.id;
    if (key) {
      acc[key] = {
        name: printfile.placement || printfile.type || key,
        details: printfile
      };
    }
    return acc;
  }, {});
};

const enrichWithPlacements = (templateResponse, printfilesResponse) => {
  const templates = templateResponse?.result?.templates || templateResponse?.result?.styles || templateResponse?.result || [];
  const placementLookup = buildPlacementLookup(printfilesResponse);

  info(`Found ${Array.isArray(templates) ? templates.length : 0} mockup templates from Printful`);

  return (Array.isArray(templates) ? templates : [])
    .map((template) => normalizeTemplate({ template, placementLookup }))
    .filter((template) => template.styleId);
};

const parseVariantResponse = (variantResponse) => {
  const variant = variantResponse?.result || variantResponse?.data || variantResponse;
  if (!variant) {
    throw new Error('Variant response missing "result" payload');
  }

  const product = variant.product || variant.catalog_product || {};
  const syncProduct = variant.sync_product || {};
  const catalogProduct = variant.catalog_product || syncProduct.catalog_product || {};

  return {
    variantId:
      variant.id ||
      variant.variant_id ||
      variant.sync_variant_id ||
      variantResponse?.id,
    productId:
      variant.product_id ||
      product.id ||
      product.product_id ||
      catalogProduct.id ||
      catalogProduct.product_id ||
      syncProduct.product_id ||
      variant.sync_product_id,
    product: Object.keys(product).length ? product : catalogProduct,
    variant
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollMockupTask = async ({ client, taskKey, timeoutMs = 120_000, intervalMs = 5_000 }) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    info(`Polling Printful mockup task ${taskKey}`);
    const response = await client.getMockupTask(taskKey);
    const task = response?.result || response;
    overkill('Mockup task payload', task);

    if (task?.status === 'completed') {
      return task;
    }
    if (task?.status === 'failed') {
      throw new Error(`Mockup task ${taskKey} failed`);
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for mockup task ${taskKey}`);
};

module.exports = {
  enrichWithPlacements,
  parseVariantResponse,
  pollMockupTask
};
