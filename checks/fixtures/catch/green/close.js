// Simplicity review finding 3, after.
export function close(link) {
  link.child.stdin.end("exit\n");
  const timer = setTimeout(() => link.child.kill("SIGKILL"), 1000);
  timer.unref();
  link.child.once("exit", () => clearTimeout(timer));
}
