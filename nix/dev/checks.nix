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
        address: nginx: tokenFile: package:
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
                nginx = lib.optionalAttrs nginx {
                  enable = true;
                  hostName = "skin.example.com";
                };
              };
            }
          ];
        }).config;
      proxied = configuration "127.0.0.1" true "/run/secrets/synthetic-skin-bot" bot;
      direct = configuration "::1" false "/run/secrets/synthetic-skin-bot" bot;
      invalid = configuration "127.0.0.1" false "/nix/store/synthetic-token" bot;
      probe = configuration "127.0.0.1" false "/run/secrets/synthetic-skin-bot" (
        pkgs.writeShellScriptBin "minecraft-skin-bot" ''
          test "$TELEGRAM_BOT_TOKEN" = '123456:synthetic_fixture_only'
        ''
      );
      allAssertions = configuration: builtins.all (item: item.assertion) configuration.assertions;
      service = proxied.systemd.services.minecraft-skin-bot;
      directService = direct.systemd.services.minecraft-skin-bot;
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
            assert allAssertions proxied;
            assert allAssertions direct;
            assert !allAssertions invalid;
            assert
              service.serviceConfig.LoadCredential == [
                "telegram-bot-token:/run/secrets/synthetic-skin-bot"
              ];
            assert service.serviceConfig.CacheDirectory == "minecraft-skin-bot";
            assert service.serviceConfig.DynamicUser;
            assert service.environment.CACHE_DIR == "/var/cache/minecraft-skin-bot";
            assert service.environment.API_UNIX_SOCKET == "/run/minecraft-skin-bot/api.sock";
            assert service.environment.API_UNIX_SOCKET_GROUP == "nginx";
            assert !(service.environment ? API_HOST);
            assert service.serviceConfig.RuntimeDirectory == "minecraft-skin-bot";
            assert service.serviceConfig.SupplementaryGroups == [ "nginx" ];
            assert
              proxied.services.nginx.virtualHosts."skin.example.com".locations."/api/".proxyPass
              == "http://unix:/run/minecraft-skin-bot/api.sock";
            assert
              proxied.services.nginx.virtualHosts."skin.example.com".locations."/healthz".proxyPass
              == "http://unix:/run/minecraft-skin-bot/api.sock";
            assert directService.environment.API_HOST == "::1";
            assert directService.environment.API_PORT == "8080";
            assert !(directService.serviceConfig ? RuntimeDirectory);
            pkgs.runCommand "minecraft-skin-bot-module-checks"
              {
                unit = proxied.systemd.units."minecraft-skin-bot.service".unit;
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
