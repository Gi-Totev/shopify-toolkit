# stk — Shopify Toolkit

A small, extensible collection of command-line tools for Shopify storefront work.
One dispatcher command (`stk`) runs any tool under `tools/`. Run `stk` with no
arguments for an fzf picker, or `stk <tool>` to run one directly.

## Requirements

- **Node.js** — runs the tools
- **fzf** — interactive pickers (`brew install fzf`)

## Install

```sh
git clone https://github.com/Gi-Totev/shopify-toolkit.git
cd shopify-toolkit
./install.sh
```

`install.sh` symlinks `bin/stk` into the first writable PATH dir it finds
(`~/.local/bin`, `/usr/local/bin`, or `~/bin`) and warns if anything is missing.
The repo stays where you cloned it — the symlink points back to it, so
`git pull` updates your tools with no reinstall.

## Usage

```sh
stk            # fzf picker of all tools
stk -h         # list tools + descriptions
stk <tool> …   # run a tool directly
```

## Tools

### `svg` — prep SVGs for Shopify image upload

Shopify's Files uploader rejects SVGs that lack a namespace or intrinsic size,
and its sanitizer strips scripts. This fixes all of that in place.

```sh
stk svg                 # choose folder or specific files (fzf)
stk svg ~/icons         # fix every .svg in a folder (recursive)
stk svg logo.svg        # fix one file
stk svg ~/icons -o out  # write fixed copies to ./out instead of in place
```

Fixes, all on by default:

- adds `xmlns` (required — upload fails without it)
- fills `width`/`height` from `viewBox` (and vice-versa)
- converts percentage sizes to absolute
- adds `xmlns:xlink` when the file uses `xlink:`
- strips `<script>` and inline `on*=` handlers
- removes unused Illustrator `id`s and `data-name` (keeps referenced ids;
  warns on duplicate referenced ids)

## Adding a tool

No dispatcher edits needed — drop a folder under `tools/`:

```
tools/<name>/<name>.js     # run via node
# or
tools/<name>/run           # any executable, any language
tools/<name>/.desc         # one-line description (shown in list + picker)
```

`stk <name>` runs it; `stk` and `stk -h` list it automatically.

## License

MIT
