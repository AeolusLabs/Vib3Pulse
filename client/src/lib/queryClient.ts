import { QueryClient, QueryFunction } from "@tanstack/react-query";

let csrfToken: string | null = null;

function getCsrfTokenFromCookie(): string | null {
  const match = document.cookie.match(/csrf-token=([^;]+)/);
  return match ? match[1] : null;
}

export async function ensureCsrfToken(): Promise<string> {
  let token = getCsrfTokenFromCookie();
  
  if (!token) {
    const res = await fetch("/api/csrf-token", {
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      token = data.csrfToken;
    }
  }
  
  if (!token) {
    token = getCsrfTokenFromCookie();
  }
  
  if (token) {
    csrfToken = token;
  }
  
  return csrfToken || "";
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    
    if (res.status === 403 && text.includes("CSRF")) {
      csrfToken = null;
      await ensureCsrfToken();
    }
    
    // Try to parse JSON error response for better error messages
    let errorMessage = text;
    try {
      const errorJson = JSON.parse(text);
      if (errorJson.message) {
        errorMessage = errorJson.message;
      }
    } catch {
      // Not JSON, use raw text
    }
    
    throw new Error(errorMessage);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const token = await ensureCsrfToken();
  
  const headers: Record<string, string> = {
    "x-csrf-token": token,
  };
  
  if (data) {
    headers["Content-Type"] = "application/json";
  }
  
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
