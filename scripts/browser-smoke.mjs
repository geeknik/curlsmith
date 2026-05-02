import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = new URL("..", import.meta.url);
const DEFAULT_TIMEOUT_MS = 15_000;
const STARTUP_GRACE_MS = 2_000;

const children = new Set();

function repoPath(path) {
  return fileURLToPath(new URL(path, ROOT));
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(names) {
  const pathDirs = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findWebExt() {
  return (await firstExecutable([
    process.env.WEB_EXT_BINARY,
    repoPath("node_modules/.bin/web-ext"),
    "/opt/homebrew/bin/web-ext",
    "/usr/local/bin/web-ext"
  ])) || findOnPath(["web-ext", "web-ext.cmd"]);
}

async function findFirefox() {
  return (await firstExecutable([
    process.env.FIREFOX_BINARY,
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
  ])) || findOnPath(["firefox", "firefox-nightly", "firefoxdeveloperedition"]);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoPath(""),
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function waitForOutput(child, pattern, timeoutMs, label) {
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not become ready within ${timeoutMs} ms.`));
    }, timeoutMs);

    function onData(chunk) {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited before readiness. code=${code} signal=${signal}`));
    });
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const webExt = await findWebExt();
  const firefox = await findFirefox();
  const timeoutMs = Number.parseInt(process.env.CURLSMITH_SMOKE_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const headless = process.env.CURLSMITH_SMOKE_HEADLESS !== "0";

  if (!webExt) {
    throw new Error("web-ext was not found. Set WEB_EXT_BINARY or install web-ext locally.");
  }
  if (!firefox) {
    throw new Error("Firefox was not found. Set FIREFOX_BINARY to a Firefox executable.");
  }

  const port = await freePort();
  const profileDir = await mkdtemp(join(tmpdir(), "curlsmith-smoke-profile-"));
  const fixture = spawnChild(process.execPath, ["extension/test/integration/server.mjs"], {
    env: { ...process.env, CURLSMITH_FIXTURE_PORT: String(port) }
  });

  let runner;
  try {
    await waitForOutput(fixture, /Curlsmith fixture server listening/, 5_000, "fixture server");

    const args = [
      "run",
      "--source-dir",
      "extension",
      "--no-input",
      "--no-reload",
      "--firefox",
      firefox,
      "--firefox-profile",
      profileDir,
      "--start-url",
      `http://127.0.0.1:${port}/`
    ];

    if (headless) {
      args.push("--arg=-headless");
    }

    runner = spawnChild(webExt, args);
    await waitForOutput(runner, /Installed .* as a temporary add-on/, timeoutMs, "web-ext Firefox run");
    await new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_MS));

    if (runner.exitCode !== null) {
      throw new Error(`Firefox exited immediately after extension install. code=${runner.exitCode}`);
    }

    process.stdout.write("Browser smoke passed: Firefox launched the fixture page with Curlsmith installed.\n");
  } finally {
    await Promise.allSettled([terminate(runner), terminate(fixture)]);
    await rm(profileDir, { force: true, recursive: true });
  }
}

process.on("SIGINT", async () => {
  await Promise.allSettled(Array.from(children, terminate));
  process.exit(130);
});

main().catch(async (error) => {
  await Promise.allSettled(Array.from(children, terminate));
  process.stderr.write(`Browser smoke failed: ${error.message}\n`);
  process.exit(1);
});
