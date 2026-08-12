param(
  [Parameter(Mandatory = $true)]
  [string]$EnvFile,
  [string]$BaselineUrl = "http://127.0.0.1:8093",
  [string]$CandidateUrl = "http://127.0.0.1:8094"
)

$ErrorActionPreference = "Stop"

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $parts = $line -split "=", 2
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path ("Env:" + $parts[0].Trim()) -Value $value
  }
}

$tokenScript = @'
import pg from "pg";
import jwt from "jsonwebtoken";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.OLD_DATABASE_URL });
const result = await pool.query(
  "select id, username, role from portal_users where active = true order by case when role = 'admin' then 0 else 1 end, id",
);
const admin = result.rows.find((row) => row.role === "admin");
const viewer = result.rows.find((row) => row.role !== "admin");
if (!admin || !viewer) throw new Error("Active admin and non-admin users are required for runtime verification.");

const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === "production" ? null : "dev-secret-change-me");
if (!secret) throw new Error("SESSION_SECRET is required.");
const sign = (row) => jwt.sign(
  { userId: row.id, username: row.username, role: row.role, permissions: [] },
  secret,
  { expiresIn: "10m" },
);
process.stdout.write(JSON.stringify({ admin: sign(admin), viewer: sign(viewer) }));
await pool.end();
'@

$tokens = ($tokenScript | & node.exe --no-warnings --input-type=module - | ConvertFrom-Json)
$adminHeaders = @{ Authorization = "Bearer $($tokens.admin)" }
$viewerHeaders = @{ Authorization = "Bearer $($tokens.viewer)" }
$today = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), "Pacific Standard Time").ToString("yyyy-MM-dd")

function Get-Json([string]$baseUrl, [string]$path) {
  Invoke-RestMethod -Uri "$baseUrl$path" -Headers $adminHeaders -TimeoutSec 60
}

function Same-Json($left, $right) {
  (ConvertTo-Json $left -Depth 30 -Compress) -ceq (ConvertTo-Json $right -Depth 30 -Compress)
}

function Http-Status(
  [string]$uri,
  [hashtable]$headers,
  [string]$method = "GET",
  [string]$body = ""
) {
  try {
    $parameters = @{
      Uri = $uri
      Method = $method
      Headers = $headers
      UseBasicParsing = $true
      TimeoutSec = 20
    }
    if ($body) {
      $parameters.Body = $body
      $parameters.ContentType = "application/json"
    }
    $response = Invoke-WebRequest @parameters
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

$health3 = Http-Status "$BaselineUrl/api/healthz" @{}
$health4 = Http-Status "$CandidateUrl/api/healthz" @{}
$attendance3 = Get-Json $BaselineUrl "/api/attendance?from=$today&to=$today"
$attendance4 = Get-Json $CandidateUrl "/api/attendance?from=$today&to=$today"
$violations3 = Get-Json $BaselineUrl "/api/violations?from=$today&to=$today"
$violations4 = Get-Json $CandidateUrl "/api/violations?from=$today&to=$today"
$ob3 = Get-Json $BaselineUrl "/api/ob-report/status?from=$today&to=$today"
$ob4 = Get-Json $CandidateUrl "/api/ob-report/status?from=$today&to=$today"
$analytics3 = Get-Json $BaselineUrl "/api/ob-analytics?from=$today&to=$today"
$analytics4 = Get-Json $CandidateUrl "/api/ob-analytics?from=$today&to=$today"
$analytics3.meta.generatedAt = $null
$analytics4.meta.generatedAt = $null
$live3 = Get-Json $BaselineUrl "/api/live-transfers/status?from=$today&to=$today"
$live4 = Get-Json $CandidateUrl "/api/live-transfers/status?from=$today&to=$today"
$qaPath = "/api/qa/stats?from=${today}T00:00:00Z&to=${today}T23:59:59Z&dateBasis=evaluated"
$qa3 = Get-Json $BaselineUrl $qaPath
$qa4 = Get-Json $CandidateUrl $qaPath

"health phase3=$health3 phase4=$health4"
"attendance_equal=$(Same-Json $attendance3 $attendance4) members=$($attendance4.members.Count) records=$($attendance4.records.Count)"
"violations_equal=$(Same-Json $violations3 $violations4) late=$($violations4.lateLogin.Count) gaps=$($violations4.availabilityGaps.Count) missed=$($violations4.missedWhileAvail.Count) verified=$($violations4.verifiedKeys.Count)"
"onboarding_status_equal=$(Same-Json $ob3 $ob4) total=$($ob4.totalCalls) classified=$($ob4.classified)"
"onboarding_analytics_equal=$(Same-Json $analytics3 $analytics4) total=$($analytics4.kpis.totalCalls)"
"live_transfers_equal=$(Same-Json $live3 $live4) total=$($live4.totalLive)"
"qa_stats_equal=$(Same-Json $qa3 $qa4) reviewed=$($qa4.reviewed)"

$memberBody = @{ name = "Sanitized"; department = "CS" } | ConvertTo-Json -Compress
$keyBody = @{ key = "sanitized" } | ConvertTo-Json -Compress
"logged_out_attendance=$(Http-Status "$CandidateUrl/api/attendance" @{}) invalid_token=$(Http-Status "$CandidateUrl/api/attendance" @{ Authorization = 'Bearer invalid' })"
"viewer_member_create=$(Http-Status "$CandidateUrl/api/attendance/members" $viewerHeaders 'POST' $memberBody) viewer_import=$(Http-Status "$CandidateUrl/api/attendance/import" $viewerHeaders 'POST' '{}')"
"viewer_ob_refresh=$(Http-Status "$CandidateUrl/api/ob-report/refresh" $viewerHeaders 'POST' '{}') viewer_lt_refresh=$(Http-Status "$CandidateUrl/api/live-transfers/refresh" $viewerHeaders 'POST' '{}') viewer_verify_delete=$(Http-Status "$CandidateUrl/api/violations/verify" $viewerHeaders 'DELETE' $keyBody)"
"malformed_attendance_date=$(Http-Status "$CandidateUrl/api/attendance?from=2026-07-15-extra&to=2026-07-15" $adminHeaders) malformed_violation_date=$(Http-Status "$CandidateUrl/api/violations?from=2026-02-30&to=2026-07-15" $adminHeaders)"

$downloads = @(
  @("ob-report", "/api/ob-report/download?from=$today&to=$today"),
  @("ob-analytics", "/api/ob-analytics/download?from=$today&to=$today"),
  @("live-transfers", "/api/live-transfers/download?from=$today&to=$today"),
  @("qa", "/api/qa/download?from=${today}T00:00:00Z&to=${today}T23:59:59Z&dateBasis=evaluated")
)
foreach ($download in $downloads) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$CandidateUrl$($download[1])" -Headers $adminHeaders -TimeoutSec 120
  $private = ([string]$response.Headers["Cache-Control"]) -eq "private, no-store, max-age=0"
  $xlsx = ([string]$response.Headers["Content-Type"]) -like "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet*"
  "$($download[0])_download status=$($response.StatusCode) xlsx=$xlsx private=$private bytes=$($response.RawContentLength) disposition=$($response.Headers['Content-Disposition'])"
}
