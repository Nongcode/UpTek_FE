require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_CONFIG_BACKUP_PATH = `${DEFAULT_CONFIG_PATH}.bak`;
const BACKEND_TOKEN_TTL_MS = Number(process.env.BACKEND_AUTH_TTL_MS || 12 * 60 * 60 * 1000);

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

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function normalizeEmail(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  return normalized || undefined;
}

function normalizeAgentId(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized) ? normalized : undefined;
}

function normalizeSessionKey(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  return normalized || undefined;
}

function dedupeAgentIds(agentIds) {
  return [...new Set((agentIds || []).map(normalizeAgentId).filter(Boolean))];
}

function resolveDefaultVisibilityForLockedAgent(lockedAgentId) {
  switch (lockedAgentId) {
    case "main":
    case "quan_ly":
      return { canViewAllSessions: true, visibleAgentIds: [] };
    case "truong_phong":
      return { canViewAllSessions: false, visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"] };
    case "pho_phong":
      return { canViewAllSessions: false, visibleAgentIds: ["pho_phong", "nv_content", "nv_media", "nv_prompt"] };
    default:
      return { canViewAllSessions: false, visibleAgentIds: [lockedAgentId] };
  }
}

function resolveVisibility({ lockedAgentId, canViewAllSessions, visibleAgentIds }) {
  if (canViewAllSessions === true) {
    return { canViewAllSessions: true, visibleAgentIds: [] };
  }
  const explicitAgentIds = dedupeAgentIds([lockedAgentId, ...(visibleAgentIds || [])]);
  if (explicitAgentIds.length > 0) {
    return { canViewAllSessions: false, visibleAgentIds: explicitAgentIds };
  }
  return resolveDefaultVisibilityForLockedAgent(lockedAgentId);
}

function normalizeEmployeeKey(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return normalized || undefined;
}

function resolveAccessPolicyForEmployee(config, employeeId, employeeName) {
  const requestedId = normalizeEmployeeKey(employeeId);
  const requestedName = normalizeEmployeeKey(employeeName);
  const entries = config?.gateway?.controlUi?.employeeDirectory;

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      const candidates = [
        normalizeEmployeeKey(entry.employeeId),
        normalizeEmployeeKey(entry.employeeName),
        ...aliases.map(normalizeEmployeeKey),
      ].filter(Boolean);

      if (
        (requestedId && candidates.includes(requestedId)) ||
        (requestedName && candidates.includes(requestedName))
      ) {
        const lockedAgentId = normalizeAgentId(entry.lockedAgentId) || "main";
        const visibility = resolveVisibility({
          lockedAgentId,
          canViewAllSessions: entry.canViewAllSessions,
          visibleAgentIds: entry.visibleAgentIds,
        });

        const cId = "UpTek";
        let dId = "PhongMarketing";
        const empIdStr = normalizeText(entry.employeeId) || normalizeText(employeeId);
        
        if (empIdStr === "admin") {
          dId = "All";
        } else if (empIdStr === "giam_doc" || empIdStr === "truong_phong" || empIdStr === "pho_phong_cskh") {
          dId = (empIdStr === "giam_doc" || empIdStr === "truong_phong") ? "BanGiamDoc" : "PhongCSKH";
        } else if (empIdStr === "nv_consultant") {
          dId = "PhongCSKH";
        }

        return {
          employeeId: empIdStr,
          employeeName: normalizeText(entry.employeeName) || normalizeText(employeeName),
          lockedAgentId,
          lockedSessionKey: normalizeSessionKey(entry.lockedSessionKey) || `agent:${lockedAgentId}:main`,
          companyId: cId,
          departmentId: dId,
          canViewAllSessions: visibility.canViewAllSessions,
          visibleAgentIds: visibility.visibleAgentIds,
          lockAgent: entry.lockAgent === true || entry.lockSession === true,
          lockSession: entry.lockSession === true,
          autoConnect: entry.autoConnect === true,
          enforcedByServer: true,
        };
      }
    }
  }

  const fallbackLockedAgentId = normalizeAgentId(employeeId) || normalizeAgentId(employeeName);
  if (!fallbackLockedAgentId) {
    return undefined;
  }
  const visibility = resolveDefaultVisibilityForLockedAgent(fallbackLockedAgentId);
  return {
    employeeId: normalizeText(employeeId),
    employeeName: normalizeText(employeeName),
    companyId: normalizeText(employeeId),
    departmentId: normalizeText(employeeId),
    lockedAgentId: fallbackLockedAgentId,
    lockedSessionKey: `agent:${fallbackLockedAgentId}:main`,
    canViewAllSessions: visibility.canViewAllSessions,
    visibleAgentIds: visibility.visibleAgentIds,
    lockAgent: true,
    lockSession: false,
    autoConnect: false,
    enforcedByServer: false,
  };
}

