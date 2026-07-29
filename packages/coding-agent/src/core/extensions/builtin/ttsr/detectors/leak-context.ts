import { isAsciiWhitespace } from "../stream-utils.ts";

export type LeakContextKind = "start" | "normal" | "quotation";

const START_TOKEN_OFFSET_LIMIT = 32;
const PREAMBLE_OFFSET_LIMIT = 160;
const PREAMBLE_MAX_TRIMMED = 96;
const HEAD_LIMIT = 160;
const WINDOW_LIMIT = 160;
const VOCAB_LOOKBACK = 128;
const INDENT_CODE_SPACES = 4;
const FENCE_TICK_RUN = 3;
const PREAMBLE_PATTERN = /^(?:Thinking|Reasoning|Analysis)[.:]*$/;
const BACKTICK = "`";
const TILDE = "~";
const DOUBLE_QUOTE = '"';
const SINGLE_QUOTE = "'";
const BLOCKQUOTE_MARK = ">";
const NEWLINE = "\n";
const SPACE = " ";
const TAB = "\t";

const DISCUSSION_VOCAB: readonly string[] = [
	"token",
	"tokens",
	"tokenizer",
	"delimiter",
	"special",
	"literal",
	"example",
	"documentation",
	"sequence",
	"sentinel",
	"vocabulary",
];

export class StreamContextTracker {
	#head = "";
	#window = "";
	#tickChar = "";
	#tickCount = 0;
	#inFence = false;
	#fenceChar = "";
	#inInline = false;
	#lineIndent = 0;
	#lineHasContent = false;
	#lineIsBlockquote = false;
	#lineIsIndented = false;
	#lastNonWs = "";

	observeGround(value: string): void {
		if (this.#tickChar !== "") {
			if (value === this.#tickChar) {
				this.#tickCount += 1;
				this.#appendText(value);
				this.#lastNonWs = value;
				this.#lineHasContent = true;
				return;
			}
			this.#resolveTicks();
		}
		if (value === BACKTICK || value === TILDE) {
			this.#tickChar = value;
			this.#tickCount = 1;
			this.#appendText(value);
			this.#lastNonWs = value;
			this.#lineHasContent = true;
			return;
		}
		if (value === NEWLINE) {
			this.#lineIndent = 0;
			this.#lineHasContent = false;
			this.#lineIsBlockquote = false;
			this.#lineIsIndented = false;
			this.#appendText(value);
			return;
		}
		const code = value.charCodeAt(0);
		const whitespace = value.length === 1 && isAsciiWhitespace(code);
		if (!this.#lineHasContent) {
			if (value === SPACE) {
				this.#lineIndent += 1;
			} else if (value === TAB) {
				this.#lineIsIndented = true;
			} else if (!whitespace) {
				this.#lineHasContent = true;
				if (this.#lineIndent >= INDENT_CODE_SPACES) {
					this.#lineIsIndented = true;
				}
				if (value === BLOCKQUOTE_MARK) {
					this.#lineIsBlockquote = true;
				}
			}
		}
		if (!whitespace) {
			this.#lastNonWs = value;
		}
		this.#appendText(value);
	}

	observeText(text: string): void {
		if (text.length === 0) {
			return;
		}
		if (this.#tickChar !== "") {
			this.#resolveTicks();
		}
		this.#lineHasContent = true;
		this.#lastNonWs = text.slice(-1);
		this.#appendText(text);
	}

	classify(tokenStartOffset: number): LeakContextKind {
		if (this.#isQuotationLike()) {
			return "quotation";
		}
		if (this.#isStartLike(tokenStartOffset)) {
			return "start";
		}
		return "normal";
	}

	#isQuotationLike(): boolean {
		if (this.#inFence || this.#inInline || this.#lineIsBlockquote || this.#lineIsIndented) {
			return true;
		}
		if (this.#lastNonWs === DOUBLE_QUOTE || this.#lastNonWs === SINGLE_QUOTE) {
			return true;
		}
		const tail = this.#window.slice(-VOCAB_LOOKBACK).toLowerCase();
		return DISCUSSION_VOCAB.some((word) => tail.includes(word));
	}

	#isStartLike(tokenStartOffset: number): boolean {
		if (
			tokenStartOffset < START_TOKEN_OFFSET_LIMIT &&
			this.#isWhitespaceOnly(this.#head.slice(0, tokenStartOffset))
		) {
			return true;
		}
		if (tokenStartOffset < PREAMBLE_OFFSET_LIMIT && tokenStartOffset <= this.#head.length) {
			const trimmed = this.#head.slice(0, tokenStartOffset).trim();
			if (trimmed.length <= PREAMBLE_MAX_TRIMMED && PREAMBLE_PATTERN.test(trimmed)) {
				return true;
			}
		}
		return false;
	}

	#isWhitespaceOnly(text: string): boolean {
		for (let i = 0; i < text.length; i += 1) {
			if (!isAsciiWhitespace(text.charCodeAt(i))) {
				return false;
			}
		}
		return true;
	}

	#resolveTicks(): void {
		const count = this.#tickCount;
		const char = this.#tickChar;
		this.#tickChar = "";
		this.#tickCount = 0;
		if (count >= FENCE_TICK_RUN) {
			if (!this.#inFence) {
				this.#inFence = true;
				this.#fenceChar = char;
			} else if (this.#fenceChar === char) {
				this.#inFence = false;
				this.#fenceChar = "";
			}
			return;
		}
		if (char === BACKTICK && !this.#inFence) {
			this.#inInline = !this.#inInline;
		}
	}

	#appendText(text: string): void {
		if (this.#head.length < HEAD_LIMIT) {
			this.#head = (this.#head + text).slice(0, HEAD_LIMIT);
		}
		this.#window += text;
		if (this.#window.length > WINDOW_LIMIT * 2) {
			this.#window = this.#window.slice(-WINDOW_LIMIT);
		}
	}
}
