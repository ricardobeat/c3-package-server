// registry.js on http://localhost:7373 under Node, to try it with c3c before deploying:
//     node test/serve.js, then "http://localhost:7373/github.com:<owner>/<repo>" in project.json
import { createServer } from "node:http";
import { handle } from "../src/registry.js";

const port = Number(process.env.PORT ?? 7373);
createServer(async (req, res) => {
	const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method });
	const response = await handle(request, { GITHUB_TOKEN: process.env.GITHUB_TOKEN });
	console.log(req.method, req.url, response.status);
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`http://localhost:${port}`));
