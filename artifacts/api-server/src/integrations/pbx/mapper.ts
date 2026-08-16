export type PbxTeam = "retention" | "nsf" | "cs" | "other";

export function teamFromRingGroupName(name: string): PbxTeam {
  const normalizedName = name.toLowerCase();
  if (normalizedName.includes("retention")) return "retention";
  if (normalizedName.includes("back") || normalizedName.includes("nsf")) return "nsf";
  if (
    normalizedName.includes("customer")
    || normalizedName.includes("support")
    || normalizedName === "cs"
    || normalizedName.includes("cs team")
  ) return "cs";
  return "other";
}
