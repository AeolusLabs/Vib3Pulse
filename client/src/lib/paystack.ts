declare global {
  interface Window {
    PaystackPop?: new () => {
      resumeTransaction: (
        accessCode: string,
        options: {
          onSuccess: (transaction: unknown) => void;
          onCancel: () => void;
          onError?: (error: { message?: string } | undefined) => void;
        },
      ) => void;
    };
  }
}

const PAYSTACK_SCRIPT_URL = "https://js.paystack.co/v2/inline.js";
let scriptLoadPromise: Promise<void> | null = null;

function loadPaystackScript(): Promise<void> {
  if (window.PaystackPop) return Promise.resolve();

  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${PAYSTACK_SCRIPT_URL}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Failed to load Paystack script")));
        return;
      }

      const script = document.createElement("script");
      script.src = PAYSTACK_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Paystack script"));
      document.head.appendChild(script);
    });
  }

  return scriptLoadPromise;
}

// The backend already initializes the Paystack transaction (createPaystackInlineSession)
// and hands us the resulting access_code, so the popup just resumes that transaction
// rather than collecting amount/email again on the client. Paystack Inline v2 requires
// instantiating `new PaystackPop()` before calling resumeTransaction — the v1 static
// `PaystackPop.setup(...)` API was retired.
export async function openPaystackPopup(
  accessCode: string,
  handlers: {
    onSuccess: () => void;
    onCancel: () => void;
    onError?: (message: string) => void;
  },
): Promise<void> {
  await loadPaystackScript();

  if (!window.PaystackPop) {
    handlers.onError?.("Paystack failed to load");
    return;
  }

  const popup = new window.PaystackPop();
  popup.resumeTransaction(accessCode, {
    onSuccess: () => handlers.onSuccess(),
    onCancel: handlers.onCancel,
    onError: (error) => handlers.onError?.(error?.message ?? "Paystack payment failed"),
  });
}
