import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { LogIn, Eye, EyeOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/auth/login", data);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
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

          {/* Form */}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/40 text-xs font-sans font-medium tracking-wide uppercase">
                      Username
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Enter your username"
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
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
                        <LogIn className="w-4 h-4 mr-2" />
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
