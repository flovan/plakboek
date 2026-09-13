import { createDb, type Db } from "@plakboek/db";

function makeDb(connectionString: string): Db {
	return createDb({ connectionString });
}

console.log(typeof makeDb);
