{
  lib,
  stdenv,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  npm,
}:
let
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../web/package.json
      ../web/package-lock.json
      ../web/index.html
      ../web/tsconfig.json
      ../web/vite.config.ts
      ../web/playwright.config.ts
      ../web/.oxlintrc.json
      ../tgcloud/lib/skin/renderer.js
      ../tgcloud/lib/skin/renderer.d.ts
      ../tgcloud/lib/skin/labels.js
      ../tgcloud/lib/skin/labels.d.ts
      (lib.fileset.fileFilter (
        file: file.hasExt "ts" || file.hasExt "css" || file.hasExt "md"
      ) ../web/src)
      (lib.fileset.fileFilter (file: file.hasExt "ts" || file.hasExt "png") ../web/tests)
      (lib.fileset.fileFilter (file: file.hasExt "png") ../tests/golden)
    ];
  };
in
buildNpmPackage {
  pname = "minecraft-skin-viewer";
  version = "0.1.0";
  src = source;
  sourceRoot = "source/web";
  nodejs = nodejs_24;
  nativeBuildInputs = [ npm ];
  npmDeps = importNpmLock { npmRoot = ../web; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmInstallFlags = [ "--ignore-scripts" ];
  npmRebuildFlags = [ "--ignore-scripts" ];
  preConfigure = ''
    node --version
    npm --version
    test "$(node -p 'require("./package.json").packageManager')" = "npm@$(npm --version)"
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run lint
    npm run typecheck
    npm test
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r dist/. "$out/"
    runHook postInstall
  '';
  meta = {
    description = "Interactive Minecraft skin viewer for Telegram";
    maintainers = with lib.maintainers; [ moraxyc ];
    platforms = [ stdenv.hostPlatform.system ];
  };
}
