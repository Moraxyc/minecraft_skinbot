{ inputs, ... }:
let
  workspace = inputs.uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ../.; };
in
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      pythonBuilds = import ./package.nix {
        inherit lib pkgs workspace;
        inherit (inputs) pyproject-nix pyproject-build-systems;
      };
    in
    {
      _module.args = {
        inherit pythonBuilds workspace;
      };
      packages = {
        default = config.packages.bot;
        bot = pythonBuilds.application;
        web = pkgs.callPackage ./web.nix { };
      };
    };
}
