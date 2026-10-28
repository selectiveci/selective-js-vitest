// Simplicity review finding 3, before (transport.js close at 00a71df).
export function close(link) {
  try {
    link.child.stdin.write("exit\n");
    link.child.stdin.end();
  } catch {
    link.broken = true;
  }
  const timer = setTimeout(() => {
    if (link.child.exitCode == null && link.child.signalCode == null) {
      try {
        link.child.kill("SIGKILL");
      } catch {
        link.broken = true;
      }
    }
  }, 1000);
  timer.unref?.();
}
