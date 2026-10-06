{
  lib,
  pkgs,
  workspace,
  pyproject-nix,
  pyproject-build-systems,
}:
let
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../pyproject.toml
      ../README.md
      (lib.fileset.fileFilter (file: file.hasExt "py" || file.hasExt "po" || file.hasExt "mo") ../bot)
    ];
  };
  overlay = workspace.mkPyprojectOverlay { sourcePreference = "wheel"; };
  overrides = final: prev: {
    minecraft-skin-bot = prev.minecraft-skin-bot.overrideAttrs (old: {
      src = source;
      nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ final.resolveBuildSystem { hatchling = [ ]; };
      meta = (old.meta or { }) // {
        description = "Minecraft skin resolver and Telegram inline utility";
        mainProgram = "minecraft-skin-bot";
        maintainers = with lib.maintainers; [ moraxyc ];
      };
    });
  };
  pythonSet =
    (pkgs.callPackage pyproject-nix.build.packages { python = pkgs.python312; }).overrideScope
      (
        lib.composeManyExtensions [
          pyproject-build-systems.overlays.wheel
          overlay
          overrides
        ]
      );
  production = pythonSet.mkVirtualEnv "minecraft-skin-bot-env" workspace.deps.default;
  inherit (pkgs.callPackages pyproject-nix.build.util { }) mkApplication;
in
{
  inherit pythonSet production;
  application = mkApplication {
    venv = production;
    package = pythonSet.minecraft-skin-bot;
  };
  development = pythonSet.mkVirtualEnv "minecraft-skin-bot-tests" workspace.deps.all;
}
