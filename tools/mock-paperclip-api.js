// A small in-memory stand-in for the subset of the Paperclip public API that
// the bridge uses. It is used by the local-run harness and the integration
// test. It is not a Paperclip implementation and makes no persistence
// guarantees.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createMockApi({ logger = null } = {}) {
  const issues = new Map();
  const comments = new Map();
  let issueCounter = 1000;
  const requests = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname });
    const send = (status, body) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload);
    };
    try {
      const companyIssueMatch = /^\/api\/companies\/([^/]+)\/issues$/.exec(url.pathname);
      if (companyIssueMatch && request.method === "POST") {
        const body = JSON.parse((await readBody(request)) || "{}");
        issueCounter += 1;
        const issue = {
          id: randomUUID(),
          identifier: `API-${issueCounter}`,
          title: body.title ?? "untitled",
          description: body.description ?? "",
          projectId: body.projectId ?? null,
          assigneeAgentId: body.assigneeAgentId ?? null,
          priority: body.priority ?? null,
          idempotencyKey: body.idempotencyKey ?? null,
        };
        issues.set(issue.id, issue);
        comments.set(issue.id, []);
        logger?.info?.(`mock api created issue ${issue.identifier}`);
        send(201, issue);
        return;
      }

      const commentMatch = /^\/api\/issues\/([^/]+)\/comments$/.exec(url.pathname);
      if (commentMatch) {
        const issue = findIssue(commentMatch[1]);
        if (!issue) {
          send(404, { error: "issue not found" });
          return;
        }
        if (request.method === "POST") {
          const body = JSON.parse((await readBody(request)) || "{}");
          const list = comments.get(issue.id) ?? [];
          const comment = {
            id: randomUUID(),
            issueId: issue.id,
            authorAgentId: null,
            clientRequestId: body.clientRequestId ?? null,
            body: body.body ?? "",
            createdAt: new Date().toISOString(),
          };
          list.push(comment);
          comments.set(issue.id, list);
          send(201, comment);
          return;
        }
        if (request.method === "GET") {
          const list = comments.get(issue.id) ?? [];
          const after = url.searchParams.get("after");
          let slice = list;
          if (after) {
            const index = list.findIndex((item) => item.id === after);
            slice = index === -1 ? list : list.slice(index);
          }
          send(200, slice);
          return;
        }
      }

      const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
      if (issueMatch && request.method === "GET") {
        const issue = findIssue(issueMatch[1]);
        if (!issue) {
          send(404, { error: "issue not found" });
          return;
        }
        send(200, issue);
        return;
      }

      send(404, { error: "not found" });
    } catch (error) {
      logger?.error?.(`mock api error: ${error.message}`);
      send(500, { error: error.message });
    }
  });

  function findIssue(ref) {
    if (issues.has(ref)) return issues.get(ref);
    for (const issue of issues.values()) {
      if (issue.identifier === ref) return issue;
    }
    return null;
  }

  return {
    issues,
    requests,
    addReply(issueRef, { body, authorAgentId = null }) {
      const issue = findIssue(issueRef);
      if (!issue) throw new Error(`no such issue: ${issueRef}`);
      const list = comments.get(issue.id) ?? [];
      const comment = {
        id: randomUUID(),
        issueId: issue.id,
        authorAgentId,
        clientRequestId: null,
        body,
        createdAt: new Date().toISOString(),
      };
      list.push(comment);
      comments.set(issue.id, list);
      return comment;
    },
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
