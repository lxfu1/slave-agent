import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { checkPermission, isCoreDirectory } from "../src/permissions/guard.js";
import type { Tool } from "../src/types/tool.js";
import type { PermissionsConfig } from "../src/types/config.js";

const home = os.homedir();

// ────────────────────────────────────────────────────────────────────────────
// isCoreDirectory
// ────────────────────────────────────────────────────────────────────────────

describe("isCoreDirectory", () => {
  it("identifies home directory as core", () => {
    expect(isCoreDirectory(home)).toBe(true);
  });

  it("identifies filesystem root as core", () => {
    expect(isCoreDirectory("/")).toBe(true);
  });

  it("identifies system paths as core", () => {
    expect(isCoreDirectory("/etc")).toBe(true);
    expect(isCoreDirectory("/usr/bin")).toBe(true);
    expect(isCoreDirectory("/etc/nginx/conf.d")).toBe(true);
  });

  it("identifies sensitive home subdirs as core", () => {
    expect(isCoreDirectory(path.join(home, ".ssh"))).toBe(true);
    expect(isCoreDirectory(path.join(home, ".aws"))).toBe(true);
    expect(isCoreDirectory(path.join(home, ".kube/contexts"))).toBe(true);
  });

  it("marks project directories as safe (non-core)", () => {
    expect(isCoreDirectory(path.join(home, "projects/myapp"))).toBe(false);
    expect(isCoreDirectory(path.join(home, "work/code/service"))).toBe(false);
    expect(isCoreDirectory("/opt/myapp")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeTool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: "test",
    inputSchema: { type: "object", properties: {} },
    maxResultChars: 1000,
    isReadOnly: () => readOnly,
    isEnabled: () => true,
    call: async () => ({ content: "" }),
  };
}

const defaultConfig: PermissionsConfig = { mode: "ask", allow: [], deny: [], disabledTools: [] };
const autoConfig: PermissionsConfig = { mode: "auto", allow: [], deny: [], disabledTools: [] };
const projectCwd = path.join(home, "projects/myapp");

// ────────────────────────────────────────────────────────────────────────────
// checkPermission
// ────────────────────────────────────────────────────────────────────────────

describe("checkPermission", () => {
  describe("step 1: explicit deny", () => {
    it("denies tools in the deny list", () => {
      const cfg = { ...defaultConfig, deny: ["RunCommand"] };
      const result = checkPermission(makeTool("RunCommand", false), {}, "auto", cfg, projectCwd);
      expect(result.behavior).toBe("deny");
    });
  });

  describe("step 2: explicit allow", () => {
    it("allows tools in the allow list", () => {
      const cfg = { ...defaultConfig, allow: ["WriteFile"] };
      const result = checkPermission(
        makeTool("WriteFile", false),
        { path: "src/foo.ts" },
        "ask",
        cfg,
        projectCwd
      );
      expect(result.behavior).toBe("allow");
    });
  });

  describe("step 3: read-only tools", () => {
    it("allows read-only tools unconditionally", () => {
      const result = checkPermission(makeTool("ReadFile", true), {}, "ask", defaultConfig, home);
      expect(result.behavior).toBe("allow");
    });
  });

  describe("step 4: safe project directory", () => {
    it("auto-allows WriteFile targeting a path inside a project cwd", () => {
      const result = checkPermission(
        makeTool("WriteFile", false),
        { path: path.join(projectCwd, "src/index.ts") },
        "ask",
        defaultConfig,
        projectCwd
      );
      expect(result.behavior).toBe("allow");
      expect(result.reason).toBe("Safe project directory");
    });

    it("does NOT auto-allow WriteFile when cwd is home directory", () => {
      const result = checkPermission(
        makeTool("WriteFile", false),
        { path: path.join(home, "src/index.ts") },
        "ask",
        defaultConfig,
        home
      );
      expect(result.behavior).toBe("ask");
    });

    it("does NOT apply safe-cwd logic to RunCommand (no target path)", () => {
      const result = checkPermission(
        makeTool("RunCommand", false),
        { command: "ls -la" },
        "ask",
        defaultConfig,
        projectCwd
      );
      expect(result.behavior).toBe("ask");
    });
  });

  describe("step 5: dangerous commands", () => {
    it("forces ask even in auto mode for rm -rf", () => {
      const result = checkPermission(
        makeTool("RunCommand", false),
        { command: "rm -rf /tmp/test" },
        "auto",
        autoConfig,
        projectCwd
      );
      expect(result.behavior).toBe("ask");
      expect(result.request.riskLevel).toBe("high");
    });

    it("forces ask even in auto mode for git push --force", () => {
      const result = checkPermission(
        makeTool("RunCommand", false),
        { command: "git push origin main --force" },
        "auto",
        autoConfig,
        projectCwd
      );
      expect(result.behavior).toBe("ask");
    });

    it("does not block normal commands in auto mode", () => {
      const result = checkPermission(
        makeTool("RunCommand", false),
        { command: "npm test" },
        "auto",
        autoConfig,
        projectCwd
      );
      expect(result.behavior).toBe("allow");
    });
  });

  describe("step 6: auto mode", () => {
    it("allows anything non-dangerous in auto mode", () => {
      const result = checkPermission(
        makeTool("WriteNotes", false),
        { content: "hello" },
        "auto",
        autoConfig,
        home
      );
      expect(result.behavior).toBe("allow");
    });
  });

  describe("step 7: default ask", () => {
    it("asks for write tools in ask mode outside safe cwd", () => {
      const result = checkPermission(
        makeTool("WriteNotes", false),
        { content: "hello" },
        "ask",
        defaultConfig,
        home
      );
      expect(result.behavior).toBe("ask");
    });
  });
});
