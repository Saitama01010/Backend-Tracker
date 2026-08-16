import { logger as rootLogger } from "../../lib/logger.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";

const READYMODE_BASE_URL = "https://icydeals.readymode.com";
const READYMODE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let cachedCookies = "";
let cookieExpiry = 0;
let loginBackoffUntil = 0;

async function getSession(): Promise<string> {
  if (cachedCookies && Date.now() < cookieExpiry) return cachedCookies;

  const now = Date.now();
  if (now < loginBackoffUntil) {
    const waitSecs = Math.ceil((loginBackoffUntil - now) / 1000);
    throw new Error(`ReadyMode login cooling down — retry in ${waitSecs}s`);
  }

  const username = process.env["READYMODE_USERNAME"];
  const password = process.env["READYMODE_PASSWORD"];
  if (!username || !password) throw new Error("READYMODE_USERNAME / READYMODE_PASSWORD not set");

  const getRes = await fetch(`${READYMODE_BASE_URL}/login_new/`, {
    headers: { "User-Agent": READYMODE_USER_AGENT, "Accept": "text/html" },
    redirect: "manual",
  });
  const initialCookies = (getRes.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]).join("; ");

  const params = new URLSearchParams();
  params.set("login_account", username);
  params.set("login_password", password);
  params.set("then", "");
  params.set("use_phone_module", "auto");
  params.set("user_tz", OPERATIONAL_CONFIG.businessTimeZone);

  const postRes = await fetch(`${READYMODE_BASE_URL}/login_new/`, {
    method: "POST",
    headers: {
      "User-Agent": READYMODE_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": initialCookies,
      "Referer": `${READYMODE_BASE_URL}/login_new/`,
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    body: params.toString(),
    redirect: "manual",
  });

  if (postRes.status !== 302) {
    const body = await postRes.text();
    const errMsg = body.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)/i)?.[1]?.trim() ?? `HTTP ${postRes.status}`;
    loginBackoffUntil = Date.now() + 15 * 60 * 1000;
    throw new Error(`ReadyMode login failed: ${errMsg}`);
  }

  const authCookies = (postRes.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]);
  const allCookies = new Map<string, string>();
  for (const keyValue of [...initialCookies.split("; "), ...authCookies]) {
    const equals = keyValue.indexOf("=");
    if (equals > 0) allCookies.set(keyValue.slice(0, equals), keyValue.slice(equals + 1));
  }

  cachedCookies = [...allCookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  cookieExpiry = Date.now() + 4 * 60 * 60 * 1000;
  rootLogger.info("ReadyMode session established");
  return cachedCookies;
}

export async function fetchReadyModeHtml(
  path: string,
  maxRedirects = 5,
): Promise<{ status: number; body: string; isJson: boolean; finalUrl: string }> {
  await getSession();
  let currentPath = path;
  let hops = 0;

  while (hops < maxRedirects) {
    const res = await fetch(`${READYMODE_BASE_URL}${currentPath}`, {
      headers: { "User-Agent": READYMODE_USER_AGENT, "Accept": "text/html,application/json,*/*", "Cookie": cachedCookies },
      redirect: "manual",
    });
    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("location") ?? "";
      if (location.includes("login_new") || location.includes("login.php")) {
        if (hops > 0) throw new Error("ReadyMode session expired (redirected to login after re-auth)");
        rootLogger.info({ location }, "ReadyMode session expired, re-authenticating");
        cachedCookies = "";
        cookieExpiry = 0;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await getSession();
        hops++;
        continue;
      }
      if (location.startsWith("http")) {
        try {
          const url = new URL(location);
          currentPath = url.pathname + url.search;
        } catch {
          currentPath = location;
        }
      } else {
        currentPath = location;
      }
      rootLogger.info({ from: path, to: currentPath }, "ReadyMode redirect followed");
      hops++;
      continue;
    }
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    return { status: res.status, body, isJson: contentType.includes("application/json"), finalUrl: currentPath };
  }
  throw new Error(`ReadyMode: too many redirects from ${path}`);
}

export async function probeReadyModePath(
  path: string,
): Promise<{ status: number; isJson: boolean; bodyLength: number }> {
  await getSession();
  const res = await fetch(`${READYMODE_BASE_URL}${path}`, {
    headers: { "User-Agent": READYMODE_USER_AGENT, "Accept": "text/html,application/json,*/*", "Cookie": cachedCookies },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("ReadyMode probe redirect rejected");
  }
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, isJson: contentType.includes("application/json"), bodyLength: body.length };
}

export function resetReadyModeSession(): void {
  cachedCookies = "";
  cookieExpiry = 0;
  loginBackoffUntil = 0;
  rootLogger.info("ReadyMode session cache cleared");
}
