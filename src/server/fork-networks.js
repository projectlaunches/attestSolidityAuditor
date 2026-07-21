const NETWORKS = Object.freeze({
  ethereum: Object.freeze({ id: "ethereum", label: "Ethereum Mainnet", chainId: 1, publicUrl: "https://ethereum-rpc.publicnode.com", provider: "PublicNode" }),
  base: Object.freeze({ id: "base", label: "Base Mainnet", chainId: 8453, publicUrl: "https://mainnet.base.org", provider: "Base public RPC" }),
  bnb: Object.freeze({ id: "bnb", label: "BNB Smart Chain", chainId: 56, publicUrl: "https://bsc-dataseed-public.bnbchain.org", provider: "BNB Chain public RPC" }),
});

export function listForkNetworks() {
  return Object.values(NETWORKS).map((network) => {
    const configured = resolveUrl(network);
    return {
      id: network.id,
      label: network.label,
      chainId: network.chainId,
      provider: network.provider,
      endpointHost: configured.hostname,
      publicDefault: true,
      rateLimited: true,
    };
  });
}

export function resolveForkNetwork(id) {
  const network = NETWORKS[id];
  if (!network) throw new Error("Unknown fork network");
  const url = resolveUrl(network);
  return { ...network, url: url.toString() };
}

export async function verifyForkNetwork(id, { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const network = resolveForkNetwork(id);
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime cannot verify JSON-RPC endpoints");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const chainHex = await rpcCall(fetchImpl, network.url, "eth_chainId", [], controller.signal);
    if (typeof chainHex !== "string" || !/^0x[0-9a-f]+$/i.test(chainHex)) throw new Error("RPC returned an invalid eth_chainId result");
    const observedChainId = Number(BigInt(chainHex));
    if (observedChainId !== network.chainId) throw new Error(`${network.label} RPC chain mismatch: expected ${network.chainId}, received ${observedChainId}`);
    const blockHex = await rpcCall(fetchImpl, network.url, "eth_blockNumber", [], controller.signal);
    if (typeof blockHex !== "string" || !/^0x[0-9a-f]+$/i.test(blockHex)) throw new Error("RPC returned an invalid block number");
    const block = await rpcCall(fetchImpl, network.url, "eth_getBlockByNumber", [blockHex, false], controller.signal);
    if (!block || block.number !== blockHex || typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error("RPC could not pin the selected block");
    return { id: network.id, label: network.label, chainId: network.chainId, blockNumber: Number(BigInt(blockHex)), blockHash: block.hash, endpointHost: new URL(network.url).hostname };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${network.label} RPC health check timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPinnedForkBlock(id, { blockNumber, blockHash }, { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const network = resolveForkNetwork(id);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !/^0x[0-9a-f]{64}$/i.test(String(blockHash || ""))) throw new Error("Fork block pin is invalid");
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime cannot verify JSON-RPC endpoints");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const blockHex = `0x${BigInt(blockNumber).toString(16)}`;
    const block = await rpcCall(fetchImpl, network.url, "eth_getBlockByNumber", [blockHex, false], controller.signal);
    if (!block || Number(BigInt(block.number)) !== blockNumber || String(block.hash || "").toLowerCase() !== blockHash.toLowerCase()) {
      throw new Error(`${network.label} fork block changed during execution; fork evidence was invalidated`);
    }
    return true;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${network.label} fork pin recheck timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveUrl(network) {
  const raw = network.publicUrl;
  let url;
  try { url = new URL(raw); } catch { throw new Error("Fork network preset must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Fork network preset must be a credential-free HTTPS URL");
  return url;
}

async function rpcCall(fetchImpl, url, method, params, signal) {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal, redirect: "error" });
  if (!response.ok) throw new Error(`RPC health check returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("RPC health check response exceeded 1 MB");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("RPC returned invalid JSON"); }
  if (payload?.error) throw new Error(`RPC health check failed: ${String(payload.error.message || "provider error").slice(0, 300)}`);
  return payload?.result;
}

export const __test = { NETWORKS };
