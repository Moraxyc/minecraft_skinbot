{ inputs, self, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      pythonBuilds,
      ...
    }:
    let
      nixpkgs = inputs.nixpkgs;
      environment = pythonBuilds.development;
      inherit (config.packages) bot web;
      module = self.nixosModules.default;
      configuration =
        address: tokenFile: package:
        (nixpkgs.lib.nixosSystem {
          inherit pkgs;
          modules = [
            module
            {
              nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system;
              system.stateVersion = "26.05";
              boot.loader.grub.enable = false;
              fileSystems."/" = {
                device = "nodev";
                fsType = "tmpfs";
              };
              services.minecraft-skin-bot = {
                enable = true;
                inherit tokenFile;
                package = lib.mkForce package;
                apiHost = address;
                cacheChatId = -1001234567890;
                miniAppUrl = "https://skin.example.com";
                publicBaseUrl = "https://skin.example.com";
                nginx = {
                  enable = true;
                  hostName = "skin.example.com";
                };
              };
            }
          ];
        }).config;
      ipv4 = configuration "127.0.0.1" "/run/secrets/synthetic-skin-bot" bot;
      ipv6 = configuration "::1" "/run/secrets/synthetic-skin-bot" bot;
      invalid = configuration "127.0.0.1" "/nix/store/synthetic-token" bot;
      probe = configuration "127.0.0.1" "/run/secrets/synthetic-skin-bot" (
        pkgs.writeShellScriptBin "minecraft-skin-bot" ''
          test "$TELEGRAM_BOT_TOKEN" = '123456:synthetic_fixture_only'
        ''
      );
      allAssertions = configuration: builtins.all (item: item.assertion) configuration.assertions;
      service = ipv4.systemd.services.minecraft-skin-bot;
    in
    {
      checks = (
        {
          inherit bot web;
          python =
            pkgs.runCommand "minecraft-skin-bot-checks"
              {
                nativeBuildInputs = [ environment ];
              }
              ''
                cp -r ${
                  lib.fileset.toSource {
                    root = ../../.;
                    fileset = lib.fileset.unions [
                      ../../pyproject.toml
                      ../../README.md
                      (lib.fileset.fileFilter (file: file.hasExt "py") ../../bot)
                      (lib.fileset.fileFilter (file: file.hasExt "py" || file.hasExt "png") ../../tests)
                    ];
                  }
                } source
                chmod -R u+w source
                cd source
                export MYPY_CACHE_DIR="$TMPDIR/mypy"
                ruff check .
                ruff format --check .
                mypy
                pytest
                touch "$out"
              '';
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          module =
            assert allAssertions ipv4;
            assert allAssertions ipv6;
            assert !allAssertions invalid;
            assert
              service.serviceConfig.LoadCredential == [
                "telegram-bot-token:/run/secrets/synthetic-skin-bot"
              ];
            assert service.serviceConfig.CacheDirectory == "minecraft-skin-bot";
            assert service.serviceConfig.DynamicUser;
            assert service.environment.CACHE_DIR == "/var/cache/minecraft-skin-bot";
            assert
              ipv4.services.nginx.virtualHosts."skin.example.com".locations."/api/".proxyPass
              == "http://127.0.0.1:8080";
            assert
              ipv6.services.nginx.virtualHosts."skin.example.com".locations."/api/".proxyPass
              == "http://[::1]:8080";
            pkgs.runCommand "minecraft-skin-bot-module-checks"
              {
                unit = ipv4.systemd.units."minecraft-skin-bot.service".unit;
                probeScript = lib.removeSuffix " " probe.systemd.services.minecraft-skin-bot.serviceConfig.ExecStart;
              }
              ''
                test -f "$unit/minecraft-skin-bot.service"
                mkdir "$TMPDIR/credentials"
                printf %s '123456:synthetic_fixture_only' > "$TMPDIR/credentials/telegram-bot-token"
                CREDENTIALS_DIRECTORY="$TMPDIR/credentials" "$probeScript"
                : > "$TMPDIR/credentials/telegram-bot-token"
                if CREDENTIALS_DIRECTORY="$TMPDIR/credentials" "$probeScript" 2>/dev/null; then
                  exit 1
                fi
                touch "$out"
              '';
        }
      );
    };
}
