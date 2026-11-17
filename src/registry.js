// A C3 library registry (the protocol of `c3c fetch` and `c3c project fetch`) in front of GitHub.
// The registry URL always names where a library comes from:
//
//     "https://<this host>/github.com:<owner>/<repo>@<tag or branch>"
//         the repository <owner>/<repo>, which is the library <repo>
//     "https://<this host>/github.com/<owner>/<repo>:<owner>/<name>@<tag or branch>"
//         the library <name> in the repository <owner>/<repo>: its manifest.json at the root, or
//         else in the folder <name>.c3l/ (as in floooh/sokol-c3)
//     "https://<this host>/github.com/<owner>/<repo>/<folder>:<owner>/<name>@<tag or branch>"
//         the library in that folder
//
// c3c takes everything before the last ':' as the registry, and checks <name> against the
// manifest's "provides". A library's versions are its repository's tags and branches.
//
// What c3c asks for, under /github.com/<owner>/<repo>[/<folder>...] (or /github.com for the first
// form, which names the repository in the route):
//   GET .../info/<owner>/<name>     the library and its versions; each version's url is the .c3l
//                                   of the commit the tag or branch points at
//   GET .../c3l/<sha>.c3l           that .c3l: the library's folder at that commit, as GitHub
//                                   archives it (files marked export-ignore in .gitattributes are
//                                   left out), without dotfiles or symlinks, zipped the same way
//                                   every time, so its sha256 can be pinned; it never changes
//   GET .../download/<owner>/<name>@<version>   redirects to the .c3l of that version (c3c's
//                                   default when a version has no url)
//   GET /index.json                 c3c fetch-list: nothing to list, any repository works

import { unzipSync, zipSync } from "fflate";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // a GitHub owner or repository
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/; // what c3c accepts as a version
const SHA = /^[0-9a-f]{40}$/;
const ZIP_TIME = new Date("1980-01-01T00:00:00Z");

// /info is what c3c asks for once per fetch, so it is counted, and the CDN must not answer it
// (GitHub's answers are kept in memory for a while instead). A .c3l never changes.
const INFO_CACHE = "no-store";
const PAGE_CACHE = "public, max-age=60";
const C3L_CACHE = "public, max-age=31536000, immutable";
const GITHUB_TTL = 5 * 60 * 1000;

// `env.db`, a @bunny.net/database-client connection, keeps the packages seen and their fetches;
// without one (running locally) nothing is counted.
export async function handle(request, env = {}) {
	const url = new URL(request.url);
	if (request.method !== "GET" && request.method !== "HEAD") return text(405, "GET only\n");
	let path = url.pathname;
	try {
		if (path === "/" || path === "") return html(await home(url.host, env.db), PAGE_CACHE);
		if (path === "/index.json") return json({ libraries: [] }, PAGE_CACHE);
		let m, source, rest;
		if ((m = path.match(/^\/github\.com(\/(?:info|download)\/([^/]+)\/([^/@]+).*)$/))) {
			// /github.com:<owner>/<repo>: the repository is the library's owner and name
			source = { owner: m[2], repo: m[3], dir: null, origin: url.origin };
			rest = m[1];
		} else if ((m = path.match(/^\/github\.com\/([^/]+)\/([^/]+)((?:\/[^/]+)*?)(\/(?:info|c3l|download)\/.*)$/))) {
			// /github.com/<owner>/<repo>[/<folder>]:<owner>/<name>
			source = { owner: m[1], repo: m[2], dir: m[3] ? m[3].slice(1) : null, origin: url.origin };
			rest = m[4];
		} else {
			return text(404, "not found; see /\n");
		}
		if ((m = rest.match(/^\/info\/([^/]+)\/([^/]+)$/))) {
			const lib = await info(source, m[2], env);
			await count(env.db, lib);
			return json(lib, INFO_CACHE);
		}
		if ((m = rest.match(/^\/c3l\/([0-9a-f]{40})\.c3l$/))) {
			return await c3l({ ...source, dir: source.dir ?? "" }, m[1], env);
		}
		if ((m = rest.match(/^\/download\/([^/]+)\/([^/@]+)@(.+)$/))) {
			const lib = await info(source, m[2], env);
			const version = lib.versions[decodeURIComponent(m[3])];
			if (!version) return text(404, `${lib.library} has no version ${m[3]}\n`);
			return Response.redirect(version.url, 302);
		}
		return text(404, "not found; see /\n");
	} catch (e) {
		if (e instanceof HttpError) return text(e.status, e.message + "\n");
		console.error(e);
		return text(500, `error: ${e.message}\n`);
	}
}

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// The registry record of the library `name` in a source ({owner, repo, dir, origin}; dir is null
// when the URL names no folder): the repository's tags, then its branches, as versions.
const info_cache = new Map();

