const express = require('express');
const multer = require('multer');
const mediaConfig = require('../config/media');
const { optionalBackendAuth, requireBackendAuth } = require('../auth');
const mediaController = require('../controllers/mediaController');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: mediaConfig.maxUploadSizeMb * 1024 * 1024,
  },
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, function (err) {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB` });
    }

    return res.status(400).json({ error: err.message || 'Invalid media upload' });
  });
}

router.post('/api/media/upload', requireBackendAuth, handleUpload, mediaController.uploadMedia);
router.get('/api/media/:id/read', optionalBackendAuth, mediaController.readMedia);
router.get('/api/media/:id/variants/:variantType/read', optionalBackendAuth, mediaController.readMediaVariant);
router.get('/api/media/:id', requireBackendAuth, mediaController.getMediaById);
router.get('/api/media', requireBackendAuth, mediaController.listMedia);

module.exports = router;
