# Photobooth

Photobooth code that will be repeatedly reused for fancy purposes in NS.

## Decisions

- VSCode-first support
- ~~[Yarn 2 Zero-Installs](https://yarnpkg.com/features/zero-installs)~~ — no longer accurate: `.yarnrc.yml` now sets `nodeLinker: node-modules` (switched from the PnP linker for easier cross-device setup), which means `node_modules` is no longer committed/zero-install and you must run `yarn install` after cloning or pulling any change to `.yarnrc.yml`/`yarn.lock`, or `yarn dev` fails immediately with `Couldn't find the node_modules state file`.
- [Vite](https://vitejs.dev/) + [Babel](https://babeljs.io/)
- [Preact](https://preactjs.com/) framework (Typescript)
- [twin.macro](https://github.com/ben-rogerson/twin.macro) + [Emotion](https://emotion.sh/docs/introduction) CSS-in-JS

### PIXI.JS

The rendering engine used for the animations and potentially other effects in the future. PIXI.JS is also modular, but in a weird way, requiring you to create a customized [`pixi.ts`](./src/pixi.ts). See <https://pixijs.io/customize/> for a customization helper.

## Recommendations

- Download VSCode: <https://code.visualstudio.com/>
- Add Preact Devtools Extension to browser: <https://preactjs.com/guide/v10/debugging/>
- Enable Yarn 2 through NodeJS Corepack: <https://yarnpkg.com/getting-started/install>

## Quirks

See upstream template: <https://github.com/Interpause/tauri-template#quirks>
