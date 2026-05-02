import http from "node:http";
import { Buffer } from "node:buffer";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.CURLSMITH_FIXTURE_PORT || "8787", 10);

const TEST_COOKIE = "curlsmith_session=fake-session-token-for-redaction-tests";
const TEST_CSRF = "fake-csrf-token-for-redaction-tests";

function jsonResponse(res, statusCode, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(encoded.byteLength),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(encoded);
}

function textResponse(res, statusCode, body, headers = {}) {
  const encoded = Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(encoded.byteLength),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(encoded);
}

async function readBoundedRequest(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Curlsmith Fixture</title>
    <style>
      :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
      body { margin: 0; color: CanvasText; background: Canvas; }
      main { display: grid; gap: 16px; max-width: 860px; margin: 0 auto; padding: 24px; }
      h1 { margin: 0; font-size: 22px; }
      button { width: fit-content; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 6px; padding: 8px 12px; color: CanvasText; background: color-mix(in srgb, Canvas 90%, CanvasText 10%); font: inherit; cursor: pointer; }
      pre { min-height: 180px; margin: 0; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 6px; padding: 12px; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Curlsmith Fixture</h1>
      <p>This page sends same-origin API requests with fake secrets so Curlsmith can verify capture and redaction locally.</p>
      <button id="run" type="button">Run API Fixtures</button>
      <pre id="output" aria-live="polite">Idle</pre>
    </main>
    <script type="module">
      const output = document.querySelector("#output");
      const button = document.querySelector("#run");
      const fakeHeaders = {
        "Accept": "application/json",
        "Authorization": "Bearer fake-authorization-token-for-redaction-tests",
        "X-CSRF-Token": "${TEST_CSRF}",
        "X-App-Trace": "curlsmith-fixture"
      };

      function write(line) {
        output.textContent += "\\n" + line;
      }

      async function run() {
        output.textContent = "Running";
        const requests = [
          fetch("/api/users?access_token=fake-query-token-for-redaction-tests&limit=2", { headers: fakeHeaders }),
          fetch("/api/posts", {
            method: "POST",
            headers: { ...fakeHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Fixture post",
              body: "hello from curlsmith",
              access_token: "fake-body-token-for-redaction-tests"
            })
          }),
          fetch("/graphql", {
            method: "POST",
            headers: { ...fakeHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              operationName: "FixtureQuery",
              variables: { limit: 2, api_key: "fake-graphql-key-for-redaction-tests" },
              query: "query FixtureQuery { posts { id title } }"
            })
          }),
          fetch("/api/ndjson", { headers: fakeHeaders }),
          fetch("/api/large", { headers: fakeHeaders }),
          fetch("/api/binary", { headers: fakeHeaders }),
          fetch("/api/redirect", { headers: fakeHeaders })
        ];

        const responses = await Promise.all(requests);
        for (const response of responses) {
          write(response.status + " " + new URL(response.url).pathname);
        }
        write("Done");
      }

      button.addEventListener("click", () => {
        run().catch((error) => {
          output.textContent = "Fixture failed: " + error.message;
        });
      });
    </script>
  </body>
</html>`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/") {
    textResponse(res, 200, pageHtml(), {
      "Set-Cookie": `${TEST_COOKIE}; SameSite=Lax; Path=/`
    });
    return;
  }

  if (url.pathname === "/api/users") {
    jsonResponse(res, 200, {
      users: [
        {
          id: "u1",
          username: "alice",
          displayName: "Alice Example",
          bio: "fixture user",
          created_at: "2026-05-02T12:00:00Z"
        },
        {
          id: "u2",
          username: "bob",
          displayName: "Bob Example",
          bio: "fixture user",
          created_at: "2026-05-02T12:05:00Z"
        }
      ]
    }, {
      "X-CSRF-Token": TEST_CSRF
    });
    return;
  }

  if (url.pathname === "/api/posts" && req.method === "POST") {
    let body = "";
    try {
      body = await readBoundedRequest(req);
    } catch {
      jsonResponse(res, 413, { error: "request too large" });
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: "malformed json" });
      return;
    }

    jsonResponse(res, 201, {
      post: {
        id: "p1",
        title: parsed.title || "Untitled",
        body: parsed.body || "",
        author: "alice",
        created_at: "2026-05-02T12:10:00Z"
      }
    });
    return;
  }

  if (url.pathname === "/graphql" && req.method === "POST") {
    await readBoundedRequest(req).catch(() => "");
    jsonResponse(res, 200, {
      data: {
        posts: [
          {
            id: "gql-p1",
            title: "GraphQL fixture",
            body: "captured response",
            author: "alice",
            created_at: "2026-05-02T12:15:00Z"
          }
        ]
      }
    });
    return;
  }

  if (url.pathname === "/api/ndjson") {
    const body = [
      JSON.stringify({ id: "m1", message: "hello", sender: "alice", timestamp: "2026-05-02T12:20:00Z" }),
      JSON.stringify({ id: "m2", message: "world", sender: "bob", timestamp: "2026-05-02T12:21:00Z" })
    ].join("\n") + "\n";
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "Cache-Control": "no-store"
    });
    res.end(body);
    return;
  }

  if (url.pathname === "/api/large") {
    const items = Array.from({ length: 70000 }, (_, index) => ({
      id: `large-${index}`,
      title: `Large fixture ${index}`,
      body: "x".repeat(12)
    }));
    jsonResponse(res, 200, { items });
    return;
  }

  if (url.pathname === "/api/binary") {
    const bytes = Buffer.alloc(256);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store"
    });
    res.end(bytes);
    return;
  }

  if (url.pathname === "/api/redirect") {
    res.writeHead(302, {
      "Location": "/api/users?from=redirect",
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }

  jsonResponse(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: "internal error" });
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Curlsmith fixture server listening at http://${HOST}:${PORT}/\n`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
