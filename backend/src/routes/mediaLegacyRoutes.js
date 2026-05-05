const express = require('express');
const multer = require('multer');
const mediaConfig = require('../config/media');
const { requireBackendAuth } = require('../auth');
const createMediaLegacyController = require('../controllers/mediaLegacyController');
const mediaLegacyService = require('../services/mediaLegacyService');

function createMediaLegacyRoutes({ automationSyncToken = '' } = {}) {
  const router = express.Router();
  const controller = createMediaLegacyController({ automationSyncToken });
  const maxUploadSizeBytes = mediaLegacyService.getMaxUploadSizeBytes();

  mediaLegacyService.ensureStorageRoot();
  void mediaLegacyService.ensureImagesTable();

  router.use(mediaConfig.galleryPublicPath, express.static(mediaLegacyService.getStorageDir()));

  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      const { companyId, departmentId } = mediaLegacyService.resolveGalleryScope(req.auth || {}, req.body);
      const dir = mediaLegacyService.ensureGalleryDirectory(companyId, departmentId);
      cb(null, dir);
    },
    filename: function (req, file, cb) {
      cb(null, mediaLegacyService.createStoredFilename(file.originalname));
    }
  });

  const upload = multer({
    storage: storage,
    limits: {
      fileSize: maxUploadSizeBytes,
    },
    fileFilter: function (req, file, cb) {
      if (!mediaLegacyService.isAllowedUploadMime(file.mimetype)) {
        return cb(new Error(`Unsupported image mime type: ${file.mimetype || 'unknown'}`));
      }
      return cb(null, true);
    },
  });
  const uploadGalleryImages = upload.array('images', 20);

  function handleGalleryUpload(req, res, next) {
    uploadGalleryImages(req, res, function (err) {
      if (!err) {
        return next();
      }

      mediaLegacyService.removeUploadedFiles(req.files);

      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB` });
      }

      return res.status(400).json({ error: err.message || 'Invalid image upload' });
    });
  }

  router.get('/api/gallery', requireBackendAuth, controller.getGallery);
  router.post('/api/gallery/upload', requireBackendAuth, handleGalleryUpload, controller.uploadGallery);
  router.post('/api/gallery/agent-upload', controller.agentUpload);

  return router;
}

module.exports = createMediaLegacyRoutes;
