import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const DATA_DIR = "/data";

function canUseDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) return false;
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const HAS_DATA_DIR = canUseDataDir();
const DEFAULT_STATE_DIR = HAS_DATA_DIR
  ? path.join(DATA_DIR, ".openclaw")
  : path.join(os.homedir(), ".openclaw");
const DEFAULT_WORKSPACE_DIR = HAS_DATA_DIR
  ? path.join(DATA_DIR, "workspace")
  : path.join(DEFAULT_STATE_DIR, "workspace");

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  DEFAULT_STATE_DIR;
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  DEFAULT_WORKSPACE_DIR;

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line);

  logRingBuffer.push(line);
  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"));
    }
  } catch {}
}

const log = {
  info: (category, message) => writeLog("INFO", category, message),
  warn: (category, message) => writeLog("WARN", category, message),
  error: (category, message) => writeLog("ERROR", category, message),
};

function isUnderDataDir(targetPath) {
  const resolved = path.resolve(targetPath);
  return resolved === DATA_DIR || resolved.startsWith(`${DATA_DIR}${path.sep}`);
}

function logPersistenceSummary() {
  const railway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
  const stateUnderData = isUnderDataDir(STATE_DIR);
  const workspaceUnderData = isUnderDataDir(WORKSPACE_DIR);

  log.info(
    "persistence",
    `dataDirAvailable=${HAS_DATA_DIR} stateDir=${STATE_DIR} workspaceDir=${WORKSPACE_DIR}`,
  );

  if (railway && (!stateUnderData || !workspaceUnderData)) {
    log.warn(
      "persistence",
      "Running on Railway without /data-backed OpenClaw paths. Set OPENCLAW_STATE_DIR=/data/.openclaw and OPENCLAW_WORKSPACE_DIR=/data/workspace to persist across redeploys.",
    );
  }
}

function getPersistenceStatus() {
  const railway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
  const stateUnderData = isUnderDataDir(STATE_DIR);
  const workspaceUnderData = isUnderDataDir(WORKSPACE_DIR);
  return {
    railway,
    dataDirAvailable: HAS_DATA_DIR,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
    stateUnderData,
    workspaceUnderData,
    expectedPersistentOnRailway:
      !railway || (HAS_DATA_DIR && stateUnderData && workspaceUnderData),
  };
}

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    log.warn("gateway-token", `could not read existing token: ${err.code || err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("gateway-token", `could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
logPersistenceSummary();

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseListEnv(value) {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => String(entry).trim())
          .filter(Boolean);
      }
    } catch {}
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeConfigKeySegment(value, fallback = "default") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

const AUTOCONFIG_ENABLED = parseBooleanEnv(
  process.env.OPENCLAW_BOOTSTRAP_AUTOCONFIG,
  Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID),
);
const AUTOCONFIG_TELEGRAM_DM_POLICY =
  process.env.OPENCLAW_BOOTSTRAP_TELEGRAM_DM_POLICY?.trim() || "pairing";
const AUTOCONFIG_TELEGRAM_GROUP_POLICY =
  process.env.OPENCLAW_BOOTSTRAP_TELEGRAM_GROUP_POLICY?.trim() || "allowlist";
const AUTOCONFIG_TELEGRAM_ALLOW_FROM =
  parseListEnv(process.env.OPENCLAW_BOOTSTRAP_TELEGRAM_ALLOW_FROM) ?? [];
const AUTOCONFIG_SANDBOX_MODE =
  process.env.OPENCLAW_BOOTSTRAP_SANDBOX_MODE?.trim() || "off";
const AUTOCONFIG_EXEC_POLICY_PRESET =
  process.env.OPENCLAW_BOOTSTRAP_EXEC_POLICY_PRESET?.trim() || "yolo";
const AUTOCONFIG_EXEC_HOST =
  process.env.OPENCLAW_BOOTSTRAP_EXEC_HOST?.trim() || "gateway";
const AUTOCONFIG_EXECUTION_CONTRACT =
  process.env.OPENCLAW_BOOTSTRAP_EXECUTION_CONTRACT?.trim() || "strict-agentic";
const AUTOCONFIG_VERBOSE_DEFAULT =
  process.env.OPENCLAW_BOOTSTRAP_VERBOSE_DEFAULT?.trim() || "off";
const AUTOCONFIG_TOOL_PROGRESS_DETAIL =
  process.env.OPENCLAW_BOOTSTRAP_TOOL_PROGRESS_DETAIL?.trim() || "raw";
