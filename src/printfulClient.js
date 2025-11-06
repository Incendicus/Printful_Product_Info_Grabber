const axios = require('axios');
const { info, debug, error, overkill } = require('./logger');

const DEFAULT_RATE_LIMIT_MS = 3000;

const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PrintfulClient {
  constructor({ apiKey, baseUrl = 'https://api.printful.com', rateLimitMs = DEFAULT_RATE_LIMIT_MS } = {}) {
    if (!apiKey) {
      throw new Error('Printful API key is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.rateLimitMs = rateLimitMs;
    this.lastRequestTime = 0;
    this.queue = Promise.resolve();
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      timeout: 30_000
    });
  }

  async request({ method = 'GET', path, params, data }) {
    if (!path) {
      throw new Error('Request path is required');
    }

    this.queue = this.queue.then(() => this._request({ method, path, params, data }));
    return this.queue;
  }

  async _request({ method, path, params, data }) {
    await this._respectRateLimit();

    try {
      debug(`Printful request: ${method} ${path}`, { params, hasData: Boolean(data) });
      const response = await this.http.request({
        method,
        url: path,
        params,
        data
      });
      overkill('Printful response payload', response.data);
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      error(`Printful API request failed: ${method} ${path} (${status || 'no status'})`);
      if (body) {
        debug('Printful error body', body);
      }
      throw err;
    }
  }

  async _respectRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.rateLimitMs - elapsed);

    if (waitTime > 0) {
      info(`Respecting Printful rate limit, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
  }

  getCatalogVariant(variantId) {
    return this.request({ method: 'GET', path: `/v2/catalog/variant/${variantId}` });
  }

  getStoreVariant(variantId) {
    return this.request({ method: 'GET', path: `/v2/store-variants/${variantId}` });
  }

  getLegacyVariant(variantId) {
    return this.request({ method: 'GET', path: `/v1/products/variant/${variantId}` });
  }

  getMockupTemplates(productId) {
    return this.request({ method: 'GET', path: `/v2/mockup-generator/templates/${productId}` });
  }

  getMockupPrintfiles(productId) {
    return this.request({ method: 'GET', path: `/v2/mockup-generator/printfiles/${productId}` });
  }

  getMockupStyles(productId) {
    return this.request({ method: 'GET', path: `/v2/mockup-generator/styles/${productId}` });
  }

  listCatalogVariants(productId, { limit = 100, offset = 0 } = {}) {
    if (!productId) {
      throw new Error('Product ID is required to list catalog variants');
    }

    const params = { limit, offset };
    return this.request({
      method: 'GET',
      path: `/v2/catalog-products/${productId}/catalog-variants`,
      params
    });
  }

  createMockupTask(productId, payload) {
    return this.request({ method: 'POST', path: `/v2/mockup-generator/create-task/${productId}`, data: payload });
  }

  getMockupTask(taskKey) {
    return this.request({ method: 'GET', path: `/v2/mockup-generator/task-fetch/${taskKey}` });
  }
}

module.exports = PrintfulClient;
