export class StrictJsonError extends Error {
  constructor(readonly code: "invalid_json" | "duplicate_key" | "json_too_deep" | "too_many_keys") {
    super(code); this.name = "StrictJsonError";
  }
}

/** JSON.parse with a lexical preflight, so duplicate escaped property names cannot collapse silently. */
export function parseJsonNoDuplicateKeys(text: string, limits: { maxDepth?: number; maxKeys?: number } = {}): unknown {
  const maxDepth = limits.maxDepth ?? 32; const maxKeys = limits.maxKeys ?? 64;
  let index = 0;
  const fail = (code: StrictJsonError["code"]): never => { throw new StrictJsonError(code); };
  const ws = () => { while (/\s/u.test(text[index] ?? "")) index += 1; };
  const stringToken = (): string => {
    const start = index;
    if (text[index++] !== '"') return fail("invalid_json");
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, index)) as string; } catch { return fail("invalid_json"); }
      }
      if (char === "\\") {
        const escaped = text[index++];
        if (escaped === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) return fail("invalid_json"); index += 4; }
        else if (!escaped || !'"\\/bfnrt'.includes(escaped)) return fail("invalid_json");
      } else if (char === undefined || char.charCodeAt(0) < 0x20) return fail("invalid_json");
    }
    return fail("invalid_json");
  };
  const value = (depth: number): void => {
    ws(); if (depth > maxDepth) return fail("json_too_deep");
    if (text[index] === '"') { stringToken(); return; }
    if (text[index] === "{") {
      index += 1; ws(); const keys = new Set<string>(); let count = 0;
      if (text[index] === "}") { index += 1; return; }
      for (;;) {
        ws(); if (text[index] !== '"') return fail("invalid_json");
        const key = stringToken(); if (keys.has(key)) return fail("duplicate_key");
        keys.add(key); if (++count > maxKeys) return fail("too_many_keys");
        ws(); if (text[index++] !== ":") return fail("invalid_json"); value(depth + 1); ws();
        const delimiter = text[index++]; if (delimiter === "}") return; if (delimiter !== ",") return fail("invalid_json");
      }
    }
    if (text[index] === "[") {
      index += 1; ws(); if (text[index] === "]") { index += 1; return; }
      for (;;) { value(depth + 1); ws(); const delimiter = text[index++]; if (delimiter === "]") return; if (delimiter !== ",") return fail("invalid_json"); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!match) return fail("invalid_json"); index += match[0].length;
  };
  value(1); ws(); if (index !== text.length) fail("invalid_json");
  try { return JSON.parse(text) as unknown; } catch { return fail("invalid_json"); }
}
