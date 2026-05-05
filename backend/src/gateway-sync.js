require("dotenv").config();
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://192.168.35.210:18789";
const DEFAULT_DEVICE_IDENTITY_PATH = path.join(os.homedir(), ".openclaw", "identity", "device.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const GATEWAY_PROTOCOL_VERSION = 3;

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadGatewayConfig() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
  const backupPath = `${configPath}.bak`;
  const primary = readJsonIfExists(configPath);
  const backup = readJsonIfExists(backupPath);
  return primary || backup || null;
}

function resolveGatewayToken() {
  const config = loadGatewayConfig();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || config?.gateway?.auth?.token || "";
  return typeof token === "string" ? token.trim() : "";
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function loadDeviceIdentity() {
  const raw = fs.readFileSync(DEFAULT_DEVICE_IDENTITY_PATH, "utf8");
  return JSON.parse(raw);
}

function buildDeviceAuthPayload(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token || "",
    params.nonce,
    String(params.platform || "").trim().toLowerCase(),
    "",
  ].join("|");
}

function onceMessage(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Gateway response timeout"));
    }, timeoutMs);

    const onMessage = (event) => {
      try {
        const text = typeof event.data === "string" ? event.data : event.data.toString();
        const payload = JSON.parse(text);
        if (!predicate(payload)) {
          return;
        }
        cleanup();
        resolve(payload);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
  });
}

async function connectGateway() {
  const token = resolveGatewayToken();
  if (!token) {
    throw new Error("Missing OPENCLAW gateway token");
  }

  const identity = loadDeviceIdentity();
  const ws = new WebSocket(DEFAULT_GATEWAY_URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway open timeout")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", (error) => {
      clearTimeout(timer);
      reject(error);
    }, { once: true });
  });

  const challenge = await onceMessage(
    ws,
    (message) => message?.type === "event" && message?.event === "connect.challenge",
  );
  const nonce = challenge?.payload?.nonce;
  if (typeof nonce !== "string" || !nonce.trim()) {
    ws.close();
    throw new Error("Gateway connect challenge nonce missing");
  }

  const connectId = `connect-${Date.now()}`;
  const signedAtMs = Date.now();
  const devicePayload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    scopes: ["operator.admin"],
    signedAtMs,
    token,
    nonce,
    platform: "node",
  });
  const signature = base64UrlEncode(
    crypto.sign(null, Buffer.from(devicePayload, "utf8"), crypto.createPrivateKey(identity.privateKeyPem)),
  );

  ws.send(JSON.stringify({
    type: "req",
    id: connectId,
    method: "connect",
    params: {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: "node",
        mode: "backend",
      },
      caps: [],
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token },
      device: {
        id: identity.deviceId,
        publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    },
  }));

  const connectResponse = await onceMessage(
    ws,
    (message) => message?.type === "res" && message?.id === connectId,
  );
  if (!connectResponse?.ok) {
    ws.close();
    throw new Error(connectResponse?.error?.message || "Gateway connect failed");
  }

  return ws;
}

async function injectAutomationMessage(params) {
  const ws = await connectGateway();
  try {
    const requestId = `inject-${params.eventId || Date.now()}`;
    ws.send(JSON.stringify({
      type: "req",
      id: requestId,
      method: "chat.inject",
      params: {
        sessionKey: params.sessionKey,
        message: params.content,
        ...(params.label ? { label: params.label } : {}),
      },
    }));

    const response = await onceMessage(
      ws,
      (message) => message?.type === "res" && message?.id === requestId,
    );

    if (!response?.ok) {
      throw new Error(response?.error?.message || "chat.inject failed");
    }
    return response?.payload || { ok: true };
  } finally {
    ws.close();
  }
}

module.exports = {
  injectAutomationMessage,
};
