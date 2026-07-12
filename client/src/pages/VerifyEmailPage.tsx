import { useEffect, useState } from "react";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";

type Status = "loading" | "success" | "error";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");

    if (!token) {
      setStatus("error");
      setMessage("No verification token found in the link.");
      return;
    }

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          // Refresh session so the banner disappears immediately
          await queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
          setStatus("success");
          setMessage(body.message || "Email verified successfully.");
        } else {
          setStatus("error");
          setMessage(body.message || "This link is invalid or has expired.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Something went wrong. Please try again.");
      });
  }, []);

  return (
    <div className="min-h-screen bg-[#090909] flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-md text-center">
        {/* Brand */}
        <Link href="/" className="no-underline">
          <span className="font-serif text-[1.35rem] font-bold text-white/50 hover:text-white/80 transition-colors tracking-tight">
            Vib3Pulse
          </span>
        </Link>

        <div className="mt-10 bg-white/[0.03] border border-white/[0.08] rounded-2xl p-10">
          {status === "loading" && (
            <>
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-violet-600/10 border border-violet-500/20 mb-6">
                <div className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
              </div>
              <h1 className="text-xl font-semibold text-white mb-2">Verifying your email…</h1>
              <p className="text-white/35 text-sm">This will only take a moment.</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-6">
                <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-white mb-2">Email verified!</h1>
              <p className="text-white/35 text-sm mb-8">{message}</p>
              <Link
                href="/feed"
                className="inline-block bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-8 py-3 rounded-xl transition-colors"
              >
                Go to feed
              </Link>
            </>
          )}

          {status === "error" && (
            <>
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 mb-6">
                <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-white mb-2">Verification failed</h1>
              <p className="text-white/35 text-sm mb-8">{message}</p>
              <Link
                href="/feed"
                className="inline-block text-violet-400 hover:text-violet-300 text-sm underline transition-colors"
              >
                Go to app and resend from the banner
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