function findDemoAccount(config, email, password) {
  const requestedEmail = normalizeEmail(email);
  const requestedPassword = normalizeText(password);
  const accounts = config?.gateway?.controlUi?.demoLogin?.accounts;
  if (!requestedEmail || !requestedPassword || !Array.isArray(accounts)) {
    return null;
  }

  return (
    accounts.find((entry) => {
      return normalizeEmail(entry.email) === requestedEmail && normalizeText(entry.password) === requestedPassword;
    }) || null
  );
}

function base64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function getBackendSigningSecret(config) {
  return process.env.BACKEND_AUTH_SECRET || normalizeText(config?.gateway?.auth?.token) || "uptek-local-secret";
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueBackendToken(config, accessPolicy) {
  const now = Date.now();
  const payload = {
    employeeId: accessPolicy.employeeId || accessPolicy.lockedAgentId || "unknown",
    employeeName: accessPolicy.employeeName || null,
    companyId: accessPolicy.companyId || null,
    departmentId: accessPolicy.departmentId || null,
    lockedAgentId: accessPolicy.lockedAgentId || null,
    visibleAgentIds: accessPolicy.visibleAgentIds || [],
    canViewAllSessions: accessPolicy.canViewAllSessions === true,
    iat: now,
    exp: now + BACKEND_TOKEN_TTL_MS,
  };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const signature = signPayload(encoded, getBackendSigningSecret(config));
  return `${encoded}.${signature}`;
}

function verifyBackendToken(config, token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expectedSignature = signPayload(encoded, getBackendSigningSecret(config));
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64urlDecode(encoded));
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function resolveAllowedAgentIds(auth) {
  if (auth.canViewAllSessions) {
    return [];
  }
  return dedupeAgentIds([auth.lockedAgentId, ...(auth.visibleAgentIds || [])]);
}

function canAccessEmployeeId(auth, employeeId) {
  const target = normalizeAgentId(employeeId) || normalizeEmployeeKey(employeeId);
  if (!target) {
    return false;
  }
  if (auth.canViewAllSessions) {
    if (auth.employeeId === 'giam_doc' && (target === 'admin' || target === 'main')) {
      return false;
    }
    return true;
  }
  if (normalizeEmployeeKey(auth.employeeId) === target) {
    return true;
  }
  return resolveAllowedAgentIds(auth).includes(normalizeAgentId(target) || "");
}

function resolveConversationAgentId(conversationLike) {
  const directAgentId = normalizeAgentId(conversationLike?.agentId);
  if (directAgentId) {
    return directAgentId;
  }
  const sessionKey = String(conversationLike?.sessionKey || "");
  const match = sessionKey.match(/^(?:agent|automation):([^:]+)/i);
  return normalizeAgentId(match?.[1]);
}

function canAccessConversation(auth, conversationLike) {
  if (!conversationLike) {
    return false;
  }
  const empId = normalizeText(conversationLike.employeeId);
  const aId = resolveConversationAgentId(conversationLike);

  if (auth.canViewAllSessions) {
    if (auth.employeeId === 'giam_doc' && (empId === 'admin' || empId === 'main' || aId === 'main')) {
      return false;
    }
    return true;
  }
  const employeeId = normalizeText(conversationLike.employeeId);
  if (employeeId && canAccessEmployeeId(auth, employeeId)) {
    return true;
  }
  const agentId = resolveConversationAgentId(conversationLike);
  if (!agentId) {
    return false;
  }
  return resolveAllowedAgentIds(auth).includes(agentId);
}

function buildLoginResponse(email, password) {
  const config = loadOpenClawConfig();
  const matchedAccount = findDemoAccount(config, email, password);
  if (!matchedAccount) {
    return null;
  }

  const accessPolicy = resolveAccessPolicyForEmployee(config, matchedAccount.employeeId, matchedAccount.employeeName);
  if (!accessPolicy) {
    return null;
  }

  return {
    ok: true,
    token: normalizeText(config?.gateway?.auth?.token) || null,
    backendToken: issueBackendToken(config, accessPolicy),
    accessPolicy,
  };
}

function extractBearerToken(req) {
  const authHeader = String(req.get("authorization") || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function requireBackendAuth(req, res, next) {
  const config = loadOpenClawConfig();
  const token = extractBearerToken(req);
  const payload = verifyBackendToken(config, token);
  if (!payload) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.auth = payload;
  req.openclawConfig = config;
  return next();
}

function optionalBackendAuth(req, res, next) {
  const config = loadOpenClawConfig();
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : '';
  const token = extractBearerToken(req) || queryToken;
  const payload = token ? verifyBackendToken(config, token) : null;
  if (payload) {
    req.auth = payload;
    req.openclawConfig = config;
  }
  return next();
}

module.exports = {
  buildLoginResponse,
  canAccessConversation,
  canAccessEmployeeId,
  extractBearerToken,
  loadOpenClawConfig,
  optionalBackendAuth,
  requireBackendAuth,
  resolveConversationAgentId,
};
