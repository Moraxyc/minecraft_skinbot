{ self, ... }:
let
  botModule =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      imports = [ ./module.nix ];
      services.minecraft-skin-bot = {
        package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.bot;
        webPackage = lib.mkDefault (
          self.packages.${pkgs.stdenv.hostPlatform.system}.web.override {
            apiBase = config.services.minecraft-skin-bot.publicBaseUrl;
          }
        );
      };
    };
in
{
  flake.nixosModules = {
    default = botModule;
    minecraft-skin-bot = botModule;
  };
}
