{
  perSystem =
    {
      lib,
      pkgs,
      pythonBuilds,
      workspace,
      ...
    }:
    let
      pythonSet = pythonBuilds.pythonSet.overrideScope (
        lib.composeManyExtensions [
          (workspace.mkEditablePyprojectOverlay { root = "$REPO_ROOT"; })
          (final: prev: {
            minecraft-skin-bot = prev.minecraft-skin-bot.overrideAttrs (old: {
              nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ final.resolveBuildSystem { editables = [ ]; };
            });
          })
        ]
      );
      environment = pythonSet.mkVirtualEnv "minecraft-skin-bot-dev" workspace.deps.all;
    in
    {
      devShells.default = pkgs.mkShell {
        packages = [
          environment
          pkgs.uv
          pkgs.nodejs_24
          pkgs.nixfmt
        ];
        env = {
          UV_NO_SYNC = "1";
          UV_PROJECT_ENVIRONMENT = environment;
          UV_PYTHON_DOWNLOADS = "never";
        };
        shellHook = ''
          unset PYTHONPATH
          export REPO_ROOT="$(git rev-parse --show-toplevel)"
        '';
      };
      formatter = pkgs.nixfmt;
    };
}
