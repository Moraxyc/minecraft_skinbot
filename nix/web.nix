{
  lib,
  stdenv,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  apiBase ? "",
}:
let
  source = lib.fileset.toSource {
    root = ../web;
    fileset = lib.fileset.unions [
      ../web/package.json
      ../web/package-lock.json
      ../web/index.html
      ../web/tsconfig.json
      ../web/vite.config.ts
      ../web/playwright.config.ts
      ../web/.oxlintrc.json
      (lib.fileset.fileFilter (file: file.hasExt "ts" || file.hasExt "css") ../web/src)
      (lib.fileset.fileFilter (file: file.hasExt "ts") ../web/tests)
    ];
  };
in
buildNpmPackage {
  pname = "minecraft-skin-viewer";
  version = "0.1.0";
  src = source;
  nodejs = nodejs_24;
  npmDeps = importNpmLock { npmRoot = source; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env = {
    VITE_API_BASE_URL = apiBase;
  };
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
