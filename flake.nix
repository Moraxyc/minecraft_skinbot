{
  description = "Telegram Serverless Minecraft skin bot and static Mini App";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import inputs.systems;
      perSystem =
        { pkgs, ... }:
        let
          npm = pkgs.stdenvNoCC.mkDerivation {
            pname = "npm";
            version = "12.2.0";
            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/npm/-/npm-12.2.0.tgz";
              hash = "sha256-Zma0iBazm4bD/rrHtRpO5N5sXKWJw4KtgAS2sRP4Znc=";
            };
            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.nodejs_24
            ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/lib/node_modules/npm" "$out/bin"
              cp -r . "$out/lib/node_modules/npm"
              for command in npm npx; do
                makeWrapper "${pkgs.nodejs_24}/bin/node" "$out/bin/$command" \
                  --add-flags "$out/lib/node_modules/npm/bin/$command-cli.js" \
                  --prefix PATH : "$out/bin:${pkgs.nodejs_24}/bin"
              done
              runHook postInstall
            '';
            meta = {
              license = pkgs.lib.licenses.artistic2;
              mainProgram = "npm";
              platforms = pkgs.nodejs_24.meta.platforms;
            };
          };
          web = pkgs.callPackage ./nix/web.nix { inherit npm; };
        in
        {
          packages = {
            default = web;
            inherit npm web;
          };
          checks = { inherit web; };
          devShells.default = pkgs.mkShell {
            packages = [
              npm
              pkgs.nodejs_24
              pkgs.nixfmt
            ];
          };
          formatter = pkgs.nixfmt;
        };
    };
}
