const PrintfulClient = require('./printfulClient');
const { info, warn, error, debug } = require('./logger');
const {
  enrichWithPlacements,
  parseVariantResponse,
  pollMockupTask,
  findCatalogVariantByAttributes,
  parseLegacyVariantResponse
} = require('./printfulService');
const S3Uploader = require('./s3Uploader');

const RATE_LIMIT_MS = 3_000;

const parseEvent = (event) => {
  if (!event) {
    throw new Error('Event payload is required');
  }

  const details = {
    variantId: null,
    productId: null,
    colorName: null,
    size: null
  };

  const applySource = (source) => {
    if (!source || typeof source !== 'object') {
      return;
    }

    if (!details.variantId) {
      const variantId = source.variantId || source.catalogVariantId || source.syncVariantId;
      if (variantId !== undefined && variantId !== null) {
        details.variantId = String(variantId);
      }
    }

    if (!details.productId) {
      const productId = source.productId || source.catalogProductId;
      if (productId !== undefined && productId !== null) {
        details.productId = String(productId);
      }
    }

    if (!details.colorName) {
      const color =
        source.colorName ||
        source.color ||
        source.colour ||
        source.colourName ||
        source.variantColor;
      if (color !== undefined && color !== null) {
        details.colorName = String(color);
      }
    }

    if (!details.size) {
      const size = source.size || source.variantSize;
      if (size !== undefined && size !== null) {
        details.size = String(size);
      }
    }
  };

  applySource(event);
  applySource(event.pathParameters);
  applySource(event.queryStringParameters);

  if (event.body) {
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      applySource(body);
    } catch (err) {
      warn('Failed to parse event body JSON');
    }
  }

  if (!details.variantId && !(details.productId && details.colorName && details.size)) {
    throw new Error('Variant ID or product lookup details were not provided');
  }

  return details;
};

const ensureEnvVars = () => {
  const apiKey = process.env.PRINTFUL_API_KEY;
  const bucket = process.env.PUBLIC_IMAGE_BUCKET;

  if (!apiKey) {
    throw new Error('PRINTFUL_API_KEY environment variable is required');
  }

  if (!bucket) {
    throw new Error('PUBLIC_IMAGE_BUCKET environment variable is required');
  }

  return { apiKey, bucket };
};

const collectMockupImages = async ({ client, uploader, variant, styles }) => {
  const uploads = [];

  for (const style of styles) {
    const upload = await uploader.uploadFromUrl({
      url: style.previewUrl,
      variantId: variant.variantId,
      styleId: style.styleId,
      color: style.color || variant.variant.color || variant.variant.hex_color,
      placements: style.placements,
      type: style.type,
      title: style.title
    });

    if (upload) {
      uploads.push({
        ...style,
        s3: upload
      });
    }
  }

  return uploads;
};

const fetchMockupStyles = async ({ client, productId }) => {
  const templatesResponse = await client.getMockupTemplates(productId);
  const printfilesResponse = await client.getMockupPrintfiles(productId);

  const styles = enrichWithPlacements(templatesResponse, printfilesResponse);

  if (!styles.length) {
    info(`No mockup styles found for product ${productId} with template endpoint, attempting fallback`);
    const fallbackResponse = await client.getMockupStyles(productId);
    return enrichWithPlacements(fallbackResponse, printfilesResponse);
  }

  return styles;
};

const createBlankMockupTask = async ({ client, productId, variantId }) => {
  const payload = {
    variant_ids: [variantId],
    format: 'png',
    files: [],
    options: {
      background: 'FFFFFF'
    }
  };

  const response = await client.createMockupTask(productId, payload);
  const taskKey = response?.result?.task_key || response?.result?.task_id || response?.task_key;

  if (!taskKey) {
    throw new Error('Failed to start Printful mockup task');
  }

  const task = await pollMockupTask({ client, taskKey });
  const mockups = task?.mockups || task?.result?.mockups || [];

  return mockups;
};

const mapMockupsToStyles = (styles, mockups = []) => {
  if (!Array.isArray(mockups) || mockups.length === 0) {
    return styles;
  }

  const mockupMap = new Map();
  for (const mockup of mockups) {
    const styleId = mockup.style_id || mockup.template_id || mockup.id;
    if (!styleId) {
      continue;
    }
    mockupMap.set(String(styleId), mockup);
  }

  return styles.map((style) => {
    const match = mockupMap.get(String(style.styleId));
    if (!match) {
      return style;
    }
    return {
      ...style,
      previewUrl: match.mockup_url || match.url || match.file_url || style.previewUrl,
      placements: style.placements.length ? style.placements : (match.placements || []).map((p) => p.placement || p.name)
    };
  });
};

