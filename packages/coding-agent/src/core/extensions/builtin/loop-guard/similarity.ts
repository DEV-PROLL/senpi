/**
 * Character-bigram Sørensen–Dice similarity over canonical argument JSON.
 *
 * Chosen over token-level or edit-distance metrics because canonical JSON keeps
 * structure stable (sorted keys, fixed separators), making bigram overlap a cheap
 * and order-insensitive-enough proxy for "same call shape, slightly different values".
 */

export type BigramCounts = Map<string, number>;

export function bigramCounts(text: string): BigramCounts {
	const counts: BigramCounts = new Map();
	for (let i = 0; i < text.length - 1; i++) {
		const gram = text.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

export function diceSimilarity(a: BigramCounts, b: BigramCounts): number {
	let totalA = 0;
	for (const count of a.values()) totalA += count;
	let totalB = 0;
	for (const count of b.values()) totalB += count;
	if (totalA === 0 && totalB === 0) return 1;
	if (totalA === 0 || totalB === 0) return 0;
	let intersection = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const [gram, count] of small) {
		const other = large.get(gram);
		if (other !== undefined) intersection += Math.min(count, other);
	}
	return (2 * intersection) / (totalA + totalB);
}

/** Mean similarity between each adjacent pair of argument strings. */
export function meanAdjacentSimilarity(argStrings: readonly string[]): number {
	if (argStrings.length < 2) return 1;
	const grams = argStrings.map(bigramCounts);
	let total = 0;
	for (let i = 0; i < grams.length - 1; i++) {
		const current = grams[i];
		const next = grams[i + 1];
		if (current === undefined || next === undefined) continue;
		total += diceSimilarity(current, next);
	}
	return total / (grams.length - 1);
}
