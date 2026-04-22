/**
 * Recipe registry — loads and manages user-defined prompt templates.
 *
 * Recipes are .md files with YAML frontmatter stored in:
 *   Global:  ~/.memo-agent/recipes/
 *   Project: .memo-agent/recipes/   (takes precedence over global)
 *
 * A recipe is invoked with /<name> [args], which expands $ARGUMENTS
 * in the template body and injects the result into the conversation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { scanForInjection } from "../context/promptBuilder.js";
import { getTool } from "../tools/registry.js";

export interface RecipeFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  watchPaths?: string[];
}

export interface Recipe {
  name: string;
  description: string;
  body: string;
  frontmatter: RecipeFrontmatter;
  filePath: string;
  scope: "global" | "project";
}

export type RecipeDescriptor = Pick<Recipe, "name" | "description" | "scope">;

export interface RecipeExpansion {
  /** Short label shown in the UI (e.g., "❯ /review main.ts") */
  markerText: string;
  /** Full prompt body injected into the conversation */
  bodyText: string;
  /** Tools pre-approved by the recipe's frontmatter */
  allowedTools: string[];
}

const RECIPE_DIR = "recipes";
const AGENT_HOME_DIR = ".memo-agent";

/** Loads recipes from both global and project-local directories */
export async function loadRecipes(cwd: string, profileDir: string): Promise<Recipe[]> {
  const globalDir = path.join(profileDir, RECIPE_DIR);
  const projectDir = path.join(cwd, AGENT_HOME_DIR, RECIPE_DIR);

  const [globalRecipes, projectRecipes] = await Promise.allSettled([
    loadRecipesFromDir(globalDir, "global"),
    loadRecipesFromDir(projectDir, "project"),
  ]);

  const global = globalRecipes.status === "fulfilled" ? globalRecipes.value : [];
  const project = projectRecipes.status === "fulfilled" ? projectRecipes.value : [];

  // Project recipes override global ones with the same name
  const nameMap = new Map<string, Recipe>();
  for (const recipe of [...global, ...project]) {
    nameMap.set(recipe.name, recipe);
  }

  return Array.from(nameMap.values());
}

async function loadRecipesFromDir(dir: string, scope: "global" | "project"): Promise<Recipe[]> {
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(dir);
    entries = dirEntries.filter(e => e.endsWith(".md"));
  } catch {
    return []; // Directory doesn't exist — not an error
  }

  const results = await Promise.allSettled(
    entries.map(filename => parseRecipeFile(path.join(dir, filename), scope))
  );

  const recipes: Recipe[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      if (result.value) recipes.push(result.value);
    } else {
      process.stderr.write(`[memo-agent] Skipping recipe ${entries[i]}: ${String(result.reason)}\n`);
    }
  }
  return recipes;
}

async function parseRecipeFile(
  filePath: string,
  scope: "global" | "project"
): Promise<Recipe | null> {
  const raw = await fs.readFile(filePath, "utf-8");

  // Parse YAML frontmatter between --- delimiters
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    console.warn(`[memo-agent] Recipe ${filePath} has no frontmatter — skipping`);
    return null;
  }

  const [, fmRaw, body] = fmMatch;

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(fmRaw!);
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter: ${String(err)}`);
  }

  if (!isFrontmatter(frontmatter)) {
    throw new Error("Frontmatter missing required fields (name, description)");
  }

  const fm = frontmatter as RecipeFrontmatter;

  // Validate recipe name (alphanumeric + hyphens only)
  if (!/^[a-z0-9-]+$/.test(fm.name)) {
    throw new Error(`Recipe name "${fm.name}" must be lowercase alphanumeric with hyphens only`);
  }

  return {
    name: fm.name,
    description: fm.description,
    body: (body ?? "").trim(),
    frontmatter: fm,
    filePath,
    scope,
  };
}

function isFrontmatter(obj: unknown): obj is RecipeFrontmatter {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as RecipeFrontmatter).name === "string" &&
    typeof (obj as RecipeFrontmatter).description === "string"
  );
}

/** Finds a recipe by name (case-insensitive) */
export function findRecipe(recipes: Recipe[], name: string): Recipe | null {
  return recipes.find(r => r.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Expands a recipe invocation into its full prompt body.
 * Returns null if the recipe is not found.
 * Scans the expanded body for prompt injection before returning.
 */
export function expandRecipe(
  recipes: Recipe[],
  invocation: string
): RecipeExpansion | null {
  // Parse "/<name> [args]" format
  const match = invocation.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/i);
  if (!match) return null;

  const [, name, rawArgs] = match;
  const recipe = findRecipe(recipes, name!);
  if (!recipe) return null;

  const args = rawArgs?.trim() ?? "";
  // Literal string replacement only — no eval, no template literals
  const bodyText = recipe.body.replace(/\$ARGUMENTS/g, args);

  // Security: scan expanded body before injecting into conversation
  if (scanForInjection(bodyText)) {
    console.warn(`[memo-agent] Potential injection in recipe "${recipe.name}" — blocking expansion`);
    return null;
  }

  // Validate allowedTools against the live registry. Unknown tool names are
  // silently wrong — they'd match nothing and give the user a false sense of
  // pre-approval. Warn and strip them so the bug surfaces at load time.
  const rawAllowedTools = recipe.frontmatter.allowedTools ?? [];
  const allowedTools = rawAllowedTools.filter(name => {
    if (getTool(name)) return true;
    process.stderr.write(
      `[memo-agent] Recipe "${recipe.name}": allowedTool "${name}" not found in registry — skipped\n`
    );
    return false;
  });

  return {
    markerText: invocation.trim(),
    bodyText,
    allowedTools,
  };
}
