// Configuration loading and validation. All configuration comes from
// environment variables; nothing is read from files in the repository.

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

function readString(env, key, { required = false, fallback = undefined } = {}) {
  const raw = env[key];
  const value = raw === undefined || raw === null ? "" : String(raw).trim();
  if (value === "") {
    if (required) return { error: `${key} is required` };
    return { value: fallback };
  }
  return { value };
}

function readInt(env, key, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { value: fallback };
  }
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value)) return { error: `${key} must be an integer` };
  if (value < min || value > max) {
    return { error: `${key} must be between ${min} and ${max}` };
  }
  return { value };
}

function readList(env, key, { required = false } = {}) {
  const raw = env[key];
  const items = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (required && items.length === 0) return { error: `${key} is required and must not be empty` };
  return { value: items };
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env = process.env) {
  const problems = [];
  const result = {};

  const assign = (key, parsed, { transform } = {}) => {
    if (parsed.error) {
      problems.push(parsed.error);
      return;
    }
    result[key] = transform ? transform(parsed.value) : parsed.value;
  };

  assign("simplexWsUrl", readString(env, "SIMPLEX_WS_URL", { fallback: "ws://127.0.0.1:5225" }));
  assign("paperclipApiUrl", readString(env, "PAPERCLIP_API_URL", { required: true }), {
    transform: stripTrailingSlash,
  });
  assign("paperclipApiToken", readString(env, "PAPERCLIP_API_TOKEN", { required: true }));
  assign("paperclipCompanyId", readString(env, "PAPERCLIP_COMPANY_ID", { required: true }));
  assign("paperclipProjectId", readString(env, "PAPERCLIP_PROJECT_ID", { required: true }));
  assign("bridgeAgentId", readString(env, "BRIDGE_AGENT_ID", { required: true }));
  assign("allowlist", readList(env, "SIMPLEX_ALLOWLIST", { required: true }));
  assign("pollIntervalMs", readInt(env, "BRIDGE_POLL_INTERVAL_MS", { fallback: 15000, min: 1000 }));
  assign("statePath", readString(env, "BRIDGE_STATE_PATH", { fallback: "./state/bridge-state.json" }));
  assign("logLevel", readString(env, "BRIDGE_LOG_LEVEL", { fallback: "info" }));
  assign(
    "issueReferencePrefix",
    readString(env, "BRIDGE_ISSUE_REFERENCE_PREFIX", { fallback: "#" })
  );
  assign(
    "defaultAssigneeAgentId",
    readString(env, "BRIDGE_DEFAULT_ASSIGNEE_AGENT_ID", { fallback: null })
  );
  assign("maxMessageBytes", readInt(env, "BRIDGE_MAX_MESSAGE_BYTES", { fallback: 8000, min: 1 }));
  assign(
    "commandTimeoutMs",
    readInt(env, "BRIDGE_COMMAND_TIMEOUT_MS", { fallback: 15000, min: 100 })
  );
  assign(
    "requestTimeoutMs",
    readInt(env, "BRIDGE_REQUEST_TIMEOUT_MS", { fallback: 20000, min: 100 })
  );
  assign("maxRetries", readInt(env, "BRIDGE_MAX_RETRIES", { fallback: 4, min: 0, max: 20 }));
  assign("retryBaseMs", readInt(env, "BRIDGE_RETRY_BASE_MS", { fallback: 500, min: 10 }));
  assign("retryMaxMs", readInt(env, "BRIDGE_RETRY_MAX_MS", { fallback: 30000, min: 100 }));
  assign("processedHistoryLimit", readInt(env, "BRIDGE_PROCESSED_HISTORY_LIMIT", { fallback: 2000, min: 100 }));

  const priority = readString(env, "BRIDGE_DEFAULT_PRIORITY", { fallback: null });
  if (priority.error) {
    problems.push(priority.error);
  } else if (priority.value !== null && !PRIORITIES.has(priority.value)) {
    problems.push(`BRIDGE_DEFAULT_PRIORITY must be one of: ${[...PRIORITIES].join(", ")}`);
  } else {
    result.defaultPriority = priority.value;
  }

  if (result.paperclipApiUrl && !/^https?:\/\//.test(result.paperclipApiUrl)) {
    problems.push("PAPERCLIP_API_URL must start with http:// or https://");
  }
  if (result.simplexWsUrl && !/^wss?:\/\//.test(result.simplexWsUrl)) {
    problems.push("SIMPLEX_WS_URL must start with ws:// or wss://");
  }
  if (result.retryBaseMs && result.retryMaxMs && result.retryBaseMs > result.retryMaxMs) {
    problems.push("BRIDGE_RETRY_BASE_MS must not exceed BRIDGE_RETRY_MAX_MS");
  }
  if (result.issueReferencePrefix !== undefined && result.issueReferencePrefix.length === 0) {
    problems.push("BRIDGE_ISSUE_REFERENCE_PREFIX must not be empty");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return result;
}
