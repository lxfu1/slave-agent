/**
 * Shared path-safety utilities for file-access tools.
 *
 * isPathSafe enforces a directory boundary: the resolved path must be
 * at or under one of the supplied allowed roots. Both roots are always
 * checked so tools that need to access profile memory (NOTES.md) as
 * well as project files can do so with a single call.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Returns true if resolvedPath is at or under at least one of the given roots.
 * Roots are normalised to include a trailing separator so that
 * "/home/user/project-other" does not match root "/home/user/project".
 */
export function isPathSafe(resolvedPath: string, ...roots: string[]): boolean {
  for (const root of roots) {
    const normalised = path.resolve(root);
    const withSep = normalised.endsWith(path.sep) ? normalised : normalised + path.sep;
    if (resolvedPath === normalised || resolvedPath.startsWith(withSep)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves a path through the filesystem and verifies that its canonical target
 * remains inside one of the allowed roots. For paths that do not exist yet, the
 * nearest existing ancestor is resolved so symlinked parent directories cannot
 * escape the boundary.
 */
export async function resolveSafePath(
  inputPath: string,
  cwd: string,
  roots: string[],
): Promise<string | null> {
  const candidate = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
  const canonicalRoots = await Promise.all(
    roots.map(async root => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );

  const canonicalCandidate = await resolveThroughExistingAncestor(candidate);
  return isPathSafe(canonicalCandidate, ...canonicalRoots) ? canonicalCandidate : null;
}

async function resolveThroughExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.join(existing, ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}
