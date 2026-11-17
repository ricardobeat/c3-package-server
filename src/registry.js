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
//   GET /github.com/index.json      the libraries fetched so far that c3c can fetch by name from
//                                   https://<this host>/github.com (the github.com:<owner>/<repo>
//                                   form), for c3c fetch-list and c3c fetch <name>
//   GET /index.json                 every library fetched so far (c3c fetch-list --fetch-url
//                                   https://<this host>), with the source as its name

import { unzipSync, zipSync } from "fflate";
import * as store from "./store.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // a GitHub owner or repository
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/; // what c3c accepts as a version
const SHA = /^[0-9a-f]{40}$/;
// Every file's time in the zip: 1980-01-01 00:00, the earliest a zip can hold. fflate writes it in
// the machine's time zone, so it is made from local fields: the same bytes (and sha256) anywhere.
const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);

// /info is what c3c asks for once per fetch, so it is counted, and the CDN must not answer it: the
// script answers from its store instead (store.js). A .c3l never changes.
const INFO_CACHE = "no-store";
const PAGE_CACHE = "public, max-age=60";
const C3L_CACHE = "public, max-age=31536000, immutable";

const INFO_TTL = 5 * 60; // seconds an /info answer is reused without asking GitHub
const DENY_TTL = 30 * 60; // seconds a repository that isn't a C3 library is refused without asking
const MAX_REPO_KB = 200 * 1024; // GitHub's size of the repository (its git data)
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024; // the archive of one commit, as downloaded

// Counting: one fetch per visitor (IP), library and hour. Counts gather in memory and go to the
// database together, at most every COUNT_FLUSH_MS from each running copy of the script, so the
// writes don't grow with the requests or the number of IPs they come from.
const SEEN_TTL = 60 * 60;
const COUNT_FLUSH_MS = 30 * 1000;

