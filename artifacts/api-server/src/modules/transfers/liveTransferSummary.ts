export interface LiveTransferClassificationCount {
  kind: string | null;
  company: string | null;
  cnt: number;
}

export function summarizeLiveTransferCounts(rows: readonly LiveTransferClassificationCount[]) {
  let aspire = 0;
  let resync = 0;
  let clarity = 0;
  let concordia = 0;
  let unspecified = 0;
  let internalTotal = 0;
  const internalMap = new Map<string, number>();

  for (const row of rows) {
    const count = Number(row.cnt) || 0;
    if (row.kind === "internal") {
      const department = row.company || "Other";
      internalMap.set(department, (internalMap.get(department) ?? 0) + count);
      internalTotal += count;
    } else if (row.company === "Aspire") aspire += count;
    else if (row.company === "Resync") resync += count;
    else if (row.company === "Clarity") clarity += count;
    else if (row.company === "Concordia") concordia += count;
    else unspecified += count;
  }

  const partnerTotal = aspire + resync + clarity + concordia + unspecified;
  return {
    totalLive: partnerTotal + internalTotal,
    partnerTotal,
    aspire,
    resync,
    clarity,
    concordia,
    unspecified,
    internalTotal,
    internalByDept: [...internalMap.entries()]
      .map(([dept, count]) => ({ dept, count }))
      .sort((left, right) => right.count - left.count),
  };
}
