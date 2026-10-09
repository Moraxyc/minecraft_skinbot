import assert from "node:assert/strict";
import { test } from "node:test";
import { MinecraftError } from "../../tgcloud/lib/minecraft/errors.js";
import {
  decodeSnapshot, encodeSnapshot, normalizeUUID, parseQuery, parseTextureURL, textureURL,
} from "../../tgcloud/lib/minecraft/reference.js";

const UUID = "069a79f444e94726a5befca90e38aaf5";
const SKIN_HASH = "a".repeat(64);
const CAPE_HASH = "b".repeat(32);

test("queries normalize UUIDs while keeping usernames separate from fixed snapshots", () => {
  assert.deepEqual(parseQuery(" Notch "), { kind: "username", username: "Notch" });
  assert.deepEqual(parseQuery("abc"), { kind: "username", username: "abc" });
  assert.deepEqual(parseQuery("a".repeat(16)), { kind: "username", username: "a".repeat(16) });
  for (const value of [UUID, "069A79F4-44E9-4726-A5BE-FCA90E38AAF5"]) {
    assert.deepEqual(parseQuery(value), { kind: "uuid", uuid: UUID });
    assert.equal(normalizeUUID(value), UUID);
  }
  assert.deepEqual(parseQuery("texture:s-" + SKIN_HASH + "-" + CAPE_HASH), {
    kind: "snapshot", snapshot: { model: "slim", skinHash: SKIN_HASH, capeHash: CAPE_HASH },
  });
});

test("immutable tokens roundtrip classic, slim, and unknown skins without a player lookup", () => {
  for (const [code, model] of [["c", "classic"], ["s", "slim"], ["u", "unknown"]]) {
    for (const capeHash of [null, CAPE_HASH, "b".repeat(64)]) {
      const snapshot = { model, skinHash: SKIN_HASH, capeHash };
      const token = code + "-" + SKIN_HASH + (capeHash === null ? "" : "-" + capeHash);
      assert.equal(encodeSnapshot(snapshot), token);
      assert.deepEqual(decodeSnapshot(token), snapshot);
      assert.match(token, /^[A-Za-z0-9_-]+$/u);
    }
  }
  assert.equal(encodeSnapshot({ model: "classic", skinHash: "a".repeat(32) }),
    "c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("malformed references and snapshot boundaries cannot introduce arbitrary URLs", () => {
  for (const reference of [null, {}, "", "ab", "a".repeat(17), "玩家名", "Name/other",
    "069a79f4-44e94726-a5be-fca90e38aaf5", UUID + "x", " ".repeat(257)]) {
    assert.throws(() => parseQuery(reference), { code: "INVALID_REFERENCE", status: 400 });
  }
  for (const token of ["c-" + "a".repeat(31), "s-" + "a".repeat(65),
    "u-" + SKIN_HASH + "-" + "b".repeat(31), "c-" + SKIN_HASH + "-" + "b".repeat(65),
    "x-" + SKIN_HASH, "c-" + "A".repeat(64),
    "c-" + SKIN_HASH + "-" + CAPE_HASH + "-" + CAPE_HASH, null]) {
    assert.throws(() => decodeSnapshot(token), MinecraftError);
    assert.throws(() => parseQuery("texture:" + token), MinecraftError);
  }
  assert.throws(() => decodeSnapshot("c-" + SKIN_HASH + "\n"), MinecraftError);
  for (const snapshot of [null, [], { model: "__proto__", skinHash: SKIN_HASH },
    { model: "slim", skinHash: "a".repeat(65) },
    { model: "classic", skinHash: SKIN_HASH, capeHash: false }]) {
    assert.throws(() => encodeSnapshot(snapshot), MinecraftError);
  }
});

test("texture URLs accept only exact official texture paths and always produce HTTPS", () => {
  const url = "https://textures.minecraft.net/texture/" + SKIN_HASH;
  assert.equal(parseTextureURL(url), SKIN_HASH);
  assert.equal(parseTextureURL("http://textures.minecraft.net/texture/" + CAPE_HASH), CAPE_HASH);
  assert.equal(textureURL(SKIN_HASH), url);
  for (const value of [null, "http://127.0.0.1/texture/" + SKIN_HASH,
    "https://textures.minecraft.net@evil.example/texture/" + SKIN_HASH,
    "https://textures.minecraft.net.evil.example/texture/" + SKIN_HASH,
    "https://textures.minecraft.net:443/texture/" + SKIN_HASH,
    url + "?redirect=evil", url + "#fragment", url + "\n", url + "/",
    "https://textures.minecraft.net/texture/../" + SKIN_HASH,
    "https://textures.minecraft.net/texture/%61" + SKIN_HASH.slice(1),
    "ftp://textures.minecraft.net/texture/" + SKIN_HASH]) {
    assert.throws(() => parseTextureURL(value), { code: "INVALID_REFERENCE" });
  }
  for (const value of ["a".repeat(31), "a".repeat(65), SKIN_HASH + "\n", "A".repeat(64), "../skin"]) {
    assert.throws(() => textureURL(value), { code: "INVALID_REFERENCE" });
  }
});
