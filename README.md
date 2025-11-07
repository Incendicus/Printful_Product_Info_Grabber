# Printful Product Info Grabber

AWS Lambda function that accepts a Printful V2 variant ID, resolves corresponding V1 mockup styles, downloads blank mockup imagery, and uploads the files to a public S3 bucket.

## Environment Variables

- `PRINTFUL_API_KEY` – Printful API key used to authenticate requests.
- `PUBLIC_IMAGE_BUCKET` – S3 bucket where blank mockup images will be stored. Existing objects with the same key are overwritten.
- `PF_STORE_ID` – Required. Printful store ID passed to mockup-generator endpoints.
- `IGNORE_COLOR` – Optional. When `true`, disables color filtering so all styles (subject to variant/product-wide rules) are returned.
- `DEBUG_ON` – Optional. Set to `true` for additional debug logs.
- `DEBUG_OVERKILL` – Optional. Set to `true` for extremely verbose logs (includes raw payloads).
- `PRODUCT_WIDE_LIST` – Optional. When `true`, include product-wide mockup styles (still filtered by color) even if the variant is not explicitly listed in the template’s `available_variant_ids`.

## Features

- Supports event payloads that provide the variant ID in the body, query string, path parameters, or top-level `variantId` field.
- Respects the requested rate limit of one Printful API call every three seconds.
- Retrieves Printful mockup templates and placement metadata using the DTG technique without invoking the mockup generator task flow.
- Offers an optional product-wide discovery mode (`PRODUCT_WIDE_LIST=true`) to include color-matching styles that do not explicitly list the requested variant.
- Downloads blank mockup images and uploads them to S3 using the naming pattern `variantID_style-STYLEID_color_placements_type-title.ext`.
- Returns the resolved style metadata along with direct S3 URLs for the uploaded images.
- Tiered logging with three levels (basic, debug, overkill) controlled through environment flags.

## Local Testing

Run the unit tests:

```bash
npm install
npm test
```

## Lambda Handler

Deploy `src/handler.js` as the Lambda entry point. Example event payload:

```json
{
  "variantId": "123456789"
}
```

The handler responds with:

```json
{
  "variant": {
    "catalogProductId": 71,
    "color": "Black",
    "size": "M",
    "image": "https://files.cdn.printful.com/products/71/4016_1752236278.jpg",
    "availablePlacements": [
      { "placement": "front", "height": 16, "width": 12, "orientation": "any" }
    ]
  },
  "styles": [
    {
      "styleId": "123",
      "title": "Front",
      "type": "flat",
      "color": "Black",
      "placements": ["Front"],
      "availableForVariant": true,
      "s3Key": "123456789_style-123_black_front_flat-front.png",
      "s3Url": "https://public-bucket.s3.amazonaws.com/123456789_style-123_black_front_flat-front.png",
      "contentType": "image/png"
    }
  ]
}
```

If `DEBUG_ON` or `DEBUG_OVERKILL` are set, the response will include the error stack trace when failures occur.
