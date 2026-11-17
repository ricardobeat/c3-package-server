# c3-package-server: a C3 library registry for GitHub

A [bunny.net Edge Script](https://bunny.net/edge-scripting/) that serves C3 libraries straight from
GitHub. It speaks the registry protocol of `c3c fetch` and `c3c project fetch` (c3c 0.8.6), and the
registry URL always says where a library comes from:

```json
"dependency-search-paths": ["lib"],
"dependencies": [
    "https://c3.ricar.do/github.com:ricardobeat/drie@main",
    "https://c3.ricar.do/github.com/floooh/sokol-c3:floooh/sokol@main"
]
```

then `c3c project fetch ricardobeat/drie floooh/sokol` unpacks them into `lib/drie.c3l` and
`lib/sokol.c3l`. c3c takes everything before the last `:` as the registry, and checks the library
name (after the `/`) against the manifest's `provides`.

| Form | Library |
|---|---|
| `/github.com:<owner>/<repo>` | the repository `<owner>/<repo>`, which is the library `<repo>` (`manifest.json` at its root) |
| `/github.com/<owner>/<repo>:<owner>/<name>` | the library `<name>` in the repository: at its root, or else in its folder `<name>.c3l/` |
| `/github.com/<owner>/<repo>/<folder>:<owner>/<name>` | the library in that folder |

- **Versions** are the repository's tags and branches. The latest is its highest tag, or its default
  branch if it has no tags.
- **Packages** are the library's folder at a commit, as GitHub archives it. Dotfiles, symlinks and any
  files marked `export-ignore` in `.gitattributes` are dropped. Each package is zipped the same way
  every time, so its sha256 (the `x-checksum` header) can be pinned:
  `"https://c3.ricar.do/github.com:ricardobeat/drie@v0.3:<sha256>"`.
- **The home page** lists the packages fetched so far and how often.

## Routes

All under `/github.com/<owner>/<repo>[/<folder>…]`, or under `/github.com` for the first form, whose
route names the repository:

| Route | |
|---|---|
| `GET …/info/<owner>/<name>` | the library and its versions; each version's `url` is the `.c3l` of the commit it names. c3c asks for this once per fetch, so it is counted and not cached by the CDN |
| `GET …/c3l/<sha>.c3l` | the package; immutable, cached by the CDN for a year |
| `GET …/download/<owner>/<name>@<version>` | redirects to the package of that version |
| `GET /` | the package list (HTML) |
| `GET /index.json` | an empty list, for `c3c fetch-list` |

## Code

- `src/registry.js`: the registry, with a `handle(request, env)` that runs under Node too.
- `src/main.js`: the Edge Script entry. It connects to the database and serves `handle`.
- `test/`: `npm test` for the unit tests. `npm run serve` serves the registry on
  `http://localhost:7373` (with no database, so nothing is counted), to try with c3c:
  `"http://localhost:7373/github.com:<owner>/<repo>"`.

## Deploy

You need the bunny CLI (`bunny login`) and Node. Pushes to `main` deploy through GitHub Actions
(`.github/workflows/deploy.yml`): it runs the tests, bundles `dist/index.js` (the script with fflate
and the database client), and publishes it with bunny's `deploy-script` action. Other branches and
pull requests are only tested.

The first time, create the database and the script, and give the script its environment:

```sh
bunny db create --name c3-registry --primary DE --link --token --save-env   # writes .env
bunny scripts create c3-registry --type standalone --link                   # and a pull zone
bunny scripts env set BUNNY_DATABASE_URL "<BUNNY_DATABASE_URL from .env>"
bunny scripts env set BUNNY_DATABASE_AUTH_TOKEN "<BUNNY_DATABASE_AUTH_TOKEN from .env>" --secret
bunny scripts env set GITHUB_TOKEN "<a GitHub token>" --secret
bunny scripts show                                                          # its id
```

Then add the script's id to the GitHub repository as the `SCRIPT_ID` secret
(`gh secret set SCRIPT_ID`), and push. To deploy from a laptop instead:
`npm run build && bunny scripts deploy dist/index.js`.

The table is created when the script starts (`SCHEMA` in `registry.js`).

**GITHUB_TOKEN:** without it, GitHub allows 60 API requests an hour per IP, and edge IPs are
shared. Each uncached `/info` makes three or four requests (repository, tags, branches, and where
its manifest is), and each running copy of the script keeps the answers for 5 minutes. A
fine-grained token with no permissions is enough for public repositories. This is the script's
own secret, unrelated to the Actions token of the same name.

**Domain:** `bunny scripts domains add c3.ricar.do` prints the pull zone hostname. `ricar.do`'s DNS
is at Namecheap, so the record goes there: a CNAME from `c3` to `<pull zone>.b-cdn.net.` Once
`dig +short CNAME c3.ricar.do` shows it, run `bunny scripts domains ssl c3.ricar.do`.

**Rollback:** `bunny scripts deployments list` lists the releases, and
`bunny scripts deployments publish <release-id>` publishes an earlier one.

**Stats:** `bunny db shell -e "SELECT * FROM packages ORDER BY fetches DESC"`.

## Cost

Within bunny's $1/month minimum at small scale. The CDN serves packages after their first
download (about $0.01/GB in Europe and North America; drie is 2.8 MB). Each fetch is one script
request (about $0.20 per million) and one database write. Zipping happens once per commit.
