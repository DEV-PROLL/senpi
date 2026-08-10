#!/usr/bin/env node
import { setWireIdentity } from "@earendil-works/pi-ai";
import { APP_NAME, BRAND } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { installEarlyInspectorVmImportRecovery } from "./inspector-policy.ts";
import { main } from "./main.ts";

// Must precede the asynchronous bootstrap: with --inspect-brk, the recoverable Inspector
// import rejection can fire before interactive mode registers its own crash handler.
installEarlyInspectorVmImportRecovery();

process.title = APP_NAME;
// Outgoing requests must carry the running product's identity, not the engine's.
setWireIdentity(BRAND?.userAgent ?? APP_NAME);
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

await main(process.argv.slice(2));
