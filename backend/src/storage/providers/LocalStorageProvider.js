const fs = require('fs');
const path = require('path');
const StorageProvider = require('./StorageProvider');
const { assertPathInsideRoot } = require('../../utils/pathSafety');

class LocalStorageProvider extends StorageProvider {
  constructor(options = {}) {
    super();
    if (!options.rootDir) {
      throw new Error('LocalStorageProvider requires rootDir');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.publicBaseUrl = options.publicBaseUrl || '';
  }

  resolveObjectPath(objectKey) {
    const normalizedKey = String(objectKey || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedKey || normalizedKey.includes('\0')) {
      throw new Error('Invalid storage object key');
    }
    const targetPath = path.join(this.rootDir, normalizedKey);
    return assertPathInsideRoot(this.rootDir, targetPath);
  }

  async upload({ objectKey, buffer, sourcePath }) {
    const targetPath = this.resolveObjectPath(objectKey);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (Buffer.isBuffer(buffer)) {
      fs.writeFileSync(targetPath, buffer);
    } else if (sourcePath) {
      const safeSourcePath = path.resolve(sourcePath);
      fs.copyFileSync(safeSourcePath, targetPath);
    } else {
      throw new Error('upload requires buffer or sourcePath');
    }

    const stat = fs.statSync(targetPath);
    return {
      objectKey,
      path: targetPath,
      sizeBytes: stat.size,
      storageProvider: 'local',
    };
  }

  async delete({ objectKey }) {
    const targetPath = this.resolveObjectPath(objectKey);
    if (!fs.existsSync(targetPath)) {
      return false;
    }
    fs.unlinkSync(targetPath);
    return true;
  }

  async exists({ objectKey }) {
    return fs.existsSync(this.resolveObjectPath(objectKey));
  }

  getPublicUrl({ objectKey }) {
    if (!this.publicBaseUrl) {
      return null;
    }
    return `${this.publicBaseUrl.replace(/\/+$/, '')}/${String(objectKey).replace(/^\/+/, '')}`;
  }

  async getSignedReadUrl({ objectKey }) {
    return this.getPublicUrl({ objectKey }) || this.resolveObjectPath(objectKey);
  }
}

module.exports = LocalStorageProvider;