async function info(source, name, env) {
	check_source(source);
	if (!NAME.test(name)) throw new HttpError(400, `invalid library name ${name}`);
	const key = `${source.origin} ${source.owner}/${source.repo}/${source.dir ?? ""}:${name}`.toLowerCase();
	const hit = info_cache.get(key);
	if (hit && Date.now() - hit.at < GITHUB_TTL) return hit.value;
	const value = await info_uncached(source, name, env);
	info_cache.set(key, { at: Date.now(), value });
	return value;
}

async function info_uncached({ owner, repo, dir, origin }, name, env) {
	const [meta, tags, branches] = await Promise.all([
		github(`/repos/${owner}/${repo}`, env),
		github(`/repos/${owner}/${repo}/tags?per_page=100`, env),
		github(`/repos/${owner}/${repo}/branches?per_page=100`, env),
	]);
	// No folder named: the root, if the library is there, else <name>.c3l/ (looked up on the
	// default branch)
	if (dir === null) {
		dir = "";
		if (!(await github_exists(`/repos/${owner}/${repo}/contents/manifest.json`, env))
			&& (await github_exists(`/repos/${owner}/${repo}/contents/${name}.c3l/manifest.json`, env))) {
			dir = `${name}.c3l`;
		}
	}
	const base = `${origin}/github.com/${owner}/${repo}${dir ? "/" + dir : ""}`;
	const updated = meta.pushed_at || meta.updated_at || new Date().toISOString();
	const versions = {};
	const add = (version, sha) => {
		if (!VERSION.test(version) || versions[version]) return;
		versions[version] = { url: `${base}/c3l/${sha}.c3l`, commit: sha, published: updated };
	};
	for (const t of tags) add(t.name, t.commit.sha);
	for (const b of branches) add(b.name, b.commit.sha);
	const tag_names = tags.map((t) => t.name).filter((n) => VERSION.test(n));
	const latest = tag_names.sort(compare_versions).at(-1) ?? meta.default_branch;
	if (!versions[latest]) throw new HttpError(404, `${owner}/${repo} has no tags or branches c3c can name`);
	return {
		library: `${owner}/${repo}${dir ? "/" + dir : ""}`.toLowerCase(),
		description: meta.description ?? "",
		latest,
		updated,
		tags: meta.topics ?? [],
		versions,
	};
}

// The source's folder of the repository at commit `sha` as a .c3l.
async function c3l({ owner, repo, dir }, sha, env) {
	check_source({ owner, repo, dir });
	const res = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/${sha}`, {
		headers: github_headers(env),
	});
	if (res.status === 404) throw new HttpError(404, `no commit ${sha} in ${owner}/${repo}`);
	if (!res.ok) throw new HttpError(502, `GitHub archive: ${res.status}`);
	const files = repack(new Uint8Array(await res.arrayBuffer()), dir);
	if (!files["manifest.json"]) {
		const where = dir ? `in ${dir}/` : "at its root";
		throw new HttpError(422, `${owner}/${repo} has no manifest.json ${where} at ${sha}: it is not a C3 library`);
	}
	const body = zipSync(files, { level: 6, mtime: ZIP_TIME });
	const sha256 = await sha256_hex(body);
	return new Response(body, {
		headers: {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="${(dir.split("/").at(-1) || repo).replace(/\.c3l$/, "")}.c3l"`,
			"cache-control": C3L_CACHE,
			"x-checksum": `sha256:${sha256}`,
		},
	});
}

