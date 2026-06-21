import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LogInIcon, EyeIcon, EyeOffIcon } from "@/components/ui/icons";

const loginSchema = z.object({
  username: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "google_auth_failed") {
      toast({
        title: "Google sign-in failed",
        description: "We couldn't sign you in with Google. Please try again.",
        variant: "destructive",
      });
    }
  }, []);

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/auth/login", data);
      const { user, csrfToken } = await response.json();
      // Immediately hydrate the cache so AuthenticatedLayout never sees null
      queryClient.setQueryData(["/api/auth/session"], user);
      // Store the rotated CSRF token the server sends back on login
      if (csrfToken) {
        document.cookie = `csrf-token=${csrfToken}; path=/; SameSite=Strict`;
      }
      toast({ title: "Welcome back!", description: "You've successfully signed in." });
      const params = new URLSearchParams(window.location.search);
      setLocation(params.get("redirect") || "/discover");
    } catch (error: any) {
      toast({
        title: "Login failed",
        description: error.message || "Invalid credentials. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090909] flex flex-col font-sans">
      {/* Subtle atmospheric glow */}
      <div className="absolute top-0 left-1/3 w-[500px] h-[500px] bg-violet-600/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Brand header */}
      <div className="relative z-10 px-8 pt-8">
        <Link href="/" className="no-underline">
          <span className="font-serif text-[1.35rem] font-bold text-white/50 hover:text-white/80 transition-colors tracking-tight">
            Vib3Pulse
          </span>
        </Link>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[360px]">

          {/* Heading */}
          <div className="mb-10">
            <h1 className="font-serif text-4xl md:text-5xl font-bold text-white tracking-tight leading-tight mb-3">
              Welcome
              <br />
              back.
            </h1>
            <p className="text-white/40 text-sm leading-relaxed">
              Sign in to your account to continue.
            </p>
          </div>

          {/* Google Sign-In */}
          <motion.div
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
            className="mb-6"
          >
            <a
              href="/api/auth/google"
              className="flex items-center justify-center gap-3 w-full h-12 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.09] rounded-xl text-white text-sm font-sans font-medium transition-colors duration-200"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </a>
          </motion.div>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-white/[0.07]" />
            <span className="text-white/25 text-xs font-sans">or</span>
            <div className="flex-1 h-px bg-white/[0.07]" />
          </div>

          {/* Form */}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/40 text-xs font-sans font-medium tracking-wide uppercase">
                      Username or Email
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Enter your username or email"
                        className="h-12 bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/20 focus-visible:ring-1 focus-visible:ring-violet-500 focus-visible:border-violet-500/50 rounded-xl font-sans text-sm transition-colors"
                        {...field}
                        data-testid="input-username"
                      />
                    </FormControl>
                    <FormMessage className="text-xs text-red-400" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/40 text-xs font-sans font-medium tracking-wide uppercase">
                      Password
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          placeholder="Password"
                          className="h-12 pr-12 bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/25 focus-visible:ring-1 focus-visible:ring-violet-500 focus-visible:border-violet-500/50 rounded-xl font-sans text-sm transition-colors"
                          {...field}
                          data-testid="input-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors cursor-pointer"
                          data-testid="button-toggle-password"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                        >
                          {showPassword ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage className="text-xs text-red-400" />
                  </FormItem>
                )}
              />

              <motion.div
                whileTap={{ scale: 0.98 }}
                transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
                className="mt-2"
              >
                <Button
                  type="submit"
                  className="w-full h-12 bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans font-medium text-sm shadow-lg shadow-violet-600/20 transition-colors duration-200 overflow-hidden relative"
                  disabled={isLoading}
                  data-testid="button-login"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {isLoading ? (
                      <motion.span
                        key="loading"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                        className="flex items-center gap-2"
                      >
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Signing in…
                      </motion.span>
                    ) : (
                      <motion.span
                        key="idle"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                        className="flex items-center"
                      >
                        <LogInIcon className="w-4 h-4 mr-2" />
                        Sign In
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>
              </motion.div>
            </form>
          </Form>

          {/* Aux links */}
          <div className="mt-7 flex flex-col items-center gap-3">
            <Link
              href="/forgot-password"
              className="text-sm text-white/30 hover:text-white/60 transition-colors font-sans"
              data-testid="link-forgot-password"
            >
              Forgot your password?
            </Link>
            <p className="text-sm text-white/25 font-sans">
              New here?{" "}
              <Link
                href={`/signup${window.location.search}`}
                className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
                data-testid="link-signup"
              >
                Create account
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
