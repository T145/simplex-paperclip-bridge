// Paperclip public API client.
//
// Uses the global fetch implementation (Node 22+). Requests are retried with
// exponential backoff and jitter on network failures, timeouts, and retryable
// HTTP status codes (429 and 5xx). The bridge authenticates with a dedicated
// token and never posts as the assignee of the issues it writes to.

import { withRetry, isRetryableHttpStatus } from "./retry.js";
import { normalizeComment } from "./mapping.js";

export class HttpError extends Error {
  constructor(status, body, method, url) {
    super(`HTTP ${status} for ${method} ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export class PaperclipClient {
  constructor({
    baseUrl,
    token,
    companyId,
    logger = null,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 20000,
    retries = 4,
    retryBaseMs = 500,
    retryMaxMs = 30000,
    random = Math.random,
    sleep = undefined,
  } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.companyId = companyId;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retries = retries;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.random = random;
    this.sleep = sleep;
  }

  _headers() {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "simplex-paperclip-bridge",
    };
  }

  async _request(method, path, { body, query } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const target = url.toString();
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
          const response = await this.fetchImpl(target, {
            method,
            headers: this._headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            throw new HttpError(response.status, text, method, target);
          }
          return text ? JSON.parse(text) : null;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        retries: this.retries,
        baseMs: this.retryBaseMs,
        maxMs: this.retryMaxMs,
        random: this.random,
        sleep: this.sleep,
        isRetryable: (error) =>
          error instanceof HttpError ? isRetryableHttpStatus(error.status) : true,
        onRetry: ({ attempt, delay, error }) =>
          this.logger?.warn(
            `retrying ${method} ${target} after ${delay}ms (attempt ${attempt + 1}): ${error.message}`
          ),
      }
    );
  }

  async createIssue(payload) {
    return this._request("POST", `/api/companies/${this.companyId}/issues`, { body: payload });
  }

  async addComment(issueRef, { body, clientRequestId }) {
    const payload = { body };
    if (clientRequestId) payload.clientRequestId = clientRequestId;
    return this._request("POST", `/api/issues/${encodeURIComponent(issueRef)}/comments`, {
      body: payload,
    });
  }

  async listComments(issueRef, { after } = {}) {
    const raw = await this._request("GET", `/api/issues/${encodeURIComponent(issueRef)}/comments`, {
      query: { after, order: "asc" },
    });
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeComment).filter(Boolean);
  }

  async getIssue(issueRef) {
    return this._request("GET", `/api/issues/${encodeURIComponent(issueRef)}`);
  }
}