// `env.db`, a @bunny.net/database-client connection, keeps the packages seen and their fetches;
// without one (running locally) nothing is counted.
export async function handle(request, env = {}) {
	const url = new URL(request.url);
	if (request.method !== "GET" && request.method !== "HEAD") return text(405, "GET only\n");
	let path = url.pathname;
	try {
		if (path === "/" || path === "") return html(await home(url.host, env.db), PAGE_CACHE);
		if (path === "/index.json") return json(await index(env.db, false), PAGE_CACHE);
		if (path === "/github.com/index.json") return json(await index(env.db, true), PAGE_CACHE);
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
			store.in_background(count(env, lib, client_ip(request), url.origin));
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

// A repository (or folder) that isn't a C3 library this registry serves: missing, without a
// manifest, providing another name, or too big. Remembered for DENY_TTL.
class NotLibrary extends HttpError {
	constructor(message, status = 404) {
		super(status, message);
	}
}

// The registry record of the library `name` in a source ({owner, repo, dir, origin}; dir is null
// when the URL names no folder): the repository's tags, then its branches, as versions. It is a
// library only if its manifest.json provides `name`.
async function info(source, name, env) {
	check_source(source);
	if (!NAME.test(name)) throw new HttpError(400, `invalid library name ${name}`);
	const key = `${source.owner}/${source.repo}/${source.dir ?? "?"}:${name}`.toLowerCase();
	const denied = await store.get(source.origin, `deny:${key}`);
	if (denied) throw new HttpError(denied.status, `${denied.message} (checked in the last 30 minutes)`);
	const hit = await store.get(source.origin, `info:${key}`);
	if (hit) return hit;
	let value;
	try {
		value = await info_uncached(source, name, env);
	} catch (e) {
		if (e instanceof NotLibrary) {
			await store.set(source.origin, `deny:${key}`, { status: e.status, message: e.message }, DENY_TTL);
		}
		throw e;
	}
	await store.set(source.origin, `info:${key}`, value, INFO_TTL);
	return value;
}

async function info_uncached({ owner, repo, dir, origin }, name, env) {
	const meta = await github(`/repos/${owner}/${repo}`, env);
	if (meta.size > MAX_REPO_KB) {
		throw new NotLibrary(`${owner}/${repo} is too big (${Math.round(meta.size / 1024)} MB; the limit is ${MAX_REPO_KB / 1024} MB)`, 413);
	}
	const [manifest, tags, branches] = await Promise.all([
		find_manifest(owner, repo, dir, name, env),
		github(`/repos/${owner}/${repo}/tags?per_page=100`, env),
		github(`/repos/${owner}/${repo}/branches?per_page=100`, env),
	]);
	dir = manifest.dir;
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

// The library's manifest.json on the repository's default branch, where `dir` says (null: the
// root, else <name>.c3l/), which must provide `name`: { dir, provides }.
async function find_manifest(owner, repo, dir, name, env) {
	const dirs = dir === null ? ["", `${name}.c3l`] : [dir];
	for (const d of dirs) {
		const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${d ? d + "/" : ""}manifest.json`, {
			headers: github_headers(env),
		});
		if (res.status === 404) continue;
		if (res.status === 403 || res.status === 429) throw new HttpError(503, "GitHub's API rate limit; try again later");
		if (!res.ok) throw new HttpError(502, `GitHub API: ${res.status}`);
		const file = await res.json();
		const bytes = Uint8Array.from(atob(String(file.content ?? "").replace(/\s/g, "")), (c) => c.charCodeAt(0));
		const provides = manifest_provides(new TextDecoder().decode(bytes));
		const where = `${owner}/${repo}/${d ? d + "/" : ""}manifest.json`;
		if (!provides) throw new NotLibrary(`${where} has no "provides"`);
		if (provides !== name) throw new NotLibrary(`${where} provides "${provides}", not "${name}"`);
		return { dir: d, provides };
	}
	const where = dir === null ? `at the root or in ${name}.c3l/` : `in ${dir}/`;
	throw new NotLibrary(`${owner}/${repo} has no manifest.json ${where}: it is not a C3 library`);
}

// The "provides" of a manifest.json: JSON, or near enough (comments, trailing commas) for a regex.
export function manifest_provides(text) {
	try {
		const p = JSON.parse(text).provides;
		if (typeof p === "string") return p;
	} catch {
		// not strict JSON
	}
	return text.match(/"provides"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

// The source's folder of the repository at commit `sha` as a .c3l.
async function c3l({ owner, repo, dir, origin }, sha, env) {
	check_source({ owner, repo, dir });
	const key = `c3l:${owner}/${repo}/${dir}`.toLowerCase();
	const denied = await store.get(origin, `deny:${key}`);
	if (denied) throw new HttpError(denied.status, `${denied.message} (checked in the last 30 minutes)`);
	let files;
	try {
		const res = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/${sha}`, {
			headers: github_headers(env),
		});
		if (res.status === 404) throw new HttpError(404, `no commit ${sha} in ${owner}/${repo}`);
		if (!res.ok) throw new HttpError(502, `GitHub archive: ${res.status}`);
		files = repack(await read_capped(res, MAX_ARCHIVE_BYTES, `${owner}/${repo}`), dir);
		if (!files["manifest.json"]) {
			const where = dir ? `in ${dir}/` : "at its root";
			throw new NotLibrary(`${owner}/${repo} has no manifest.json ${where} at ${sha}: it is not a C3 library`, 422);
		}
	} catch (e) {
		if (e instanceof NotLibrary) {
			await store.set(origin, `deny:${key}`, { status: e.status, message: e.message }, DENY_TTL);
		}
		throw e;
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

// The body of `res`, refusing (NotLibrary, 413) one over `limit` bytes without reading the rest.
async function read_capped(res, limit, what) {
	const too_big = () => new NotLibrary(`${what}'s archive is too big (the limit is ${limit / 1024 / 1024} MB)`, 413);
	if (Number(res.headers.get("content-length")) > limit) throw too_big();
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			throw too_big();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) out.set(c, at), at += c.length;
	return out;
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
	if (res.status === 404) throw new NotLibrary(`no GitHub repository ${path.split("/").slice(2, 4).join("/")}`);
	if (res.status === 403 || res.status === 429) throw new HttpError(503, "GitHub's API rate limit; try again later");
	if (!res.ok) throw new HttpError(502, `GitHub API: ${res.status}`);
	return res.json();
}

// The visitor's address: bunny sets X-Real-IP (and a single-address X-Forwarded-For).
function client_ip(request) {
	return request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || "unknown";
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

// Counts a fetch of `lib` by `ip`, once an hour per visitor: the visitors seen are kept in the
// store as hashes of (salt, ip, library, hour), never as addresses.
const pending = new Map(); // library -> { n, description, latest }
let flushing = null;

export async function count(env, lib, ip, origin) {
	if (!env.db) return;
	const hour = Math.floor(Date.now() / 3600000);
	const seen = await sha256_hex(new TextEncoder().encode(`${env.IP_SALT ?? ""}|${ip}|${lib.library}|${hour}`));
	if (await store.get(origin, `seen:${seen}`)) return;
	await store.set(origin, `seen:${seen}`, 1, SEEN_TTL);
	const p = pending.get(lib.library);
	pending.set(lib.library, { n: (p?.n ?? 0) + 1, description: lib.description, latest: lib.latest });
	if (!flushing) {
		flushing = new Promise((resolve) => setTimeout(resolve, COUNT_FLUSH_MS)).then(() => flush(env.db));
		store.in_background(flushing);
	}
}

// Writes the counts gathered so far, in one transaction.
export async function flush(db) {
	flushing = null;
	const items = [...pending];
	pending.clear();
	if (!items.length || !db) return;
	const now = new Date().toISOString();
	const upsert = db.prepare(`INSERT INTO packages (library, description, latest, fetches, first_seen, last_seen)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (library) DO UPDATE SET fetches = fetches + excluded.fetches,
			description = excluded.description, latest = excluded.latest, last_seen = excluded.last_seen`);
	try {
		await db.batch(items.map(([library, p]) => upsert.bind(library, p.description, p.latest, p.n, now, now)), { mode: "immediate" });
	} catch (e) {
		console.error("count:", e.message);
	}
}

// The registry index (c3c's format) of the packages seen. `fetchable`: only those whose name c3c can
// ask /github.com/info for (a repository that is the library: <owner>/<repo>, no folder).
async function index(db, fetchable) {
	let rows = [];
	if (db) {
		try {
			rows = await db.sql`SELECT library, description, latest, last_seen FROM packages
				ORDER BY library LIMIT 5000`.all();
		} catch (e) {
			console.error("index:", e.message);
		}
	}
	if (fetchable) rows = rows.filter((r) => String(r.library).split("/").length === 2);
	return {
		libraries: rows.map((r) => ({
			library: r.library,
			description: r.description,
			latest: r.latest,
			updated: r.last_seen,
			tags: [],
			versions: [r.latest],
		})),
	};
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

const HELP = `C3 package registry. Can auto-package libraries from GitHub and other sources.

 Since c3 v0.8.6, you can add this directly to your project.json:

    "dependencies": [
        "https://<host>/github.com:<owner>/<repo>@<tag or branch>",
        "https://<host>/github.com/<owner>/<repo>:<owner>/<name>@<tag or branch>",
        "https://<host>/github.com/<owner>/<repo>/<folder>:<owner>/<name>@<tag or branch>"
    ]

then: c3c project fetch <owner>/<name>

For cases where the repository name doesn't match the library name, you can add the full
repository path to the URL part:

    "https://<host>/github.com/floooh/sokol-c3:floooh/sokol@main"

Invalid packages are cached as rejected. If you made a mistake, wait and try again later.

Versions can be pinned to branches and tags with "...@<tag>"" and pinned to the hash of its .c3l with "...@<version>:<sha256>".

`;
