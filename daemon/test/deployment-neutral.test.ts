import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve("..");
// Code in this public repo stays deployment-neutral: a deployment's names,
// accounts, and cloud project come from its site config, not from source.
const deploymentSpecific = /bloom/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("deployment-neutral code", () => {
  it("keeps daemon and machine code free of deployment-specific names", () => {
    const code = ["daemon/src", "daemon/ops", "daemon/scripts", "machines"]
      .flatMap(dir => files(join(repo, dir)))
      .filter(path => !path.endsWith(".md"));
    const offenders = code
      .filter(path => deploymentSpecific.test(relative(repo, path)) || deploymentSpecific.test(readFileSync(path, "utf8")))
      .map(path => relative(repo, path));
    expect(offenders).toEqual([]);
  });
});