// GitHub's archive without its top folder (<repo>-<sha>/), dotfiles and symlinks (which it stores
// as files holding their target), in a fixed order. With `dir`, only what is in that folder, as the
// root.
export function repack(zip, dir = "") {
	const out = {};
	const links = symlinks(zip);
	const entries = unzipSync(zip, { filter: (file) => !links.has(file.name) });
	for (const name of Object.keys(entries).sort()) {
		const slash = name.indexOf("/");
		const path = slash < 0 ? "" : name.slice(slash + 1);
		if (!path || path.endsWith("/")) continue;
		if (path.split("/").some((part) => part.startsWith("."))) continue;
		if (dir && !path.startsWith(dir + "/")) continue;
		out[dir ? path.slice(dir.length + 1) : path] = [entries[name], { mtime: ZIP_TIME }];
	}
	return out;
}

// The names of the symlinks in a zip: the entries made on Unix whose mode (the high half of the
// external attributes in the central directory) is S_IFLNK. fflate doesn't expose the mode.
function symlinks(zip) {
	const links = new Set();
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) return links;
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	for (let i = 0; i < count && view.getUint32(at, true) === 0x02014b50; i++) {
		const made_by = view.getUint8(at + 5);
		const name_len = view.getUint16(at + 28, true);
		const extra_len = view.getUint16(at + 30, true);
		const comment_len = view.getUint16(at + 32, true);
		const mode = view.getUint32(at + 38, true) >>> 16;
		if (made_by === 3 && (mode & 0o170000) === 0o120000) {
			links.add(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + name_len)));
		}
		at += 46 + name_len + extra_len + comment_len;
	}
	return links;
}

function check_source({ owner, repo, dir }) {
	if (!NAME.test(owner) || !NAME.test(repo) || (dir && !dir.split("/").every((p) => NAME.test(p))) || false) {
		throw new HttpError(400, "expected <owner>/<repo>[/<folder>...]");
	}
}

function github_headers(env) {
	const headers = { "user-agent": "c3-registry", accept: "application/vnd.github+json" };
	if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
	return headers;
}

async function github(path, env) {
	const res = await fetch(`https://api.github.com${path}`, { headers: github_headers(env) });
	if (res.status === 404) throw new HttpError(404, `no GitHub repository ${path.split("/").slice(2, 4).join("/")}`);
	if (res.status === 403 || res.status === 429) throw new HttpError(503, "GitHub's API rate limit; try again later");
	if (!res.ok) throw new HttpError(502, `GitHub API: ${res.status}`);
	return res.json();
}

async function github_exists(path, env) {
	const res = await fetch(`https://api.github.com${path}`, { method: "HEAD", headers: github_headers(env) });
	if (res.status === 403 || res.status === 429) throw new HttpError(503, "GitHub's API rate limit; try again later");
	return res.ok;
}

// Orders tags as versions: v1.10.0 after v1.9.0, v2.0.0-rc1 before v2.0.0; anything not
// numeric sorts by text.
export function compare_versions(a, b) {
	const split = (s) => {
		const [core, pre] = s.replace(/^v/i, "").split(/-(.*)/s);
		return { core: core.split(/[.+]/), pre };
	};
	const va = split(a), vb = split(b);
	const c = compare_parts(va.core, vb.core);
	if (c || va.pre === vb.pre) return c;
	if (va.pre === undefined) return 1;
	if (vb.pre === undefined) return -1;
	return compare_parts(va.pre.split("."), vb.pre.split("."));
}

