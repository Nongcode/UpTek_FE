const mediaLegacyService = require('../services/mediaLegacyService');
const mediaAgentUploadService = require('../services/mediaAgentUploadService');
const { extractBearerToken } = require('../auth');

function sendError(res, err) {
  return res.status(err.statusCode || 500).json({ error: err.message });
}

function createMediaLegacyController({ automationSyncToken = '' } = {}) {
  async function getGallery(req, res) {
    try {
      const rows = await mediaLegacyService.listGalleryImages(req.auth, extractBearerToken(req));
      return res.json(rows);
    } catch (err) {
      return sendError(res, err);
    }
  }

  async function uploadGallery(req, res) {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const { productModel } = req.body;
    if (!productModel) {
      return res.status(400).json({ error: 'productModel is required for manual uploads' });
    }

    try {
      const result = await mediaLegacyService.saveUploadedGalleryImages({
        files: req.files,
        auth: req.auth || {},
        body: req.body,
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }

  async function agentUpload(req, res) {
    if (automationSyncToken) {
      const incomingToken = req.get('x-automation-sync-token') || '';
      if (incomingToken !== automationSyncToken) {
        return res.status(401).json({ error: 'Unauthorized automation sync token' });
      }
    }

    const { filename, base64Data, productModel, prefix } = req.body;
    if (!filename || !base64Data || !productModel || !prefix) {
      return res.status(400).json({ error: 'filename, base64Data, productModel, and prefix are required' });
    }

    try {
      const result = await mediaAgentUploadService.saveAgentUploadedImage(req.body);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }

  return {
    agentUpload,
    getGallery,
    uploadGallery,
  };
}

module.exports = createMediaLegacyController;
