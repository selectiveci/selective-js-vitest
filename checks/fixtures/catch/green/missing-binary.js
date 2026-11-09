// Simplicity review finding 5, after.
import { spawn } from "node:child_process";

export function connect(url, openStdio) {
  const link = openStdio(url);
  return link;
}

export function spawnTransport(command, args, options) {
  return spawn(command, args, options);
}
