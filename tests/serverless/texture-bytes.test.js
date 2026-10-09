import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { MinecraftError } from "../../tgcloud/lib/minecraft/errors.js";

const requests = [];
let response;
mock.module("sdk", {
  exports: {
    async fetch(url, options) {
      requests.push({ url, options });
      if (response instanceof Error) throw response;
      return response;
    },
  },
});
const { fetchTextureBytes } = await import("../../tgcloud/lib/minecraft/texture-bytes.js");

const TEXTURE_URL = "https://textures.minecraft.net/texture/" + "a".repeat(64);

async function* stream(chunks) {
  yield* chunks;
}

function serve(body, headers = {}, overrides = {}) {
  response = {
    url: TEXTURE_URL,
    status: 200,
    headers: { get: (name) => ({ "content-type": "image/png", ...headers })[name] ?? null },
    body,
    ...overrides,
  };
}

function failure(code) {
  return (error) => error instanceof MinecraftError && error.code === code
    && error.status === 502 && error.retryAfter === null;
}

beforeEach(() => { requests.length = 0; response = undefined; });

test("preserves segmented raw bytes, view offsets and reused backing storage", async () => {
  const expected = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 254]);
  for (const declaredLength of [null, "12"]) {
    const backing = new Uint8Array([99, 137, 80, 78, 71, 99]);
    async function* chunks() {
      yield backing.subarray(1, 5);
      backing.fill(99);
      yield new Uint8Array([13, 10]).buffer;
      yield new DataView(new Uint8Array([99, 26, 10, 99]).buffer, 1, 2);
      yield new Uint8ClampedArray(new Uint8Array([99, 0, 255, 99]).buffer, 1, 2);
      yield new Int8Array(new Uint8Array([99, 128, 254, 99]).buffer, 1, 2);
    }
    serve(chunks(), {
      "content-length": declaredLength,
      "content-type": "IMAGE/PNG; charset=binary",
      "content-encoding": "identity",
    });
    const bytes = await fetchTextureBytes(TEXTURE_URL.replace("https:", "http:"));
    assert.deepEqual(bytes, expected);
    assert.equal(bytes.buffer.byteLength, expected.length);
    assert.deepEqual(requests.at(-1), {
      url: TEXTURE_URL,
      options: { method: "GET", headers: { Accept: "image/png" } },
    });
  }
});

test("rejects unsafe or mutable references before any upstream request", async () => {
  serve(stream([new Uint8Array([1])]));
  for (const reference of [null, "Notch", "a".repeat(64), TEXTURE_URL + "?next=evil",
    TEXTURE_URL + "\n", TEXTURE_URL.replace(".net/", ".net:443/"),
    TEXTURE_URL.replace("textures.minecraft.net", "textures.minecraft.net.evil.example"),
    TEXTURE_URL.replace("/texture/", "/texture/../")]) {
    await assert.rejects(fetchTextureBytes(reference), { code: "INVALID_REFERENCE", status: 400 });
  }
  assert.deepEqual(requests, []);
});

test("rejects upstream status, final URL and content violations before reading bytes", async () => {
  const cases = [
    ...[204, 206, 301, 404, 429, 500, "200"].map((status) => [{}, { status }]),
    [{}, { url: TEXTURE_URL.replace("a".repeat(64), "b".repeat(64)) }],
    [{}, { url: TEXTURE_URL + "?redirected=1" }],
    [{}, { url: undefined }],
    [{}, { headers: {} }],
    ...[null, "image/jpeg", "application/octet-stream", 42]
      .map((type) => [{ "content-type": type }, {}]),
    ...["gzip", "br", 42].map((encoding) => [{ "content-encoding": encoding }, {}]),
    ...["", "-1", "0", "1.5", "1,1", "NaN", "1\n", 12, "9007199254740992"]
      .map((length) => [{ "content-length": length }, {}]),
    [{ "content-length": "65537" }, {}, "TEXTURE_TOO_LARGE"],
  ];
  let reads = 0;
  async function* body() {
    reads += 1;
    yield new Uint8Array([1]);
  }
  for (const [headers, overrides, code = "UPSTREAM_UNAVAILABLE"] of cases) {
    serve(body(), headers, overrides);
    await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure(code));
  }
  response = null;
  await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UPSTREAM_UNAVAILABLE"));
  assert.equal(reads, 0);
});

test("rejects text, numeric collections and malformed chunks without partial success", async () => {
  const detached = new ArrayBuffer(1);
  structuredClone(detached, { transfer: [detached] });
  const wider = new Uint16Array([255]);
  Object.defineProperty(wider, "BYTES_PER_ELEMENT", { value: 1 });
  for (const chunk of ["\u0089PNG\r\n\u001a\n", null, undefined, 255, [0, 255],
    { buffer: new ArrayBuffer(1), byteOffset: 0, byteLength: 1 },
    wider, new Float32Array([1]), detached]) {
    let closed = false;
    async function* body() {
      try {
        yield new Uint8Array([137, 80]);
        yield chunk;
        assert.fail("Invalid chunks must stop collection.");
      } finally {
        closed = true;
      }
    }
    serve(body());
    await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UNSUPPORTED_BYTE_TRANSPORT"));
    assert.equal(closed, true);
  }
  for (const body of [null, undefined, "PNG", [new Uint8Array([1])],
    { [Symbol.asyncIterator]: 42 }]) {
    serve(body);
    await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UNSUPPORTED_BYTE_TRANSPORT"));
  }
});

test("bounds byte and chunk collection and detects truncated or excess declared lengths", async () => {
  const full = new Uint8Array(65536).fill(255);
  serve(stream([full.subarray(0, 32768), full.subarray(32768)]), { "content-length": "65536" });
  assert.deepEqual(await fetchTextureBytes(TEXTURE_URL), full);
  for (const [chunks, length, code] of [
    [[new Uint8Array(65537)], null, "TEXTURE_TOO_LARGE"],
    [[full, new Uint8Array([1])], null, "TEXTURE_TOO_LARGE"],
    [[full, new Uint8Array([1])], "65536", "TEXTURE_TOO_LARGE"],
    [[], null, "UPSTREAM_UNAVAILABLE"],
    [[new Uint8Array(0)], null, "UPSTREAM_UNAVAILABLE"],
    [[new Uint8Array([1])], "2", "UPSTREAM_UNAVAILABLE"],
    [[new Uint8Array([1, 2])], "1", "UPSTREAM_UNAVAILABLE"],
  ]) {
    let closed = false;
    async function* body() {
      try {
        yield* chunks;
      } finally {
        closed = true;
      }
    }
    serve(body(), { "content-length": length });
    await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure(code));
    assert.equal(closed, true);
  }
  let readChunks = 0;
  let closed = false;
  async function* emptyChunks() {
    try {
      while (readChunks < 65538) {
        readChunks += 1;
        yield new Uint8Array(0);
      }
      assert.fail("Empty chunks must not bypass the collection bound.");
    } finally {
      closed = true;
    }
  }
  serve(emptyChunks());
  await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UPSTREAM_UNAVAILABLE"));
  assert.equal(readChunks, 65537);
  assert.equal(closed, true);
});

test("normalizes SDK network and interrupted stream failures without returning partial bytes", async () => {
  response = new Error("Synthetic network failure.");
  await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UPSTREAM_UNAVAILABLE"));
  async function* interrupted() {
    yield new Uint8Array([137, 80]);
    throw new Error("Synthetic stream failure.");
  }
  serve(interrupted());
  await assert.rejects(fetchTextureBytes(TEXTURE_URL), failure("UPSTREAM_UNAVAILABLE"));
});
