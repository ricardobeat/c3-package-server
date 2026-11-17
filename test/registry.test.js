import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync, unzipSync } from "fflate";
import { compare_versions, repack } from "../src/registry.js";

test("versions sort numerically", () => {
	const tags = ["v1.10.0", "v1.9.0", "v1.2", "v2.0.0-rc1", "v2.0.0"];
	assert.deepEqual(tags.sort(compare_versions), ["v1.2", "v1.9.0", "v1.10.0", "v2.0.0-rc1", "v2.0.0"]);
});

test("repack drops the top folder and dotfiles, and is the same every time", () => {
	const archive = zipSync({
		"drie-abc/manifest.json": strToU8('{"provides":"drie"}'),
		"drie-abc/core.c3": strToU8("module drie;"),
		"drie-abc/.github/ci.yml": strToU8("x"),
		"drie-abc/lib/.hidden": strToU8("x"),
		"drie-abc/lib/sokol.c3l/sg.c3": strToU8("module sokol;"),
	}, { mtime: new Date() });
	const files = repack(archive);
	assert.deepEqual(Object.keys(files), ["core.c3", "lib/sokol.c3l/sg.c3", "manifest.json"]);
	const a = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
	const b = zipSync(repack(archive), { level: 6, mtime: new Date(1980, 0, 1) });
	assert.deepEqual(a, b);
	assert.equal(new TextDecoder().decode(unzipSync(a)["core.c3"]), "module drie;");
});

test("repack with a folder keeps only that folder, as the root", () => {
	const archive = zipSync({
		"sokol-c3-abc/README.md": strToU8("x"),
		"sokol-c3-abc/sokol.c3l/manifest.json": strToU8('{"provides":"sokol"}'),
		"sokol-c3-abc/sokol.c3l/sg.c3": strToU8("module sokol::sg;"),
		"sokol-c3-abc/sokol.c3l/c/sokol.c": strToU8("//"),
		"sokol-c3-abc/examples/x.c3": strToU8("x"),
	});
	assert.deepEqual(Object.keys(repack(archive, "sokol.c3l")), ["c/sokol.c", "manifest.json", "sg.c3"]);
});

import { count, flush, manifest_provides } from "../src/registry.js";
import * as store from "../src/store.js";

test("manifest_provides reads JSON, and near-JSON with a regex", () => {
	assert.equal(manifest_provides('{"provides": "sokol", "c-sources": []}'), "sokol");
	assert.equal(manifest_provides('{\n  // a comment\n  "provides": "drie",\n}'), "drie");
	assert.equal(manifest_provides('{"name": "x"}'), null);
});

test("the store keeps values until they expire", async () => {
	await store.set("http://x", "k", { a: 1 }, 60);
	assert.deepEqual(await store.get("http://x", "k"), { a: 1 });
	await store.set("http://x", "gone", 1, -1);
	assert.equal(await store.get("http://x", "gone"), undefined);
});

test("counting: once per IP and library, written in one batch", async () => {
	const batches = [];
	const db = {
		prepare: () => ({ bind: (...args) => args }),
		batch: async (statements) => batches.push(statements),
	};
	const lib = { library: "ricardobeat/drie", description: "", latest: "main" };
	const other = { library: "floooh/sokol-c3/sokol.c3l", description: "", latest: "main" };
	await count({ db }, lib, "203.0.113.1", "http://x");
	await count({ db }, lib, "203.0.113.1", "http://x");
	await count({ db }, lib, "203.0.113.2", "http://x");
	await count({ db }, other, "203.0.113.1", "http://x");
	await flush(db);
	assert.equal(batches.length, 1);
	const fetches = Object.fromEntries(batches[0].map(([library, , , n]) => [library, n]));
	assert.deepEqual(fetches, { "ricardobeat/drie": 2, "floooh/sokol-c3/sokol.c3l": 1 });
});
