import { describe, it, expect } from "vitest";
import path from "node:path";
import { isPathSafe } from "../src/tools/pathUtils.js";

const home = process.env["HOME"] ?? "/home/user";
const cwd = "/home/user/projects/myapp";

describe("isPathSafe", () => {
  it("allows a file directly inside the root", () => {
    expect(isPathSafe(path.join(cwd, "src/index.ts"), cwd)).toBe(true);
  });

  it("allows a deeply nested file inside the root", () => {
    expect(isPathSafe(path.join(cwd, "a/b/c/d.ts"), cwd)).toBe(true);
  });

  it("allows the root itself", () => {
    expect(isPathSafe(cwd, cwd)).toBe(true);
  });

  it("rejects a path outside the root", () => {
    expect(isPathSafe("/etc/passwd", cwd)).toBe(false);
  });

  it("rejects a sibling directory with a shared prefix", () => {
    // /home/user/projects/myapp-evil should NOT match /home/user/projects/myapp
    expect(isPathSafe("/home/user/projects/myapp-evil/file.ts", cwd)).toBe(false);
  });

  it("allows a path in any of multiple roots", () => {
    const profileDir = `${home}/.memo-agent`;
    const file = path.join(profileDir, "memory/NOTES.md");
    expect(isPathSafe(file, cwd, profileDir)).toBe(true);
  });

  it("rejects a path not in any root when multiple roots are given", () => {
    const profileDir = `${home}/.memo-agent`;
    expect(isPathSafe("/tmp/evil.sh", cwd, profileDir)).toBe(false);
  });

  it("rejects parent directory traversal attempts", () => {
    // path.resolve will collapse .., so this should resolve to something outside cwd
    const attempt = path.resolve(cwd, "../../etc/passwd");
    expect(isPathSafe(attempt, cwd)).toBe(false);
  });
});
