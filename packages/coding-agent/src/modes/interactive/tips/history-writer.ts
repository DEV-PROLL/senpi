export function recordTipShown(history: Record<string, number>, tipId: string, now: number): Record<string, number> {
	return { ...history, [tipId]: now };
}
