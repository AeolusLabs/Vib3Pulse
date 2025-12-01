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
import { UserPlus, Users, Building2, ArrowRight, ArrowLeft, Check, Eye, EyeOff } from "lucide-react";
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

      if (step2Data?.userType === "social") {
        setLocation("/discover");
      } else {
        setLocation("/discover");
      }
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
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <h1 className="font-playfair text-4xl font-bold text-primary mb-2">
            VibePulse
          </h1>
          <p className="text-muted-foreground">
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
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground text-muted-foreground"
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
                      currentStep > step ? "bg-primary" : "bg-muted"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {currentStep === 1 && "Create Account"}
              {currentStep === 2 && "Select User Type"}
              {currentStep === 3 && "Complete Your Profile"}
            </CardTitle>
            <CardDescription>
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
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="you@example.com"
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
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="johndoe"
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
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2 border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                            <Input
                              type={showPassword ? "text" : "password"}
                              placeholder="Min. 8 characters"
                              className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                              {...field}
                              data-testid="input-password"
                            />
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground transition-colors p-2 mr-1"
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
                        <FormLabel>Confirm Password</FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2 border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                            <Input
                              type={showConfirmPassword ? "text" : "password"}
                              placeholder="Re-enter your password"
                              className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                              {...field}
                              data-testid="input-confirm-password"
                            />
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground transition-colors p-2 mr-1"
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
                      className="flex-1"
                      onClick={() => window.location.href = '/login'}
                      data-testid="button-back-to-login"
                    >
                      Back to Login
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
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
                              className={`cursor-pointer transition-colors hover-elevate ${
                                field.value === "social" ? "border-primary bg-primary/5" : ""
                              }`}
                              onClick={() => field.onChange("social")}
                              data-testid="card-user-type-social"
                            >
                              <CardContent className="flex items-start gap-4 p-6">
                                <RadioGroupItem value="social" id="social" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <Users className="w-5 h-5 text-primary" />
                                    <Label
                                      htmlFor="social"
                                      className="text-lg font-semibold cursor-pointer"
                                    >
                                      Social User
                                    </Label>
                                  </div>
                                  <p className="text-sm text-muted-foreground">
                                    Discover events, follow friends, buy tickets, and RSVP to events.
                                    Perfect for attendees looking to explore and connect.
                                  </p>
                                </div>
                              </CardContent>
                            </Card>

                            <Card
                              className={`cursor-pointer transition-colors hover-elevate ${
                                field.value === "organizer" ? "border-primary bg-primary/5" : ""
                              }`}
                              onClick={() => field.onChange("organizer")}
                              data-testid="card-user-type-organizer"
                            >
                              <CardContent className="flex items-start gap-4 p-6">
                                <RadioGroupItem value="organizer" id="organizer" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <Building2 className="w-5 h-5 text-primary" />
                                    <Label
                                      htmlFor="organizer"
                                      className="text-lg font-semibold cursor-pointer"
                                    >
                                      Event Organizer
                                    </Label>
                                  </div>
                                  <p className="text-sm text-muted-foreground">
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
                      className="flex-1"
                      data-testid="button-back-step-2"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
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
                        <FormLabel>Display Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="How should others see you?"
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
                        <FormLabel>Date of Birth</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            {...field}
                            data-testid="input-date-of-birth"
                          />
                        </FormControl>
                        <FormDescription>
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
                        <FormLabel>Gender</FormLabel>
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
                                  data-testid={`radio-gender-${option.toLowerCase().replace(/\s+/g, '-')}`}
                                />
                                <Label 
                                  htmlFor={`gender-${option.toLowerCase().replace(/\s+/g, '-')}`}
                                  className="cursor-pointer"
                                >
                                  {option}
                                </Label>
                              </div>
                            ))}
                          </RadioGroup>
                        </FormControl>
                        <FormDescription>
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
                        <FormLabel>Bio (Optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Tell us about yourself..."
                            className="resize-none"
                            rows={3}
                            {...field}
                            data-testid="input-bio"
                          />
                        </FormControl>
                        <FormDescription>
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
                        <FormLabel>Interests</FormLabel>
                        <FormDescription>
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
                                    <FormLabel className="text-sm font-normal cursor-pointer">
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
                      className="flex-1"
                      data-testid="button-back-step-3"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
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
                        <FormLabel>Organization Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Your company or organization name"
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
                        <FormLabel>Contact Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="contact@organization.com"
                            {...field}
                            data-testid="input-contact-email"
                          />
                        </FormControl>
                        <FormDescription>
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
                        <FormLabel>Bio (Optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Tell us about your organization..."
                            className="resize-none"
                            rows={3}
                            {...field}
                            data-testid="input-org-bio"
                          />
                        </FormControl>
                        <FormDescription>
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
                        <FormLabel>Social Media Links (Optional)</FormLabel>
                        <FormDescription>
                          Add links to your social media profiles (one per line)
                        </FormDescription>
                        <FormControl>
                          <Textarea
                            placeholder="https://twitter.com/yourorg&#10;https://instagram.com/yourorg&#10;https://facebook.com/yourorg"
                            className="resize-none"
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
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 bg-muted/30">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="checkbox-manage-venues"
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel className="cursor-pointer">
                            I manage a venue (club, bar, lounge)
                          </FormLabel>
                          <FormDescription>
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
                      className="flex-1"
                      data-testid="button-back-step-3"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
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

        <div className="text-sm text-center text-muted-foreground mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline font-medium" data-testid="link-login">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
