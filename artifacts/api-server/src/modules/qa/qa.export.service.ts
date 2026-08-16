import ExcelJS from "exceljs";
import type { QaAgentScope } from "./qa.authorization.js";
import { QaRepository, qaRepository } from "./qa.repository.js";
import type { QaDepartment } from "./qa.schemas.js";
import type { QaDateBasis } from "../../lib/qaPolicy.js";

export type QaExportInput = {
  from: Date;
  to: Date;
  dateBasis: QaDateBasis;
  departments: QaDepartment[] | null;
  agentScope: QaAgentScope;
};

type QaExportRepository = Pick<QaRepository, "listExportReviews">;

export class QaExportService {
  constructor(private readonly repository: QaExportRepository = qaRepository) {}

  async buildWorkbook(input: QaExportInput): Promise<ExcelJS.Workbook> {
    const queriedRows = await this.repository.listExportReviews({
      from: input.from,
      to: input.to,
      dateBasis: input.dateBasis,
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
    });
    const rows = queriedRows.filter((row) => input.agentScope.canAccess(row.agentName));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Backend Tracker";
    workbook.created = new Date();
    const timezone = "America/Los_Angeles";
    const solid = (argb: string): ExcelJS.Fill => ({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb },
    });

    const worksheet = workbook.addWorksheet("QA Reviews", {
      views: [{ state: "frozen", ySplit: 4 }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const headers = [
      "Evaluated (Los Angeles)", "Call Date (Los Angeles)", "Agent", "Department", "Customer Phone",
      "Score", "Protocol", "Soft Skills", "Result", "Critical Fail", "Mentions Tax", "AI Summary",
    ];
    const widths = [22, 22, 22, 14, 16, 8, 10, 11, 10, 12, 13, 60];
    widths.forEach((width, index) => (worksheet.getColumn(index + 1).width = width));
    const columnCount = headers.length;

    worksheet.mergeCells(1, 1, 1, columnCount);
    const titleCell = worksheet.getCell(1, 1);
    titleCell.value = "QA Reviews — Tax Mentions Report";
    titleCell.font = { bold: true, size: 16, color: { argb: "FF3B0764" } };
    worksheet.mergeCells(2, 1, 2, columnCount);
    const taxCount = rows.filter((row) => row.mentionsTax).length;
    worksheet.getCell(2, 1).value = `${rows.length} reviewed  •  ${taxCount} mention tax  •  Generated ${new Date().toLocaleString("en-US", { timeZone: timezone })} (LA)`;
    worksheet.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "FF666666" } };

    const headerRow = worksheet.getRow(4);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = solid("FF6D28D9");
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    headerRow.commit();

    let rowNumber = 5;
    for (const row of rows) {
      const exportRow = worksheet.getRow(rowNumber);
      exportRow.getCell(1).value = new Date(row.evaluatedAt).toLocaleString("en-US", { timeZone: timezone });
      exportRow.getCell(2).value = new Date(row.callDate).toLocaleString("en-US", { timeZone: timezone });
      exportRow.getCell(3).value = row.agentName ?? "";
      exportRow.getCell(4).value = row.department ?? "";
      exportRow.getCell(5).value = row.phoneNumber ?? "";
      exportRow.getCell(6).value = row.score ?? 0;
      exportRow.getCell(7).value = row.protocolScore ?? 0;
      exportRow.getCell(8).value = row.softSkillsScore ?? 0;
      exportRow.getCell(9).value = row.pass ? "Pass" : "Fail";
      exportRow.getCell(10).value = row.criticalFail ? "YES" : "";
      const taxCell = exportRow.getCell(11);
      taxCell.value = row.mentionsTax ? "YES" : "";
      taxCell.alignment = { horizontal: "center" };
      if (row.mentionsTax) {
        taxCell.fill = solid("FFFEF3C7");
        taxCell.font = { bold: true, color: { argb: "FF92400E" } };
      }
      exportRow.getCell(12).value = row.aiSummary ?? "";
      exportRow.commit();
      rowNumber++;
    }
    worksheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: Math.max(4, rowNumber - 1), column: columnCount },
    };
    return workbook;
  }
}

export const qaExportService = new QaExportService();
