import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { encodeSnapshot } from "../../tgcloud/lib/minecraft/reference.js";

const responses = new Map();
const requests = [];
mock.module("sdk", {
  exports: {
    async fetch(url) {
      requests.push(url);
      const response = responses.get(url);
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected upstream request.");
      return response;
    },
  },
});
const { resolveProfile } = await import("../../tgcloud/lib/minecraft/client.js");

const UUID = "069a79f444e94726a5befca90e38aaf5";
const OTHER_UUID = "853c80ef3c3749fdaa49938b674adae6";
const SKIN_HASH = "a".repeat(64);
const CAPE_HASH = "b".repeat(64);
const USERNAME_URL = "https://api.mojang.com/users/profiles/minecraft/notch";
const PROFILE_URL = "https://sessionserver.mojang.com/session/minecraft/profile/" + UUID;

function serve(url, data, options = {}) {
  responses.set(url, {
    url: options.url ?? url,
    status: options.status ?? 200,
    headers: { get: (name) => options.headers?.[name] ?? null },
    async json() { return options.body === undefined ? data : JSON.parse(options.body); },
  });
}

function profile(textures = {
  SKIN: { url: "http://textures.minecraft.net/texture/" + SKIN_HASH },
}) {
  const property = { profileId: UUID, profileName: "Notch", textures };
  return {
    id: UUID, name: "Notch",
    properties: [{ name: "textures", value: Buffer.from(JSON.stringify(property)).toString("base64") }],
  };
}

function encodedProfile(payload) {
  return {
    id: UUID, name: "Notch",
    properties: [{ name: "textures", value: Buffer.from(JSON.stringify(payload)).toString("base64") }],
  };
}

beforeEach(() => { responses.clear(); requests.length = 0; });

test("username resolution preserves identity, declared model, official skin, and optional cape", async () => {
  for (const [declared, model] of [[undefined, "classic"], ["slim", "slim"], ["future", "unknown"]]) {
    const skin = { url: "http://textures.minecraft.net/texture/" + SKIN_HASH };
    if (declared !== undefined) skin.metadata = { model: declared };
    serve(USERNAME_URL, { id: UUID.toUpperCase(), name: "Notch" });
    serve(PROFILE_URL, profile({ SKIN: skin, CAPE: { url: "https://textures.minecraft.net/texture/" + CAPE_HASH } }));
    const found = await resolveProfile("notch");
    assert.deepEqual(found, {
      uuid: UUID, name: "Notch", model,
      skinUrl: "https://textures.minecraft.net/texture/" + SKIN_HASH,
      capeUrl: "https://textures.minecraft.net/texture/" + CAPE_HASH,
      snapshot: { model, skinHash: SKIN_HASH, capeHash: CAPE_HASH },
    });
  }
});

test("UUID lookups skip username resolution and fixed snapshots never refresh player textures", async () => {
  serve(PROFILE_URL, profile());
  const found = await resolveProfile("069A79F4-44E9-4726-A5BE-FCA90E38AAF5");
  assert.equal(found.capeUrl, null);
  assert.equal(found.snapshot.capeHash, null);
  const token = encodeSnapshot(found.snapshot);
  serve(PROFILE_URL, profile({ SKIN: { url: "https://textures.minecraft.net/texture/" + "c".repeat(64) } }));
  const shared = await resolveProfile("texture:" + token);
  assert.deepEqual(shared, { ...found, uuid: null, name: null });
  assert.deepEqual(requests, [PROFILE_URL]);
});

test("profiles without a custom skin remain valid and UTF-8 texture metadata decodes correctly", async () => {
  for (const data of [{ id: UUID, name: "Notch" }, profile({})]) {
    serve(PROFILE_URL, data);
    assert.deepEqual(await resolveProfile(UUID), {
      uuid: UUID, name: "Notch", model: "unknown", skinUrl: null, capeUrl: null, snapshot: null,
    });
  }
  const data = encodedProfile({
    profileId: UUID, note: "雪人 ☃",
    textures: { SKIN: { url: "https://textures.minecraft.net/texture/" + SKIN_HASH } },
  });
  data.properties.push({ name: "unrelated", value: "ignored" });
  serve(PROFILE_URL, data);
  assert.equal((await resolveProfile(UUID)).skinUrl, "https://textures.minecraft.net/texture/" + SKIN_HASH);
});

