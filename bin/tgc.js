#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  },
);
