export interface ScalarEntry {
	readonly value: string;
	readonly startOffset: number;
	readonly width: number;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

export class ScalarScanner {
	#offset = 0;
	#pendingHigh: string | undefined;

	push(delta: string): ScalarEntry[] {
		const entries: ScalarEntry[] = [];
		let input = delta;
		if (this.#pendingHigh !== undefined) {
			input = this.#pendingHigh + delta;
			this.#offset -= 1;
			this.#pendingHigh = undefined;
		}
		let i = 0;
		while (i < input.length) {
			const code = input.charCodeAt(i);
			if (isHighSurrogate(code)) {
				if (i + 1 >= input.length) {
					this.#pendingHigh = input[i];
					this.#offset += 1;
					break;
				}
				const next = input.charCodeAt(i + 1);
				if (isLowSurrogate(next)) {
					entries.push({ value: input.slice(i, i + 2), startOffset: this.#offset, width: 2 });
					this.#offset += 2;
					i += 2;
					continue;
				}
			}
			entries.push({ value: input.slice(i, i + 1), startOffset: this.#offset, width: 1 });
			this.#offset += 1;
			i += 1;
		}
		return entries;
	}

	hasPendingSurrogate(): boolean {
		return this.#pendingHigh !== undefined;
	}

	get offset(): number {
		return this.#offset;
	}
}

export class FixedRing<T> {
	readonly #capacity: number;
	#entries: T[] = [];

	constructor(capacity: number) {
		this.#capacity = capacity;
	}

	push(entry: T): void {
		this.#entries.push(entry);
		if (this.#entries.length > this.#capacity) {
			this.#entries.shift();
		}
	}

	getBack(offset: number): T | undefined {
		return this.#entries[this.#entries.length - 1 - offset];
	}

	get size(): number {
		return this.#entries.length;
	}

	toArray(): T[] {
		return [...this.#entries];
	}

	clear(): void {
		this.#entries = [];
	}
}

export function isAsciiWhitespace(code: number): boolean {
	return code === 32 || (code >= 9 && code <= 13);
}

export const CharCode = {
	Tab: 9,
	LineFeed: 10,
	VerticalTab: 11,
	FormFeed: 12,
	CarriageReturn: 13,
	Space: 32,
	LessThan: 60,
	LeftBracket: 91,
	Backslash: 92,
	RightBracket: 93,
	Underscore: 95,
	Pipe: 124,
} as const;
