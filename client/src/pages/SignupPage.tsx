import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { UserPlus, Users, Building2, ArrowRight, ArrowLeft, Check, Eye, EyeOff, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const EVENT_CATEGORIES = [
  "Music",
  "Food & Drink",
  "Tech",
  "Arts",
  "Sports",
  "Wellness",
  "Business",
  "Education",
  "Community",
  "Entertainment",
];

const step1Schema = z.object({
  email: z.string().email("Please enter a valid email address"),
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

const step2Schema = z.object({
  userType: z.enum(["social", "organizer"], {
    required_error: "Please select a user type",
  }),
});

const GENDER_OPTIONS = ["Male", "Female", "Rather not say"] as const;

const socialUserSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  dateOfBirth: z.string().min(1, "Date of birth is required"),
  gender: z.enum(GENDER_OPTIONS, { required_error: "Please select your gender" }),
  bio: z.string().max(500, "Bio must be less than 500 characters").optional(),
  interests: z.array(z.string()).min(1, "Please select at least one interest"),
});

const organizerSchema = z.object({
  organizationName: z.string().min(1, "Organization name is required"),
  bio: z.string().max(500, "Bio must be less than 500 characters").optional(),
  contactEmail: z.string().email("Please enter a valid email address"),
  socialMediaLinks: z.array(z.string()).optional(),
  canManageVenues: z.boolean().default(false),
});

type Step1Data = z.infer<typeof step1Schema>;
type Step2Data = z.infer<typeof step2Schema>;
type SocialUserData = z.infer<typeof socialUserSchema>;
type OrganizerData = z.infer<typeof organizerSchema>;

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
    defaultValues: step1Data || {
      email: "",
      username: "",
      password: "",
      confirmPassword: "",
    },
  });

  const step2Form = useForm<Step2Data>({
    resolver: zodResolver(step2Schema),
    defaultValues: step2Data || {
      userType: undefined,
    },
  });

  const socialUserForm = useForm<SocialUserData>({
    resolver: zodResolver(socialUserSchema),
    defaultValues: step3DataSocial || {
      displayName: "",
      dateOfBirth: "",
      gender: undefined,
      bio: "",
      interests: [],
    },
  });

  const organizerForm = useForm<OrganizerData>({
    resolver: zodResolver(organizerSchema),
    defaultValues: step3DataOrganizer || {
      organizationName: "",
      bio: "",
      contactEmail: "",
      socialMediaLinks: [],
      canManageVenues: false,
    },
  });

  const onStep1Submit = (data: Step1Data) => {
    setStep1Data(data);
    setCurrentStep(2);
  };

  const onStep2Submit = (data: Step2Data) => {
    setStep2Data(data);
    setCurrentStep(3);
  };

  const onFinalSubmit = async (data: SocialUserData | OrganizerData) => {
    setIsLoading(true);
    
    if (step2Data?.userType === "social") {
      setStep3DataSocial(data as SocialUserData);
    } else {
      setStep3DataOrganizer(data as OrganizerData);
    }
    
    const completeData = {
      ...step1Data,
      ...step2Data,
      ...data,
    };
    
    delete (completeData as any).confirmPassword;
    
    try {
      await apiRequest("POST", "/api/auth/signup", completeData);

      // Invalidate session cache so useAuth updates with new user data
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });

      toast({
        title: "Account created!",
        description: "Welcome to VibePulse. Let's explore!",
      });

      // Honor redirect param if present (for share-to-message flow)
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      setLocation(redirect || "/discover");
    } catch (error: any) {
      toast({
        title: "Signup failed",
        description: error.message || "Could not create account. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const goBack = () => {
    if (currentStep === 3) {
      const currentFormData = step2Data?.userType === "social" 
        ? socialUserForm.getValues() 
        : organizerForm.getValues();
      
      if (step2Data?.userType === "social") {
        setStep3DataSocial(currentFormData as SocialUserData);
      } else {
        setStep3DataOrganizer(currentFormData as OrganizerData);
      }
    } else if (currentStep === 2) {
      setStep2Data(step2Form.getValues());
    }
    
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  useEffect(() => {
    if (currentStep === 1 && step1Data) {
      step1Form.reset(step1Data);
    }
  }, [currentStep]);

  useEffect(() => {
    if (currentStep === 2 && step2Data) {
      step2Form.reset(step2Data);
    }
  }, [currentStep]);

  useEffect(() => {
    if (currentStep === 3 && step2Data?.userType === "social" && step3DataSocial) {
      socialUserForm.reset(step3DataSocial);
    } else if (currentStep === 3 && step2Data?.userType === "organizer" && step3DataOrganizer) {
      organizerForm.reset(step3DataOrganizer);
    }
  }, [currentStep, step2Data]);

  return (
    <div className="dark min-h-screen flex items-center justify-center p-4 bg-[#0a0a0a] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-[#0a0a0a] to-pink-900/10" />
      <div className="absolute top-20 left-10 w-72 h-72 bg-purple-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-20 right-10 w-96 h-96 bg-pink-500/10 rounded-full blur-3xl" />
      
      <div className="w-full max-w-2xl relative z-10">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Sparkles className="w-8 h-8 text-purple-400" />
            <h1 className="font-playfair text-4xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
              VibePulse
            </h1>
          </div>
          <p className="text-white/60">
            Join the community and discover amazing events
          </p>
        </div>

        <div className="flex justify-center mb-6">
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((step) => (
              <div key={step} className="flex items-center">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors ${
                    currentStep >= step
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 border-purple-500 text-white"
                      : "border-white/30 text-white/40"
                  }`}
                  data-testid={`step-indicator-${step}`}
                >
                  {currentStep > step ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <span className="text-sm font-medium">{step}</span>
                  )}
                </div>
                {step < 3 && (
                  <div
                    className={`w-16 h-0.5 mx-2 ${
                      currentStep > step ? "bg-purple-500" : "bg-white/20"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-white">
              {currentStep === 1 && "Create Account"}
              {currentStep === 2 && "Select User Type"}
              {currentStep === 3 && "Complete Your Profile"}
            </CardTitle>
            <CardDescription className="text-white/60">
              {currentStep === 1 && "Enter your basic information to get started"}
              {currentStep === 2 && "Choose how you'll use VibePulse"}
              {currentStep === 3 && "Tell us a bit more about yourself"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {currentStep === 1 && (
              <Form {...step1Form}>
                <form onSubmit={step1Form.handleSubmit(onStep1Submit)} className="space-y-4">
                  <FormField
                    control={step1Form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="you@example.com"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            {...field}
                            data-testid="input-email"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={step1Form.control}
                    name="username"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Username</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="johndoe"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            {...field}
                            data-testid="input-username"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={step1Form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Password</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2 border border-white/20 rounded-md focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-purple-500 bg-white/5">
                            <Input
                              type={showPassword ? "text" : "password"}
                              placeholder="Min. 8 characters"
                              className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 bg-transparent text-white placeholder:text-white/40"
                              {...field}
                              data-testid="input-password"
                            />
                            <button
                              type="button"
                              className="text-white/40 hover:text-white/80 transition-colors p-2 mr-1"
                              onClick={() => setShowPassword(!showPassword)}
                              data-testid="button-toggle-password"
                            >
                              {showPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={step1Form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Confirm Password</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2 border border-white/20 rounded-md focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-purple-500 bg-white/5">
                            <Input
                              type={showConfirmPassword ? "text" : "password"}
                              placeholder="Re-enter your password"
                              className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 bg-transparent text-white placeholder:text-white/40"
                              {...field}
                              data-testid="input-confirm-password"
                            />
                            <button
                              type="button"
                              className="text-white/40 hover:text-white/80 transition-colors p-2 mr-1"
                              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                              data-testid="button-toggle-confirm-password"
                            >
                              {showConfirmPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-2 pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30"
                      onClick={() => window.location.href = '/login'}
                      data-testid="button-back-to-login"
                    >
                      Back to Login
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0"
                      data-testid="button-next-step-1"
                    >
                      Next
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </form>
              </Form>
            )}

            {currentStep === 2 && (
              <Form {...step2Form}>
                <form onSubmit={step2Form.handleSubmit(onStep2Submit)} className="space-y-6">
                  <FormField
                    control={step2Form.control}
                    name="userType"
                    render={({ field }) => (
                      <FormItem className="space-y-4">
                        <FormControl>
                          <RadioGroup
                            onValueChange={field.onChange}
                            value={field.value}
                            className="grid gap-4"
                          >
                            <Card
                              className={`cursor-pointer transition-colors bg-white/5 border-white/10 hover:border-white/20 ${
                                field.value === "social" ? "border-purple-500 bg-purple-500/10" : ""
                              }`}
                              onClick={() => field.onChange("social")}
                              data-testid="card-user-type-social"
                            >
                              <CardContent className="flex items-start gap-4 p-6">
                                <RadioGroupItem value="social" id="social" className="border-white/40 text-purple-400" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <Users className="w-5 h-5 text-purple-400" />
                                    <Label
                                      htmlFor="social"
                                      className="text-lg font-semibold cursor-pointer text-white"
                                    >
                                      Social User
                                    </Label>
                                  </div>
                                  <p className="text-sm text-white/50">
                                    Discover events, follow friends, buy tickets, and RSVP to events.
                                    Perfect for attendees looking to explore and connect.
                                  </p>
                                </div>
                              </CardContent>
                            </Card>

                            <Card
                              className={`cursor-pointer transition-colors bg-white/5 border-white/10 hover:border-white/20 ${
                                field.value === "organizer" ? "border-purple-500 bg-purple-500/10" : ""
                              }`}
                              onClick={() => field.onChange("organizer")}
                              data-testid="card-user-type-organizer"
                            >
                              <CardContent className="flex items-start gap-4 p-6">
                                <RadioGroupItem value="organizer" id="organizer" className="border-white/40 text-purple-400" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <Building2 className="w-5 h-5 text-purple-400" />
                                    <Label
                                      htmlFor="organizer"
                                      className="text-lg font-semibold cursor-pointer text-white"
                                    >
                                      Event Organizer
                                    </Label>
                                  </div>
                                  <p className="text-sm text-white/50">
                                    Create and manage events, sell tickets, and track attendance.
                                    Perfect for businesses and creators hosting events.
                                  </p>
                                </div>
                              </CardContent>
                            </Card>
                          </RadioGroup>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-2 pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={goBack}
                      className="flex-1 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30"
                      data-testid="button-back-step-2"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0"
                      data-testid="button-next-step-2"
                    >
                      Next
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </form>
              </Form>
            )}

            {currentStep === 3 && step2Data?.userType === "social" && (
              <Form {...socialUserForm}>
                <form onSubmit={socialUserForm.handleSubmit(onFinalSubmit)} className="space-y-4">
                  <FormField
                    control={socialUserForm.control}
                    name="displayName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Display Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="How should others see you?"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            {...field}
                            data-testid="input-display-name"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={socialUserForm.control}
                    name="dateOfBirth"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Date of Birth</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500 [color-scheme:dark]"
                            {...field}
                            data-testid="input-date-of-birth"
                          />
                        </FormControl>
                        <FormDescription className="text-white/40">
                          This will not be shown publicly. Used for age verification for events.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={socialUserForm.control}
                    name="gender"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Gender</FormLabel>
                        <FormControl>
                          <RadioGroup
                            onValueChange={field.onChange}
                            value={field.value}
                            className="flex flex-wrap gap-4"
                          >
                            {GENDER_OPTIONS.map((option) => (
                              <div key={option} className="flex items-center space-x-2">
                                <RadioGroupItem 
                                  value={option} 
                                  id={`gender-${option.toLowerCase().replace(/\s+/g, '-')}`}
                                  className="border-white/40 text-purple-400"
                                  data-testid={`radio-gender-${option.toLowerCase().replace(/\s+/g, '-')}`}
                                />
                                <Label 
                                  htmlFor={`gender-${option.toLowerCase().replace(/\s+/g, '-')}`}
                                  className="cursor-pointer text-white/70"
                                >
                                  {option}
                                </Label>
                              </div>
                            ))}
                          </RadioGroup>
                        </FormControl>
                        <FormDescription className="text-white/40">
                          This can only be changed once after signup.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={socialUserForm.control}
                    name="bio"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Bio (Optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Tell us about yourself..."
                            className="resize-none bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            rows={3}
                            {...field}
                            data-testid="input-bio"
                          />
                        </FormControl>
                        <FormDescription className="text-white/40">
                          {field.value?.length || 0}/500 characters
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={socialUserForm.control}
                    name="interests"
                    render={() => (
                      <FormItem>
                        <FormLabel className="text-white/80">Interests</FormLabel>
                        <FormDescription className="text-white/40">
                          Select categories you're interested in. We'll use this to personalize your feed.
                        </FormDescription>
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          {EVENT_CATEGORIES.map((category) => (
                            <FormField
                              key={category}
                              control={socialUserForm.control}
                              name="interests"
                              render={({ field }) => {
                                return (
                                  <FormItem
                                    key={category}
                                    className="flex items-center space-x-2 space-y-0"
                                  >
                                    <FormControl>
                                      <Checkbox
                                        checked={field.value?.includes(category)}
                                        className="border-white/40 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                                        onCheckedChange={(checked) => {
                                          return checked
                                            ? field.onChange([...field.value, category])
                                            : field.onChange(
                                                field.value?.filter(
                                                  (value) => value !== category
                                                )
                                              );
                                        }}
                                        data-testid={`checkbox-interest-${category.toLowerCase().replace(/\s+/g, '-')}`}
                                      />
                                    </FormControl>
                                    <FormLabel className="text-sm font-normal cursor-pointer text-white/70">
                                      {category}
                                    </FormLabel>
                                  </FormItem>
                                );
                              }}
                            />
                          ))}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-2 pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={goBack}
                      className="flex-1 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30"
                      data-testid="button-back-step-3"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0"
                      disabled={isLoading}
                      data-testid="button-complete-signup"
                    >
                      {isLoading ? (
                        "Creating Account..."
                      ) : (
                        <>
                          <UserPlus className="w-4 h-4 mr-2" />
                          Complete Signup
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </Form>
            )}

            {currentStep === 3 && step2Data?.userType === "organizer" && (
              <Form {...organizerForm}>
                <form onSubmit={organizerForm.handleSubmit(onFinalSubmit)} className="space-y-4">
                  <FormField
                    control={organizerForm.control}
                    name="organizationName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Organization Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Your company or organization name"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            {...field}
                            data-testid="input-organization-name"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={organizerForm.control}
                    name="contactEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Contact Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="contact@organization.com"
                            className="bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            {...field}
                            data-testid="input-contact-email"
                          />
                        </FormControl>
                        <FormDescription className="text-white/40">
                          This will be shown publicly for event inquiries
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={organizerForm.control}
                    name="bio"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Bio (Optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Tell us about your organization..."
                            className="resize-none bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            rows={3}
                            {...field}
                            data-testid="input-org-bio"
                          />
                        </FormControl>
                        <FormDescription className="text-white/40">
                          {field.value?.length || 0}/500 characters
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={organizerForm.control}
                    name="socialMediaLinks"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-white/80">Social Media Links (Optional)</FormLabel>
                        <FormDescription className="text-white/40">
                          Add links to your social media profiles (one per line)
                        </FormDescription>
                        <FormControl>
                          <Textarea
                            placeholder="https://twitter.com/yourorg&#10;https://instagram.com/yourorg&#10;https://facebook.com/yourorg"
                            className="resize-none bg-white/5 border-white/20 text-white placeholder:text-white/40 focus:border-purple-500"
                            rows={4}
                            value={field.value?.join('\n') || ''}
                            onChange={(e) => {
                              const links = e.target.value
                                .split('\n')
                                .filter(link => link.trim() !== '');
                              field.onChange(links);
                            }}
                            data-testid="input-social-links"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={organizerForm.control}
                    name="canManageVenues"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border border-white/10 p-4 bg-white/5">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            className="border-white/40 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                            data-testid="checkbox-manage-venues"
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel className="cursor-pointer text-white/80">
                            I manage a venue (club, bar, lounge)
                          </FormLabel>
                          <FormDescription className="text-white/40">
                            Enable this if you own or manage a venue and want to list it on VibePulse for event hosting and entry ticket sales.
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-2 pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={goBack}
                      className="flex-1 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30"
                      data-testid="button-back-step-3"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0"
                      disabled={isLoading}
                      data-testid="button-complete-signup"
                    >
                      {isLoading ? (
                        "Creating Account..."
                      ) : (
                        <>
                          <UserPlus className="w-4 h-4 mr-2" />
                          Complete Signup
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>

        <div className="text-sm text-center text-white/50 mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-purple-400 hover:text-purple-300 hover:underline font-medium" data-testid="link-login">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
