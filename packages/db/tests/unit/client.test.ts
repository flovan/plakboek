import { describe, expect, it } from "vitest";
import { createDb, DbConfigError } from "../../src/client.js";

describe("createDb", () => {
	it("rejects a non-Postgres connection string without leaking the input", () => {
		let caught: unknown;
		try {
			createDb({ connectionString: "mysql://user:s3cret@host/db" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DbConfigError);
		expect((caught as Error).message).not.toContain("s3cret");
		expect((caught as Error).message).not.toContain("mysql://user:s3cret@host/db");
	});

	it("rejects an empty connection string", () => {
		expect(() => createDb({ connectionString: "" })).toThrow(DbConfigError);
	});

	it("returns a Db handle without connecting, and close() resolves", async () => {
		const { db, sql, close } = createDb({
			connectionString: "postgres://user:pw@127.0.0.1:1/db",
		});
		expect(db).toBeDefined();
		expect(sql).toBeDefined();
		await expect(close()).resolves.toBeUndefined();
	});
});
