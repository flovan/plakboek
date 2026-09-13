const mod = await import("@plakboek/db");

if (typeof mod.createDb !== "function") {
	process.exit(1);
}

// Must not open a connection: no createDb() call here, just the type-of check above.
console.log("db.mjs: createDb is exported as a function (no connection opened)");
