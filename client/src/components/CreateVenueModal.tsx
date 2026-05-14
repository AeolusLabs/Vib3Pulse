import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  X, Upload, ImageIcon, MoreVertical, Trash2, RefreshCw,
  Building2, MapPin, Music, Accessibility, Eye,
} from "lucide-react";
import { ObjectUploader } from "@/components/ObjectUploader";
import ImageLightbox from "@/components/ImageLightbox";
import type { Venue, InsertVenue } from "@shared/schema";

interface CreateVenueModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingVenue?: Venue;
}

const venueCategories = [
  { value: "Club", label: "Club" },
  { value: "Pub", label: "Pub" },
  { value: "Lounge", label: "Lounge" },
  { value: "Bar", label: "Bar" },
  { value: "Nightclub", label: "Nightclub" },
  { value: "Rooftop", label: "Rooftop" },
];

const musicTypeOptions = [
  "Hip Hop", "EDM", "House", "Techno", "R&B", "Pop", "Latin",
  "Reggaeton", "Rock", "Jazz", "Live DJ", "Karaoke", "Top 40",
];

const amenityOptions = [
  "VIP Section", "Bottle Service", "Dance Floor", "Outdoor Patio",
  "Pool Table", "Darts", "Live Stage", "Photo Booth", "Coat Check",
  "Free Parking", "Valet Parking", "Food Menu", "Happy Hour",
];

