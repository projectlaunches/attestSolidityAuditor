import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadStaticAssetSnapshot({ webRoot, sharedRoot, entries }) {
  const snapshot = new Map();
  for (const [pathname, [configuredName, contentType]] of Object.entries(entries)) {
    const shared = configuredName.startsWith("../shared/");
    const root = shared ? sharedRoot : webRoot;
    const fileName = shared ? path.basename(configuredName) : configuredName;
    snapshot.set(pathname, {
      body: await readFile(path.join(root, fileName), "utf8"),
      contentType,
    });
  }
  return snapshot;
}

export function staticSnapshotBuildId(snapshot) {
  const hash = createHash("sha256");
  for (const [pathname, asset] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(pathname);
    hash.update("\0");
    hash.update(asset.contentType);
    hash.update("\0");
    hash.update(asset.body);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
