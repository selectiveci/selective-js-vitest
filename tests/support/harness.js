import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

export const repoRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

export function transportBin() {
  if (process.env.SELECTIVE_TRANSPORT && existsSync(process.env.SELECTIVE_TRANSPORT)) {
    return process.env.SELECTIVE_TRANSPORT;
  }
  const candidate = "/tmp/selective-transport/bin/transport";
  if (existsSync(candidate)) return candidate;
  throw new Error("SELECTIVE_TRANSPORT is not set and the pinned binary is missing");
}

export function selectiveEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    SELECTIVE_TRANSPORT: transportBin(),
    SELECTIVE_API_KEY: "conformance-key",
    SELECTIVE_PLATFORM: "github_actions",
    SELECTIVE_RUN_ID: "run-1",
    SELECTIVE_RUN_ATTEMPT: "1",
    SELECTIVE_RUNNER_ID: "runner-1",
    SELECTIVE_BRANCH: "main",
    SELECTIVE_SHA: "abc123",
    SELECTIVE_GIT_REPO: "selectiveci/selective-js-vitest",
    SELECTIVE_GIT_PROVIDER: "github",
    ...extra,
  };
}

export function spawnNode(script, args, env, cwd = repoRoot) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    stdout() {
      return Buffer.concat(stdout).toString();
    },
    stderr() {
      return Buffer.concat(stderr).toString();
    },
    exit(timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`client timed out\n${Buffer.concat(stderr).toString()}\n${Buffer.concat(stdout).toString()}`));
        }, timeoutMs);
        exited.then((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

export function startMock() {
  const messages = [];
  const waiters = [];
  const connections = [];
  const fragments = [];
  let rejectBudget = 0;
  let uploadStatus = 200;
  let current = null;
  let pingCount = 0;

  function push(value) {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        fragments.push({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
          at: Date.now(),
        });
        res.writeHead(uploadStatus, { "content-length": "0" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (rejectBudget > 0) {
      rejectBudget -= 1;
      connections.push({ rejected: true, url: req.url });
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { rejected: false, url: req.url, ws };
      connections.push(conn);
      current = conn;
      ws.on("ping", () => {
        pingCount += 1;
      });
      ws.on("message", (data) => {
        const text = data.toString();
        if (text.trim() === "exit") {
          push("exit");
          return;
        }
        try {
          push(Object.defineProperty(JSON.parse(text), "raw", { value: text }));
        } catch {
          push(text);
        }
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `ws://127.0.0.1:${port}`,
        connections,
        fragments,
        reject(times) {
          rejectBudget = times;
        },
        failUploads(status) {
          uploadStatus = status;
        },
        sendRaw(text) {
          current.ws.send(text);
        },
        send(value) {
          if (!current?.ws || current.ws.readyState !== current.ws.OPEN) {
            throw new Error("no open websocket");
          }
          current.ws.send(JSON.stringify(value));
        },
        drop() {
          current?.ws?.close();
        },
        pings() {
          return pingCount;
        },
        pending() {
          return messages.length;
        },
        drain() {
          return messages.splice(0, messages.length);
        },
        next(timeoutMs = 8000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => {
              const index = waiters.indexOf(onMessage);
              if (index >= 0) waiters.splice(index, 1);
              rejectNext(new Error("timed out waiting for a client frame"));
            }, timeoutMs);
            function onMessage(value) {
              clearTimeout(timer);
              resolveNext(value);
            }
            waiters.push(onMessage);
          });
        },
        async until(predicate, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (predicate()) return;
            await new Promise((wait) => setTimeout(wait, 20));
          }
          throw new Error(`timed out waiting for mock condition (${connections.length} connections)`);
        },
        async close() {
          for (const conn of connections) conn.ws?.terminate?.();
          wss.close();
          await new Promise((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}

export function websocketQuery(url) {
  return new URL(url, "ws://127.0.0.1").searchParams;
}
