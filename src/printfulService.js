const { info, debug, overkill } = require('./logger');

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
};

const toNumberOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseLegacyVariantResponse = (legacyResponse) => {
  const result = legacyResponse?.result || legacyResponse || {};
  const variant = result.variant || legacyResponse?.variant;

  if (!variant) {
    throw new Error('Legacy variant response missing "variant" payload');
  }

  const product = result.product || legacyResponse?.product || {};
  const syncVariant = result.sync_variant || legacyResponse?.sync_variant || {};
  const syncProduct = result.sync_product || legacyResponse?.sync_product || {};

  const legacyVariantId =
    toNumberOrNull(
      firstDefined(
        variant.id,
        variant.variant_id,
        variant.variantId,
        syncVariant.id,
        syncVariant.variant_id
      )
    );

  if (legacyVariantId === null) {
    throw new Error('Legacy variant response missing identifier');
  }

  const catalogVariantId =
    toNumberOrNull(
      firstDefined(
        variant.catalog_variant_id,
        variant.catalogVariantId,
        variant.catalog_variantId,
        syncVariant.catalog_variant_id,
        syncVariant.variant_id
      )
    );

  const productId =
    toNumberOrNull(
      firstDefined(
        variant.catalog_product_id,
        variant.product_id,
        product.catalog_product_id,
        product.id,
        product.product_id,
        syncProduct.catalog_product_id,
        syncProduct.product_id
      )
    );

  const colorName = firstDefined(variant.color, variant.color_name, variant.colorName);
  const size = firstDefined(variant.size, variant.size_name, variant.sizeName, variant.size_label);

  return {
    legacyVariantId,
    catalogVariantId,
    productId,
    colorName,
    size
  };
};

const toArray = (value) => (Array.isArray(value) ? value : []);

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
  const preview =
    template.preview ||
    template.preview_url ||
    template.image ||
    template.template_image ||
    template.thumbnail ||
    template.image_url ||
    template.background_url;
  const availableVariantIds = toArray(
    template.available_variant_ids ||
      template.availableVariantIds ||
      template.available_variants ||
      template.variant_ids ||
      template.variants
  ).map((id) => String(id));

  return {
    styleId,
    title,
    type,
    color,
    placements,
    previewUrl: preview,
    availableVariantIds,
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

const buildTemplateAugmentations = (templateResponse) => {
  const result = templateResponse?.result || {};
  const templateCandidates = [
    toArray(result.templates),
    toArray(result.styles),
    toArray(result.data),
    toArray(templateResponse?.templates),
    toArray(templateResponse?.data),
    toArray(templateResponse)
  ];
  const templates = templateCandidates.find((candidate) => candidate.length) || [];

  const variantMapping = toArray(result.variant_mapping);

  const templateVariants = new Map();
  const templatePlacements = new Map();

  if (variantMapping.length) {
    variantMapping.forEach((mapping) => {
      const variantId =
        mapping?.variant_id !== undefined && mapping?.variant_id !== null
          ? String(mapping.variant_id)
          : null;
      toArray(mapping?.templates).forEach((entry) => {
        const templateId = entry?.template_id || entry?.id;
        if (!templateId) {
          return;
        }
        const key = String(templateId);
        if (variantId) {
          if (!templateVariants.has(key)) {
            templateVariants.set(key, new Set());
          }
          templateVariants.get(key).add(variantId);
        }
        if (entry?.placement) {
          if (!templatePlacements.has(key)) {
            templatePlacements.set(key, new Set());
          }
          templatePlacements.get(key).add(entry.placement);
        }
      });
    });
  }

  let templatePayloads = templates;
  if (!templatePayloads.length && variantMapping.length) {
    templatePayloads = variantMapping.flatMap((mapping) =>
      toArray(mapping?.templates).map((entry) => ({
        ...entry,
        template_id: entry.template_id || entry.id
      }))
    );
  }

  return {
    templatePayloads,
    templateVariants,
    templatePlacements
  };
};

const enrichWithPlacements = (templateResponse, printfilesResponse) => {
  const { templatePayloads, templateVariants, templatePlacements } = buildTemplateAugmentations(templateResponse);
  const placementLookup = buildPlacementLookup(printfilesResponse);

  info(`Found ${Array.isArray(templatePayloads) ? templatePayloads.length : 0} mockup templates from Printful`);

  return (Array.isArray(templatePayloads) ? templatePayloads : [])
    .map((template) => {
      const normalized = normalizeTemplate({ template, placementLookup });
      const key = String(normalized.styleId);
      const mappedPlacements = templatePlacements.get(key);
      const mappedVariants = templateVariants.get(key);

      return {
        ...normalized,
        placements: normalized.placements.length
          ? normalized.placements
          : mappedPlacements
            ? Array.from(mappedPlacements)
            : normalized.placements,
        availableVariantIds: normalized.availableVariantIds.length
          ? normalized.availableVariantIds
          : mappedVariants
            ? Array.from(mappedVariants)
            : normalized.availableVariantIds
      };
    })
    .filter((template) => template.styleId);
};

const extractCatalogVariants = (response) => {
  if (!response || typeof response !== 'object') {
    return [];
  }

  const candidates = [
    response.data,
    response.result?.data,
    response.result?.variants,
    response.result?.items,
    response.result,
    response.variants,
    response.items
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      if (Array.isArray(candidate.items)) {
        return candidate.items;
      }
      if (Array.isArray(candidate.data)) {
        return candidate.data;
      }
    }
  }

  return [];
};

