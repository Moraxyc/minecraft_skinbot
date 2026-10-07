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
        {
          address,
          nginx,
          tokenFile,
          package,
          webhookUrl ? null,
          lookupRateLimit ? { },
          cacheMaxBytes ? 536870912,
        }:
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
                inherit webhookUrl;
                inherit cacheMaxBytes;
                package = lib.mkForce package;
                apiHost = address;
                cacheChatId = -1001234567890;
                miniAppUrl = "https://skin.example.com";
                publicBaseUrl = "https://skin.example.com";
                nginx = lib.optionalAttrs nginx {
                  enable = true;
                  hostName = "skin.example.com";
                  inherit lookupRateLimit;
                };
              };
            }
          ];
        }).config;
      proxied = configuration {
        address = "127.0.0.1";
        nginx = true;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
      };
      hooked = configuration {
        address = "127.0.0.1";
        nginx = true;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
        webhookUrl = "https://skin.example.com/telegram/webhook/";
      };
      direct = configuration {
        address = "::1";
        nginx = false;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
      };
      limited = configuration {
        address = "127.0.0.1";
        nginx = true;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
        cacheMaxBytes = 1048576;
        lookupRateLimit = {
          requestsPerSecond = 1;
          burst = 1;
        };
      };
      unlimited = configuration {
        address = "127.0.0.1";
        nginx = true;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
        lookupRateLimit.enable = false;
      };
      invalid = configuration {
        address = "127.0.0.1";
        nginx = false;
        tokenFile = "/nix/store/synthetic-token";
        package = bot;
      };
      invalidWebhook = configuration {
        address = "127.0.0.1";
        nginx = true;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = bot;
        webhookUrl = "https://skin.example.com/api/hook";
      };
      probe = configuration {
        address = "127.0.0.1";
        nginx = false;
        tokenFile = "/run/secrets/synthetic-skin-bot";
        package = pkgs.writeShellScriptBin "minecraft-skin-bot" ''
          test "$TELEGRAM_BOT_TOKEN" = '123456:synthetic_fixture_only'
        '';
      };
      allAssertions = configuration: builtins.all (item: item.assertion) configuration.assertions;
      service = proxied.systemd.services.minecraft-skin-bot;
      hookedService = hooked.systemd.services.minecraft-skin-bot;
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
                python - <<'PY'
                import gettext
                from importlib.resources import files

                catalogs = files("minecraft_skin_bot").joinpath("locales")
                translation = gettext.translation("messages", localedir=str(catalogs), languages=["zh_Hans"])
                assert translation.gettext("Open 3D") == "打开 3D"
                PY
                cp -r ${
                  lib.fileset.toSource {
                    root = ../../.;
                    fileset = lib.fileset.unions [
                      ../../pyproject.toml
                      ../../README.md
                      (lib.fileset.fileFilter (file: file.hasExt "py" || file.hasExt "po" || file.hasExt "mo") ../../bot)
                      (lib.fileset.fileFilter (file: file.hasExt "py" || file.hasExt "png") ../../tests)
                    ];
                  }
                } source
                chmod -R u+w source
                cd source
                cp -r bot/src/minecraft_skin_bot/locales "$TMPDIR/catalogs"
                pybabel compile -d "$TMPDIR/catalogs" -D messages
                for catalog in bot/src/minecraft_skin_bot/locales/*/LC_MESSAGES/messages.mo; do
                  cmp "$catalog" "$TMPDIR/catalogs/''${catalog#bot/src/minecraft_skin_bot/locales/}"
                done
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
            assert allAssertions hooked;
            assert allAssertions direct;
            assert allAssertions limited;
            assert allAssertions unlimited;
            assert !allAssertions invalid;
            assert !allAssertions invalidWebhook;
            assert
              service.serviceConfig.LoadCredential == [
                "telegram-bot-token:/run/secrets/synthetic-skin-bot"
              ];
            assert service.serviceConfig.CacheDirectory == "minecraft-skin-bot";
            assert service.serviceConfig.DynamicUser;
            assert service.environment.CACHE_DIR == "/var/cache/minecraft-skin-bot";
            assert service.environment.CACHE_MAX_BYTES == "536870912";
            assert limited.systemd.services.minecraft-skin-bot.environment.CACHE_MAX_BYTES == "1048576";
            assert !(service.environment ? API_UNIX_SOCKET);
            assert !(service.environment ? API_UNIX_SOCKET_GROUP);
            assert !(service.environment ? API_HOST);
            assert !(service.environment ? TELEGRAM_WEBHOOK_URL);
            assert
              hookedService.environment.TELEGRAM_WEBHOOK_URL == "https://skin.example.com/telegram/webhook";
            assert
              hooked.services.nginx.virtualHosts."skin.example.com".locations."/telegram/webhook".proxyPass
              == "http://unix:/run/minecraft-skin-bot/api.sock";
            assert !(proxied.services.nginx.virtualHosts."skin.example.com".locations ? "/telegram/webhook");
            assert service.serviceConfig.Sockets == [ "minecraft-skin-bot.socket" ];
            assert !(service.serviceConfig ? RuntimeDirectory);
            assert !(service.serviceConfig ? SupplementaryGroups);
            assert
              proxied.systemd.sockets.minecraft-skin-bot.listenStreams == [
                "/run/minecraft-skin-bot/api.sock"
              ];
            assert
              proxied.systemd.sockets.minecraft-skin-bot.socketConfig == {
                SocketMode = "0660";
                SocketGroup = "nginx";
              };
            assert proxied.systemd.sockets.minecraft-skin-bot.wantedBy == [ "sockets.target" ];
            assert !(direct.systemd.sockets ? minecraft-skin-bot);
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
                nativeBuildInputs = [
                  pkgs.nginx
                  pkgs.curl
                ];
                unit = proxied.systemd.units."minecraft-skin-bot.service".unit;
                socketUnit = proxied.systemd.units."minecraft-skin-bot.socket".unit;
                probeScript = lib.removeSuffix " " probe.systemd.services.minecraft-skin-bot.serviceConfig.ExecStart;
              }
              ''
                test -f "$unit/minecraft-skin-bot.service"
                test -f "$socketUnit/minecraft-skin-bot.socket"
                mkdir "$TMPDIR/credentials"
                printf %s '123456:synthetic_fixture_only' > "$TMPDIR/credentials/telegram-bot-token"
                CREDENTIALS_DIRECTORY="$TMPDIR/credentials" "$probeScript"
                : > "$TMPDIR/credentials/telegram-bot-token"
                if CREDENTIALS_DIRECTORY="$TMPDIR/credentials" "$probeScript" 2>/dev/null; then
                  exit 1
                fi
                mkdir -p "$TMPDIR/content/api/"{profile,texture,upload,skin,cape} "$TMPDIR/content/telegram"
                for path in api/profile/test api/texture/test api/upload/test api/skin/test api/cape/test healthz index.html telegram/webhook; do
                  printf %s 'synthetic content' > "$TMPDIR/content/$path"
                done
                cat > "$TMPDIR/nginx.conf" <<CONF
                pid $TMPDIR/nginx.pid;
                error_log stderr;
                events {}
                http {
                  access_log off;
                  client_body_temp_path $TMPDIR/client_temp;
                  proxy_temp_path $TMPDIR/proxy_temp;
                  fastcgi_temp_path $TMPDIR/fastcgi_temp;
                  uwsgi_temp_path $TMPDIR/uwsgi_temp;
                  scgi_temp_path $TMPDIR/scgi_temp;
                  ${limited.services.nginx.commonHttpConfig}
                  server {
                    listen 127.0.0.1:18081;
                    root $TMPDIR/content;
                    location ~ ^/api/(profile|texture|upload)/ {
                      ${limited.services.nginx.virtualHosts."skin.example.com".locations."~ ^/api/(profile|texture|upload)/".extraConfig
                      }
                    }
                  }
                  server {
                    listen 127.0.0.1:18082;
                    root $TMPDIR/content;
                    location /api/ {
                      ${unlimited.services.nginx.virtualHosts."skin.example.com".locations."/api/".extraConfig}
                    }
                  }
                }
                CONF
                nginx -t -p "$TMPDIR" -c "$TMPDIR/nginx.conf"
                nginx -p "$TMPDIR" -c "$TMPDIR/nginx.conf" -g 'daemon off;' &
                nginx_pid=$!
                trap 'kill "$nginx_pid"; wait "$nginx_pid" || true' EXIT
                for attempt in $(seq 1 50); do
                  if curl --silent --max-time 0.1 --fail http://127.0.0.1:18081/healthz > /dev/null; then
                    break
                  fi
                  sleep 0.1
                done
                rejected=0
                for attempt in $(seq 1 10); do
                  for path in profile texture upload; do
                    status=$(curl --silent --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:18081/api/$path/test")
                    case "$status" in
                      200) ;;
                      429) rejected=$((rejected + 1));;
                      *) exit 1;;
                    esac
                  done
                done
                test "$rejected" -gt 0
                for path in healthz index.html telegram/webhook api/skin/test api/cape/test; do
                  test "$(curl --silent --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:18081/$path")" = 200
                done
                for attempt in $(seq 1 10); do
                  test "$(curl --silent --max-time 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:18082/api/profile/test)" = 200
                done
                touch "$out"
              '';
        }
      );
    };
}
