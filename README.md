# Background Remover

A web tool that removes image backgrounds directly in the browser. Images are never uploaded anywhere — all processing happens on your device.

## Features

- **AI background removal** using [@imgly/background-removal](https://github.com/imgly/background-removal-js) (ONNX model running in the browser via WebAssembly). Three quality levels; the model is downloaded on first use and cached by the browser.
- **Color tool** — click a color to remove it (great for solid/studio backgrounds), with tolerance and an "only connected area" option. Works without downloading the AI model.
- **Erase / Restore brushes** with adjustable size and softness to touch up edges (`[` / `]` change brush size).
- **Undo / Redo** (`Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`).
- **New background**: transparent, preset colors, custom color, or your own image.
- **Before/after compare** slider.
- **Export** as PNG, WebP or JPG, optional auto-trim, or copy to clipboard.
- Load images by file picker, drag & drop, or paste.

## Run locally

It's a static site with no build step. Serve the folder with any static server (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

A GitHub Actions workflow (`.github/workflows/pages.yml`) publishes the site to GitHub Pages on every push to `main`. Enable it once under **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Any other static host (Netlify, Vercel, Cloudflare Pages, …) works too — just point it at the repository root.

## Notes

- Very large images are downscaled to 3000 px on the longest side to keep memory use reasonable.
- The AI library (`@imgly/background-removal`) is licensed under AGPL-3.0; check its license terms if you plan to use this commercially.
