const STORAGE_KEY = "attest.localSession";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export function resolveLocalSessionToken(browser = globalThis) {
  const hash = String(browser.location?.hash || "").replace(/^#/, "");
  const supplied = new URLSearchParams(hash).get("attest-session") || "";
  if (TOKEN_PATTERN.test(supplied)) {
    browser.sessionStorage?.setItem(STORAGE_KEY, supplied);
    browser.history?.replaceState?.(null, "", `${browser.location.pathname || "/"}${browser.location.search || ""}`);
    return supplied;
  }
  const retained = browser.sessionStorage?.getItem(STORAGE_KEY) || "";
  return TOKEN_PATTERN.test(retained) ? retained : "";
}

export function createApiClient(initialToken, fetchImpl = fetch, browser = globalThis) {
  let token = TOKEN_PATTERN.test(String(initialToken || "")) ? String(initialToken) : "";
  let refreshPromise = null;

  return async function api(path, options = {}) {
    if (!token) await adoptCurrentSession();
    const { responseType = "json", ...fetchOptions } = options;
    return await request(path, fetchOptions, responseType, true);
  };

  async function adoptCurrentSession() {
    refreshPromise ||= refreshSessionToken(fetchImpl).finally(() => { refreshPromise = null; });
    token = await refreshPromise;
    browser.sessionStorage?.setItem(STORAGE_KEY, token);
  }

  async function request(path, fetchOptions, responseType, allowSessionRefresh) {
    const headers = { ...(fetchOptions.headers || {}), "x-soltesting-token": token };
    if (fetchOptions.body) headers["content-type"] = "application/json";
    const response = await fetchImpl(path, { ...fetchOptions, headers });
    if (response.status === 403) {
      const payload = await response.json().catch(() => ({}));
      if (allowSessionRefresh && /local session token/i.test(String(payload.error || ""))) {
        await adoptCurrentSession();
        return await request(path, fetchOptions, responseType, false);
      }
      throw new Error(apiErrorMessage(response.status, payload.error));
    }
    if (responseType === "blob") {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(apiErrorMessage(response.status, payload.error));
      }
      return await response.blob();
    }
    if (responseType === "text") {
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Request failed (${response.status})`);
      return text;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(response.status, payload.error));
    return payload;
  }
}

async function refreshSessionToken(fetchImpl) {
  const response = await fetchImpl("/api/session", {
    method: "GET",
    cache: "no-store",
    headers: { "x-attest-session-refresh": "1" },
  });
  const payload = await response.json().catch(() => ({}));
  const token = String(payload.token || "");
  if (!response.ok || !TOKEN_PATTERN.test(token)) {
    throw new Error("Attest could not refresh this browser session. Reload the page and retry.");
  }
  return token;
}

function apiErrorMessage(status, supplied) {
  if (status === 403 && /local session token/i.test(String(supplied || ""))) {
    return "Attest could not refresh this browser session. Reload the page and retry.";
  }
  return supplied || `Request failed (${status})`;
}
