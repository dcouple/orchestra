import { readFile } from "node:fs/promises";

function assignment(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(?:'([^'\\r\\n]*)'|"([^"\\r\\n]*)"|([^\\s#'"]+))\\s*(?:#.*)?$`,
    "m",
  ).exec(source);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

async function readProxyEnv(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => {
    throw new Error("proxy_env_unreadable");
  });
}

export async function readCliproxyApiKey(path: string): Promise<string> {
  const key = assignment(await readProxyEnv(path), "CLIPROXY_API_KEY");
  if (!key) throw new Error("proxy_api_key_missing");
  return key;
}

export async function readCliproxyManagementKey(path: string): Promise<string> {
  const key = assignment(
    await readProxyEnv(path),
    "CLIPROXY_MANAGEMENT_KEY",
  );
  if (!key) throw new Error("proxy_management_key_missing");
  return key;
}
