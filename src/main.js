// The bunny.net Edge Script: registry.js behind BunnySDK's server.
// Its environment: BUNNY_DATABASE_URL and BUNNY_DATABASE_AUTH_TOKEN (the database of packages
// seen, injected for a linked database) and GITHUB_TOKEN (a secret, optional: it lifts GitHub's
// API limit of 60 requests an hour per IP).
import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.12.0";
import { connect } from "@bunny.net/database-client";
import { handle, SCHEMA } from "./registry.js";

const get = (name) => globalThis.process?.env?.[name] ?? globalThis.Deno?.env?.get(name);
const db_url = get("BUNNY_DATABASE_URL");
const db = db_url ? connect({ url: db_url, authToken: get("BUNNY_DATABASE_AUTH_TOKEN"), timeout: 3000 }) : null;
const env = { GITHUB_TOKEN: get("GITHUB_TOKEN"), db };

let ready = db ? db.exec(SCHEMA).catch((e) => console.error("schema:", e.message)) : null;

BunnySDK.net.http.serve(async (request) => {
	if (ready) await ready, ready = null;
	return handle(request, env);
});
