import type { Icon as SpecIcon } from '@raycast/api'
import { Icon } from '../shared/icon'

/**
 * `Icon` — re-exported from `shared/icon.ts`, where the renderer can reach it too.
 *
 * What lives here is the part that needs the spec: a compile-time assertion that
 * our member names match `@raycast/api`'s exactly. The spec declares `Icon` as a
 * TypeScript `enum`, which has no runtime form to copy, so ours is a plain object
 * with the same keys — and this makes a member the spec adds, or one we misspell,
 * a `npm run typecheck` failure rather than a missing glyph found six months later.
 */
type Missing = Exclude<keyof typeof SpecIcon, keyof typeof Icon>
type Extra = Exclude<keyof typeof Icon, keyof typeof SpecIcon>
const iconsMatch: [Missing, Extra] extends [never, never] ? true : never = true
void iconsMatch

export { Icon }
export type { IconValue } from '../shared/icon'
