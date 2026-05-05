require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_CONFIG_BACKUP_PATH = `${DEFAULT_CONFIG_PATH}.bak`;

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to read config ${filePath}:`, error.message);
    return null;
  }
}

function writeJsonWithBackup(filePath, backupPath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  fs.writeFileSync(filePath, serialized, "utf8");
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeControlUiConfig(primaryConfig, backupConfig) {
  const merged = deepClone(primaryConfig || {}) || {};
  const primaryGateway = merged.gateway || {};
  const backupGateway = backupConfig?.gateway || {};
  const primaryControlUi = primaryGateway.controlUi || {};
  const backupControlUi = backupGateway.controlUi || {};

  merged.gateway = {
    ...backupGateway,
    ...primaryGateway,
    controlUi: {
      ...backupControlUi,
      ...primaryControlUi,
      allowedOrigins: primaryControlUi.allowedOrigins || backupControlUi.allowedOrigins,
      employeeDirectory:
        Array.isArray(primaryControlUi.employeeDirectory) && primaryControlUi.employeeDirectory.length > 0
          ? primaryControlUi.employeeDirectory
          : (backupControlUi.employeeDirectory || []),
      demoLogin:
        primaryControlUi.demoLogin?.enabled
          ? primaryControlUi.demoLogin
          : backupControlUi.demoLogin,
    },
    auth: {
      ...(backupGateway.auth || {}),
      ...(primaryGateway.auth || {}),
    },
  };

  return merged;
}

function loadOpenClawConfig() {
  const primaryConfig = readJsonIfExists(DEFAULT_CONFIG_PATH);
  const backupConfig = readJsonIfExists(DEFAULT_CONFIG_BACKUP_PATH);
  return mergeControlUiConfig(primaryConfig, backupConfig);
}

function saveOpenClawConfig(config) {
  writeJsonWithBackup(DEFAULT_CONFIG_PATH, DEFAULT_CONFIG_BACKUP_PATH, config || {});
}

module.exports = {
  DEFAULT_CONFIG_BACKUP_PATH,
  DEFAULT_CONFIG_PATH,
  deepClone,
  loadOpenClawConfig,
  mergeControlUiConfig,
  readJsonIfExists,
  saveOpenClawConfig,
  writeJsonWithBackup,
};

