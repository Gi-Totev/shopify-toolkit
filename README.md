# stk — Shopify Toolkit

A small, extensible collection of command-line tools for Shopify storefront work.
One dispatcher command (`stk`) runs any tool under `tools/`. Run `stk` with no
arguments for a picker, or `stk <tool>` to run one directly.

Pure Node — runs natively on **Windows, macOS, and Linux**.

## Requirements

- **Node.js** ≥ 16
- **fzf** — used for the interactive pickers

## Install

One command:

```sh
npm i -g github:Gi-Totev/shopify-toolkit
```

Update:

```sh
stk update
```

Uninstall:

```sh
npm rm -g shopify-toolkit
```

## Usage

```sh
stk            # pick a tool to run
stk -l         # list all tools + descriptions
stk <tool> …   # run a tool directly
stk <tool> -h  # help for a specific tool
stk update     # update to the latest version
stk -v         # show installed version
```

## Tools

### `svg` — prep SVGs for Shopify image upload

Shopify's Files uploader rejects SVGs that lack a namespace or intrinsic size,
and its sanitizer strips scripts. This fixes all of that in place.

```sh
stk svg                 # choose folder or specific files (picker)
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

### `extract` — pull SVGs from a URL or HTML file

Finds every SVG on a page and writes them into `stk-extracted-svgs/` in the
current directory (a new `-N` if that exists). Never modifies the source.

```sh
stk extract https://example.com
stk extract ~/Desktop/page.html
```

Sources, all on:

- inline `<svg>` blocks
- linked `.svg` files (`<img>`, `<object>`, `<embed>`, `href`/`src`/`srcset`)
- CSS `url(...)` (style attributes, `<style>`, linked stylesheets)
- `data:image/svg+xml` URIs

Names come from the URL basename, or the inline `id` / `aria-label`, or
`svg-N.svg`.

## Adding a tool

No dispatcher edits needed — drop a folder under `tools/`:

```
tools/<tool>/<tool>.js     # run via node
# or
tools/<tool>/run           # any executable, any language
tools/<tool>/.desc         # one-line description (shown in list + picker)
```

`stk <tool>` runs it; `stk -l` lists it automatically.

## License

MIT
