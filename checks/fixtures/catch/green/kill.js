// Simplicity review finding 6, after.
export function stop(proc) {
  proc.child.kill("SIGKILL");
}
