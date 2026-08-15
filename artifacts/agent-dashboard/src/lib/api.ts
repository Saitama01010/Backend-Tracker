import {
  browserAccessToken,
  browserSessionBinding,
  persistBrowserAuthSession,
} from "./authSession.js";

export const API_UNAUTHORIZED_EVENT = "tracker:unauthorized";
export const API_SESSION_RENEWED_EVENT = "tracker:session-renewed";

export type ApiAuthentication = "required" | "none";

export interface ApiRequestOptions extends RequestInit {
  auth?: ApiAuthentication;
}

export interface ApiClientRuntime {
  origin: string;
  fetch: typeof fetch;
  getToken: () => string | null;
  renewSession?: () => Promise<string | null>;
  onUnauthorized: () => void;
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(response: Response) {
    super(`API request failed with status ${response.status}`);
    this.name = "ApiHttpError";
    this.status = response.status;
    this.response = response;
  }
}

export class ApiUnauthorizedError extends ApiHttpError {
  constructor(response: Response) {
    super(response);
    this.name = "ApiUnauthorizedError";
  }
}

let browserRenewal: Promise<string | null> | null = null;

function browserStores() {
  return { local: window.localStorage, session: window.sessionStorage };
}

function renewBrowserSession(): Promise<string | null> {
  if (browserRenewal) return browserRenewal;
  const sessionBinding = browserSessionBinding(browserStores());
  const headers = new Headers({ Accept: "application/json" });
  if (sessionBinding) headers.set("X-Tracker-Session-Binding", sessionBinding);
  browserRenewal = window.fetch(new URL("/api/auth/refresh", window.location.origin), {
    method: "POST",
    credentials: "same-origin",
    headers,
  }).then(async (response) => {
    if (!response.ok) return null;
    const data = await response.json() as { token?: unknown; user?: { role?: unknown }; sessionBinding?: unknown };
    if (typeof data.token !== "string" || !data.user || typeof data.user.role !== "string") return null;
    persistBrowserAuthSession(browserStores(), {
      token: data.token,
      user: data.user as { role: string },
      ...(typeof data.sessionBinding === "string" ? { sessionBinding: data.sessionBinding } : {}),
    });
    window.dispatchEvent(new CustomEvent(API_SESSION_RENEWED_EVENT));
    return data.token;
  }).catch(() => null).finally(() => {
    browserRenewal = null;
  });
  return browserRenewal;
}

function browserRuntime(): ApiClientRuntime {
  return {
    origin: window.location.origin,
    fetch: window.fetch.bind(window),
    getToken: () => browserAccessToken(browserStores()),
    renewSession: renewBrowserSession,
    onUnauthorized: () => {
      window.dispatchEvent(new CustomEvent(API_UNAUTHORIZED_EVENT));
    },
  };
}

function assertSuccessful(response: Response): void {
  if (!response.ok) throw new ApiHttpError(response);
}

export async function apiFetchWithRuntime(
  input: string | URL,
  options: ApiRequestOptions,
  runtime: ApiClientRuntime,
): Promise<Response> {
  const { auth = "required", ...requestInit } = options;
  const runtimeOrigin = new URL(runtime.origin).origin;
  const requestUrl = new URL(input.toString(), runtimeOrigin);

  if (requestUrl.origin !== runtimeOrigin) {
    throw new TypeError("apiFetch only accepts same-origin URLs");
  }

  const headers = new Headers(requestInit.headers);
  if (auth === "required" && !headers.has("Authorization")) {
    const token = runtime.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await runtime.fetch(requestUrl, {
    credentials: requestInit.credentials ?? "same-origin",
    ...requestInit,
    headers,
  });
  if (auth === "required" && response.status === 401) {
    const renewedToken = await runtime.renewSession?.();
    if (renewedToken) {
      const retryHeaders = new Headers(requestInit.headers);
      retryHeaders.set("Authorization", `Bearer ${renewedToken}`);
      const retry = await runtime.fetch(requestUrl, {
        credentials: requestInit.credentials ?? "same-origin",
        ...requestInit,
        headers: retryHeaders,
      });
      if (retry.status !== 401) return retry;
    }
    runtime.onUnauthorized();
    throw new ApiUnauthorizedError(response);
  }

  return response;
}

export function apiFetch(input: string | URL, options: ApiRequestOptions = {}): Promise<Response> {
  return apiFetchWithRuntime(input, options, browserRuntime());
}

export async function apiJsonWithRuntime<T>(
  input: string | URL,
  options: ApiRequestOptions,
  runtime: ApiClientRuntime,
): Promise<T> {
  const response = await apiFetchWithRuntime(input, options, runtime);
  assertSuccessful(response);
  return response.json() as Promise<T>;
}

export function apiJson<T>(input: string | URL, options: ApiRequestOptions = {}): Promise<T> {
  return apiJsonWithRuntime<T>(input, options, browserRuntime());
}

export async function apiBlobWithRuntime(
  input: string | URL,
  options: ApiRequestOptions,
  runtime: ApiClientRuntime,
): Promise<Blob> {
  const response = await apiFetchWithRuntime(input, options, runtime);
  assertSuccessful(response);
  return response.blob();
}

export function apiBlob(input: string | URL, options: ApiRequestOptions = {}): Promise<Blob> {
  return apiBlobWithRuntime(input, options, browserRuntime());
}
