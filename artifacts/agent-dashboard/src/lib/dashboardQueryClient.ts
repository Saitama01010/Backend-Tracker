import { QueryClient } from "@tanstack/react-query";

export const dashboardQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

export function clearDashboardQueryCache(): void {
  dashboardQueryClient.clear();
}
