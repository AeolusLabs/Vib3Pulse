import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { UserPlus, Users, Building2, ArrowRight, ArrowLeft, Check, Eye, EyeOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const EVENT_CATEGORIES = [
  "Music", "Food & Drink", "Tech", "Arts",
  "Sports", "Wellness", "Business", "Education", "Community", "Entertainment",
];

const step1Schema = z.object({
  email: z.string().email("Please enter a valid email address"),
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

const step2Schema = z.object({
  userType: z.enum(["social", "organizer"], { required_error: "Please select a user type" }),
});

const GENDER_OPTIONS = ["Male", "Female", "Rather not say"] as const;

const socialUserSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  dateOfBirth: z.string().min(1, "Date of birth is required"),
  gender: z.enum(GENDER_OPTIONS, { required_error: "Please select your gender" }),
  bio: z.string().max(500).optional(),
  interests: z.array(z.string()).min(1, "Please select at least one interest"),
});

const organizerSchema = z.object({
  organizationName: z.string().min(1, "Organization name is required"),
  bio: z.string().max(500).optional(),
  contactEmail: z.string().email("Please enter a valid email address"),
  socialMediaLinks: z.array(z.string()).optional(),
  canManageVenues: z.boolean().default(false),
});

type Step1Data = z.infer<typeof step1Schema>;
type Step2Data = z.infer<typeof step2Schema>;
type SocialUserData = z.infer<typeof socialUserSchema>;
type OrganizerData = z.infer<typeof organizerSchema>;

const inputCls =
  "h-12 bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/25 focus-visible:ring-1 focus-visible:ring-violet-500 focus-visible:border-violet-500/50 rounded-xl font-sans text-sm transition-colors";

const labelCls = "text-white/55 text-xs font-sans font-medium tracking-wide uppercase";

export default function SignupPage() {
  const [, setLocation] = useLocation();
  const [currentStep, setCurrentStep] = useState(1);
  const [step1Data, setStep1Data] = useState<Step1Data | null>(null);
  const [step2Data, setStep2Data] = useState<Step2Data | null>(null);
  const [step3DataSocial, setStep3DataSocial] = useState<SocialUserData | null>(null);
  const [step3DataOrganizer, setStep3DataOrganizer] = useState<OrganizerData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { toast } = useToast();

  const step1Form = useForm<Step1Data>({
    resolver: zodResolver(step1Schema),
    defaultValues: step1Data || { email: "", username: "", password: "", confirmPassword: "" },
  });

  const step2Form = useForm<Step2Data>({
    resolver: zodResolver(step2Schema),
    defaultValues: step2Data || { userType: undefined },
  });

  const socialUserForm = useForm<SocialUserData>({
    resolver: zodResolver(socialUserSchema),
    defaultValues: step3DataSocial || { displayName: "", dateOfBirth: "", gender: undefined, bio: "", interests: [] },
  });

  const organizerForm = useForm<OrganizerData>({
    resolver: zodResolver(organizerSchema),
    defaultValues: step3DataOrganizer || { organizationName: "", bio: "", contactEmail: "", socialMediaLinks: [], canManageVenues: false },
  });

  const onStep1Submit = (data: Step1Data) => { setStep1Data(data); setCurrentStep(2); };
  const onStep2Submit = (data: Step2Data) => { setStep2Data(data); setCurrentStep(3); };

  const onFinalSubmit = async (data: SocialUserData | OrganizerData) => {
    setIsLoading(true);
    if (step2Data?.userType === "social") setStep3DataSocial(data as SocialUserData);
    else setStep3DataOrganizer(data as OrganizerData);

    const completeData = { ...step1Data, ...step2Data, ...data };
    delete (completeData as any).confirmPassword;

    try {
      await apiRequest("POST", "/api/auth/signup", completeData);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      toast({ title: "Account created!", description: "Welcome to Vib3Pulse. Let's explore!" });
      const params = new URLSearchParams(window.location.search);
      setLocation(params.get("redirect") || "/discover");
    } catch (error: any) {
      toast({ title: "Signup failed", description: error.message || "Could not create account. Please try again.", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const goBack = () => {
    if (currentStep === 3) {
      const vals = step2Data?.userType === "social" ? socialUserForm.getValues() : organizerForm.getValues();
      if (step2Data?.userType === "social") setStep3DataSocial(vals as SocialUserData);
      else setStep3DataOrganizer(vals as OrganizerData);
    } else if (currentStep === 2) {
      setStep2Data(step2Form.getValues());
    }
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  useEffect(() => { if (currentStep === 1 && step1Data) step1Form.reset(step1Data); }, [currentStep]);
  useEffect(() => { if (currentStep === 2 && step2Data) step2Form.reset(step2Data); }, [currentStep]);
  useEffect(() => {
    if (currentStep === 3 && step2Data?.userType === "social" && step3DataSocial) socialUserForm.reset(step3DataSocial);
    else if (currentStep === 3 && step2Data?.userType === "organizer" && step3DataOrganizer) organizerForm.reset(step3DataOrganizer);
  }, [currentStep, step2Data]);

  const stepLabels = ["Account", "Role", "Profile"];

  return (
    <div className="min-h-screen bg-[#090909] flex flex-col font-sans">
      {/* Atmospheric glow */}
      <div className="absolute top-0 right-1/4 w-[500px] h-[500px] bg-violet-600/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Brand header */}
      <div className="relative z-10 px-8 pt-8">
        <Link href="/" className="no-underline">
          <span className="font-serif text-[1.35rem] font-bold text-white/50 hover:text-white/80 transition-colors tracking-tight">
            Vib3Pulse
          </span>
        </Link>
      </div>

      <div className="relative z-10 flex-1 flex items-start justify-center px-6 py-10">
        <div className="w-full max-w-lg">

          {/* Step indicator */}
          <div className="flex items-center gap-0 mb-12">
            {stepLabels.map((label, i) => {
              const step = i + 1;
              const done = currentStep > step;
              const active = currentStep === step;
              return (
                <div key={step} className="flex items-center">
                  <div className="flex flex-col items-center gap-1.5">
                    <motion.div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-sans font-semibold transition-colors duration-300 ${
                        done
                          ? "bg-violet-600 text-white"
                          : active
                          ? "bg-violet-600/20 border border-violet-500 text-violet-400"
                          : "bg-white/[0.06] border border-white/[0.08] text-white/25"
                      }`}
                      whileHover={{ scale: done || active ? 1.12 : 1.06 }}
                      whileTap={{ scale: 0.94 }}
                      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                      data-testid={`step-indicator-${step}`}
                    >
                      {done ? <Check className="w-3.5 h-3.5" /> : step}
                    </motion.div>
                    <span
                      className={`text-[0.6rem] tracking-[0.12em] uppercase font-sans transition-colors duration-300 ${
                        active ? "text-white/60" : done ? "text-violet-400/60" : "text-white/20"
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                  {i < stepLabels.length - 1 && (
                    <div
                      className={`w-16 sm:w-24 h-px mx-3 mb-5 transition-colors duration-300 ${
                        currentStep > step ? "bg-violet-600/40" : "bg-white/[0.07]"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Step heading */}
          <div className="mb-8">
            <h1 className="font-serif text-3xl md:text-4xl font-bold text-white tracking-tight leading-tight mb-2">
              {currentStep === 1 && "Create account."}
              {currentStep === 2 && "Choose your role."}
              {currentStep === 3 && "Complete your profile."}
            </h1>
            <p className="text-white/35 text-sm font-sans">
              {currentStep === 1 && "Enter your basic information to get started."}
              {currentStep === 2 && "How will you use Vib3Pulse?"}
              {currentStep === 3 && "Tell us a bit more about yourself."}
            </p>
          </div>

          {/* ── Step 1: Credentials ── */}
          {currentStep === 1 && (
            <Form {...step1Form}>
              <form onSubmit={step1Form.handleSubmit(onStep1Submit)} className="space-y-4">
                <FormField
                  control={step1Form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="you@example.com" className={inputCls} {...field} data-testid="input-email" />
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={step1Form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Username</FormLabel>
                      <FormControl>
                        <Input placeholder="johndoe" className={inputCls} {...field} data-testid="input-username" />
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={step1Form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input type={showPassword ? "text" : "password"} placeholder="Min. 8 characters" className={inputCls + " pr-12"} {...field} data-testid="input-password" />
                          <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors cursor-pointer" data-testid="button-toggle-password" aria-label="Toggle password">
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={step1Form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Confirm Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input type={showConfirmPassword ? "text" : "password"} placeholder="Re-enter your password" className={inputCls + " pr-12"} {...field} data-testid="input-confirm-password" />
                          <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors cursor-pointer" data-testid="button-toggle-confirm-password" aria-label="Toggle confirm password">
                            {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <div className="flex gap-3 pt-2">
                  <Button type="button" variant="outline" className="flex-1 h-12 bg-transparent border-white/[0.09] text-white/50 hover:bg-white/[0.05] hover:text-white rounded-xl font-sans text-sm" onClick={() => window.location.href = "/login"} data-testid="button-back-to-login">
                    Back to Login
                  </Button>
                  <Button type="submit" className="flex-1 h-12 bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans font-medium text-sm shadow-lg shadow-violet-600/15" data-testid="button-next-step-1">
                    Next <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {/* ── Step 2: Role selection ── */}
          {currentStep === 2 && (
            <Form {...step2Form}>
              <form onSubmit={step2Form.handleSubmit(onStep2Submit)} className="space-y-4">
                <FormField
                  control={step2Form.control}
                  name="userType"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <RadioGroup onValueChange={field.onChange} value={field.value} className="grid gap-3">
                          {[
                            {
                              value: "social",
                              icon: Users,
                              title: "Social User",
                              desc: "Discover events, follow friends, buy tickets, and RSVP. Perfect for attendees.",
                            },
                            {
                              value: "organizer",
                              icon: Building2,
                              title: "Event Organizer",
                              desc: "Create and manage events, sell tickets, and track attendance.",
                            },
                          ].map((option) => (
                            <div
                              key={option.value}
                              onClick={() => field.onChange(option.value)}
                              className={`flex items-start gap-4 p-5 rounded-2xl border cursor-pointer transition-all duration-200 ${
                                field.value === option.value
                                  ? "border-violet-500/50 bg-violet-600/[0.07]"
                                  : "border-white/[0.09] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.15]"
                              }`}
                              data-testid={`card-user-type-${option.value}`}
                            >
                              <RadioGroupItem value={option.value} id={option.value} className="border-white/30 text-violet-400 mt-0.5 flex-shrink-0" />
                              <div>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <option.icon className={`w-4 h-4 ${field.value === option.value ? "text-violet-400" : "text-white/40"}`} />
                                  <Label htmlFor={option.value} className="font-sans font-semibold text-white text-sm cursor-pointer">
                                    {option.title}
                                  </Label>
                                </div>
                                <p className="text-white/40 text-xs font-sans leading-relaxed">{option.desc}</p>
                              </div>
                            </div>
                          ))}
                        </RadioGroup>
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <div className="flex gap-3 pt-2">
                  <Button type="button" variant="outline" onClick={goBack} className="flex-1 h-12 bg-transparent border-white/[0.09] text-white/50 hover:bg-white/[0.05] hover:text-white rounded-xl font-sans text-sm" data-testid="button-back-step-2">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button type="submit" className="flex-1 h-12 bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans font-medium text-sm shadow-lg shadow-violet-600/15" data-testid="button-next-step-2">
                    Next <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {/* ── Step 3: Social profile ── */}
          {currentStep === 3 && step2Data?.userType === "social" && (
            <Form {...socialUserForm}>
              <form onSubmit={socialUserForm.handleSubmit(onFinalSubmit)} className="space-y-5">
                <FormField
                  control={socialUserForm.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="How should others see you?" className={inputCls} {...field} data-testid="input-display-name" />
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={socialUserForm.control}
                  name="dateOfBirth"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Date of Birth</FormLabel>
                      <FormControl>
                        <Input type="date" className={inputCls + " [color-scheme:dark]"} {...field} data-testid="input-date-of-birth" />
                      </FormControl>
                      <FormDescription className="text-white/25 text-xs">Not shown publicly. Used for age verification.</FormDescription>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={socialUserForm.control}
                  name="gender"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Gender</FormLabel>
                      <FormControl>
                        <RadioGroup onValueChange={field.onChange} value={field.value} className="flex flex-wrap gap-3">
                          {GENDER_OPTIONS.map((option) => (
                            <div key={option} className="flex items-center gap-2">
                              <RadioGroupItem value={option} id={`gender-${option.toLowerCase().replace(/\s+/g, "-")}`} className="border-white/30 text-violet-400" data-testid={`radio-gender-${option.toLowerCase().replace(/\s+/g, "-")}`} />
                              <Label htmlFor={`gender-${option.toLowerCase().replace(/\s+/g, "-")}`} className="text-white/55 text-sm cursor-pointer font-sans">{option}</Label>
                            </div>
                          ))}
                        </RadioGroup>
                      </FormControl>
                      <FormDescription className="text-white/25 text-xs">Can only be changed once after signup.</FormDescription>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={socialUserForm.control}
                  name="bio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Bio <span className="text-white/25 normal-case tracking-normal">(optional)</span></FormLabel>
                      <FormControl>
                        <Textarea placeholder="Tell us about yourself…" className="resize-none bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/25 focus-visible:ring-1 focus-visible:ring-violet-500 rounded-xl font-sans text-sm" rows={3} {...field} data-testid="input-bio" />
                      </FormControl>
                      <FormDescription className="text-white/25 text-xs">{field.value?.length || 0}/500</FormDescription>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={socialUserForm.control}
                  name="interests"
                  render={() => (
                    <FormItem>
                      <FormLabel className={labelCls}>Interests</FormLabel>
                      <FormDescription className="text-white/25 text-xs -mt-1">Select categories to personalise your feed.</FormDescription>
                      <div className="grid grid-cols-2 gap-2.5 mt-2">
                        {EVENT_CATEGORIES.map((cat) => (
                          <FormField
                            key={cat}
                            control={socialUserForm.control}
                            name="interests"
                            render={({ field }) => (
                              <FormItem className="flex items-center gap-2.5 space-y-0">
                                <FormControl>
                                  <Checkbox
                                    checked={field.value?.includes(cat)}
                                    className="border-white/25 data-[state=checked]:bg-violet-600 data-[state=checked]:border-violet-600 rounded-md"
                                    onCheckedChange={(checked) =>
                                      checked
                                        ? field.onChange([...field.value, cat])
                                        : field.onChange(field.value?.filter((v) => v !== cat))
                                    }
                                    data-testid={`checkbox-interest-${cat.toLowerCase().replace(/\s+/g, "-")}`}
                                  />
                                </FormControl>
                                <FormLabel className="text-sm font-normal cursor-pointer text-white/55 font-sans">{cat}</FormLabel>
                              </FormItem>
                            )}
                          />
                        ))}
                      </div>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <div className="flex gap-3 pt-2">
                  <Button type="button" variant="outline" onClick={goBack} className="flex-1 h-12 bg-transparent border-white/[0.09] text-white/50 hover:bg-white/[0.05] hover:text-white rounded-xl font-sans text-sm" data-testid="button-back-step-3">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button type="submit" className="flex-1 h-12 bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans font-medium text-sm shadow-lg shadow-violet-600/15 overflow-hidden relative" disabled={isLoading} data-testid="button-complete-signup">
                    <AnimatePresence mode="wait" initial={false}>
                      {isLoading ? (
                        <motion.span key="loading" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="flex items-center gap-2">
                          <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…
                        </motion.span>
                      ) : (
                        <motion.span key="idle" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="flex items-center">
                          <UserPlus className="w-4 h-4 mr-2" />Complete Signup
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {/* ── Step 3: Organizer profile ── */}
          {currentStep === 3 && step2Data?.userType === "organizer" && (
            <Form {...organizerForm}>
              <form onSubmit={organizerForm.handleSubmit(onFinalSubmit)} className="space-y-5">
                <FormField
                  control={organizerForm.control}
                  name="organizationName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Organization Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Your company or organization" className={inputCls} {...field} data-testid="input-organization-name" />
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={organizerForm.control}
                  name="contactEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Contact Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="contact@organization.com" className={inputCls} {...field} data-testid="input-contact-email" />
                      </FormControl>
                      <FormDescription className="text-white/25 text-xs">Shown publicly for event enquiries.</FormDescription>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={organizerForm.control}
                  name="bio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Bio <span className="text-white/25 normal-case tracking-normal">(optional)</span></FormLabel>
                      <FormControl>
                        <Textarea placeholder="Tell us about your organization…" className="resize-none bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/25 focus-visible:ring-1 focus-visible:ring-violet-500 rounded-xl font-sans text-sm" rows={3} {...field} data-testid="input-org-bio" />
                      </FormControl>
                      <FormDescription className="text-white/25 text-xs">{field.value?.length || 0}/500</FormDescription>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={organizerForm.control}
                  name="socialMediaLinks"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelCls}>Social Links <span className="text-white/25 normal-case tracking-normal">(optional)</span></FormLabel>
                      <FormDescription className="text-white/25 text-xs -mt-1">One URL per line.</FormDescription>
                      <FormControl>
                        <Textarea
                          placeholder={"https://instagram.com/yourorg\nhttps://twitter.com/yourorg"}
                          className="resize-none bg-white/[0.04] border-white/[0.09] text-white placeholder:text-white/25 focus-visible:ring-1 focus-visible:ring-violet-500 rounded-xl font-sans text-sm"
                          rows={3}
                          value={field.value?.join("\n") || ""}
                          onChange={(e) => field.onChange(e.target.value.split("\n").filter((l) => l.trim()))}
                          data-testid="input-social-links"
                        />
                      </FormControl>
                      <FormMessage className="text-xs text-red-400" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={organizerForm.control}
                  name="canManageVenues"
                  render={({ field }) => (
                    <FormItem className="flex items-start gap-3 p-4 rounded-2xl border border-white/[0.08] bg-white/[0.03]">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={field.onChange} className="border-white/25 data-[state=checked]:bg-violet-600 data-[state=checked]:border-violet-600 rounded-md mt-0.5 flex-shrink-0" data-testid="checkbox-manage-venues" />
                      </FormControl>
                      <div>
                        <FormLabel className="cursor-pointer text-white/70 text-sm font-sans font-medium">I manage a venue</FormLabel>
                        <FormDescription className="text-white/30 text-xs font-sans mt-0.5">Enable to list your club, bar, or lounge for event hosting.</FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
                <div className="flex gap-3 pt-2">
                  <Button type="button" variant="outline" onClick={goBack} className="flex-1 h-12 bg-transparent border-white/[0.09] text-white/50 hover:bg-white/[0.05] hover:text-white rounded-xl font-sans text-sm" data-testid="button-back-step-3">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button type="submit" className="flex-1 h-12 bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans font-medium text-sm shadow-lg shadow-violet-600/15 overflow-hidden relative" disabled={isLoading} data-testid="button-complete-signup">
                    <AnimatePresence mode="wait" initial={false}>
                      {isLoading ? (
                        <motion.span key="loading" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="flex items-center gap-2">
                          <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…
                        </motion.span>
                      ) : (
                        <motion.span key="idle" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="flex items-center">
                          <UserPlus className="w-4 h-4 mr-2" />Complete Signup
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </Button>
                </div>
              </form>
            </Form>
          )}

          <p className="text-sm text-center text-white/25 mt-8 font-sans">
            Already have an account?{" "}
            <Link href="/login" className="text-violet-400 hover:text-violet-300 transition-colors font-medium" data-testid="link-login">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
