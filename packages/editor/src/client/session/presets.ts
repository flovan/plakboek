/**
 * Column presets are ratios written `a:b:c`, one term per column. Equal splits
 * (`1`, `1:1`, `1:1:1`, ...) exist for every count; the configured ratios add
 * the common unequal ones.
 */

/** The terms of a ratio, one per column: `2:1` is `['2', '1']`. */
export function ratioTerms(ratio: string): readonly string[] {
  return ratio.split(':');
}

/** Whether every column of the ratio gets the same share. */
export function isEqualRatio(ratio: string): boolean {
  const terms = ratioTerms(ratio);
  return terms.every((term) => term === terms[0]);
}

/** The equal split for a column count: `1:1:1` for three. */
export function equalRatio(count: number): string {
  return Array.from({ length: Math.max(1, count) }, () => '1').join(':');
}

/**
 * The ratios offered for a column count: those configured with that many
 * terms, in configured order, with the equal split first when it is not among
 * them (so a count beyond every configured ratio still has one choice).
 */
export function presetsFor(
  count: number,
  presets: readonly string[],
): readonly string[] {
  const equal = equalRatio(count);
  const matching: string[] = [];
  for (const ratio of presets) {
    if (
      ratioTerms(ratio).length === Math.max(1, count) &&
      !matching.includes(ratio)
    ) {
      matching.push(ratio);
    }
  }
  return matching.includes(equal) ? matching : [equal, ...matching];
}

/** The terms the chrome joins into a label such as "1 to 2". */
export function ratioLabelParts(ratio: string): readonly string[] {
  return ratioTerms(ratio);
}
