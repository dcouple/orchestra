import { describe, expect, it } from "vitest";
import {
  assertBrowserPrerequisites,
  BrowserPrerequisiteError,
} from "../src/browser.js";

describe("assertBrowserPrerequisites", () => {
  it("fails closed with the typed disabled error when browser capability is opted out", async () => {
    const rejection = assertBrowserPrerequisites({
      browserEnabled: false,
      playwrightMcpBin: "/not-needed/playwright-mcp",
      playwrightChromeBin: "/not-needed/google-chrome",
    });

    await expect(rejection).rejects.toBeInstanceOf(BrowserPrerequisiteError);
    await expect(rejection).rejects.toMatchObject({
      kind: "disabled",
      message: "browser capability is disabled (BROWSER_ENABLED=0)",
    });
  });
});
