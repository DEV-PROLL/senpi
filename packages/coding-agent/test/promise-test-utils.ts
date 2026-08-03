export async function waitForSignalBeforeCompletion(
	operation: Promise<unknown>,
	signal: Promise<void>,
	description: string,
): Promise<void> {
	const operationOutcome = operation.then(
		() => ({ status: "completed" }) as const,
		(error: unknown) => ({ status: "rejected", error }) as const,
	);
	const outcome = await Promise.race([signal.then(() => ({ status: "signaled" }) as const), operationOutcome]);

	if (outcome.status === "rejected") throw outcome.error;
	if (outcome.status === "completed") {
		throw new Error(`Operation completed before ${description}`);
	}
}
