const ownedChildren = new Set();
let closing = false;

export function registerChild(child) {
  if (closing) {
    signalGroup(child, "SIGKILL");
    return child;
  }
  ownedChildren.add(child);
  const remove = () => ownedChildren.delete(child);
  child.once("close", remove);
  child.once("error", remove);
  return child;
}

export async function terminateChild(child, graceMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, "SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup(child, "SIGKILL");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(1_000)]);
  }
}

export async function shutdownChildren() {
  closing = true;
  const children = [...ownedChildren];
  await Promise.allSettled(children.map((child) => terminateChild(child)));
  ownedChildren.clear();
}

function signalGroup(child, signal) {
  let signaled = false;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      signaled = true;
    }
  } catch {}
  if (!signaled) {
    try { child.kill(signal); } catch {}
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
