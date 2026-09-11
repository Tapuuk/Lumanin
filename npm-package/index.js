/*
 * The real `lumanin` module lives inside the Lumanin launcher: when a plugin
 * runs, the launcher answers `require('lumanin')` with its own implementation.
 * This npm package exists so the name cannot be claimed by someone else, and so
 * an accidental `npm install lumanin` fails loudly instead of resolving to a
 * stranger's code.
 */
throw new Error(
  'The `lumanin` module is provided by the Lumanin launcher at runtime. ' +
    'Remove it from your dependencies — a plugin needs no packages to use it. ' +
    'https://github.com/Tapuuk/Lumanin'
)
