import { ConsoleValidationError } from "./console-operation-schema.js";

export interface ManagedEnvDocument { lines: string[]; values: Record<string, string>; assignments: Map<string, number> }

function decodeSingleQuoted(raw: string): string | undefined {
  if (!raw.startsWith("'") || !raw.endsWith("'")) return undefined;
  const escapedApostrophe = "'\\''";
  const pieces = raw.slice(1, -1).split(escapedApostrophe);
  if (pieces.some(piece => piece.includes("'"))) return undefined;
  return pieces.join("'");
}

function decodeValue(raw: string): string | undefined {
  if (raw.startsWith("'")) return decodeSingleQuoted(raw);
  if (raw.startsWith('"') && raw.endsWith('"') && !/[`$]/.test(raw)) {
    const body = raw.slice(1, -1);
    if (/\\(?![\\"])/.test(body)) return undefined;
    return body.replace(/\\([\\"])/g, "$1");
  }
  return /^[A-Za-z0-9_./:@%+,\-\[\]{}]*$/.test(raw) ? raw : undefined;
}

export function parseManagedEnv(text: string): ManagedEnvDocument {
  if (Buffer.byteLength(text) > 1024 * 1024 || text.includes("\0")) throw new ConsoleValidationError("invalid_env_file");
  const lines = text.match(/.*(?:\n|$)/g)?.filter((line, index, all) => line || index < all.length - 1) ?? [];
  const values: Record<string, string> = {}; const assignments = new Map<string, number>();
  lines.forEach((line, index) => {
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (!body || /^\s*#/.test(body)) return;
    const match = /^(?:export )?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(body);
    if (!match) throw new ConsoleValidationError("unsupported_env_syntax");
    const key = match[1]!; if (assignments.has(key)) throw new ConsoleValidationError("duplicate_env_key");
    const value = decodeValue(match[2]!); if (value === undefined) throw new ConsoleValidationError("unsupported_env_syntax");
    assignments.set(key, index); values[key] = value;
  });
  return { lines, values, assignments };
}

export function shellLiteral(value: string): string {
  if (/[\u0000\r\n]/.test(value)) throw new ConsoleValidationError("invalid_env_value");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderManagedEnv(document: ManagedEnvDocument, changes: Record<string, string | null>): string {
  const output = [...document.lines];
  for (const key of Object.keys(changes).sort()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new ConsoleValidationError("invalid_env_key");
    const value = changes[key]!; const replacement = value === null ? null : `${key}=${shellLiteral(value)}\n`;
    const at = document.assignments.get(key);
    if (at !== undefined) output[at] = replacement ?? "";
    else if (replacement) output.push(replacement);
  }
  const rendered = output.join(""); parseManagedEnv(rendered); return rendered;
}
