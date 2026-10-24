import fs from "node:fs";

function logPath() {
  return process.env.SELECTIVE_SETUP_LOG;
}

export function setup(project) {
  const file = logPath();
  if (file) fs.appendFileSync(file, "setup\n");
  const out = process.env.SELECTIVE_CONFIG_OUT;
  if (out) {
    const { fileParallelism, maxWorkers, isolate } = project.globalConfig;
    fs.writeFileSync(out, JSON.stringify({ fileParallelism, maxWorkers, isolate }));
  }
  const signal = process.env.SELECTIVE_SIGNAL_LOG;
  if (signal) {
    process.on("SIGTERM", function setupTerm() {
      fs.appendFileSync(signal, "setup\n");
    });
  }
}

export function teardown() {
  const file = logPath();
  if (file) fs.appendFileSync(file, "teardown\n");
}
