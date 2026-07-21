export function canonicalLoopbackOrigin(host, port) {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${urlHost}:${port}`).origin;
}

export function originMatches(origin, host, port) {
  try {
    return new URL(origin).origin === canonicalLoopbackOrigin(host, port);
  } catch {
    return false;
  }
}

export function sessionRefreshAllowed(headers = {}) {
  if (headers["x-attest-session-refresh"] !== "1") return false;
  const fetchSite = String(headers["sec-fetch-site"] || "");
  return !fetchSite || fetchSite === "same-origin";
}
