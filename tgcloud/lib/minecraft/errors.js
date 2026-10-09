export class MinecraftError extends Error {
  constructor(code, status, message, retryAfter = null) {
    super(message);
    this.name = "MinecraftError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
