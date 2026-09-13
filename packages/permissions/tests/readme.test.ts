/**
 * README.md's permissions table (between the `permissions-table:start`/
 * `permissions-table:end` markers) must exactly match what
 * `renderPermissionsTable()` produces from the catalogue and the default
 * roles -- the single source of truth this package documents. This test
 * fails whenever the committed table drifts from that source.
 *
 * The assembled document is piped through `oxfmt` (the same formatter
 * `pnpm run format:check` enforces workspace-wide) before comparing, so
 * this test's expectation and the format gate can never disagree about
 * table column alignment or block spacing around the markers -- `oxfmt`'s
 * own formatting algorithm is the single source of truth for that, not a
 * hand-reimplemented copy of it.
 *
 * `UPDATE_PERMISSIONS_TABLE=1` regenerates the region in place instead of
 * failing (the package's `docs:permissions` script).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderPermissionsTable } from "./support/permissions-table.js";

const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
const START_MARKER = "<!-- permissions-table:start -->";
const END_MARKER = "<!-- permissions-table:end -->";

/** Format a markdown document through the workspace's own `oxfmt` binary
 * (via stdin, `--stdin-filepath` to select the markdown parser and pick up
 * the repo's `.oxfmtrc.json`) so the result always matches what
 * `format:check` requires. */
function formatWithOxfmt(markdown: string): string {
	return execFileSync("pnpm", ["exec", "oxfmt", "--stdin-filepath=README.md"], {
		input: markdown,
		encoding: "utf8",
	});
}

interface Split {
	before: string;
	after: string;
}

function splitOnMarkers(content: string): Split {
	const startIndex = content.indexOf(START_MARKER);
	const endIndex = content.indexOf(END_MARKER);
	if (startIndex === -1 || endIndex === -1) {
		throw new Error(`README.md is missing the ${START_MARKER} / ${END_MARKER} markers`);
	}
	return {
		before: content.slice(0, startIndex + START_MARKER.length),
		after: content.slice(endIndex),
	};
}

describe("permissions table drift", () => {
	it("matches the generated table", () => {
		const content = readFileSync(README_PATH, "utf8");
		const { before, after } = splitOnMarkers(content);
		const assembled = `${before}\n${renderPermissionsTable()}\n${after}`;
		const formatted = formatWithOxfmt(assembled);

		if (process.env["UPDATE_PERMISSIONS_TABLE"] === "1") {
			writeFileSync(README_PATH, formatted);
			return;
		}

		expect(
			formatted,
			"README.md's permissions table is stale -- run `pnpm --filter @plakboek/permissions run docs:permissions`",
		).toBe(content);
	});
});
