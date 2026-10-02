import { useQuery } from "@tanstack/react-query";

export interface AdminFilterOptions {
  countries: string[];
  currencies: string[];
}

export function useAdminFilterOptions() {
  return useQuery<AdminFilterOptions>({
    queryKey: ["/api/admin/meta/filters"],
    staleTime: 5 * 60 * 1000,
  });
}
