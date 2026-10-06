{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.minecraft-skin-bot;
  socketPath = "/run/minecraft-skin-bot/api.sock";
  socketUnit = "minecraft-skin-bot.socket";
  proxyOverSocket = cfg.nginx.enable;
  proxyGroup = config.services.nginx.group;
  webhookUrl = if cfg.webhookUrl == null then null else lib.removeSuffix "/" cfg.webhookUrl;
  webhookMatch = if webhookUrl == null then null else builtins.match "https://[^/]+(/.*)" webhookUrl;
  webhookPath = if webhookMatch == null then null else builtins.head webhookMatch;
in
{
  meta.maintainers = with lib.maintainers; [ moraxyc ];
  options.services.minecraft-skin-bot = {
    enable = lib.mkEnableOption "Minecraft skin bot";
    package = lib.mkPackageOption pkgs "minecraft-skin-bot" { };
    webPackage = lib.mkOption {
      type = lib.types.package;
      description = "Built Mini App assets.";
    };
    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/minecraft-skin-bot-token";
      description = "Absolute runtime path to the bot token supplied through a systemd credential.";
    };
    cacheChatId = lib.mkOption {
      type = lib.types.nullOr lib.types.int;
      default = null;
      example = -1001234567890;
      description = "Telegram channel or chat used for technical media uploads.";
    };
    miniAppUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://skin.example.com";
      description = "Public HTTPS Mini App URL.";
    };
    publicBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://skin.example.com";
      description = "Public HTTPS API base URL.";
    };
    apiHost = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "API listener address for deployments without the nginx integration.";
    };
    apiPort = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "API listener port for deployments without the nginx integration.";
    };
    webhookUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "https://skin.example.com/telegram/webhook";
      description = ''
        Public HTTPS endpoint that receives Telegram updates. Unset keeps long
        polling. The bot draws the Telegram secret token at startup and
        registers it with setWebhook, so no secret file is required.
      '';
    };
    uploadTtlSeconds = lib.mkOption {
      type = lib.types.ints.between 60 31536000;
      default = 86400;
      description = "Uploaded content availability in seconds.";
    };
    richMessages = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable Rich Message previews on supported Telegram clients.";
    };
    nginx = {
      enable = lib.mkEnableOption "nginx hosting for the Mini App and public API";
      hostName = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "skin.example.com";
        description = "nginx virtual host for the Mini App and API.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          cfg.tokenFile != null
          && lib.hasPrefix "/" cfg.tokenFile
          && !lib.hasPrefix builtins.storeDir cfg.tokenFile;
        message = "Set services.minecraft-skin-bot.tokenFile to an absolute runtime file path.";
      }
      {
        assertion = cfg.cacheChatId != null;
        message = "Set services.minecraft-skin-bot.cacheChatId to the media cache chat ID.";
      }
      {
        assertion = lib.hasPrefix "https://" cfg.miniAppUrl && lib.hasPrefix "https://" cfg.publicBaseUrl;
        message = "Set HTTPS URLs for the Mini App and public API.";
      }
      {
        assertion = cfg.nginx.enable || cfg.apiPort >= 1024;
        message = "Use an API listener port of at least 1024 for the direct listener.";
      }
      {
        assertion = cfg.nginx.enable -> cfg.nginx.hostName != "";
        message = "Set the nginx host name for the hosted viewer.";
      }
      {
        assertion =
          cfg.webhookUrl == null
          || (webhookPath != null && webhookPath != "/healthz" && !lib.hasPrefix "/api/" webhookPath);
        message = ''
          Set services.minecraft-skin-bot.webhookUrl to an https URL with a path,
          such as https://skin.example.com/telegram/webhook, and keep it clear of
          the reserved /api/ and /healthz routes.
        '';
      }
    ];
    systemd.sockets.minecraft-skin-bot = lib.mkIf proxyOverSocket {
      description = "Minecraft skin bot public viewer API socket";
      wantedBy = [ "sockets.target" ];
      listenStreams = [ socketPath ];
      socketConfig = {
        SocketMode = "0660";
        SocketGroup = proxyGroup;
      };
    };
    systemd.services.minecraft-skin-bot = {
      description = "Minecraft skin bot and public viewer API";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        TELEGRAM_CACHE_CHAT_ID = toString cfg.cacheChatId;
        MINI_APP_URL = cfg.miniAppUrl;
        PUBLIC_BASE_URL = cfg.publicBaseUrl;
        CACHE_DIR = "/var/cache/minecraft-skin-bot";
        UPLOAD_TTL_SECONDS = toString cfg.uploadTtlSeconds;
        TELEGRAM_RICH_MESSAGES = lib.boolToString cfg.richMessages;
      }
      // lib.optionalAttrs (!proxyOverSocket) {
        API_HOST = cfg.apiHost;
        API_PORT = toString cfg.apiPort;
      }
      // lib.optionalAttrs (webhookUrl != null) {
        TELEGRAM_WEBHOOK_URL = webhookUrl;
      };
      enableStrictShellChecks = true;
      script = ''
        TELEGRAM_BOT_TOKEN="$(<"$CREDENTIALS_DIRECTORY/telegram-bot-token")"
        export TELEGRAM_BOT_TOKEN
        : "''${TELEGRAM_BOT_TOKEN:?Bot token credential is empty}"
        exec ${lib.getExe cfg.package}
      '';
      serviceConfig = {
        LoadCredential = lib.optional (cfg.tokenFile != null) "telegram-bot-token:${cfg.tokenFile}";
        DynamicUser = true;
        CacheDirectory = "minecraft-skin-bot";
        CacheDirectoryMode = "0700";
        WorkingDirectory = "/var/cache/minecraft-skin-bot";
        Restart = "on-failure";
        RestartSec = "5s";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        LockPersonality = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
      }
      // lib.optionalAttrs proxyOverSocket {
        Sockets = [ socketUnit ];
      };
    };
    services.nginx = lib.mkIf cfg.nginx.enable {
      enable = true;
      virtualHosts.${cfg.nginx.hostName} = {
        root = cfg.webPackage;
        locations = {
          "/" = {
            tryFiles = "$uri $uri/ /index.html";
          };
          "/api/" = {
            proxyPass = "http://unix:${socketPath}";
            extraConfig = ''
              proxy_connect_timeout 3s;
              proxy_read_timeout 25s;
            '';
          };
          "/healthz" = {
            proxyPass = "http://unix:${socketPath}";
          };
        }
        // lib.optionalAttrs (webhookPath != null) {
          ${webhookPath} = {
            proxyPass = "http://unix:${socketPath}";
            extraConfig = ''
              proxy_connect_timeout 3s;
              proxy_read_timeout 25s;
            '';
          };
        };
      };
    };
  };
}
