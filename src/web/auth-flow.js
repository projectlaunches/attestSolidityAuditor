export function normalizeLoginLaunch(result = {}) {
  const type = String(result.type || "");
  if (type === "chatgpt") return {
    type,
    url: secureUrl(result.authUrl, "Codex did not return a valid ChatGPT authorization URL"),
    userCode: null,
    message: "Complete ChatGPT sign-in in the opened window.",
  };
  if (type === "chatgptDeviceCode") {
    const userCode = String(result.userCode || "").trim();
    if (!userCode || userCode.length > 128) throw new Error("Codex did not return a valid ChatGPT device code");
    return {
      type,
      url: secureUrl(result.verificationUrl, "Codex did not return a valid ChatGPT verification URL"),
      userCode,
      message: `Enter code ${userCode} in the opened ChatGPT sign-in window.`,
    };
  }
  throw new Error("Codex returned an unsupported ChatGPT sign-in method");
}

export function showLoginPopupMessage(popup, message) {
  if (!popup || popup.closed) return;
  try {
    popup.document.title = "Attest · ChatGPT sign-in";
    popup.document.body.replaceChildren();
    const status = popup.document.createElement("p");
    status.textContent = message;
    status.style.cssText = "font: 16px/1.5 system-ui, sans-serif; color: #20252b; max-width: 34rem; margin: 4rem auto; padding: 1.5rem;";
    popup.document.body.append(status);
  } catch {
    // The popup may already have navigated cross-origin.
  }
}

function secureUrl(value, errorMessage) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error(errorMessage); }
  if (url.protocol !== "https:") throw new Error(errorMessage);
  return url.href;
}
