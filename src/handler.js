const PrintfulClient = require('./printfulClient');
const { info, warn, error, debug } = require('./logger');
const { enrichWithPlacements, parseVariantResponse, pollMockupTask } = require('./printfulService');
const S3Uploader = require('./s3Uploader');

const RATE_LIMIT_MS = 3_000;

const parseEvent = (event) => {
  if (!event) {
    throw new Error('Event payload is required');
  }

  if (event.variantId) {
    return String(event.variantId);
  }

  if (event.pathParameters?.variantId) {
    return String(event.pathParameters.variantId);
  }

  if (event.queryStringParameters?.variantId) {
    return String(event.queryStringParameters.variantId);
  }

  if (event.body) {
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      if (body?.variantId) {
        return String(body.variantId);
      }
    } catch (err) {
      warn('Failed to parse event body JSON');
    }
  }

  throw new Error('Variant ID was not provided');
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
    const variantId = parseEvent(event);
    info(`Processing Printful variant ${variantId}`);
    const { apiKey, bucket } = ensureEnvVars();

    const client = new PrintfulClient({ apiKey, rateLimitMs: RATE_LIMIT_MS });
    const uploader = new S3Uploader({ bucket });

    const variantResponse = await client.getCatalogVariant(variantId);
    const variant = parseVariantResponse(variantResponse);
    debug('Variant payload parsed', variant);

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
