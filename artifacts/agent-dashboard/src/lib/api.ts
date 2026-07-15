export const API_UNAUTHORIZED_EVENT = "tracker:unauthorized";

export type ApiAuthentication = "required" | "none";

export interface ApiRequestOptions extends RequestInit {
  auth?: ApiAuthentication;
}

export interface ApiClientRuntime {
  origin: string;
  fetch: typeof fetch;
  getToken: () => string | null;
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

function browserRuntime(): ApiClientRuntime {
  return {
    origin: window.location.origin,
    fetch: window.fetch.bind(window),
    getToken: () => window.localStorage.getItem("tracker_token"),
    onUnauthorized: () => {
      window.localStorage.removeItem("tracker_token");
      window.localStorage.removeItem("tracker_user");
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

  const response = await runtime.fetch(requestUrl, { ...requestInit, headers });
  if (auth === "required" && response.status === 401) {
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
