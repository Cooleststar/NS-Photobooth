/** Design tokens for the booth UI.
 *
 * Added because the app had grown three separate palettes: HUD.tsx had been
 * modernised onto the gallery's dark tokens (#272c35 / #2c313b / #cbd2dc /
 * #6f7887 / #3b82f6), Settings and the start screen were still generic
 * Tailwind greys plus a stark bg-white, and 67 Mode was black-50% boxes. Same
 * product, three looks.
 *
 * These names are that modern palette, promoted from hex literals scattered
 * through the JSX to semantic classes (bg-surface, text-ink-muted,
 * border-edge), so a screen can be built without picking a grey and every
 * screen picks the SAME grey.
 *
 * Deliberately additive (theme.extend): the stock palette stays available, so
 * nothing that already uses gray-800 or blue-600 breaks while surfaces are
 * migrated one at a time.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Text, brightest to faintest.
        ink: {
          DEFAULT: '#f3f4f6',
          dim: '#cbd2dc',
          muted: '#6f7887',
        },
        // Backgrounds, by how far forward they sit.
        surface: {
          // The app's own backdrop. Not pure black: flat #000 reads as
          // unstyled, and it leaves a card sitting on it no room to be
          // darker than the page for an inset control.
          base: '#0d1016',
          DEFAULT: '#1e222a',
          raised: '#272c35',
          // Inputs, which should read as cut INTO a surface rather than
          // sitting on it.
          sunken: '#12151b',
        },
        edge: {
          DEFAULT: '#2c313b',
          strong: '#3a4150',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
        },
      },
    },
  },
}