function compare_parts(pa, pb) {
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? "", y = pb[i] ?? "";
		const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
		if (nx && ny && +x !== +y) return +x - +y;
		if (nx !== ny) return nx ? 1 : -1;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

async function sha256_hex(bytes) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One row per package: first and last fetch, and how many fetches. Counting never fails a fetch.
export const SCHEMA = `CREATE TABLE IF NOT EXISTS packages (
	library TEXT PRIMARY KEY,
	description TEXT NOT NULL DEFAULT '',
	latest TEXT NOT NULL DEFAULT '',
	fetches INTEGER NOT NULL DEFAULT 0,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL
)`;

async function count(db, lib) {
	if (!db) return;
	const now = new Date().toISOString();
	try {
		await db.sql`INSERT INTO packages (library, description, latest, fetches, first_seen, last_seen)
			VALUES (${lib.library}, ${lib.description}, ${lib.latest}, 1, ${now}, ${now})
			ON CONFLICT (library) DO UPDATE SET fetches = fetches + 1, description = excluded.description,
				latest = excluded.latest, last_seen = excluded.last_seen`.run();
	} catch (e) {
		console.error("count:", e.message);
	}
}

async function home(host, db) {
	let rows = [];
	if (db) {
		try {
			rows = await db.sql`SELECT library, description, latest, fetches, last_seen FROM packages
				ORDER BY fetches DESC, library LIMIT 500`.all();
		} catch (e) {
			console.error("home:", e.message);
		}
	}
	const github_url = (lib) => {
		const [owner, repo, ...dir] = String(lib).split("/");
		return `https://github.com/${owner}/${repo}${dir.length ? "/tree/HEAD/" + dir.join("/") : ""}`;
	};
	const row = (r) => `<tr><td><a href="${esc(github_url(r.library))}">${esc(r.library)}</a></td>`
		+ `<td>${esc(r.latest)}</td><td class=n>${r.fetches}</td><td>${esc(String(r.last_seen).slice(0, 10))}</td>`
		+ `<td>${esc(r.description)}</td></tr>`;
	const table = rows.length
		? `<table><tr><th>package</th><th>latest</th><th class=n>fetches</th><th>last</th><th></th></tr>\n${rows.map(row).join("\n")}\n</table>`
		: "<p>no packages fetched yet</p>";
	return `<!doctype html>
<html><head><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>${esc(host)}: C3 libraries from GitHub</title>
<style>
body { font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; margin: 2em; max-width: 60em; }
table { border-collapse: collapse; } th, td { text-align: left; padding: 0 1.5em 0 0; vertical-align: top; }
th { font-weight: normal; color: #888; } .n { text-align: right; } pre { font: inherit; }
a { color: inherit; }
</style></head><body>
<pre>${esc(HELP.replaceAll("<host>", host))}</pre>
${table}
</body></html>
`;
}

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(body, cache) {
	return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });
}

function json(value, cache) {
	return new Response(JSON.stringify(value, null, 2) + "\n", {
		headers: { "content-type": "application/json", "cache-control": cache },
	});
}

function text(status, body) {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const HELP = `A C3 library registry for libraries on GitHub. In project.json:

    "dependencies": [
        "https://<host>/github.com:<owner>/<repo>@<tag or branch>",
        "https://<host>/github.com/<owner>/<repo>:<owner>/<name>@<tag or branch>",
        "https://<host>/github.com/<owner>/<repo>/<folder>:<owner>/<name>@<tag or branch>"
    ]

then: c3c project fetch <owner>/<name>

The first is a repository that is the library <repo> (its manifest.json at the root). The second
is the library <name> in a repository: at its root, or in its folder <name>.c3l/, e.g.

    "https://<host>/github.com/floooh/sokol-c3:floooh/sokol@main"

The third names the folder. A library's versions are its repository's tags and branches; the
latest is its highest tag, else its default branch. A version can be pinned to the sha256 of
its .c3l (the x-checksum header of its url in /info): "...@<version>:<sha256>". Files marked
export-ignore in the repository's .gitattributes are left out.
`;
