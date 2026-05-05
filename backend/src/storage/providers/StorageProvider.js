class StorageProvider {
  async upload() {
    throw new Error('StorageProvider.upload must be implemented');
  }

  async delete() {
    throw new Error('StorageProvider.delete must be implemented');
  }

  async exists() {
    throw new Error('StorageProvider.exists must be implemented');
  }

  getPublicUrl() {
    throw new Error('StorageProvider.getPublicUrl must be implemented');
  }

  async getSignedReadUrl() {
    throw new Error('StorageProvider.getSignedReadUrl must be implemented');
  }
}

module.exports = StorageProvider;