const normalizeColor = (value) => String(value || '').trim().toLowerCase();
const normalizeSize = (value) => String(value || '').trim().toUpperCase();

const listAllCatalogVariants = async ({ client, productId, limit = 100 }) => {
  const variants = [];
  let offset = 0;

  while (true) {
    const page = await client.listCatalogVariants(productId, { limit, offset });
    const entries = extractCatalogVariants(page);
    if (!entries.length) {
      break;
    }
    variants.push(...entries);

    if (entries.length < limit) {
      break;
    }

    offset += limit;
  }

  return variants;
};

const candidateColorNames = (variant) => {
  const values = [
    variant.color,
    variant.color_name,
    variant.colorName,
    variant.color_code,
    variant.colorCode,
    variant.variant_color,
    variant.options?.color
  ];
  return values.map((value) => normalizeColor(value)).filter(Boolean);
};

const candidateSize = (variant) =>
  normalizeSize(
    variant.size || variant.size_name || variant.sizeName || variant.size_label || variant.variant_size || variant.options?.size
  );

const unique = (values) => Array.from(new Set(values));

const findCatalogVariantByAttributes = async ({ client, productId, colorName, size }) => {
  const normalizedSize = normalizeSize(size);
  const normalizedColor = normalizeColor(colorName);

  const allVariants = await listAllCatalogVariants({ client, productId });
  info(`Retrieved ${allVariants.length} catalog variants for product ${productId}`);

  if (!allVariants.length) {
    throw new Error(`No catalog variants found for product ${productId}`);
  }

  const matches = allVariants.filter((variant) => {
    if (normalizedSize && candidateSize(variant) !== normalizedSize) {
      return false;
    }

    if (!normalizedColor) {
      return true;
    }

    const colors = candidateColorNames(variant);
    return colors.some((color) => color.includes(normalizedColor));
  });

  if (!matches.length) {
    const availableColors = unique(
      allVariants
        .filter((variant) => !normalizedSize || candidateSize(variant) === normalizedSize)
        .map((variant) => variant.color || variant.color_name || variant.colorName)
        .filter(Boolean)
    );

    throw new Error(
      `No catalog variant found for product ${productId} matching color "${colorName}" and size "${size}". ` +
        (availableColors.length ? `Available colors for size "${size}": ${availableColors.join(', ')}` : '')
    );
  }

  const match = matches[0];
  const catalogVariantId =
    match.id || match.catalog_variant_id || match.catalogVariantId || match.variant_id || match.catalog_variantId;

  if (!catalogVariantId) {
    throw new Error(
      `Catalog variant record missing identifier for product ${productId}, color "${colorName}" and size "${size}"`
    );
  }

  debug('Resolved catalog variant from attributes', {
    productId,
    colorName,
    size,
    catalogVariantId,
    match
  });

  return {
    catalogVariantId,
    variant: match,
    matches: toArray(matches)
  };
};

const parseVariantResponse = (variantResponse) => {
  const candidate =
    variantResponse?.data ||
    variantResponse?.result?.variant ||
    variantResponse?.result ||
    variantResponse?.variant ||
    variantResponse;
  const variant = candidate?.data || candidate;

  if (!variant || typeof variant !== 'object') {
    throw new Error('Variant response missing "data" payload');
  }

  const variantId = variant.id ?? variant.variant_id ?? variant.sync_variant_id;
  if (!variantId) {
    throw new Error('Variant response missing variant identifier');
  }

  const product =
    variant.catalog_product ||
    variant.product ||
    variant.sync_product ||
    {};

  const productId =
    product.id ??
    product.product_id ??
    product.sync_product_id ??
    variant.catalog_product_id ??
    variant.product_id ??
    variant.sync_product_id;

  if (!productId) {
    throw new Error(`Variant ${variantId} response missing product identifier`);
  }

  return {
    variantId,
    productId,
    product,
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
  parseLegacyVariantResponse,
  parseVariantResponse,
  pollMockupTask,
  findCatalogVariantByAttributes
};
