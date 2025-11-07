const PrintfulClient = require('./printfulClient');
const { info, warn, error, debug } = require('./logger');
const { enrichWithPlacements, parseVariantResponse, findCatalogVariantByAttributes } = require('./printfulService');
const S3Uploader = require('./s3Uploader');

const RATE_LIMIT_MS = 3_000;
const MOCKUP_TECHNIQUE = 'DTG';

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
  const storeId = process.env.PF_STORE_ID;

  if (!apiKey) {
    throw new Error('PRINTFUL_API_KEY environment variable is required');
  }

  if (!bucket) {
    throw new Error('PUBLIC_IMAGE_BUCKET environment variable is required');
  }

  if (!storeId) {
    throw new Error('PF_STORE_ID environment variable is required');
  }

  return { apiKey, bucket, storeId };
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

const fetchMockupStyles = async ({ client, productId, variantId, storeId }) => {
  const templateParams = { technique: MOCKUP_TECHNIQUE, store_id: storeId };
  if (variantId) {
    templateParams.variant_ids = variantId;
  }

  let templatesResponse;
  try {
    templatesResponse = await client.getMockupTemplates(productId, templateParams);
  } catch (err) {
    const shouldRetryWithoutVariant =
      variantId && err?.response?.status === 404 && templateParams.variant_ids;
    if (!shouldRetryWithoutVariant) {
      throw err;
    }
    info(
      `Templates endpoint rejected variant filter for product ${productId}, retrying without variant_ids`
    );
    const fallbackParams = { ...templateParams };
    delete fallbackParams.variant_ids;
    templatesResponse = await client.getMockupTemplates(productId, fallbackParams);
  }

  const printfilesResponse = await client.getMockupPrintfiles(productId, {
    technique: MOCKUP_TECHNIQUE,
    store_id: storeId
  });

  const styles = enrichWithPlacements(templatesResponse, printfilesResponse);

  if (!styles.length) {
    info(`No mockup styles found for product ${productId} using technique ${MOCKUP_TECHNIQUE}`);
  }

  return styles;
};

const normalizeColor = (value) => String(value || '').trim().toLowerCase();

const annotateStylesForVariant = ({ styles, variantId }) => {
  const normalizedVariantId = variantId ? String(variantId) : null;
  return styles.map((style) => {
    const availableForVariant = normalizedVariantId
      ? style.availableVariantIds?.some((id) => String(id) === normalizedVariantId)
      : false;
    return {
      ...style,
      availableForVariant
    };
  });
};

const filterStylesForVariant = ({
  styles,
  variantId,
  variantColor,
  includeProductWideList,
  ignoreColor
}) => {
  const annotated = annotateStylesForVariant({ styles, variantId });
  const normalizedColor = normalizeColor(variantColor);

  return annotated.filter((style) => {
    const colorMatches =
      ignoreColor ||
      !normalizedColor ||
      (style.color ? normalizeColor(style.color) === normalizedColor : false);

    if (!colorMatches) {
      return false;
    }

    if (style.availableForVariant) {
      return true;
    }

    return includeProductWideList;
  });
};

const buildVariantSummary = ({ variant, productId }) => {
  const placements = Array.isArray(variant.placement_dimensions) ? variant.placement_dimensions : [];
  return {
    catalogProductId: productId,
    color: variant.color || variant.color_name,
    size: variant.size || variant.size_name,
    image: variant.image,
    availablePlacements: placements
  };
};

exports.filterStylesForVariant = filterStylesForVariant;

exports.handler = async (event) => {
  try {
    const { variantId: parsedVariantId, productId, colorName, size } = parseEvent(event);

    if (parsedVariantId) {
      info(`Processing Printful variant ${parsedVariantId}`);
    } else {
      info(
        `Processing Printful variant lookup for product ${productId} (color=${colorName}, size=${size})`
      );
    }
    const { apiKey, bucket, storeId } = ensureEnvVars();

    const client = new PrintfulClient({ apiKey, rateLimitMs: RATE_LIMIT_MS });
    const uploader = new S3Uploader({ bucket });

    let variantResponse;
    let resolvedVariantId = parsedVariantId;

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

    if (!variantResponse && productId && colorName && size) {
      info(
        `Attempting catalog variant resolution for product ${productId} color "${colorName}" size "${size}"`
      );
      const lookup = await findCatalogVariantByAttributes({
        client,
        productId,
        colorName,
        size
      });
      resolvedVariantId = String(lookup.catalogVariantId);
      variantResponse = await fetchVariantById(resolvedVariantId);
      if (!variantResponse) {
        throw new Error(
          `Variant ${resolvedVariantId} derived from product ${productId} could not be retrieved`
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

    const includeProductWideList = process.env.PRODUCT_WIDE_LIST === 'true';
    const ignoreColor = process.env.IGNORE_COLOR === 'true';
    const styles = await fetchMockupStyles({
      client,
      productId: variant.productId,
      variantId,
      storeId
    });

    const filteredStyles = filterStylesForVariant({
      styles,
      variantId,
      variantColor: variant.variant?.color || variant.variant?.color_name,
      includeProductWideList,
      ignoreColor
    });

    if (!filteredStyles.length) {
      throw new Error(
        `No mockup styles matched variant ${variantId} (color=${variant.variant?.color || 'unknown'}, PRODUCT_WIDE_LIST=${includeProductWideList})`
      );
    }

    const uploads = await collectMockupImages({ client, uploader, variant, styles: filteredStyles });

    const response = {
      variant: buildVariantSummary({
        variant: variant.variant,
        productId: variant.productId
      }),
      styles: uploads.map((style) => ({
        styleId: style.styleId,
        title: style.title,
        type: style.type,
        color: style.color,
        placements: style.placements,
        availableForVariant: style.availableForVariant,
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
