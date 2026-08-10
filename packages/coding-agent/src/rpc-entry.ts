#!/usr/bin/env node
import { setWireIdentity } from "@earendil-works/pi-ai";
import { APP_NAME, BRAND } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
setWireIdentity(BRAND?.userAgent ?? APP_NAME);
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
