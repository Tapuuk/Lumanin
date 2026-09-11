/**
 * Frecency: how much a past launch should still count.
 *
 * The point of ranking by frecency rather than by frequency is that habits
 * change. Something opened forty times last year and never since should fall
 * behind something opened four times this week — but it should fall behind
 * *smoothly*, so a launcher does not lurch every time you try a new app.
 *
 * Each launch contributes a weight that halves every {@link HALF_LIFE_DAYS}, and
 * an item's frecency is the sum. That is exponential decay, which has the two
 * properties that matter here: it is a running total (no need to keep every
 * timestamp forever) and it never reaches zero (nothing you use is ever
 * permanently demoted by disuse).
 *
 * Kept in `src/shared` and pure so the ranking can be reasoned about — and
 * asserted — without a database.
 */

/** Two weeks: long enough to survive a holiday, short enough to follow a project. */
export const HALF_LIFE_DAYS = 14

const MS_PER_DAY = 86_400_000

/**
 * The weight of a launch at `at`, evaluated at `now`.
 *
 * Anchored to an epoch rather than to "days ago" so stored scores stay
 * comparable without rewriting them: two entries decayed from different times
 * can be added directly, which is what makes the running total work.
 */
export function launchWeight(at: number, epoch: number): number {
  return Math.pow(2, (at - epoch) / (HALF_LIFE_DAYS * MS_PER_DAY))
}

/** Decay a stored total from when it was last evaluated to `now`. */
export function decay(score: number, from: number, to: number): number {
  if (to <= from) return score
  return score * Math.pow(2, (from - to) / (HALF_LIFE_DAYS * MS_PER_DAY))
}

export interface Frecency {
  /** Decay-weighted launch total. */
  readonly score: number
  readonly lastUsed: number
}

/**
 * Combine a search score with frecency into the final ranking.
 *
 * The two must not simply be added: match quality and usage habit are measured
 * in different units, and letting frecency outweigh the match is how a launcher
 * ends up opening your most-used app no matter what you typed. So frecency is a
 * *multiplier* bounded to a modest range — it reorders items that already match
 * comparably well, and can never promote a poor match over a good one.
 *
 * With an empty query every match scores 0, so ranking falls through to frecency
 * alone. That is the intended behaviour for the root list: what you open most,
 * first.
 */
export function rank(
  matchScore: number,
  frecency: Frecency | undefined,
  now: number,
  /**
   * `[search].frecency_weight` — the *most* habit is allowed to lift a match,
   * as a fraction. 0 is pure fuzzy score, 1 lets a well-worn item roughly double
   * its match score. It caps the multiplier rather than blending the two, which
   * is what keeps the guarantee below true at every setting.
   */
  weight = 0.75
): number {
  const score = frecency === undefined ? 0 : decay(frecency.score, frecency.lastUsed, now)
  // log1p rather than the raw count: the difference between never and once
  // should be large, between forty and forty-one almost nothing.
  const boost = 1 + Math.min(Math.log1p(score) / 4, Math.max(0, weight))
  return matchScore === 0 ? score : matchScore * boost
}
