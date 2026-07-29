const SYMBOLS: Readonly<Record<string, string>> = {
	"\\aleph": "ℵ",
	"\\alpha": "α",
	"\\approx": "≈",
	"\\beta": "β",
	"\\cdot": "·",
	"\\chi": "χ",
	"\\Delta": "Δ",
	"\\delta": "δ",
	"\\div": "÷",
	"\\epsilon": "ε",
	"\\equiv": "≡",
	"\\eta": "η",
	"\\exists": "∃",
	"\\forall": "∀",
	"\\Gamma": "Γ",
	"\\gamma": "γ",
	"\\ge": "≥",
	"\\geq": "≥",
	"\\in": "∈",
	"\\infty": "∞",
	"\\int": "∫",
	"\\iota": "ι",
	"\\kappa": "κ",
	"\\Lambda": "Λ",
	"\\lambda": "λ",
	"\\le": "≤",
	"\\leftarrow": "←",
	"\\leftrightarrow": "↔",
	"\\leq": "≤",
	"\\mu": "μ",
	"\\nabla": "∇",
	"\\ne": "≠",
	"\\neq": "≠",
	"\\ni": "∋",
	"\\notin": "∉",
	"\\nu": "ν",
	"\\Omega": "Ω",
	"\\omega": "ω",
	"\\otimes": "⊗",
	"\\partial": "∂",
	"\\Phi": "Φ",
	"\\phi": "φ",
	"\\Pi": "Π",
	"\\pi": "π",
	"\\pm": "±",
	"\\prod": "∏",
	"\\Psi": "Ψ",
	"\\psi": "ψ",
	"\\rho": "ρ",
	"\\rightarrow": "→",
	"\\Sigma": "Σ",
	"\\sigma": "σ",
	"\\sim": "∼",
	"\\subset": "⊂",
	"\\subseteq": "⊆",
	"\\sum": "∑",
	"\\supset": "⊃",
	"\\supseteq": "⊇",
	"\\tau": "τ",
	"\\Theta": "Θ",
	"\\theta": "θ",
	"\\times": "×",
	"\\to": "→",
	"\\Upsilon": "Υ",
	"\\upsilon": "υ",
	"\\varepsilon": "ϵ",
	"\\varphi": "φ",
	"\\vartheta": "ϑ",
	"\\xi": "ξ",
	"\\zeta": "ζ",
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	i: "ⁱ",
	n: "ⁿ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceBraced = (input: string, command: string, render: (body: string) => string): string => {
	const pattern = new RegExp(`${escapeRegex(command)}\\{([^{}]*)\\}`, "g");
	let output = input;
	let previous: string;
	do {
		previous = output;
		output = output.replace(pattern, (_match, body: string) => render(body));
	} while (output !== previous);
	return output;
};

const scriptText = (text: string, alphabet: Readonly<Record<string, string>>): string | undefined => {
	let output = "";
	for (const character of text) {
		const replacement = alphabet[character];
		if (replacement === undefined) return undefined;
		output += replacement;
	}
	return output;
};

const replaceScripts = (input: string, marker: "^" | "_", alphabet: Readonly<Record<string, string>>): string => {
	const grouped = new RegExp(`${escapeRegex(marker)}\\{([^{}\\n]+)\\}`, "g");
	const single = new RegExp(`${escapeRegex(marker)}([A-Za-z0-9+\\-=()])`, "g");
	return input
		.replace(grouped, (raw, body: string) => scriptText(body, alphabet) ?? raw)
		.replace(single, (raw, body: string) => scriptText(body, alphabet) ?? raw);
};

export const latexToUnicode = (formula: string): string => {
	let output = formula.trim().replace(/\s+/g, " ");
	for (const command of ["\\mathrm", "\\mathbf", "\\mathit", "\\text", "\\operatorname"]) {
		output = replaceBraced(output, command, (body) => body);
	}
	output = replaceBraced(output, "\\sqrt", (body) => `√(${body})`);
	output = output.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)⁄($2)");
	output = output.replace(/\\(?:left|right)(?=[()[\]{}|])/g, "");
	for (const [command, symbol] of Object.entries(SYMBOLS).sort(([a], [b]) => b.length - a.length)) {
		output = output.replace(new RegExp(`${escapeRegex(command)}(?![A-Za-z])`, "g"), symbol);
	}
	output = replaceScripts(output, "^", SUPERSCRIPTS);
	output = replaceScripts(output, "_", SUBSCRIPTS);
	output = output.replace(/\\(?:,|;|:|!)/g, " ").replace(/\\quad/g, "  ");
	return output.trim();
};
