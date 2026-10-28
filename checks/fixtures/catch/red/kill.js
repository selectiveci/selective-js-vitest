// Simplicity review finding 6, before (tests/protocol.test.js and
// tests/vitest-e2e.test.js at 00a71df). `void 0` is the lint dodge for an
// empty catch around child.kill().
export function stop(proc) {
  try {
    proc.child.kill("SIGKILL");
  } catch {
    void 0;
  }
  try {
    proc.child.kill("SIGKILL");
  } catch {
    // ignored
  }
}
