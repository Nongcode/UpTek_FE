const mediaUploadService = require('../services/mediaUploadService');
const mediaReadService = require('../services/mediaReadService');
const { extractBearerToken } = require('../auth');

function sendError(res, err) {
  return res.status(err.statusCode || 500).json({ error: err.message });
}

function decorateMediaReadUrls(media, token) {
  if (!media?.id) {
    return media;
  }

  return {
    ...media,
    readUrl: mediaReadService.buildOriginalReadUrl(media.id, token, media),
    variants: (media.variants || []).map((variant) => ({
      ...variant,
      readUrl: mediaReadService.buildVariantReadUrl(media.id, variant.variant_type, token, media, variant),
    })),
  };
}

async function uploadMedia(req, res) {
  try {
    const result = await mediaUploadService.uploadMediaFile({
      file: req.file,
      body: req.body || {},
      auth: req.auth || {},
    });
    return res.json({ success: true, media: decorateMediaReadUrls(result, extractBearerToken(req)) });
  } catch (err) {
    return sendError(res, err);
  }
}

async function getMediaById(req, res) {
  try {
    const media = await mediaReadService.getMediaMetadata(req.params.id, req.auth || {}, extractBearerToken(req));
    if (!media) {
      return res.status(404).json({ error: 'Media file not found' });
    }
    return res.json({ media });
  } catch (err) {
    return sendError(res, err);
  }
}

async function readMedia(req, res) {
  try {
    const target = await mediaReadService.getReadTarget({
      mediaFileId: req.params.id,
      variantType: req.query.variant || 'original',
      auth: req.auth || {},
    });

    if (!target) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    if (target.mode === 'redirect') {
      return res.redirect(target.url);
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(target.mimeType);
    return res.sendFile(target.filePath);
  } catch (err) {
    return sendError(res, err);
  }
}

async function readMediaVariant(req, res) {
  try {
    const target = await mediaReadService.getReadTarget({
      mediaFileId: req.params.id,
      variantType: req.params.variantType,
      auth: req.auth || {},
    });

    if (!target) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    if (target.mode === 'redirect') {
      return res.redirect(target.url);
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(target.mimeType);
    return res.sendFile(target.filePath);
  } catch (err) {
    return sendError(res, err);
  }
}

async function listMedia(req, res) {
  try {
    const scope = {
      category: req.query.category,
      companyId: req.query.companyId || req.auth?.companyId,
      departmentId: req.query.departmentId,
      limit: Number.parseInt(String(req.query.limit || ''), 10),
      ownerId: req.query.ownerId,
      ownerType: req.query.ownerType,
      status: req.query.status,
      visibility: req.query.visibility,
    };
    const result = await mediaUploadService.listMediaFiles(scope);
    const token = extractBearerToken(req);
    return res.json({
      ...result,
      items: (result.items || []).map((item) => decorateMediaReadUrls(item, token)),
    });
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = {
  getMediaById,
  listMedia,
  readMedia,
  readMediaVariant,
  uploadMedia,
};
