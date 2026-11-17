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
	const a = zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
	const b = zipSync(repack(archive), { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
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
