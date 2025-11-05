const sanitizeSegment = (value) => {
  if (value === undefined || value === null) {
    return 'unknown';
  }
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)/g, '')
    || 'unknown';
};

const buildPlacementsSegment = (placements = []) => {
  if (!Array.isArray(placements) || placements.length === 0) {
    return 'no-placement';
  }
  return placements.map((placement) => sanitizeSegment(placement)).join('_');
};

const guessExtensionFromUrl = (url) => {
  if (!url) {
    return 'png';
  }
  const match = url.match(/\.([a-zA-Z0-9]{3,4})(?:\?|$)/);
  if (match) {
    return match[1].toLowerCase();
  }
  return 'png';
};

const generateObjectKey = ({
  variantId,
  styleId,
  color,
  placements,
  type,
  title,
  extension
}) => {
  const variantSegment = sanitizeSegment(variantId);
  const styleSegment = `style-${sanitizeSegment(styleId)}`;
  const colorSegment = sanitizeSegment(color);
  const placementsSegment = buildPlacementsSegment(placements);
  const typeSegment = sanitizeSegment(type || 'style');
  const titleSegment = sanitizeSegment(title || styleId || 'mockup');
  const fileExtension = sanitizeSegment(extension || 'png');

  return `${variantSegment}_${styleSegment}_${colorSegment}_${placementsSegment}_${typeSegment}-${titleSegment}.${fileExtension}`;
};

const buildPublicUrl = (bucket, key) => {
  const encodedKey = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://${bucket}.s3.amazonaws.com/${encodedKey}`;
};

module.exports = {
  sanitizeSegment,
  buildPlacementsSegment,
  guessExtensionFromUrl,
  generateObjectKey,
  buildPublicUrl
};