exports.handler = async (event) => {
  try {
    const { variantId: parsedVariantId, productId, colorName, size } = parseEvent(event);

    const fallbackAttributes = {
      productId: productId ? String(productId) : null,
      colorName: colorName || null,
      size: size || null
    };

    if (parsedVariantId) {
      info(`Processing Printful variant ${parsedVariantId}`);
    } else {
      info(
        `Processing Printful variant lookup for product ${productId} (color=${colorName}, size=${size})`
      );
    }
    const { apiKey, bucket } = ensureEnvVars();

    const client = new PrintfulClient({ apiKey, rateLimitMs: RATE_LIMIT_MS });
    const uploader = new S3Uploader({ bucket });

    let variantResponse;
    let resolvedVariantId = parsedVariantId ? String(parsedVariantId) : null;
    let legacyDetails = null;

    const fetchVariantById = async (id) => {
      if (!id) {
        return null;
      }

      try {
        return await client.getCatalogVariant(id);
      } catch (err) {
        if (err?.response?.status === 404) {
          info(`Catalog variant ${id} not found, attempting store variant lookup`);
          try {
            return await client.getStoreVariant(id);
          } catch (storeErr) {
            if (storeErr?.response?.status === 404) {
              info(`Store variant ${id} not found`);
              return null;
            }
            throw storeErr;
          }
        }
        throw err;
      }
    };

    if (resolvedVariantId) {
      variantResponse = await fetchVariantById(resolvedVariantId);
    }

    if (!variantResponse && resolvedVariantId) {
      info(`Attempting legacy variant lookup for ${resolvedVariantId}`);
      try {
        const legacyResponse = await client.getLegacyVariant(resolvedVariantId);
        legacyDetails = parseLegacyVariantResponse(legacyResponse);

        if (legacyDetails) {
          if (legacyDetails.catalogVariantId) {
            const mappedVariantId = String(legacyDetails.catalogVariantId);
            info(`Legacy variant ${resolvedVariantId} maps to catalog variant ${mappedVariantId}`);
            resolvedVariantId = mappedVariantId;
            variantResponse = await fetchVariantById(resolvedVariantId);
          }

          if (!fallbackAttributes.productId && legacyDetails.productId) {
            fallbackAttributes.productId = String(legacyDetails.productId);
          }
          if (!fallbackAttributes.colorName && legacyDetails.colorName) {
            fallbackAttributes.colorName = legacyDetails.colorName;
          }
          if (!fallbackAttributes.size && legacyDetails.size) {
            fallbackAttributes.size = legacyDetails.size;
          }
        } else {
          info(`Legacy lookup for variant ${resolvedVariantId} returned no usable mapping data`);
        }
      } catch (legacyErr) {
        if (legacyErr?.response?.status === 404) {
          info(`Legacy variant ${resolvedVariantId} not found`);
        } else {
          throw legacyErr;
        }
      }
    }

    if (variantResponse && !fallbackAttributes.productId && legacyDetails?.productId) {
      fallbackAttributes.productId = String(legacyDetails.productId);
    }

    const canUseAttributeLookup =
      !variantResponse &&
      fallbackAttributes.productId &&
      fallbackAttributes.colorName &&
      fallbackAttributes.size;

    if (canUseAttributeLookup) {
      info(
        `Attempting catalog variant resolution for product ${fallbackAttributes.productId} color "${fallbackAttributes.colorName}" size "${fallbackAttributes.size}"`
      );
      const lookup = await findCatalogVariantByAttributes({
        client,
        productId: fallbackAttributes.productId,
        colorName: fallbackAttributes.colorName,
        size: fallbackAttributes.size
      });
      resolvedVariantId = String(lookup.catalogVariantId);
      variantResponse = await fetchVariantById(resolvedVariantId);
      if (!variantResponse) {
        throw new Error(
          `Variant ${resolvedVariantId} derived from product ${fallbackAttributes.productId} could not be retrieved`
        );
      }
    }

    if (!variantResponse) {
      throw new Error(
        `Could not resolve Printful variant ${parsedVariantId || ''}`.trim()
      );
    }

    const variant = parseVariantResponse(variantResponse);
    debug('Variant payload parsed', variant);

    const variantId = String(variant.variantId);

    if (!variant.productId) {
      throw new Error(`Could not resolve product ID for variant ${variantId}`);
    }

    const styles = await fetchMockupStyles({ client, productId: variant.productId });

    let stylesWithMockups = styles;
    const missingPreview = styles.every((style) => !style.previewUrl);
    if (missingPreview) {
      info('No preview URLs returned from template endpoints, requesting blank mockup task');
      const mockups = await createBlankMockupTask({
        client,
        productId: variant.productId,
        variantId: variant.variantId
      });
      stylesWithMockups = mapMockupsToStyles(styles, mockups);
    }

    const uploads = await collectMockupImages({ client, uploader, variant, styles: stylesWithMockups });

    const response = {
      variant: {
        id: variant.variantId,
        productId: variant.productId,
        name: variant.variant?.name,
        color: variant.variant?.color,
        size: variant.variant?.size
      },
      styles: uploads.map((style) => ({
        styleId: style.styleId,
        title: style.title,
        type: style.type,
        color: style.color,
        placements: style.placements,
        s3Key: style.s3.key,
        s3Url: style.s3.url,
        contentType: style.s3.contentType
      }))
    };

    info(`Successfully processed variant ${variantId}`);

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };
  } catch (err) {
    error('Failed to process Printful mockup request', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: err.message,
        stack: process.env.DEBUG_ON === 'true' || process.env.DEBUG_OVERKILL === 'true' ? err.stack : undefined
      })
    };
  }
};
