import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const VERSION = "0.6.8";
const ARCHIVE_SHA256 = "ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46";
const BINARY_SHA256 = "a268d616826901e17717b1bc6368d8b2c063045a46fb99a0c0f657f102d977ca";
const ARTIFACT = "aderyn-x86_64-unknown-linux-gnu.tar.xz";
const URL = `https://github.com/cyfrin/aderyn/releases/download/aderyn-v${VERSION}/${ARTIFACT}`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsRoot = path.join(projectRoot, "work", "tools", "aderyn");
const destination = path.join(toolsRoot, VERSION);
const binary = path.join(destination, "aderyn");

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The pinned Aderyn installer currently supports x64 Linux/WSL only");
}

try {
  const installedBytes = await readFile(binary);
  const installedHash = createHash("sha256").update(installedBytes).digest("hex");
  const { stdout } = await execFileAsync(binary, ["--version"]);
  if (installedHash === BINARY_SHA256 && stdout.trim() === `aderyn ${VERSION}`) {
    console.log(`Aderyn ${VERSION} is already installed at ${binary}`);
    process.exit(0);
  }
} catch {
  // Continue with a verified reinstall into a fresh version directory.
}

await mkdir(toolsRoot, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(path.join(toolsRoot, ".install-"));
const archive = path.join(temporary, ARTIFACT);
const extracted = path.join(temporary, "extracted");

try {
  const response = await fetch(URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Aderyn download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== ARCHIVE_SHA256) throw new Error(`Aderyn archive checksum mismatch: expected ${ARCHIVE_SHA256}, received ${actual}`);
  await writeFile(archive, bytes, { mode: 0o600 });
  await mkdir(extracted, { mode: 0o700 });
  await execFileAsync("tar", ["xf", archive, "--strip-components", "1", "-C", extracted]);
  const extractedBinary = path.join(extracted, "aderyn");
  const extractedBytes = await readFile(extractedBinary);
  const extractedHash = createHash("sha256").update(extractedBytes).digest("hex");
  if (extractedHash !== BINARY_SHA256) throw new Error(`Aderyn binary checksum mismatch: expected ${BINARY_SHA256}, received ${extractedHash}`);
  await chmod(extractedBinary, 0o700);
  await rm(destination, { recursive: true, force: true });
  await rename(extracted, destination);
  const { stdout } = await execFileAsync(binary, ["--version"]);
  if (stdout.trim() !== `aderyn ${VERSION}`) throw new Error(`Unexpected installed version: ${stdout.trim()}`);
  console.log(`Installed checksum-verified Aderyn ${VERSION} at ${binary}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
