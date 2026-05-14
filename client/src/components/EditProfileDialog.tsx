import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { updateUserSchema, type UpdateUser, type User, genderOptions } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Pencil, X, Lock, Sparkles, Zap, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getBannerStyle,
  generateFingerprintGradient,
  VIBES,
  VIBE_KEYS,
  type BannerMode,
  type VibeKey,
} from "@/lib/bannerUtils";

interface EditProfileDialogProps {
  user: User;
}

// ─── Banner mode card ────────────────────────────────────────────────────────

interface ModeCardProps {
  id: BannerMode;
  icon: React.ReactNode;
  title: string;
  description: string;
  active: boolean;
  onClick: () => void;
}

function ModeCard({ id, icon, title, description, active, onClick }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-xl border-2 p-3 text-left transition-all duration-150 cursor-pointer",
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/40"
      )}
      data-testid={`banner-mode-${id}`}
    >
      <div className={cn("mb-1.5", active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </div>
      <p className={cn("text-sm font-semibold", active ? "text-foreground" : "text-muted-foreground")}>
        {title}
      </p>
      <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
    </button>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function EditProfileDialog({ user }: EditProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [interestInput, setInterestInput] = useState("");
  const [socialLinkInput, setSocialLinkInput] = useState("");
  const { toast } = useToast();

  const isSocialUser = user.userType === "social";
  const hasEditedGender = !!user.genderEditedAt;

  const form = useForm<UpdateUser>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      displayName: user.displayName || "",
      dateOfBirth: user.dateOfBirth || "",
      gender: user.gender || undefined,
      bio: user.bio || "",
      interests: user.interests || [],
      organizationName: user.organizationName || "",
      contactEmail: user.contactEmail || "",
      socialMediaLinks: user.socialMediaLinks || [],
      bannerMode: (user.bannerMode as BannerMode) || "fingerprint",
      bannerVibe: user.bannerVibe || "hype",
      bannerColor: user.bannerColor || "#6d28d9",
    },
  });

  // Live-watch banner fields for the preview strip
  const watchedMode = form.watch("bannerMode") as BannerMode;
  const watchedVibe = form.watch("bannerVibe");
  const watchedColor = form.watch("bannerColor");
  const watchedInterests = form.watch("interests");

  const previewStyle = getBannerStyle({
    bannerMode: watchedMode,
    bannerVibe: watchedVibe,
    bannerColor: watchedColor,
    interests: watchedInterests,
  });

  // ─── Mutation ────────────────────────────────────────────────────────────

  const updateProfileMutation = useMutation({
    mutationFn: async (data: UpdateUser) => {
      const res = await apiRequest("PATCH", `/api/users/${user.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user.username}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user.id}/profile`] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      toast({ title: "Saved", description: "Profile updated successfully" });
      setOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error?.message || "Failed to update profile",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: UpdateUser) => {
    // Never send gender when it's already locked
    if (hasEditedGender) delete data.gender;
    // Only send banner sub-fields relevant to the chosen mode
    if (data.bannerMode !== "vibe") delete data.bannerVibe;
    if (data.bannerMode !== "custom") delete data.bannerColor;
    updateProfileMutation.mutate(data);
  };

  // ─── Interest helpers ─────────────────────────────────────────────────────

  const addInterest = () => {
    const val = interestInput.trim();
    if (!val) return;
    const current = form.getValues("interests") || [];
    if (!current.includes(val)) form.setValue("interests", [...current, val]);
    setInterestInput("");
  };

  const removeInterest = (interest: string) => {
    form.setValue(
      "interests",
      (form.getValues("interests") || []).filter((i) => i !== interest)
    );
  };

  // ─── Social link helpers ──────────────────────────────────────────────────

  const addSocialLink = () => {
    const val = socialLinkInput.trim();
    if (!val) return;
    const current = form.getValues("socialMediaLinks") || [];
    if (!current.includes(val)) form.setValue("socialMediaLinks", [...current, val]);
    setSocialLinkInput("");
  };

  const removeSocialLink = (link: string) => {
    form.setValue(
      "socialMediaLinks",
      (form.getValues("socialMediaLinks") || []).filter((l) => l !== link)
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-profile">
          <Pencil className="h-4 w-4 mr-2" />
          Edit Profile
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>Update your profile information</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

            {/* ── BANNER SECTION ─────────────────────────────────────────── */}
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-semibold">Profile Banner</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your banner is the first thing people see on your profile.
                </p>
              </div>

              {/* Live preview strip */}
              <div
                className="h-16 w-full rounded-xl overflow-hidden transition-all duration-300 relative"
                style={{ background: previewStyle }}
                data-testid="banner-preview"
              >
                <div
                  className="absolute inset-0 opacity-10"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)",
                    backgroundSize: "24px 24px",
                  }}
                />
              </div>

              {/* Mode selector */}
              <div className="flex gap-2">
                <ModeCard
                  id="fingerprint"
                  icon={<Sparkles className="h-4 w-4" />}
                  title="Fingerprint"
                  description="Auto-generated from your interests. Unique to you."
                  active={watchedMode === "fingerprint"}
                  onClick={() => form.setValue("bannerMode", "fingerprint")}
                />
                <ModeCard
                  id="vibe"
                  icon={<Zap className="h-4 w-4" />}
                  title="Vibe"
                  description="Pick a mood. Change it whenever your energy shifts."
                  active={watchedMode === "vibe"}
                  onClick={() => form.setValue("bannerMode", "vibe")}
                />
                <ModeCard
                  id="custom"
                  icon={<Palette className="h-4 w-4" />}
                  title="Custom"
                  description="Choose your own colour. Full control."
                  active={watchedMode === "custom"}
                  onClick={() => form.setValue("bannerMode", "custom")}
                />
              </div>

              {/* Fingerprint explanation */}
              {watchedMode === "fingerprint" && (
                <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                  Your banner is built from your interests below — update your interests to see it
                  change. No two profiles look exactly alike.
                </p>
              )}

              {/* Vibe picker */}
              {watchedMode === "vibe" && (
                <div className="grid grid-cols-3 gap-2" data-testid="vibe-picker">
                  {VIBE_KEYS.map((key) => {
                    const vibe = VIBES[key];
                    const isActive = watchedVibe === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => form.setValue("bannerVibe", key)}
                        className={cn(
                          "rounded-lg p-2.5 text-left transition-all duration-150 cursor-pointer border-2",
                          isActive ? "border-white/60 scale-[1.02]" : "border-transparent opacity-80 hover:opacity-100"
                        )}
                        style={{ background: vibe.gradient }}
                        data-testid={`vibe-option-${key}`}
                      >
                        <p className="text-white font-semibold text-xs drop-shadow">{vibe.label}</p>
                        <p className="text-white/80 text-[10px] leading-tight mt-0.5 drop-shadow">{vibe.tagline}</p>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Custom colour picker */}
              {watchedMode === "custom" && (
                <div className="flex items-center gap-3" data-testid="custom-color-picker">
                  <div className="relative">
                    <input
                      type="color"
                      value={watchedColor || "#6d28d9"}
                      onChange={(e) => form.setValue("bannerColor", e.target.value)}
                      className="h-10 w-10 rounded-lg border border-border cursor-pointer p-0.5 bg-transparent"
                      data-testid="input-banner-color"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{watchedColor || "#6d28d9"}</p>
                    <p className="text-xs text-muted-foreground">
                      We turn your colour into a gradient automatically.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border" />

            {/* ── PROFILE FIELDS ─────────────────────────────────────────── */}
            {isSocialUser ? (
              <>
                <FormField
                  control={form.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          placeholder="Enter your display name"
                          data-testid="input-displayName"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="dateOfBirth"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date of Birth</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          type="date"
                          data-testid="input-dateOfBirth"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="gender"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2">
                        Gender
                        {hasEditedGender && <Lock className="h-3 w-3 text-muted-foreground" />}
                      </FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          value={field.value || undefined}
                          className="flex flex-wrap gap-4"
                          disabled={hasEditedGender}
                        >
                          {genderOptions.map((option) => (
                            <div key={option} className="flex items-center space-x-2">
                              <RadioGroupItem
                                value={option}
                                id={`edit-gender-${option.toLowerCase().replace(/\s+/g, "-")}`}
                                disabled={hasEditedGender}
                                data-testid={`radio-edit-gender-${option.toLowerCase().replace(/\s+/g, "-")}`}
                              />
                              <Label
                                htmlFor={`edit-gender-${option.toLowerCase().replace(/\s+/g, "-")}`}
                                className={hasEditedGender ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"}
                              >
                                {option}
                              </Label>
                            </div>
                          ))}
                        </RadioGroup>
                      </FormControl>
                      {hasEditedGender ? (
                        <FormDescription className="text-muted-foreground">
                          Gender has already been set and cannot be changed.
                        </FormDescription>
                      ) : (
                        <FormDescription>This can only be changed once.</FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="bio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bio</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value || ""}
                          placeholder="Tell us about yourself"
                          rows={4}
                          data-testid="textarea-bio"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div>
                  <FormLabel>Interests</FormLabel>
                  {watchedMode === "fingerprint" && (
                    <p className="text-xs text-primary mt-0.5 mb-2">
                      Your interests shape your Fingerprint banner above.
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <Input
                      value={interestInput}
                      onChange={(e) => setInterestInput(e.target.value)}
                      placeholder="Add an interest"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addInterest();
                        }
                      }}
                      data-testid="input-interest"
                    />
                    <Button type="button" variant="outline" onClick={addInterest} data-testid="button-add-interest">
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {(form.watch("interests") || []).map((interest) => (
                      <Badge key={interest} variant="secondary" className="gap-1" data-testid={`badge-interest-${interest}`}>
                        {interest}
                        <X className="h-3 w-3 cursor-pointer" onClick={() => removeInterest(interest)} />
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <FormField
                  control={form.control}
                  name="organizationName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          placeholder="Enter organization name"
                          data-testid="input-organizationName"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="bio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value || ""}
                          placeholder="Describe your organization"
                          rows={4}
                          data-testid="textarea-bio"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="contactEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Email</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          type="email"
                          placeholder="contact@example.com"
                          data-testid="input-contactEmail"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* ── SOCIAL LINKS ───────────────────────────────────────────── */}
            <div>
              <FormLabel>Social Media Links</FormLabel>
              <div className="flex gap-2 mt-2">
                <Input
                  value={socialLinkInput}
                  onChange={(e) => setSocialLinkInput(e.target.value)}
                  placeholder="Add a social media link"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSocialLink();
                    }
                  }}
                  data-testid="input-social-link"
                />
                <Button type="button" variant="outline" onClick={addSocialLink} data-testid="button-add-social-link">
                  Add
                </Button>
              </div>
              <div className="flex flex-col gap-2 mt-3">
                {(form.watch("socialMediaLinks") || []).map((link, index) => (
                  <Badge
                    key={index}
                    variant="secondary"
                    className="gap-2 justify-between"
                    data-testid={`badge-social-link-${index}`}
                  >
                    <span className="truncate">{link}</span>
                    <X
                      className="h-3 w-3 cursor-pointer flex-shrink-0"
                      onClick={() => removeSocialLink(link)}
                    />
                  </Badge>
                ))}
              </div>
            </div>

            {/* ── ACTIONS ────────────────────────────────────────────────── */}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={updateProfileMutation.isPending}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={updateProfileMutation.isPending}
                data-testid="button-save"
              >
                {updateProfileMutation.isPending ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
