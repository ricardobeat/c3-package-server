// A small key/value store with expiry, for what the registry remembers between requests: answers
// it got from GitHub, repositories that aren't C3 libraries, and the visitors already counted.
//
// Entries live in bunny's edge Cache API (https://bunny.net/docs/scripting/cache/index.md), which
// every copy of the script in a region shares, with a copy in this isolate's memory in front of
// it. The Cache API keys entries by URL on the requesting host, so `origin` (the request's) is
// part of every call. Where there is no Cache API (Node, in tests), memory is all there is.
//
// The pull zone's "Cache expiration time" must respect the origin's Cache-Control: with "do not
// cache", put() stores nothing, and the store is only as good as one isolate's memory.

const CACHE_NAME = "c3-registry:v1";
const MEMORY_MAX = 20000;
const MEMORY_TTL = 30 * 1000; // how long memory trusts what it read from the shared cache

const memory = new Map(); // key -> { value, until }
let cache_promise = null;

function cache() {
	if (!cache_promise) {
		cache_promise = globalThis.caches?.open
			? globalThis.caches.open(CACHE_NAME).catch((e) => (console.error("cache:", e.message), null))
			: Promise.resolve(null);
	}
	return cache_promise;
}

function remember(key, value, ms) {
	memory.delete(key);
	memory.set(key, { value, until: Date.now() + ms });
	while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
}

function cache_key(origin, key) {
	return `${origin}/__store/${encodeURIComponent(key)}`;
}

// The value stored under `key`, or undefined.
export async function get(origin, key) {
	const hit = memory.get(key);
	if (hit) {
		if (hit.until > Date.now()) return hit.value;
		memory.delete(key);
	}
	try {
		const res = await (await cache())?.match(cache_key(origin, key));
		if (!res) return undefined;
		const value = await res.json();
		remember(key, value, MEMORY_TTL);
		return value;
	} catch (e) {
		console.error("store get:", e.message);
		return undefined;
	}
}

// Stores `value` (anything JSON can hold) under `key` for `ttl` seconds.
export async function set(origin, key, value, ttl) {
	remember(key, value, ttl * 1000);
	try {
		const c = await cache();
		if (!c) return;
		await c.put(cache_key(origin, key), new Response(JSON.stringify(value), {
			headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
		}));
	} catch (e) {
		console.error("store set:", e.message);
	}
}

// Runs `promise` past the response (bunny's waitUntil keeps the isolate alive for it).
export function in_background(promise) {
	const p = Promise.resolve(promise).catch((e) => console.error("background:", e.message));
	globalThis.Bunny?.v1?.waitUntil?.(p);
	return p;
}
