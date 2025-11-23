import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { updateUserSchema, type UpdateUser, type User } from "@shared/schema";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Pencil, X } from "lucide-react";

interface EditProfileDialogProps {
  user: User;
}

export default function EditProfileDialog({ user }: EditProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [interestInput, setInterestInput] = useState("");
  const [socialLinkInput, setSocialLinkInput] = useState("");
  const { toast } = useToast();

  const isSocialUser = user.userType === "social";

  const form = useForm<UpdateUser>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      displayName: user.displayName || "",
      dateOfBirth: user.dateOfBirth || "",
      bio: user.bio || "",
      interests: user.interests || [],
      organizationName: user.organizationName || "",
      contactEmail: user.contactEmail || "",
      socialMediaLinks: user.socialMediaLinks || [],
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: async (data: UpdateUser) => {
      return await apiRequest("PATCH", `/api/users/${user.id}`, data);
    },
    onSuccess: () => {
      // Invalidate profile query by username (used by ProfilePage)
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user.username}`] });
      // Invalidate session in case display name changed
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      toast({
        title: "Success",
        description: "Profile updated successfully",
      });
      setOpen(false);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update profile",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: UpdateUser) => {
    updateProfileMutation.mutate(data);
  };

  const addInterest = () => {
    if (interestInput.trim()) {
      const currentInterests = form.getValues("interests") || [];
      if (!currentInterests.includes(interestInput.trim())) {
        form.setValue("interests", [...currentInterests, interestInput.trim()]);
      }
      setInterestInput("");
    }
  };

  const removeInterest = (interest: string) => {
    const currentInterests = form.getValues("interests") || [];
    form.setValue(
      "interests",
      currentInterests.filter((i) => i !== interest)
    );
  };

  const addSocialLink = () => {
    if (socialLinkInput.trim()) {
      const currentLinks = form.getValues("socialMediaLinks") || [];
      if (!currentLinks.includes(socialLinkInput.trim())) {
        form.setValue("socialMediaLinks", [...currentLinks, socialLinkInput.trim()]);
      }
      setSocialLinkInput("");
    }
  };

  const removeSocialLink = (link: string) => {
    const currentLinks = form.getValues("socialMediaLinks") || [];
    form.setValue(
      "socialMediaLinks",
      currentLinks.filter((l) => l !== link)
    );
  };

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
          <DialogDescription>
            Update your profile information
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                  <div className="flex gap-2 mt-2">
                    <Input
                      value={interestInput}
                      onChange={(e) => setInterestInput(e.target.value)}
                      placeholder="Add an interest"
                      onKeyPress={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addInterest();
                        }
                      }}
                      data-testid="input-interest"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={addInterest}
                      data-testid="button-add-interest"
                    >
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {(form.watch("interests") || []).map((interest) => (
                      <Badge
                        key={interest}
                        variant="secondary"
                        className="gap-1"
                        data-testid={`badge-interest-${interest}`}
                      >
                        {interest}
                        <X
                          className="h-3 w-3 cursor-pointer"
                          onClick={() => removeInterest(interest)}
                        />
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

            <div>
              <FormLabel>Social Media Links</FormLabel>
              <div className="flex gap-2 mt-2">
                <Input
                  value={socialLinkInput}
                  onChange={(e) => setSocialLinkInput(e.target.value)}
                  placeholder="Add a social media link"
                  onKeyPress={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSocialLink();
                    }
                  }}
                  data-testid="input-social-link"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={addSocialLink}
                  data-testid="button-add-social-link"
                >
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

            <div className="flex justify-end gap-2">
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
                {updateProfileMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
