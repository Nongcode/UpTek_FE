const sharp = require('sharp');
const { buildMediaObjectKey } = require('../utils/mediaObjectKey');
const mediaService = require('../services/mediaService');
const mediaVariantService = require('../services/mediaVariantService');

const VARIANT_SPECS = [
  { type: 'thumb', width: 240 },
  { type: 'small', width: 640 },
  { type: 'medium', width: 1280 },
];

async function readOriginalMetadata(buffer) {
  const metadata = await sharp(buffer, { animated: false }).metadata();
  return {
    width: metadata.width || null,
    height: metadata.height || null,
  };
}

async function buildVariantBuffer(buffer, width) {
  return sharp(buffer, { animated: false })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
}

async function processImageVariants({ mediaFile, originalBuffer, storageProvider }) {
  let originalMetadata;
  try {
    originalMetadata = await readOriginalMetadata(originalBuffer);
    if (originalMetadata.width || originalMetadata.height) {
      await mediaService.updateMediaFile(mediaFile.id, originalMetadata);
    }
  } catch (err) {
    console.warn(`Failed to read image metadata for ${mediaFile.id}: ${err.message}`);
    return { variants: [], originalMetadata: null };
  }

  const variants = [];
  for (const spec of VARIANT_SPECS) {
    try {
      const result = await buildVariantBuffer(originalBuffer, spec.width);
      const objectKey = buildMediaObjectKey({
        category: mediaFile.category,
        companyId: mediaFile.company_id,
        departmentId: mediaFile.department_id,
        mediaId: mediaFile.id,
        variant: spec.type,
        extension: '.webp',
        createdAt: mediaFile.created_at,
      });

      const uploadResult = await storageProvider.upload({
        objectKey,
        buffer: result.data,
        mimeType: 'image/webp',
      });

      const variant = await mediaVariantService.createMediaVariant({
        mediaFileId: mediaFile.id,
        variantType: spec.type,
        bucket: mediaFile.bucket,
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: uploadResult.sizeBytes,
        width: result.info.width || null,
        height: result.info.height || null,
      });
      variants.push(variant);
    } catch (err) {
      console.warn(`Failed to create ${spec.type} variant for ${mediaFile.id}: ${err.message}`);
    }
  }

  return { variants, originalMetadata };
}

module.exports = {
  VARIANT_SPECS,
  processImageVariants,
  readOriginalMetadata,
};
