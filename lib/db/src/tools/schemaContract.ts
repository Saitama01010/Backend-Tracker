import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export type SchemaContractObjectType =
  | "table"
  | "column"
  | "index"
  | "constraint"
  | "function"
  | "trigger";

export interface SchemaContractObject {
  name: string;
  type: SchemaContractObjectType;
  migration: string;
  parent: string;
  purpose: string;
  drizzleRepresented: boolean;
  definitionIncludes?: string[];
}

interface SchemaContractDocument {
  version: number;
  authority: string;
  objects: SchemaContractObject[];
}

export interface SchemaContractResult {
  name: string;
  type: SchemaContractObjectType;
  migration: string;
  present: boolean;
  definitionMatches: boolean;
  drizzleRepresented: boolean;
  error: string | null;
}

const CONTRACT_PATH = fileURLToPath(
  new URL("../../schema-contract.json", import.meta.url),
);

function normalizeDefinition(value: string): string {
  return value
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/public\./g, "")
    .replace(/::(?:text|character varying|date|timestamp with time zone)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

export async function loadSchemaContract(): Promise<SchemaContractDocument> {
  const parsed = JSON.parse(
    await readFile(CONTRACT_PATH, "utf8"),
  ) as SchemaContractDocument;
  if (
    parsed.version !== 1 ||
    parsed.authority !== "checked-in-migrations" ||
    !Array.isArray(parsed.objects) ||
    parsed.objects.length === 0
  ) {
    throw new Error("SCHEMA_CONTRACT_INVALID");
  }
  const identities = new Set<string>();
  for (const object of parsed.objects) {
    const identity = `${object.type}:${object.parent}:${object.name}`;
    if (identities.has(identity)) throw new Error("SCHEMA_CONTRACT_DUPLICATE");
    identities.add(identity);
  }
  return parsed;
}

async function objectDefinition(
  pool: Pick<Pool, "query">,
  object: SchemaContractObject,
): Promise<string | null> {
  if (object.type === "table") {
    const result = await pool.query<{ definition: string | null }>(
      "SELECT to_regclass($1)::text AS definition",
      [`public.${object.name}`],
    );
    return result.rows[0]?.definition ?? null;
  }
  if (object.type === "column") {
    const result = await pool.query<{ definition: string }>(
      `SELECT format_type(attribute.atttypid, attribute.atttypmod) AS definition
         FROM pg_attribute AS attribute
         JOIN pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = $1
          AND attribute.attname = $2 AND attribute.attnum > 0
          AND NOT attribute.attisdropped`,
      [object.parent, object.name],
    );
    return result.rows[0]?.definition ?? null;
  }
  if (object.type === "index") {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_indexdef(index_relation.oid) AS definition
         FROM pg_class AS index_relation
         JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
         JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_relation.oid
         JOIN pg_class AS table_relation ON table_relation.oid = index_metadata.indrelid
        WHERE namespace.nspname = 'public' AND index_relation.relname = $1
          AND table_relation.relname = $2`,
      [object.name, object.parent],
    );
    return result.rows[0]?.definition ?? null;
  }
  if (object.type === "constraint") {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(constraint_metadata.oid, true) AS definition
         FROM pg_constraint AS constraint_metadata
         JOIN pg_class AS relation ON relation.oid = constraint_metadata.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND constraint_metadata.conname = $1
          AND relation.relname = $2`,
      [object.name, object.parent],
    );
    return result.rows[0]?.definition ?? null;
  }
  if (object.type === "function") {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(procedure.oid) AS definition
         FROM pg_proc AS procedure
         JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname = $1
        ORDER BY procedure.oid
        LIMIT 1`,
      [object.name],
    );
    return result.rows[0]?.definition ?? null;
  }
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_triggerdef(trigger_metadata.oid, true) AS definition
       FROM pg_trigger AS trigger_metadata
       JOIN pg_class AS relation ON relation.oid = trigger_metadata.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND trigger_metadata.tgname = $1
        AND relation.relname = $2 AND NOT trigger_metadata.tgisinternal`,
    [object.name, object.parent],
  );
  return result.rows[0]?.definition ?? null;
}

export async function verifySchemaContract(
  pool: Pick<Pool, "query">,
): Promise<{
  ok: boolean;
  authority: string;
  results: SchemaContractResult[];
}> {
  const contract = await loadSchemaContract();
  const results: SchemaContractResult[] = [];
  for (const object of contract.objects) {
    const definition = await objectDefinition(pool, object);
    const normalized = definition ? normalizeDefinition(definition) : "";
    const expected = (object.definitionIncludes ?? []).map(normalizeDefinition);
    const definitionMatches =
      definition !== null &&
      expected.every((part) => normalized.includes(part));
    results.push({
      name: object.name,
      type: object.type,
      migration: object.migration,
      present: definition !== null,
      definitionMatches,
      drizzleRepresented: object.drizzleRepresented,
      error:
        definition === null
          ? "missing"
          : definitionMatches
            ? null
            : "definition_mismatch",
    });
  }
  return {
    ok: results.every((result) => result.present && result.definitionMatches),
    authority: contract.authority,
    results,
  };
}
