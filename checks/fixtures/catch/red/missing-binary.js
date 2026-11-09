// Simplicity review finding 5, before (session.js openStdio catch and the
// transport.js spawn catch at 00a71df). The catch body is abbreviated in the
// review as `{...}`; this keeps the missingTransport branch and the retry.
import { spawn } from "node:child_process";

export function connect(url, openStdio) {
  let failures = 0;
  while (failures < 10) {
    let link;
    try {
      link = openStdio(url);
    } catch (err) {
      if (err.missingTransport) {
        console.error(err.message);
      }
      failures += 1;
      continue;
    }
    return link;
  }
  return null;
}

export function spawnTransport(command, args, options) {
  try {
    return spawn(command, args, options);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EACCES") {
      err.missingTransport = true;
    }
    throw err;
  }
}
