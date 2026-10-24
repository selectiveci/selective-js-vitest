import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);

const INTEGER_IN_FLOAT_FIELD = /(?<=[{,])("(?:run_time|seconds_in_\w+)":\d+)(?=[,}])/g;

export function encodeFrame(value) {
  return `${JSON.stringify(value).replace(INTEGER_IN_FLOAT_FIELD, "$1.0")}\n`;
}

export function transportPackage(platform = process.platform, arch = process.arch) {
  return `@selectiveci/transport-${platform}-${arch}`;
}

export function transportPath() {
  if (process.env.SELECTIVE_TRANSPORT) return process.env.SELECTIVE_TRANSPORT;
  try {
    return require.resolve(`${transportPackage()}/bin/transport`);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    throw Object.assign(new Error(missingTransportMessage()), { missingTransport: true });
  }
}

export function missingTransportMessage() {
  return `selective could not start the transport for ${process.platform}-${process.arch}. Install ${transportPackage()}, or set SELECTIVE_TRANSPORT to a transport binary.`;
}

export function stdioLaunch(url) {
  return {
    command: transportPath(),
    args: ["--stdio"],
    env: { ...process.env, SELECTIVE_TRANSPORT_URL: url },
  };
}

export function openStdio(url) {
  const launch = stdioLaunch(url);
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new StdioLink(child);
}

class StdioLink {
  constructor(child) {
    this.child = child;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ended = false;
    child.stdin.on("error", () => {
      this.broken = true;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.push(line));
    const finish = () => this.push(null);
    lines.on("close", finish);
    child.on("error", () => {
      this.broken = true;
      finish();
    });
    child.on("exit", () => {
      if (this.ended) return;
      const timer = setTimeout(finish, 2000);
      timer.unref();
      lines.once("close", () => clearTimeout(timer));
    });
  }

  push(item) {
    if (item === null) {
      if (this.ended) return;
      this.ended = true;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.queue.push(item);
  }

  recv() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(value, unsent = () => {}) {
    if (this.closed || this.broken || this.child.stdin.destroyed) return false;
    this.child.stdin.write(encodeFrame(value), (err) => {
      if (err) unsent();
    });
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end("exit\n");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }
}