test("untrusted profile identities and texture metadata cannot become usable snapshots", async () => {
  const invalid = [
    { ...profile(), id: OTHER_UUID }, { ...profile(), name: "Notch\n" },
    { ...profile(), properties: null }, { ...profile(), properties: {} },
    { ...profile(), properties: [null] }, { ...profile(), properties: [profile().properties[0], profile().properties[0]] },
    { ...profile(), properties: [{ name: "textures", value: "not base64" }] },
    { ...profile(), properties: [{ name: "textures", value: Buffer.from([255]).toString("base64") }] },
    encodedProfile({ profileId: OTHER_UUID, textures: {} }),
    encodedProfile({ profileId: UUID, textures: [] }),
    encodedProfile([]),
    profile({ SKIN: { url: "https://evil.example/texture/" + SKIN_HASH } }),
    profile({ SKIN: { url: "https://textures.minecraft.net:443/texture/" + SKIN_HASH } }),
    profile({ SKIN: { url: "https://textures.minecraft.net/texture/" + SKIN_HASH + "?redirect=evil" } }),
    profile({ SKIN: { url: "http://textures.minecraft.net/texture/" + SKIN_HASH, metadata: null } }),
    profile({ SKIN: { url: "http://textures.minecraft.net/texture/" + SKIN_HASH, metadata: { model: 3 } } }),
    profile({ CAPE: { url: "http://127.0.0.1/texture/" + CAPE_HASH } }),
    profile({ CAPE: { url: "http://textures.minecraft.net/texture/" + CAPE_HASH + "\n" } }),
  ];
  for (const data of invalid) {
    serve(PROFILE_URL, data);
    await assert.rejects(resolveProfile(UUID), { code: "UPSTREAM_UNAVAILABLE", status: 502 });
  }
  for (const data of [{ id: UUID, name: "Other" }, { id: "invalid", name: "Notch" }]) {
    serve(USERNAME_URL, data);
    await assert.rejects(resolveProfile("notch"), { code: "UPSTREAM_UNAVAILABLE", status: 502 });
  }
});

test("valid profiles are accepted when the response body exceeds 1 MiB", async () => {
  const data = { ...profile(), padding: "a".repeat(1048576) };
  serve(PROFILE_URL, data, { headers: { "content-length": "1048577" } });
  assert.equal((await resolveProfile(UUID)).name, "Notch");
});

test("texture properties and oversized property lists reject excessive input", async () => {
  for (const data of [
    encodedProfile({
      profileId: UUID, padding: "a".repeat(13000),
      textures: { SKIN: { url: "https://textures.minecraft.net/texture/" + SKIN_HASH } },
    }),
    { ...profile(), properties: Array.from({ length: 17 }, () => ({ name: "other" })) },
  ]) {
    serve(PROFILE_URL, data);
    await assert.rejects(resolveProfile(UUID), { code: "UPSTREAM_UNAVAILABLE", status: 502 });
  }
});

test("missing, redirected, malformed, and failed HTTP responses expose only stable errors", async () => {
  for (const url of [USERNAME_URL, PROFILE_URL]) {
    const query = url === USERNAME_URL ? "notch" : UUID;
    serve(PROFILE_URL, profile());
    for (const status of [204, 404]) {
      serve(url, {}, { status });
      await assert.rejects(resolveProfile(query), { code: "NOT_FOUND", status: 404, retryAfter: null });
    }
    for (const options of [{ status: 500 }, { status: 302 }, { url: "https://evil.example/profile" },
      { body: "not JSON" }, { body: "[]" }]) {
      serve(url, url === USERNAME_URL ? { id: UUID, name: "Notch" } : profile(), options);
      await assert.rejects(resolveProfile(query), { code: "UPSTREAM_UNAVAILABLE", status: 502 });
    }
    responses.set(url, new Error("Untrusted upstream details."));
    await assert.rejects(resolveProfile(query), {
      code: "UPSTREAM_UNAVAILABLE", status: 502, message: "Minecraft is unavailable.",
    });
  }
  await assert.rejects(resolveProfile("../player"), { code: "INVALID_REFERENCE", status: 400 });
});

test("rate limits retain a bounded retry delay for independent invocations", async () => {
  for (const [header, seconds] of [[undefined, 30], ["invalid", 30], ["60", 60], ["0", 1],
    ["999999999999999999999999", 300], ["Thu, 01 Jan 1970 00:00:00 GMT", 1],
    ["Thu, 01 Jan 2099 00:00:00 GMT", 300]]) {
    serve(PROFILE_URL, {}, { status: 429, headers: { "retry-after": header } });
    await assert.rejects(resolveProfile(UUID), { code: "RATE_LIMITED", status: 429, retryAfter: seconds });
  }
  serve(PROFILE_URL, profile());
  assert.equal((await resolveProfile(UUID)).name, "Notch");
});
