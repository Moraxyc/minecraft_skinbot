import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkRuntime } from "../../scripts/check-runtime.mjs";

async function project(context, files = {}, config = { static: { source: "web/dist" } }) {
  const projectRoot = await mkdtemp(join(tmpdir(), "skinbot-contract-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  for (const [filename, contents] of Object.entries({
    "tgcloud.jsonc": JSON.stringify(config),
    "tgcloud/schema.js": "export {};",
    ...files,
  })) {
    const target = join(projectRoot, filename);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return projectRoot;
}

test("accepts a deployable ESM graph without executing runtime code", async (context) => {
  const projectRoot = await project(context, {
    "tgcloud.jsonc": '{ // static hosting\n "static": { "source": "web/dist", }, }',
    "tgcloud/lib/nested/core.js": 'import { api } from "sdk"; import { table } from "sdk/db"; export { api, table };',
    "tgcloud/lib/exports.js": 'export * from "./nested/core.js";',
    "tgcloud/handlers/message.js": 'import { api } from "../lib/exports.js"; export default () => api;',
    "tgcloud/endpoints/lookup.js": 'export { default } from "../handlers/message.js";',
    "tgcloud/lib/data.js": 'export const text = "import fs from \\"node:fs\\""; throw new Error("Do not execute");',
  });
  await assert.doesNotReject(checkRuntime({ projectRoot }));
});

test("rejects Node, npm and computed runtime imports", async (context) => {
  const cases = [
    ['import fs from "node:fs";', /only sdk/],
    ['import fs from "fs";', /only sdk/],
    ['export * from "pngjs";', /only sdk/],
    ['await import("node:path");', /only sdk/],
    ['const name = "sdk"; await import(name);', /string literals/],
    ['const fs = require("fs");', /CommonJS/],
  ];
  for (const [source, expected] of cases) {
    const projectRoot = await project(context, { "tgcloud/lib/imports.js": source });
    await assert.rejects(checkRuntime({ projectRoot }), expected, source);
  }
});

test("rejects relative imports the deployment cannot resolve", async (context) => {
  const cases = [
    ['import "./missing.js";', /missing or not deployable/],
    ['import "../../outside.js";', /escapes tgcloud/],
    ['export * from "./helper";', /explicit .js/],
    ['import "./helper.js?version=1";', /explicit .js/],
  ];
  for (const [source, expected] of cases) {
    const projectRoot = await project(context, {
      "tgcloud/lib/imports.js": source,
      "tgcloud/lib/helper.js": "export {};",
      "outside.js": "export {};",
    });
    await assert.rejects(checkRuntime({ projectRoot }), expected, source);
  }
});

test("rejects undispatched entrypoints and unsupported module locations", async (context) => {
  const cases = [
    [{ "tgcloud/handlers/message.js": "export const handle = () => {};" }, /default export/],
    [{ "tgcloud/handlers/nested/message.js": "export default () => {};" }, /single-level/],
    [{ "tgcloud/endpoints/nested/lookup.js": "export default () => {};" }, /single-level/],
    [{ "tgcloud/other/helper.js": "export {};" }, /supported runtime layout/],
    [{ "tgcloud/schema.js": "export const broken = ;" }, /Unexpected token/],
  ];
  for (const [files, expected] of cases) {
    const projectRoot = await project(context, files);
    await assert.rejects(checkRuntime({ projectRoot }), expected);
  }
  const projectRoot = await project(context, { "outside.js": "export {};" });
  await mkdir(join(projectRoot, "tgcloud/lib"));
  await symlink(join(projectRoot, "outside.js"), join(projectRoot, "tgcloud/lib/linked.js"));
  await assert.rejects(checkRuntime({ projectRoot }), /runtime symlinks/);
});

test("checks configuration against the pinned official schema and static build boundary", async (context) => {
  const cases = [
    [{ static: { source: "web/dist" }, env: {} }, /additional properties/],
    [{ static: { source: "web/dist", proxy: {} } }, /additional properties/],
    [{ static: { source: "web/dist", immutable: ["assets/**"] } }, /pattern/],
    [{ static: { source: "../outside" } }, /inside the project/],
    [{ static: false }, /build output directory/],
  ];
  for (const [config, expected] of cases) {
    const projectRoot = await project(context, {}, config);
    await assert.rejects(checkRuntime({ projectRoot }), expected);
  }
  const malformed = await project(context, { "tgcloud.jsonc": '{"static":' });
  await assert.rejects(checkRuntime({ projectRoot: malformed }), /ValueExpected/);
  const projectRoot = await project(context);
  await assert.rejects(checkRuntime({ projectRoot, checkStatic: true }), /ENOENT/);
  await mkdir(join(projectRoot, "web/dist"), { recursive: true });
  await writeFile(join(projectRoot, "web/dist/index.html"), "<!doctype html>");
  await assert.doesNotReject(checkRuntime({ projectRoot, checkStatic: true }));
});

test("local SDK resolution fails closed until a test provides its own exports", async (context) => {
  await assert.rejects(import("sdk/db"), /explicit SDK mocks/);
  const expected = { ok: true };
  context.mock.module("sdk", { exports: { fetch: async () => expected } });
  const { fetch } = await import("sdk");
  assert.equal(await fetch("https://example.invalid"), expected);
});
