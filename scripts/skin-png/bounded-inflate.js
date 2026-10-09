import { Inflate } from "pako/lib/inflate.js";

export class Unzlib {
  constructor(callback, expectedBytes) {
    if (!Number.isInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 16_448) {
      throw new Error("Invalid skin inflation budget");
    }
    this.total = 0;
    this.done = false;
    this.stream = new Inflate({ chunkSize: 1024, windowBits: 15, strictZlib: true });
    this.stream.onData = (chunk) => {
      this.total += chunk.length;
      if (this.total > expectedBytes) throw new Error("Inflated skin exceeds budget");
      callback(chunk, false);
    };
    this.stream.onEnd = (status) => {
      if (status !== 0) throw new Error("Invalid skin zlib stream");
      if (this.total !== expectedBytes) throw new Error("Inflated skin length mismatch");
      this.done = true;
      callback(new Uint8Array(0), true);
    };
  }

  push(data, final) {
    if (this.done) {
      if (data.length) throw new Error("Trailing skin zlib data");
      return;
    }
    this.stream.push(data, final);
    if (this.stream.err || (final && !this.done)) throw new Error("Incomplete skin zlib stream");
  }
}

export function unzlibSync() {
  throw new Error("Compressed PNG metadata is unsupported");
}