const AUTOCONFIG_MCP_SCRAPER_ENABLED = parseBooleanEnv(
  process.env.OPENCLAW_BOOTSTRAP_MCP_SCRAPER_ENABLED,
  false,
);
const AUTOCONFIG_MCP_SCRAPER_NAME = normalizeConfigKeySegment(
  process.env.OPENCLAW_BOOTSTRAP_MCP_SCRAPER_NAME?.trim() || "scraper",
  "scraper",
);
const AUTOCONFIG_MCP_SCRAPER_COMMAND =
  process.env.OPENCLAW_BOOTSTRAP_MCP_SCRAPER_COMMAND?.trim() || "npx";
const AUTOCONFIG_MCP_SCRAPER_ARGS =
  parseListEnv(process.env.OPENCLAW_BOOTSTRAP_MCP_SCRAPER_ARGS) ?? [
    "-y",
    "mcp-server-scraper",
  ];
const AUTOCONFIG_OWNER_ALLOW_FROM =
  parseListEnv(process.env.OPENCLAW_BOOTSTRAP_OWNER_ALLOW_FROM) ??
  parseListEnv(process.env.OPENCLAW_OWNER_ALLOW_FROM);

async function configSetJson(pathExpr, value) {
  return runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      pathExpr,
      JSON.stringify(value),
    ]),
  );
}

async function configPathExists(pathExpr) {
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "get", pathExpr]),
  );
  return result.code === 0;
}

async function configureTelegramViaChannelsAdd(token) {
  const add = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "channels",
      "add",
      "--channel",
      "telegram",
      "--account",
      "default",
      "--token",
      token,
    ]),
  );
  return add;
}

async function applyManagedDefaults(reason = "boot") {
  const report = [];

  if (!AUTOCONFIG_ENABLED) {
    report.push(`[managed-defaults] disabled (reason=${reason})`);
    return report.join("\n");
  }
  if (!isConfigured()) {
    report.push(`[managed-defaults] skipped: openclaw not configured (reason=${reason})`);
    return report.join("\n");
  }

  report.push(`[managed-defaults] applying (reason=${reason})`);

  const sandboxResult = await configSetJson(
    "agents.defaults.sandbox.mode",
    AUTOCONFIG_SANDBOX_MODE,
  );
  report.push(
    `[managed-defaults] agents.defaults.sandbox.mode=${AUTOCONFIG_SANDBOX_MODE} exit=${sandboxResult.code}`,
  );

  const executionContractResult = await configSetJson(
    "agents.defaults.embeddedPi.executionContract",
    AUTOCONFIG_EXECUTION_CONTRACT,
  );
  report.push(
    `[managed-defaults] agents.defaults.embeddedPi.executionContract=${AUTOCONFIG_EXECUTION_CONTRACT} exit=${executionContractResult.code}`,
  );

  const verboseResult = await configSetJson(
    "agents.defaults.verboseDefault",
    AUTOCONFIG_VERBOSE_DEFAULT,
  );
  report.push(
    `[managed-defaults] agents.defaults.verboseDefault=${AUTOCONFIG_VERBOSE_DEFAULT} exit=${verboseResult.code}`,
  );

  const toolProgressResult = await configSetJson(
    "agents.defaults.toolProgressDetail",
    AUTOCONFIG_TOOL_PROGRESS_DETAIL,
  );
  report.push(
    `[managed-defaults] agents.defaults.toolProgressDetail=${AUTOCONFIG_TOOL_PROGRESS_DETAIL} exit=${toolProgressResult.code}`,
  );

  if (AUTOCONFIG_MCP_SCRAPER_ENABLED) {
    const mcpServerPath = `mcp.servers.${AUTOCONFIG_MCP_SCRAPER_NAME}`;
    const mcpServerConfig = {
      command: AUTOCONFIG_MCP_SCRAPER_COMMAND,
      args: AUTOCONFIG_MCP_SCRAPER_ARGS,
    };
    const mcpServerResult = await configSetJson(mcpServerPath, mcpServerConfig);
    report.push(
      `[managed-defaults] ${mcpServerPath}=${JSON.stringify(mcpServerConfig)} exit=${mcpServerResult.code}`,
    );
  } else {
    report.push("[managed-defaults] mcp scraper bootstrap disabled");
  }

  const presetResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["exec-policy", "preset", AUTOCONFIG_EXEC_POLICY_PRESET]),
  );
  report.push(
    `[managed-defaults] exec-policy preset ${AUTOCONFIG_EXEC_POLICY_PRESET} exit=${presetResult.code}`,
  );

  const execSetResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "exec-policy",
      "set",
      "--host",
      AUTOCONFIG_EXEC_HOST,
      "--security",
      "full",
      "--ask",
      "off",
      "--ask-fallback",
      "full",
    ]),
  );
  report.push(
    `[managed-defaults] exec-policy set host=${AUTOCONFIG_EXEC_HOST} security=full ask=off exit=${execSetResult.code}`,
  );

  if (await configPathExists("channels.telegram")) {
    const dmResult = await configSetJson(
      "channels.telegram.dmPolicy",
      AUTOCONFIG_TELEGRAM_DM_POLICY,
    );
    report.push(
      `[managed-defaults] channels.telegram.dmPolicy=${AUTOCONFIG_TELEGRAM_DM_POLICY} exit=${dmResult.code}`,
    );

    const groupResult = await configSetJson(
      "channels.telegram.groupPolicy",
      AUTOCONFIG_TELEGRAM_GROUP_POLICY,
    );
    report.push(
      `[managed-defaults] channels.telegram.groupPolicy=${AUTOCONFIG_TELEGRAM_GROUP_POLICY} exit=${groupResult.code}`,
    );

    const allowFromResult = await configSetJson(
      "channels.telegram.allowFrom",
      AUTOCONFIG_TELEGRAM_ALLOW_FROM,
    );
    report.push(
      `[managed-defaults] channels.telegram.allowFrom=${JSON.stringify(AUTOCONFIG_TELEGRAM_ALLOW_FROM)} exit=${allowFromResult.code}`,
    );
  } else {
    report.push("[managed-defaults] channels.telegram not configured; skipping telegram policy defaults");
  }

  if (AUTOCONFIG_OWNER_ALLOW_FROM) {
    const ownerResult = await configSetJson(
      "commands.ownerAllowFrom",
      AUTOCONFIG_OWNER_ALLOW_FROM,
    );
    report.push(
      `[managed-defaults] commands.ownerAllowFrom=${JSON.stringify(AUTOCONFIG_OWNER_ALLOW_FROM)} exit=${ownerResult.code}`,
    );
  } else {
    report.push("[managed-defaults] owner allowlist env not set; leaving commands.ownerAllowFrom unchanged");
  }

  return report.join("\n");
}