const accessibilityOptions = [
  "Wheelchair Access", "Step-Free Entrance", "Accessible Toilets",
  "Accessible Parking", "Lift / Elevator", "Hearing Loop",
  "BSL Interpretation", "Large Print Menus", "Braille Menus",
  "Guide Dogs Welcome", "Reserved Seating", "Accessible Bar", "Carer Discount",
];

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  color = "purple",
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  color?: "purple" | "blue" | "pink" | "green";
}) {
  const colorMap = {
    purple: "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
    blue:   "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
    pink:   "bg-pink-100 dark:bg-pink-900/30 text-pink-600 dark:text-pink-400",
    green:  "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400",
  };
  return (
    <div className="flex items-center gap-3 mb-4 pb-3 border-b">
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${colorMap[color]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="font-semibold text-sm leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

const emptyForm = {
  name: "",
  category: "",
  description: "",
  imageUrl: "",
  coverImageUrl: "",
  imageUrls: [] as string[],
  address: "",
  city: "",
  phone: "",
  website: "",
  hours: "",
  dressCode: "",
  ageRestriction: "",
  musicTypes: [] as string[],
  amenities: [] as string[],
  accessibilityFeatures: [] as string[],
};

export default function CreateVenueModal({ open, onOpenChange, editingVenue }: CreateVenueModalProps) {
  const { toast } = useToast();
  const isEditing = !!editingVenue;

  const [formData, setFormData] = useState(emptyForm);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const maxGalleryImages = 6;
  const [replacingImageIndex, setReplacingImageIndex] = useState<number | null>(null);
  const replaceImageInputRef = useRef<HTMLInputElement>(null);

  const handleReplaceImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || replacingImageIndex === null) return;
    const file = e.target.files[0];
    const idx = replacingImageIndex;
    setReplacingImageIndex(null);
    if (replaceImageInputRef.current) replaceImageInputRef.current.value = "";

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = reader.result as string;
        const res = await fetch("/api/upload-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: [base64] }),
          credentials: "include",
        });
        if (!res.ok) throw new Error("Upload failed");
        const { urls } = await res.json();
        if (!urls?.[0]) throw new Error("No URL returned");
        setFormData(prev => {
          const newImageUrls = [...prev.imageUrls];
          newImageUrls[idx] = urls[0];
          return { ...prev, imageUrls: newImageUrls };
        });
        toast({ title: "Image replaced successfully" });
      } catch {
        toast({ title: "Failed to replace image", variant: "destructive" });
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (editingVenue) {
      setFormData({
        name: editingVenue.name || "",
        category: editingVenue.category || "",
        description: editingVenue.description || "",
        imageUrl: editingVenue.imageUrl || "",
        coverImageUrl: editingVenue.coverImageUrl || "",
        imageUrls: editingVenue.imageUrls || [],
        address: editingVenue.address || "",
        city: editingVenue.city || "",
        phone: editingVenue.phone || "",
        website: editingVenue.website || "",
        hours: editingVenue.hours || "",
        dressCode: editingVenue.dressCode || "",
        ageRestriction: editingVenue.ageRestriction?.toString() || "",
        musicTypes: editingVenue.musicTypes || [],
        amenities: editingVenue.amenities || [],
        accessibilityFeatures: (editingVenue as any).accessibilityFeatures || [],
      });
    } else {
      setFormData(emptyForm);
    }
  }, [editingVenue, open]);

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertVenue>) => {
      if (isEditing) return await apiRequest("PATCH", `/api/venues/${editingVenue.id}`, data);
      return await apiRequest("POST", "/api/venues", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venues"] });
      toast({ title: isEditing ? "Venue updated successfully" : "Venue created successfully" });
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({
        title: isEditing ? "Failed to update venue" : "Failed to create venue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Partial<InsertVenue> & { accessibilityFeatures?: string[] } = {
      name: formData.name,
      category: formData.category,
      description: formData.description || null,
      imageUrl: formData.imageUrl || null,
      coverImageUrl: formData.coverImageUrl || null,
      imageUrls: formData.imageUrls.length > 0 ? formData.imageUrls : [],
      address: formData.address || null,
      city: formData.city || null,
      phone: formData.phone || null,
      website: formData.website || null,
      hours: formData.hours || null,
      dressCode: formData.dressCode || null,
      ageRestriction: formData.ageRestriction ? (parseInt(formData.ageRestriction, 10) || null) : null,
      musicTypes: formData.musicTypes.length > 0 ? formData.musicTypes : null,
      amenities: formData.amenities.length > 0 ? formData.amenities : null,
      accessibilityFeatures: formData.accessibilityFeatures.length > 0 ? formData.accessibilityFeatures : [],
    };
    createMutation.mutate(payload as Partial<InsertVenue>);
  };

  const toggle = (key: "musicTypes" | "amenities" | "accessibilityFeatures", value: string) => {
    setFormData(prev => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((v: string) => v !== value)
        : [...prev[key], value],
    }));
  };

  const openLightbox = (idx: number) => {
    setLightboxIndex(idx);
    setLightboxOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] p-0 overflow-hidden">

          {/* Gradient header */}
          <div className="relative px-6 pt-6 pb-7 bg-gradient-to-br from-purple-600 via-purple-500 to-pink-500">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-white" />
              </div>
              <div>
                <DialogHeader>
                  <DialogTitle className="font-serif text-2xl text-white leading-tight">
                    {isEditing ? "Edit Venue" : "Add Your Venue"}
                  </DialogTitle>
                </DialogHeader>
                <p className="text-purple-100 text-sm mt-0.5">
                  {isEditing ? "Update your venue details below" : "List your venue on Vib3Pulse"}
                </p>
              </div>
            </div>
          </div>

          <ScrollArea className="max-h-[calc(90vh-110px)]">
            <form onSubmit={handleSubmit} className="p-6 space-y-5">

              {/* ── SECTION 1: Basic Info ── */}
              <Card>
                <CardContent className="pt-5 space-y-4">
                  <SectionHeader
                    icon={Building2}
                    title="Basic Info"
                    subtitle="Name, category, and description"
                    color="purple"
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Venue Name <span className="text-destructive">*</span></Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g. The Velvet Room"
                        required
                        data-testid="input-venue-name"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="category">Category <span className="text-destructive">*</span></Label>
                      <Select
                        value={formData.category}
                        onValueChange={(value) => setFormData(prev => ({ ...prev, category: value }))}
                        required
                      >
                        <SelectTrigger data-testid="select-venue-category">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent>
                          {venueCategories.map(cat => (
                            <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Describe the atmosphere, what makes your venue unique..."
                      rows={3}
                      data-testid="input-venue-description"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* ── SECTION 2: Location & Contact ── */}
              <Card>
                <CardContent className="pt-5 space-y-4">
                  <SectionHeader
                    icon={MapPin}
                    title="Location & Contact"
                    subtitle="Where to find you and how to reach you"
                    color="blue"
                  />

                  <div className="space-y-2">
                    <Label htmlFor="address">Street Address</Label>
                    <Input
                      id="address"
                      value={formData.address}
                      onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                      placeholder="123 Main Street"
                      data-testid="input-venue-address"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={formData.city}
                        onChange={(e) => setFormData(prev => ({ ...prev, city: e.target.value }))}
                        placeholder="London"
                        data-testid="input-venue-city"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        value={formData.phone}
                        onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                        placeholder="+44 20 1234 5678"
                        data-testid="input-venue-phone"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="website">Website</Label>
                      <Input
                        id="website"
                        value={formData.website}
                        onChange={(e) => setFormData(prev => ({ ...prev, website: e.target.value }))}
                        placeholder="https://..."
                        data-testid="input-venue-website"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="hours">Opening Hours</Label>
                    <Input
                      id="hours"
                      value={formData.hours}
                      onChange={(e) => setFormData(prev => ({ ...prev, hours: e.target.value }))}
                      placeholder="e.g. Mon–Thu 5pm–2am, Fri–Sat 5pm–4am, Sun Closed"
                      data-testid="input-venue-hours"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* ── SECTION 3: Gallery ── */}
              <Card>
                <CardContent className="pt-5 space-y-4">
                  <SectionHeader
                    icon={ImageIcon}
                    title="Gallery"
                    subtitle="Logo, cover photo, and venue gallery (up to 6)"
                    color="pink"
                  />

                  {/* Logo + Cover side by side */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Logo */}
                    <div className="space-y-2">
                      <Label>Venue Logo</Label>
                      <div className="flex items-center gap-3">
                        {formData.imageUrl ? (
                          <div className="relative flex-shrink-0">
                            <img
                              src={formData.imageUrl}
                              alt="Venue logo"
                              className="h-16 w-16 rounded-xl object-cover border shadow-sm"
                            />
                            <Button
                              type="button" size="icon" variant="ghost"
                              className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground shadow"
                              onClick={() => setFormData(prev => ({ ...prev, imageUrl: "" }))}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="h-16 w-16 rounded-xl border-2 border-dashed flex items-center justify-center bg-muted/50 flex-shrink-0">
                            <ImageIcon className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <ObjectUploader
                          maxNumberOfFiles={1}
                          maxFileSizeMB={5}
                          onComplete={(urls: string[]) => {
                            if (urls[0]) {
                              setFormData(prev => ({ ...prev, imageUrl: urls[0] }));
                              toast({ title: "Logo uploaded" });
                            }
                          }}
                          buttonVariant="outline"
                          buttonSize="sm"
                        >
                          <Upload className="h-4 w-4 mr-2" />
                          Upload Logo
                        </ObjectUploader>
                      </div>
                    </div>

                    {/* Cover */}
                    <div className="space-y-2">
                      <Label>Cover Image</Label>
                      <div className="flex items-center gap-3">
                        {formData.coverImageUrl ? (
                          <div className="relative flex-shrink-0">
                            <img
                              src={formData.coverImageUrl}
                              alt="Cover"
                              className="h-16 w-28 rounded-xl object-cover border shadow-sm"
                            />
                            <Button
                              type="button" size="icon" variant="ghost"
                              className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground shadow"
                              onClick={() => setFormData(prev => ({ ...prev, coverImageUrl: "" }))}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="h-16 w-28 rounded-xl border-2 border-dashed flex items-center justify-center bg-muted/50 flex-shrink-0">
                            <ImageIcon className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <ObjectUploader
                          maxNumberOfFiles={1}
                          maxFileSizeMB={10}
                          onComplete={(urls: string[]) => {
                            if (urls[0]) {
                              setFormData(prev => ({ ...prev, coverImageUrl: urls[0] }));
                              toast({ title: "Cover image uploaded" });
                            }
                          }}
                          buttonVariant="outline"
                          buttonSize="sm"
                        >
                          <Upload className="h-4 w-4 mr-2" />
                          Upload Cover
                        </ObjectUploader>
                      </div>
                    </div>
                  </div>

                  {/* Gallery grid */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Gallery Photos</Label>
                      <span className="text-xs text-muted-foreground">
                        {formData.imageUrls.length} / {maxGalleryImages}
                      </span>
                    </div>

                    <input
                      ref={replaceImageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleReplaceImage}
                      data-testid="input-replace-gallery-image"
                    />

                    {formData.imageUrls.length > 0 && (
                      <div className="grid grid-cols-3 gap-2">
                        {formData.imageUrls.map((url, idx) => (
                          <div key={idx} className="relative aspect-video rounded-xl overflow-hidden border group shadow-sm">
                            <img
                              src={url}
                              alt={`Gallery ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors z-10" />

                            {/* View button */}
                            <Button
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="absolute bottom-1 left-1 h-7 w-7 rounded-full shadow-lg z-20 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => openLightbox(idx)}
                              data-testid={`button-gallery-preview-${idx}`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>

                            {/* Actions menu */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="absolute top-1 right-1 h-7 w-7 rounded-full shadow-lg z-20"
                                  data-testid={`button-gallery-menu-${idx}`}
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() => openLightbox(idx)}
                                >
                                  <Eye className="h-4 w-4 mr-2" />
                                  View
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    setReplacingImageIndex(idx);
                                    setTimeout(() => replaceImageInputRef.current?.click(), 0);
                                  }}
                                  data-testid={`menu-replace-gallery-${idx}`}
                                >
                                  <RefreshCw className="h-4 w-4 mr-2" />
                                  Replace
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onSelect={() => setFormData(prev => ({
                                    ...prev,
                                    imageUrls: prev.imageUrls.filter((_, i) => i !== idx),
                                  }))}
                                  data-testid={`menu-delete-gallery-${idx}`}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        ))}
                      </div>
                    )}

                    {formData.imageUrls.length < maxGalleryImages && (
                      <ObjectUploader
                        maxNumberOfFiles={maxGalleryImages - formData.imageUrls.length}
                        maxFileSizeMB={10}
                        onComplete={(urls: string[]) => {
                          if (urls.length > 0) {
                            setFormData(prev => ({
                              ...prev,
                              imageUrls: [...prev.imageUrls, ...urls].slice(0, maxGalleryImages),
                            }));
                            toast({ title: `${urls.length} photo${urls.length > 1 ? "s" : ""} added to gallery` });
                          }
                        }}
                        buttonVariant="outline"
                        buttonSize="sm"
                        buttonClassName="w-full"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Add Photos ({maxGalleryImages - formData.imageUrls.length} remaining)
                      </ObjectUploader>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Interior, exterior, atmosphere — click any thumbnail to preview full size.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* ── SECTION 4: Vibe ── */}
              <Card>
                <CardContent className="pt-5 space-y-4">
                  <SectionHeader
                    icon={Music}
                    title="Vibe"
                    subtitle="Music, amenities, dress code, and age policy"
                    color="purple"
                  />

                  <div className="space-y-2">
                    <Label>Music Types</Label>
                    <div className="flex flex-wrap gap-2">
                      {musicTypeOptions.map(type => (
                        <Badge
                          key={type}
                          variant={formData.musicTypes.includes(type) ? "default" : "outline"}
                          className="cursor-pointer select-none transition-all hover:shadow-sm"
                          onClick={() => toggle("musicTypes", type)}
                          data-testid={`badge-music-${type.toLowerCase().replace(/\s+/g, "-")}`}
                        >
                          {formData.musicTypes.includes(type) && <X className="h-3 w-3 mr-1" />}
                          {type}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Amenities</Label>
                    <div className="flex flex-wrap gap-2">
                      {amenityOptions.map(amenity => (
                        <Badge
                          key={amenity}
                          variant={formData.amenities.includes(amenity) ? "default" : "outline"}
                          className="cursor-pointer select-none transition-all hover:shadow-sm"
                          onClick={() => toggle("amenities", amenity)}
                          data-testid={`badge-amenity-${amenity.toLowerCase().replace(/\s+/g, "-")}`}
                        >
                          {formData.amenities.includes(amenity) && <X className="h-3 w-3 mr-1" />}
                          {amenity}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="dressCode">Dress Code</Label>
                      <Input
                        id="dressCode"
                        value={formData.dressCode}
                        onChange={(e) => setFormData(prev => ({ ...prev, dressCode: e.target.value }))}
                        placeholder="e.g. Smart Casual, No Trainers"
                        data-testid="input-venue-dresscode"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ageRestriction">Minimum Age</Label>
                      <Select
                        value={formData.ageRestriction}
                        onValueChange={(value) => setFormData(prev => ({ ...prev, ageRestriction: value }))}
                      >
                        <SelectTrigger data-testid="select-age-restriction">
                          <SelectValue placeholder="No restriction" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="18">18+</SelectItem>
                          <SelectItem value="21">21+</SelectItem>
                          <SelectItem value="25">25+</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* ── SECTION 5: Accessibility ── */}
              <Card>
                <CardContent className="pt-5 space-y-4">
                  <SectionHeader
                    icon={Accessibility}
                    title="Accessibility"
                    subtitle="Help guests with disabilities know what to expect"
                    color="green"
                  />

                  <div className="flex flex-wrap gap-2">
                    {accessibilityOptions.map(feature => (
                      <Badge
                        key={feature}
                        variant={formData.accessibilityFeatures.includes(feature) ? "default" : "outline"}
                        className={`cursor-pointer select-none transition-all hover:shadow-sm ${
                          formData.accessibilityFeatures.includes(feature)
                            ? "bg-green-600 hover:bg-green-700 border-green-600"
                            : "border-green-300 text-green-700 hover:border-green-400 dark:border-green-700 dark:text-green-400"
                        }`}
                        onClick={() => toggle("accessibilityFeatures", feature)}
                        data-testid={`badge-access-${feature.toLowerCase().replace(/[\s/]+/g, "-")}`}
                      >
                        {formData.accessibilityFeatures.includes(feature) && <X className="h-3 w-3 mr-1" />}
                        {feature}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Venues that share accessibility info receive significantly more trust from guests.
                  </p>
                </CardContent>
              </Card>

              {/* Footer actions */}
              <div className="flex justify-end gap-3 pt-2 pb-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-venue"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="bg-gradient-to-r from-purple-600 to-pink-500 hover:from-purple-700 hover:to-pink-600 text-white min-w-[130px]"
                  data-testid="button-save-venue"
                >
                  {createMutation.isPending
                    ? "Saving..."
                    : isEditing ? "Update Venue" : "Create Venue"}
                </Button>
              </div>
            </form>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Gallery lightbox — outside Dialog to avoid z-index conflicts */}
      {formData.imageUrls.length > 0 && (
        <ImageLightbox
          images={formData.imageUrls}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}
