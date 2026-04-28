const mediaConfig = require('../config/media');
const LocalStorageProvider = require('./providers/LocalStorageProvider');

function createStorageProvider(config = mediaConfig) {
  if (config.storageDriver === 'local') {
    return new LocalStorageProvider({
      rootDir: config.localRoot,
      publicBaseUrl: config.publicBaseUrl || config.cdnBaseUrl,
    });
  }

  throw new Error(`Unsupported media storage driver: ${config.storageDriver}`);
}

module.exports = {
  createStorageProvider,
};