async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    log.info("gateway", `set allowedOrigins to [${origin}]`);
  } else {
    log.warn("gateway", `failed to set allowedOrigins (exit=${result.code})`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          log.info("gateway", `ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            log.warn("gateway", `health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  log.error("gateway", `failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("gateway", `stop existing gateway exit=${stopResult.code}`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  log.info("gateway", `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);
  log.info("gateway", `STATE_DIR: ${STATE_DIR}`);
  log.info("gateway", `WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  log.info("gateway", `config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    log.error("gateway", `spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    log.error("gateway", `exited code=${code} signal=${signal}`);
    gatewayProc = null;
    if (!shuttingDown && isConfigured()) {
      log.info("gateway", "scheduling auto-restart in 2s...");
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            log.error("gateway", `auto-restart failed: ${err.message}`);
          });
        }
      }, 2000);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gateway", `kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "API key",
      options: [
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "microsoft-foundry",
      label: "Microsoft Foundry",
      hint: "Azure OpenAI API key + endpoint",
      options: [
        {
          value: "microsoft-foundry-apikey",
          label: "Microsoft Foundry (API key)",
          hint: "Use Azure OpenAI API key and Foundry endpoint URL",
        },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "API key",
      options: [
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "API key",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    "quickstart",
  ];

  if (payload.authChoice) {
    const onboardAuthChoice =
      payload.authChoice === "microsoft-foundry-apikey"
        ? "skip"
        : payload.authChoice;
    args.push("--auth-choice", onboardAuthChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[onboardAuthChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

  }

  return args;
}

function normalizeFoundryEndpoint(endpoint) {
  const trimmed = (endpoint || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    const normalizedPath = parsed.pathname
      .replace(/\/openai(?:$|\/).*/i, "")
      .replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
  } catch {
    const withoutQuery = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return withoutQuery.replace(/\/openai(?:$|\/).*/i, "");
  }
}

function resolveFoundryModelId(modelValue) {
  const trimmed = (modelValue || "").trim();
  if (!trimmed) return "gpt-4o";
  if (trimmed.startsWith("microsoft-foundry/")) {
    return trimmed.slice("microsoft-foundry/".length).trim();
  }
  return trimmed;
}

function supportsFoundryImageInput(modelName) {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "computer-use-preview"
  );
}

function requiresFoundryMaxCompletionTokens(modelName) {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

function buildFoundryProviderConfig(payload) {
  const endpoint = normalizeFoundryEndpoint(payload.foundryEndpoint);
  const modelId = resolveFoundryModelId(payload.model);
  const api =
    payload.foundryApiMode === "openai-completions"
      ? "openai-completions"
      : "openai-responses";
  const apiKey = payload.authSecret.trim();
  const maxTokensField = requiresFoundryMaxCompletionTokens(modelId)
    ? "max_completion_tokens"
    : "max_tokens";

  const modelConfig = {
    id: modelId,
    name: modelId,
    api,
    reasoning: false,
    input: supportsFoundryImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };

  if (api === "openai-responses") {
    modelConfig.compat = {
      supportsStore: false,
      maxTokensField,
    };
  } else if (maxTokensField === "max_completion_tokens") {
    modelConfig.compat = { maxTokensField };
  }

  return {
    modelId,
    providerConfig: {
      baseUrl: `${endpoint}/openai/v1`,
      api,
      authHeader: false,
      apiKey,
      headers: { "api-key": apiKey },
      models: [modelConfig],
    },
  };
}

async function configureMicrosoftFoundry(payload) {
  const { modelId, providerConfig } = buildFoundryProviderConfig(payload);
  const modelName = `microsoft-foundry/${modelId}`;

  const setProvider = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "models.providers.microsoft-foundry",
      JSON.stringify(providerConfig),
    ]),
  );

  const enablePlugin = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "plugins.entries.microsoft-foundry.enabled", "true"]),
  );

  const setModel = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["models", "set", modelName]),
  );

  if (setProvider.code !== 0 || enablePlugin.code !== 0 || setModel.code !== 0) {
    throw new Error(
      "Microsoft Foundry configuration failed. Check setup logs for details.",
    );
  }

  return (
    `[config] models.providers.microsoft-foundry exit=${setProvider.code}\n${setProvider.output || ""}` +
    `\n[config] plugins.entries.microsoft-foundry.enabled=true exit=${enablePlugin.code}\n${enablePlugin.output || ""}` +
    `\n[models set] ${modelName} exit=${setModel.code}\n${setModel.output || ""}`
  );
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const extraEnv = opts.env || {};
    const spawnOpts = { ...opts };
    delete spawnOpts.env;

    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: {
        ...process.env,
        ...extraEnv,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

const VALID_AUTH_CHOICES = [
  "openai-api-key",
  "microsoft-foundry-apikey",
  "apiKey",
  "gemini-api-key",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "foundryEndpoint",
    "foundryApiMode",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  if (
    payload.authChoice === "microsoft-foundry-apikey" &&
    !payload.foundryEndpoint?.trim()
  ) {
    return "Missing foundryEndpoint for microsoft-foundry-apikey";
  }
  if (
    payload.authChoice === "microsoft-foundry-apikey" &&
    !payload.authSecret?.trim()
  ) {
    return "Missing authSecret for microsoft-foundry-apikey";
  }
  if (payload.foundryEndpoint?.trim() && !URL.canParse(payload.foundryEndpoint.trim())) {
    return "Invalid foundryEndpoint: must be a valid URL";
  }
  if (
    payload.foundryApiMode &&
    payload.foundryApiMode !== "openai-responses" &&
    payload.foundryApiMode !== "openai-completions"
  ) {
    return "Invalid foundryApiMode: must be openai-responses or openai-completions";
  }
  if (payload.authChoice === "microsoft-foundry-apikey" && payload.model?.trim()) {
    const model = payload.model.trim();
    if (model.includes("/") && !model.startsWith("microsoft-foundry/")) {
      return "Invalid model: for Microsoft Foundry use deployment name or microsoft-foundry/<deployment>";
    }
    if (model.startsWith("microsoft-foundry/") && !resolveFoundryModelId(model)) {
      return "Invalid model: missing deployment name after microsoft-foundry/";
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      if (payload.authChoice === "microsoft-foundry-apikey") {
        extra += "\n[setup] Configuring Microsoft Foundry provider...\n";
        extra += `${await configureMicrosoftFoundry(payload)}\n`;
      } else if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        const addTelegram = await configureTelegramViaChannelsAdd(
          payload.telegramToken.trim(),
        );
        extra += `\n[telegram add] exit=${addTelegram.code}\n${addTelegram.output || ""}`;
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "open",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Applying managed defaults...\n";
      extra += `${await applyManagedDefaults("setup")}\n`;

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    log.error("setup", `run error: ${String(err)}`);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  const persistence = getPersistenceStatus();
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      persistence,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      managedDefaults: {
        enabled: AUTOCONFIG_ENABLED,
        telegram: {
          dmPolicy: AUTOCONFIG_TELEGRAM_DM_POLICY,
          groupPolicy: AUTOCONFIG_TELEGRAM_GROUP_POLICY,
          allowFrom: AUTOCONFIG_TELEGRAM_ALLOW_FROM,
        },
        sandboxMode: AUTOCONFIG_SANDBOX_MODE,
        execPolicyPreset: AUTOCONFIG_EXEC_POLICY_PRESET,
        execHost: AUTOCONFIG_EXEC_HOST,
        ownerAllowFrom: AUTOCONFIG_OWNER_ALLOW_FROM ?? null,
      },
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const args = ["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  log.info("devices", `list exit=${result.code} output=${result.output}`);
  try {
    const jsonMatch = result.output.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!jsonMatch) {
      log.warn("devices", "no JSON found in output");
      return res.json({ ok: result.code === 0, raw: result.output });
    }
    const data = JSON.parse(jsonMatch[1]);
    log.info("devices", `parsed keys=${Object.keys(data)} pending=${JSON.stringify(data.pending)} paired=${JSON.stringify(data.paired)}`);
    return res.json({ ok: true, data, raw: result.output });
  } catch (parseErr) {
    log.warn("devices", `JSON parse failed: ${parseErr.message}`);
    return res.json({ ok: result.code === 0, raw: result.output });
  }
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];
  if (requestId) {
    args.push(String(requestId));
  } else {
    args.push("--latest");
  }
  args.push("--token", OPENCLAW_GATEWAY_TOKEN);
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/devices/reject", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }
  const args = [
    "devices", "reject", String(requestId),
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.get("/setup/api/export", requireSetupAuth, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipName = `openclaw-export-${timestamp}.zip`;
  const tmpZip = path.join(os.tmpdir(), zipName);

  try {
    const dirsToExport = [];
    if (fs.existsSync(STATE_DIR)) dirsToExport.push(STATE_DIR);
    if (fs.existsSync(WORKSPACE_DIR)) dirsToExport.push(WORKSPACE_DIR);

    if (dirsToExport.length === 0) {
      return res.status(404).json({ ok: false, error: "No data directories found to export." });
    }

    const zipArgs = ["-r", "-P", SETUP_PASSWORD, tmpZip, ...dirsToExport];
    const result = await runCmd("zip", zipArgs);

    if (result.code !== 0 || !fs.existsSync(tmpZip)) {
      return res.status(500).json({ ok: false, error: "Failed to create export archive.", output: result.output });
    }

    const stat = fs.statSync(tmpZip);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(stat.size),
    });

    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    });
    stream.on("error", (err) => {
      log.error("export", `stream error: ${err.message}`);
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Stream error during export." });
      }
    });
  } catch (err) {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    log.error("export", `error: ${err.message}`);
    return res.status(500).json({ ok: false, error: `Export failed: ${err.message}` });
  }
});

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/logs", requireSetupAuth, async (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const limit = Math.min(Number.parseInt(_req.query.lines ?? "500", 10), 5000);
    return res.json({ ok: true, lines: lines.slice(-limit) });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.json({ ok: true, lines: [] });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of logRingBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    log.info("tui", `session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      log.info("tui", `spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        log.info("tui", "max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info("tui", `PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        log.warn("tui", `invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log.info("tui", "session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      log.error("tui", `WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  log.error("proxy", String(err));
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  if (!req.url?.startsWith("/hooks/")) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  log.info("wrapper", `listening on port ${PORT}`);
  log.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  log.info("wrapper", `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  log.info("wrapper", `configured: ${isConfigured()}`);

  if (isConfigured()) {
    (async () => {
      try {
        log.info("wrapper", "running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        log.info("wrapper", `doctor --fix exit=${dr.code}`);
        if (dr.output) log.info("wrapper", dr.output);
      } catch (err) {
        log.warn("wrapper", `doctor --fix failed: ${err.message}`);
      }
      try {
        const managedDefaults = await applyManagedDefaults("boot");
        if (managedDefaults) log.info("wrapper", managedDefaults);
      } catch (err) {
        log.warn("wrapper", `managed defaults failed: ${err.message}`);
      }
      await ensureGatewayRunning();
    })().catch((err) => {
      log.error("wrapper", `failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    log.warn("websocket", `gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  log.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
