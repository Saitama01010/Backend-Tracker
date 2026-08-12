export async function unparseCsv(rows: unknown[]): Promise<string> {
  const { default: Papa } = await import("papaparse");
  return Papa.unparse(rows);
}
