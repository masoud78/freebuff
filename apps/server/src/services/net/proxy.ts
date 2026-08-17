/**
 * Outbound proxy support.
 *
 * The desktop server runs locally and talks to Gemini over Node's built-in
 * `fetch` (the @google/genai SDK uses the global fetch), which respects
 * undici's *global dispatcher*. By installing a proxy agent as the global
 * dispatcher at startup, ALL outbound HTTP(S) traffic of this process —
 * including the Gemini SDK — is routed through the proxy.
 *
 * Precedence:
 *   1. Standard proxy env vars (HTTPS_PROXY / HTTP_PROXY, incl. lowercase).
 *      `EnvHttpProxyAgent` also honors NO_PROXY, so loopback and listed hosts
 *      are bypassed automatically.
 *   2. Windows system proxy read from the registry
 *      (HKCU\...\Internet Settings, the "Settings > Proxy" toggle).
 *   3. Nothing — traffic goes direct.
 *
 * Set FREEBUFF_NO_PROXY=1 to force direct connections even when a system
 * proxy is configured.
 */

import { spawnSync } from 'node:child_process';
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';

export type ProxySource = 'env' | 'windows-registry' | 'disabled';

export interface ProxySetup {
  enabled: boolean;
  source: ProxySource;
  url: string;
  detail?: string;
}

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** First non-empty proxy value among the standard env vars. */
function envProxy(): string | null {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Normalize a proxy server string from the Windows registry.
 * Handles plain "host:port" and per-protocol "http=...;https=..." forms,
 * and prepends a scheme when missing.
 */
function normalizeProxyServer(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  if (value.includes(';')) {
    const parts: Record<string, string> = {};
    for (const entry of value.split(';')) {
      const idx = entry.indexOf('=');
      if (idx === -1) continue;
      parts[entry.slice(0, idx).trim().toLowerCase()] = entry.slice(idx + 1).trim();
    }
    value = parts.https ?? parts.http ?? '';
    if (!value) return null;
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
  return value;
}

/** Read the Windows system proxy from the registry (no-op on other platforms). */
function windowsSystemProxy(): string | null {
  if (process.platform !== 'win32') return null;
  const result = spawnSync(
    'reg.exe',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  );
  if (result.status !== 0) return null;
  const output = result.stdout ?? '';

  const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(output);
  if (!enable || parseInt(enable[1]!, 16) === 0) return null;

  const server = /ProxyServer\s+REG_SZ\s+(.+)/.exec(output);
  if (!server) return null;
  return normalizeProxyServer(server[1]!);
}

/**
 * undici v8's ProxyAgent breaks when a request carries an explicit
 * `Content-Length` header (the @google/genai SDK sets one for its resumable
 * file upload): converting the header list to an object empties the value and
 * the dispatcher then rejects it with "invalid content-length header". The
 * header is redundant anyway — undici computes it from the body — so strip it
 * from requests that have a body and let undici set it. Idempotent.
 */
let fetchPatched = false;
function installUploadHeaderFix(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (init?.body != null) {
      const headers = new Headers(init.headers ?? undefined);
      headers.delete('content-length');
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  };
}

/**
 * Install the best available proxy as undici's global dispatcher.
 * Safe to call once at startup; returns what was applied (or why not) so the
 * caller can log it.
 */
export function setupOutboundProxy(): ProxySetup {
  const noProxyFlag = process.env.FREEBUFF_NO_PROXY;
  if (noProxyFlag && (noProxyFlag === '1' || noProxyFlag.toLowerCase() === 'true')) {
    return { enabled: false, source: 'disabled', url: '', detail: 'FREEBUFF_NO_PROXY is set' };
  }

  const envUrl = envProxy();
  if (envUrl) {
    try {
      // Honors HTTPS_PROXY/HTTP_PROXY/NO_PROXY from the environment.
      setGlobalDispatcher(new EnvHttpProxyAgent());
      installUploadHeaderFix();
      return { enabled: true, source: 'env', url: envUrl };
    } catch (error) {
      return { enabled: false, source: 'env', url: envUrl, detail: `failed to build proxy agent: ${String(error)}` };
    }
  }

  const registryUrl = windowsSystemProxy();
  if (registryUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent({ uri: registryUrl }));
      installUploadHeaderFix();
      return { enabled: true, source: 'windows-registry', url: registryUrl };
    } catch (error) {
      return {
        enabled: false,
        source: 'windows-registry',
        url: registryUrl,
        detail: `failed to build proxy agent: ${String(error)}`,
      };
    }
  }

  return { enabled: false, source: 'disabled', url: '', detail: 'no system proxy detected' };
}
