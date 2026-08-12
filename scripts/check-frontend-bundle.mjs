import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dist = path.resolve("artifacts/agent-dashboard/dist/public");
const html = await readFile(path.join(dist, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="([^"]+\.js)"/);
assert.ok(entryMatch, "production index.html must reference a JavaScript entry");

const entryPath = path.join(dist, entryMatch[1].replace(/^\//, ""));
const entry = await readFile(entryPath);
const rawBytes = (await stat(entryPath)).size;
const gzipBytes = gzipSync(entry).byteLength;

assert.ok(rawBytes <= 1_100_000, `initial JavaScript entry ${rawBytes} bytes exceeds the 1.1 MB budget`);
assert.ok(gzipBytes <= 350_000, `initial JavaScript entry ${gzipBytes} gzip bytes exceeds the 350 KB budget`);

console.log(JSON.stringify({ entry: path.basename(entryPath), rawBytes, gzipBytes }, null, 2));
