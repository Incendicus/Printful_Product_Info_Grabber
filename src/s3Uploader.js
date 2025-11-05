const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const { info, debug, error, overkill } = require('./logger');
const { guessExtensionFromUrl, generateObjectKey, buildPublicUrl } = require('./naming');

const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

class S3Uploader {
  constructor({ bucket }) {
    if (!bucket) {
      throw new Error('S3 bucket is required for uploader');
    }
    this.bucket = bucket;
    this.client = new S3Client({ region: DEFAULT_REGION });
  }

  async uploadFromUrl({ url, variantId, styleId, color, placements, type, title }) {
    if (!url) {
      info(`No mockup URL found for style ${styleId}, skipping download`);
      return null;
    }

    const extension = guessExtensionFromUrl(url);
    const key = generateObjectKey({
      variantId,
      styleId,
      color,
      placements,
      type,
      title,
      extension
    });

    try {
      info(`Downloading mockup image from ${url}`);
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60_000
      });
      overkill('Mockup image download headers', response.headers);

      const contentType = response.headers['content-type'] || this._guessContentType(extension);

      info(`Uploading mockup to s3://${this.bucket}/${key}`);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: response.data,
          ContentType: contentType
        })
      );

      const publicUrl = buildPublicUrl(this.bucket, key);
      debug(`Uploaded mockup available at ${publicUrl}`);
      return {
        key,
        url: publicUrl,
        contentType
      };
    } catch (err) {
      error(`Failed to upload mockup style ${styleId} to S3`, err);
      throw err;
    }
  }

  _guessContentType(extension) {
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
      default:
        return 'image/png';
    }
  }
}

module.exports = S3Uploader;
