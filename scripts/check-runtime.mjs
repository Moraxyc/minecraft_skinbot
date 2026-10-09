import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJavaScript } from "acorn";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

const schemaURL = new URL(
  "./schema/tgcloud.json",
  import.meta.resolve("@tgcloud/cli/package.json"),
);
const validateConfig = new Ajv2020({ allErrors: true }).compile(
  JSON.parse(await readFile(schemaURL, "utf8")),
);
const defaultProjectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleDirectories = new Set(["handlers", "endpoints", "lib"]);

function visit(node, inspect) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") inspect(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inspect);
    } else {
      visit(value, inspect);
    }
  }
}

async function collectModules(directory, nested, modules) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${filename}: runtime symlinks are not allowed`);
    }
    if (entry.isDirectory()) {
      if (!nested) {
        throw new Error(`${filename}: handlers and endpoints must be single-level`);
      }
      await collectModules(filename, true, modules);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      modules.add(filename);
    }
  }
}

function checkModule(source, filename, runtimeRoot, modules) {
  const syntax = parseJavaScript(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  const fail = (node, message) => {
    throw new Error(`${relative(runtimeRoot, filename)}:${node.loc.start.line}: ${message}`);
  };
  const entrypoint = ["handlers", "endpoints"].includes(
    relative(runtimeRoot, filename).split(/[\\/]/)[0],
  );
  const hasDefault = syntax.body.some(
    (node) => node.type === "ExportDefaultDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.specifiers.some(
        (specifier) => (specifier.exported.name ?? specifier.exported.value) === "default",
      )),
  );
  if (entrypoint && !hasDefault) {
    throw new Error(`${relative(runtimeRoot, filename)}: handler or endpoint needs a default export`);
  }

  visit(syntax, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" &&
        node.callee.name === "require") {
      fail(node, "CommonJS require is unavailable; use ESM imports");
    }
    if (!["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) ||
        !node.source) return;
    if (node.source.type !== "Literal" || typeof node.source.value !== "string") {
      fail(node, "import paths must be string literals");
    }
    const specifier = node.source.value;
    if (specifier === "sdk" || specifier === "sdk/db") return;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      fail(node, `only sdk, sdk/db and relative project imports are allowed: ${specifier}`);
    }
    if (!specifier.endsWith(".js")) {
      fail(node, `relative imports need an explicit .js extension: ${specifier}`);
    }
    const target = resolve(dirname(filename), specifier);
    const targetPath = relative(runtimeRoot, target);
    if (targetPath === ".." || targetPath.startsWith("../") || targetPath.startsWith("..\\") ||
        isAbsolute(targetPath)) {
      fail(node, `import escapes tgcloud/: ${specifier}`);
    }
    if (!modules.has(target)) {
      fail(node, `import target is missing or not deployable: ${specifier}`);
    }
  });
}

export async function checkRuntime({ projectRoot = defaultProjectRoot, checkStatic = false } = {}) {
  const errors = [];
  const config = parseJsonc(
    await readFile(resolve(projectRoot, "tgcloud.jsonc"), "utf8"),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length) {
    throw new Error(`tgcloud.jsonc: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  if (!validateConfig(config)) {
    throw new Error(`tgcloud.jsonc: ${JSON.stringify(validateConfig.errors)}`);
  }
  const staticSource = typeof config.static === "string" ? config.static : config.static?.source;
  if (!staticSource) {
    throw new Error("tgcloud.jsonc: static hosting needs a build output directory");
  }
  const normalizedSource = staticSource.replaceAll("\\", "/").replace(/\/+$/, "");
  if (isAbsolute(normalizedSource) || normalizedSource.split("/").some(
    (segment) => !segment || segment === "." || segment === "..",
  )) {
    throw new Error("tgcloud.jsonc: static.source must be a directory inside the project");
  }

  const runtimeRoot = resolve(projectRoot, "tgcloud");
  if (!(await lstat(runtimeRoot)).isDirectory()) {
    throw new Error("tgcloud/: runtime root must be a directory, not a symlink");
  }
  const modules = new Set();
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    const filename = resolve(runtimeRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${filename}: runtime symlinks are not allowed`);
    }
    if (entry.isFile() && entry.name === "schema.js") {
      modules.add(filename);
    } else if (entry.isDirectory() && moduleDirectories.has(entry.name)) {
      await collectModules(filename, entry.name === "lib", modules);
    } else if (entry.isDirectory() || entry.name.endsWith(".js")) {
      throw new Error(`${filename}: module is outside the supported runtime layout`);
    }
  }
  if (!modules.has(resolve(runtimeRoot, "schema.js"))) {
    throw new Error("tgcloud/schema.js is required");
  }
  for (const filename of [...modules].sort()) {
    checkModule(await readFile(filename, "utf8"), filename, runtimeRoot, modules);
  }
  if (checkStatic) {
    const indexFile = resolve(projectRoot, normalizedSource, "index.html");
    if (!(await lstat(indexFile)).isFile()) {
      throw new Error(`${indexFile}: static build needs a regular index.html`);
    }
  }
  return { moduleCount: modules.size, staticSource: normalizedSource };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--static")) {
      throw new Error("Usage: node scripts/check-runtime.mjs [--static]");
    }
    const result = await checkRuntime({ checkStatic: process.argv.includes("--static") });
    console.log(`Runtime contract OK: ${result.moduleCount} module(s), static source ${result.staticSource}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
