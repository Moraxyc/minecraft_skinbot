import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check" && !arg.startsWith("--outdir=") && !arg.startsWith("--packages="))) {
  throw new Error("Usage: build-skin-png.mjs [--check] [--outdir=directory] [--packages=node_modules]");
}
const packagesDirectory = await realpath(resolve(args.find((arg) => arg.startsWith("--packages="))?.slice(11) ?? resolve(root, "node_modules")));
const outputDirectory = resolve(args.find((arg) => arg.startsWith("--outdir="))?.slice(9) ?? resolve(root, "tgcloud/lib/skin/vendor"));
const packages = [
  { name: "fast-png", version: "8.0.0", license: "MIT", integrity: "sha512-gCysNasJ8KEMgfdYIKd/wTDo6ENK1PWT0RJO7O+0pgmuHPw2O6tA1WvdxFRJoLf9V8yFYpG0FA1YgI8X97OhJA==" },
  { name: "fflate", version: "0.8.2", license: "MIT", integrity: "sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==" },
  { name: "iobuffer", version: "6.0.1", license: "MIT", integrity: "sha512-SZWYkWNfjIXIBYSDpXDYIgshqtbOPsi4lviawAEceR1Kqk+sHDlcQjWrzNQsii80AyBY0q5c8HCTNjqo74ul+Q==" },
  { name: "pako", version: "2.1.0", license: "(MIT AND Zlib)", integrity: "sha512-w+eufiZ1WuJYgPXbV/PO3NCMEc3xqylkKHzp8bxp1uW4qaSNQUkwmLLEc3kKsfz8lpV1F8Ht3U1Cm+9Srog2ug==" },
];
const guardedSources = {
  "fast-png/lib/png_decoder.js": "14453916f2b5cdfaae36bdd511e77a13930ae7eb0d542f21cc59c1c9e69c2166",
  "fast-png/lib/helpers/text.js": "3af1b5d0fb66ff7d5ea81683c70f7e5a0a76959f1e44a99a699fd5b9f730a589",
  "iobuffer/lib/text.js": "4321a36e64f09be499af03a89cdc929014068213d7156d67af1bbc218d3736b4",
  "pako/lib/inflate.js": "f6d86f7e71ecbbdec39f91d109a92147a215db9e31e3dcc540db19cfa71c0616",
  "pako/lib/utils/strings.js": "5d072a04492071250b8ea5bb8f64106adec4301429c32e3670d30e163b3f94a2",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
for (const dependency of [...packages, { name: "esbuild", version: "0.25.12" }]) {
  const installed = JSON.parse(await readFile(resolve(packagesDirectory, dependency.name, "package.json"), "utf8"));
  const locked = lock.packages[`node_modules/${dependency.name}`];
  if (installed.version !== dependency.version || locked?.version !== dependency.version
    || (dependency.integrity && locked.integrity !== dependency.integrity)) throw new Error(`Unverified package pin: ${dependency.name}`);
}
const sources = {};
for (const [filename, expected] of Object.entries(guardedSources)) {
  sources[filename] = await readFile(resolve(packagesDirectory, filename), "utf8");
  if (sha256(sources[filename]) !== expected) throw new Error(`Pinned source changed: ${filename}`);
}
function replacePinned(source, search, replacement, occurrences = 1) {
  if (source.split(search).length !== occurrences + 1) throw new Error("Pinned adaptation marker changed");
  return source.replace(search, replacement);
}
const inflatePath = resolve(root, "scripts/skin-png/bounded-inflate.js");
let decoder = replacePinned(sources["fast-png/lib/png_decoder.js"],
  "import { Unzlib as Inflator, unzlibSync } from 'fflate';",
  `import { Unzlib as Inflator, unzlibSync } from ${JSON.stringify(inflatePath)};`);
decoder = replacePinned(decoder, "        });\n        this._chunks = [];",
  "        }, options.expectedInflatedBytes);\n        this._chunks = [];", 2);
let strictInflate = replacePinned(sources["pako/lib/inflate.js"], "while (strm.avail_in > 0 &&",
  "while (!this.options.strictZlib && strm.avail_in > 0 &&");
strictInflate = replacePinned(strictInflate, "    if (status === Z_STREAM_END) {\n",
  "    if (status === Z_STREAM_END) {\n      if (this.options.strictZlib && strm.avail_in !== 0) throw new Error('Trailing zlib bytes');\n");
const unsupportedText = "() => { throw new Error('PNG text paths are unsupported'); }";
const replacements = {
  "fast-png/lib/png_decoder.js": decoder,
  "fast-png/lib/helpers/text.js": `export const textChunkName = 'tEXt'; export const decodetEXt = ${unsupportedText}; export const encodetEXt = decodetEXt; export const readKeyword = decodetEXt;`,
  "iobuffer/lib/text.js": `export const encode = ${unsupportedText}; export const decode = encode;`,
  "pako/lib/inflate.js": strictInflate,
  "pako/lib/utils/strings.js": `module.exports.string2buf = module.exports.buf2string = module.exports.utf8border = ${unsupportedText};`,
};
const licenseParts = [];
const licenseHashes = {};
for (const dependency of packages) {
  const filename = `${dependency.name}/LICENSE`;
  const license = await readFile(resolve(packagesDirectory, filename), "utf8");
  licenseHashes[filename] = sha256(license);
  licenseParts.push(`${dependency.name} ${dependency.version}\n${license.trimEnd()}`);
}
const zlibSource = await readFile(resolve(packagesDirectory, "pako/lib/zlib/inflate.js"), "utf8");
const zlibNotice = zlibSource.slice(zlibSource.indexOf("// (C)"), zlibSource.indexOf("\nconst adler32")).trim();
if (!zlibNotice.includes("3. This notice may not be removed")) throw new Error("Missing Zlib license notice");
licenseParts.push(`pako embedded Zlib notice\n${zlibNotice}`);
const alterationNotice = "Altered source distribution: fast-png receives a fixed skin inflation budget; pako's high-level Inflate rejects concatenated and trailing zlib streams; optional text paths are disabled. The strictZlib flag is a local, version-bound adaptation, not a pako API. Original PNG filtering, CRC, palette conversion, zlib algorithms and encoding remain upstream library code.";
const licenses = `${alterationNotice}\n\n${licenseParts.join("\n\n")}\n`;
const require = createRequire(resolve(packagesDirectory, "esbuild/package.json"));
const { build } = require("./lib/main.js");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/skin-png/entry.js"],
  outfile: "png-codec.js", bundle: true, write: false, format: "esm", platform: "browser",
  target: "es2022", minify: true, legalComments: "none", metafile: true,
  define: { TextEncoder: "undefined", TextDecoder: "undefined" },
  banner: { js: `/*!\n${licenses.replaceAll("*/", "* /")}*/` },
  plugins: [{
    name: "pinned-binary-png",
    setup(builder) {
      builder.onResolve({ filter: /^(fast-png|fflate|iobuffer|pako\/lib\/inflate\.js)$/ }, ({ path }) => {
        const selected = { "fast-png": "fast-png/lib/index.js", fflate: "fflate/esm/browser.js", iobuffer: "iobuffer/lib/iobuffer.js", "pako/lib/inflate.js": "pako/lib/inflate.js" };
        return { path: resolve(packagesDirectory, selected[path]) };
      });
      builder.onLoad({ filter: /\.js$/ }, async ({ path }) => {
        const filename = relative(packagesDirectory, path);
        if (!(filename in replacements)) return undefined;
        return { contents: replacements[filename], resolveDir: dirname(path), loader: "js" };
      });
    },
  }],
});
const bundle = result.outputFiles[0].contents;
const sourceHashes = {};
for (const filename of Object.keys(result.metafile.inputs).sort()) {
  const absolute = resolve(root, filename);
  const packageFile = relative(packagesDirectory, absolute);
  const key = packageFile.startsWith("../") ? relative(root, absolute) : `node_modules/${packageFile}`;
  sourceHashes[key] = sha256(await readFile(absolute));
}
sourceHashes["scripts/build-skin-png.mjs"] = sha256(await readFile(fileURLToPath(import.meta.url)));
const provenance = JSON.stringify({
  packages: packages.map((dependency) => ({ ...dependency, source: `https://registry.npmjs.org/${dependency.name}/-/${dependency.name}-${dependency.version}.tgz` })),
  bundler: { name: "esbuild", version: "0.25.12", integrity: lock.packages["node_modules/esbuild"].integrity, format: "esm", platform: "browser", target: "es2022", minify: true },
  alterationNotice, guardedSources, sourceHashes, licenseHashes,
  output: { file: "png-codec.js", bytes: bundle.length, sha256: sha256(bundle) },
}, null, 2) + "\n";
const outputs = { "png-codec.js": bundle, "LICENSES.txt": licenses, "provenance.json": provenance };
if (!args.includes("--check")) await mkdir(outputDirectory, { recursive: true });
for (const [filename, contents] of Object.entries(outputs)) {
  const target = resolve(outputDirectory, filename);
  if (args.includes("--check")) {
    if (sha256(await readFile(target)) !== sha256(contents)) throw new Error(`Generated PNG artifact differs: ${filename}`);
  } else {
    await writeFile(target, contents);
  }
}
console.log(JSON.stringify({ status: args.includes("--check") ? "MATCH" : "GENERATED", bytes: bundle.length, sha256: sha256(bundle) }));
