/**
 * The Lumanin logo — a search glass as a sun, inlined from
 * `resources/lumanin.svg` so it renders as part of the page instead of as an
 * image request, and so `currentColor` inherits from CSS: whatever colour the
 * surrounding text (or an explicit `color:` on the class) sets is the colour
 * the whole mark takes, which is how it follows the theme with no work here.
 *
 * `resources/lumanin.svg` stays the canonical file — it is what the install
 * script publishes as the icon-theme icon and what anything outside the
 * renderer should use. Edit there first, mirror here.
 */

export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="100 100 312 312"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="lumanin-logo-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="55%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* soft halo */}
      <circle cx="256" cy="256" r="170" fill="url(#lumanin-logo-glow)" />

      {/* rays (bottom-left one removed — handle lives there) */}
      <g stroke="currentColor" strokeWidth="10" strokeLinecap="round">
        <line x1="256" y1="113" x2="256" y2="153" />
        <line x1="256" y1="359" x2="256" y2="399" />
        <line x1="113" y1="256" x2="153" y2="256" />
        <line x1="359" y1="256" x2="399" y2="256" />
        <line x1="155" y1="155" x2="183" y2="183" />
        <line x1="329" y1="329" x2="357" y2="357" />
        <line x1="329" y1="183" x2="357" y2="155" />
      </g>

      {/* search glass: ring + handle to bottom-left */}
      <circle cx="256" cy="256" r="72" fill="none" stroke="currentColor" strokeWidth="12" />
      <line
        x1="203"
        y1="309"
        x2="142"
        y2="370"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinecap="round"
      />

      {/* bright core */}
      <circle cx="256" cy="256" r="24" fill="currentColor" />
    </svg>
  )
}
