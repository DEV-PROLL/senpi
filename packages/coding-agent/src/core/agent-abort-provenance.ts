import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentEndEvent } from "./extensions/types.ts";

type AbortSource = NonNullable<AgentEndEvent["abortSource"]>;

export type JoinedAbort = {
	readonly abortCurrentAgent: boolean;
	readonly userOwned: boolean;
};

export class AgentAbortProvenance {
	#source: AbortSource | undefined;
	#agentEndEvent: AgentEndEvent | undefined;

	get isAgentEndDispatching(): boolean {
		return this.#agentEndEvent !== undefined;
	}

	begin(source: AbortSource): boolean {
		this.#source = source;
		return source === "user";
	}

	join(source: AbortSource, isStreaming: boolean): JoinedAbort {
		if (this.#source === undefined) {
			if (!isStreaming) return { abortCurrentAgent: false, userOwned: false };
			this.#source = source;
			return { abortCurrentAgent: true, userOwned: source === "user" };
		}
		if (source === "user") {
			this.#source = "user";
			if (this.#agentEndEvent !== undefined) {
				this.#agentEndEvent.aborted = true;
				this.#agentEndEvent.abortSource = "user";
			}
			return { abortCurrentAgent: false, userOwned: true };
		}
		return { abortCurrentAgent: false, userOwned: false };
	}

	beginAgentEnd(messages: AgentMessage[], willRetry: boolean, abortedWithoutSource: boolean): AgentEndEvent {
		const event: AgentEndEvent = {
			type: "agent_end",
			messages,
			willRetry,
			...(this.#source !== undefined || abortedWithoutSource ? { aborted: true } : {}),
			...(this.#source === undefined ? {} : { abortSource: this.#source }),
		};
		this.#agentEndEvent = event;
		return event;
	}

	endAgentEnd(event: AgentEndEvent): void {
		if (this.#agentEndEvent === event) this.#agentEndEvent = undefined;
		this.#source = undefined;
	}
}
