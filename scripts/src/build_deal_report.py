import json, glob, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

deals = json.load(open("/tmp/deals.json"))
results = json.load(open("/tmp/results.json"))

headers = [
    "Agent Name", "Agent Team", "Customer Name", "File ID", "Phone", "Submission Date", "Status",
    "Total Calls", "Retention (in)", "NSF", "CS", "Onboarding", "OB (outbound)", "Other (in)",
    "Live Call?", "Live Call Evidence", "Transfer Source", "Flag", "Outcome Summary",
]

wb = Workbook()
ws = wb.active
ws.title = "May Deals - Call Analysis"

hdr_fill = PatternFill("solid", fgColor="3B0764")
hdr_font = Font(bold=True, color="FFFFFF", size=11)
thin = Side(style="thin", color="D4D4D8")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
center = Alignment(horizontal="center", vertical="top")
wrap = Alignment(horizontal="left", vertical="top", wrap_text=True)

ws.append(headers)
for c in ws[1]:
    c.fill = hdr_fill; c.font = hdr_font; c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True); c.border = border

yes_fill = PatternFill("solid", fgColor="DCFCE7")
flag_fill = PatternFill("solid", fgColor="FEF9C3")
nocall_fill = PatternFill("solid", fgColor="FEE2E2")

for d in deals:
    r = results.get(d.get("_e164") or "", {})
    total = r.get("total_calls", 0)
    if total == 0:
        flag = "No calls found"
    elif r.get("ob_done_no_retention"):
        flag = "OB done — no calls on retention line"
    else:
        flag = ""
    row = [
        d.get("AgentName"), d.get("AgentTeam"), d.get("CustomerName"), d.get("FileID"),
        d.get("Phone"), d.get("SubmissionDate"), d.get("Status"),
        total, r.get("retention_in_completed", 0), r.get("nsf_completed", 0),
        r.get("cs_completed", 0), r.get("onboarding_completed", 0),
        r.get("ob_completed", 0), r.get("other_completed", 0),
        r.get("live_call", "No"), r.get("live_call_evidence", ""),
        r.get("transfer_source", ""), flag, r.get("outcome_summary", ""),
    ]
    ws.append(row)
    ri = ws.max_row
    for ci in range(1, len(headers) + 1):
        cell = ws.cell(row=ri, column=ci)
        cell.border = border
        cell.alignment = center if 8 <= ci <= 15 or ci == 4 else wrap
    if r.get("live_call") == "Yes":
        ws.cell(row=ri, column=15).fill = yes_fill
        ws.cell(row=ri, column=15).font = Font(bold=True, color="166534")
    if flag == "No calls found":
        ws.cell(row=ri, column=18).fill = nocall_fill
    elif flag:
        ws.cell(row=ri, column=18).fill = flag_fill

widths = [22, 14, 18, 12, 14, 18, 22, 9, 11, 7, 7, 11, 12, 9, 9, 38, 18, 30, 60]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w

ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{ws.max_row}"

src = sorted(f for f in glob.glob("attached_assets/May_Deals_*.xlsx") if "_Call_Analysis" not in f)[-1]
base = os.path.splitext(os.path.basename(src))[0]
out = f"attached_assets/{base}_Call_Analysis.xlsx"
wb.save(out)
print("wrote", out, "rows:", ws.max_row - 1)

# Quick stats
live = sum(1 for d in deals if results.get(d.get("_e164") or "", {}).get("live_call") == "Yes")
nocall = sum(1 for d in deals if results.get(d.get("_e164") or "", {}).get("total_calls", 0) == 0)
obdone = sum(1 for d in deals if results.get(d.get("_e164") or "", {}).get("ob_done_no_retention"))
print(f"live={live} no_calls={nocall} ob_done={obdone}")
