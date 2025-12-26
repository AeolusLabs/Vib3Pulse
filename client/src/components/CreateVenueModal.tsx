import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { X, Upload, ImageIcon, MoreVertical, Trash2, RefreshCw } from "lucide-react";
import { ObjectUploader } from "@/components/ObjectUploader";
import type { Venue, InsertVenue } from "@shared/schema";
import type { UploadResult } from "@uppy/core";

interface CreateVenueModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingVenue?: Venue;
}

const venueCategories = [
  { value: "nightclub", label: "Nightclub" },
  { value: "bar", label: "Bar" },
  { value: "lounge", label: "Lounge" },
  { value: "pub", label: "Pub" },
  { value: "rooftop", label: "Rooftop" },
  { value: "sports_bar", label: "Sports Bar" },
  { value: "wine_bar", label: "Wine Bar" },
  { value: "cocktail_bar", label: "Cocktail Bar" },
  { value: "live_music", label: "Live Music Venue" },
  { value: "comedy_club", label: "Comedy Club" },
];

const musicTypeOptions = [
  "Hip Hop", "EDM", "House", "Techno", "R&B", "Pop", "Latin", 
  "Reggaeton", "Rock", "Jazz", "Live DJ", "Karaoke", "Top 40"
];

const amenityOptions = [
  "VIP Section", "Bottle Service", "Dance Floor", "Outdoor Patio",
  "Pool Table", "Darts", "Live Stage", "Photo Booth", "Coat Check",
  "Free Parking", "Valet Parking", "Food Menu", "Happy Hour"
];

export default function CreateVenueModal({ open, onOpenChange, editingVenue }: CreateVenueModalProps) {
  const { toast } = useToast();
  const isEditing = !!editingVenue;

  const [formData, setFormData] = useState({
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
    dressCode: "",
    ageRestriction: "",
    musicTypes: [] as string[],
    amenities: [] as string[],
  });
  const maxGalleryImages = 6;
  const [replacingImageIndex, setReplacingImageIndex] = useState<number | null>(null);
  const replaceImageInputRef = useRef<HTMLInputElement>(null);

  const handleReplaceImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || replacingImageIndex === null) return;
    
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setFormData(prev => {
        const newImageUrls = [...prev.imageUrls];
        newImageUrls[replacingImageIndex] = base64;
        return { ...prev, imageUrls: newImageUrls };
      });
      toast({ title: "Image replaced successfully" });
    };
    reader.readAsDataURL(file);
    
    setReplacingImageIndex(null);
    if (replaceImageInputRef.current) {
      replaceImageInputRef.current.value = "";
    }
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
        dressCode: editingVenue.dressCode || "",
        ageRestriction: editingVenue.ageRestriction?.toString() || "",
        musicTypes: editingVenue.musicTypes || [],
        amenities: editingVenue.amenities || [],
      });
    } else {
      setFormData({
        name: "",
        category: "",
        description: "",
        imageUrl: "",
        coverImageUrl: "",
        imageUrls: [],
        address: "",
        city: "",
        phone: "",
        website: "",
        dressCode: "",
        ageRestriction: "",
        musicTypes: [],
        amenities: [],
      });
    }
  }, [editingVenue, open]);

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertVenue>) => {
      if (isEditing) {
        return await apiRequest("PATCH", `/api/venues/${editingVenue.id}`, data);
      }
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
        variant: "destructive" 
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const payload: Partial<InsertVenue> = {
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
      dressCode: formData.dressCode || null,
      ageRestriction: formData.ageRestriction ? parseInt(formData.ageRestriction) : null,
      musicTypes: formData.musicTypes.length > 0 ? formData.musicTypes : null,
      amenities: formData.amenities.length > 0 ? formData.amenities : null,
    };

    createMutation.mutate(payload);
  };

  const toggleMusicType = (type: string) => {
    setFormData(prev => ({
      ...prev,
      musicTypes: prev.musicTypes.includes(type)
        ? prev.musicTypes.filter(t => t !== type)
        : [...prev.musicTypes, type]
    }));
  };

  const toggleAmenity = (amenity: string) => {
    setFormData(prev => ({
      ...prev,
      amenities: prev.amenities.includes(amenity)
        ? prev.amenities.filter(a => a !== amenity)
        : [...prev.amenities, amenity]
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">
            {isEditing ? "Edit Venue" : "Add New Venue"}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)]">
          <form onSubmit={handleSubmit} className="space-y-6 pr-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Venue Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Enter venue name"
                  required
                  data-testid="input-venue-name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="category">Category *</Label>
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
                placeholder="Describe your venue..."
                rows={3}
                data-testid="input-venue-description"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Logo/Image</Label>
                <div className="flex items-center gap-3">
                  {formData.imageUrl ? (
                    <div className="relative">
                      <img 
                        src={formData.imageUrl} 
                        alt="Venue logo" 
                        className="h-16 w-16 rounded-lg object-cover border"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground"
                        onClick={() => setFormData(prev => ({ ...prev, imageUrl: "" }))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="h-16 w-16 rounded-lg border-2 border-dashed flex items-center justify-center bg-muted/50">
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <ObjectUploader
                    maxNumberOfFiles={1}
                    maxFileSize={5242880}
                    onGetUploadParameters={async () => {
                      const response = await apiRequest("POST", "/api/objects/upload");
                      const data = await response.json() as { uploadURL: string };
                      return { method: "PUT" as const, url: data.uploadURL };
                    }}
                    onComplete={async (result: UploadResult<Record<string, unknown>, Record<string, unknown>>) => {
                      if (result.successful?.[0]?.uploadURL) {
                        const response = await apiRequest("PUT", "/api/venue-images", { 
                          imageURL: result.successful[0].uploadURL 
                        });
                        const data = await response.json() as { objectPath: string };
                        setFormData(prev => ({ ...prev, imageUrl: data.objectPath }));
                        toast({ title: "Logo uploaded successfully" });
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

              <div className="space-y-2">
                <Label>Cover Image</Label>
                <div className="flex items-center gap-3">
                  {formData.coverImageUrl ? (
                    <div className="relative">
                      <img 
                        src={formData.coverImageUrl} 
                        alt="Cover image" 
                        className="h-16 w-24 rounded-lg object-cover border"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground"
                        onClick={() => setFormData(prev => ({ ...prev, coverImageUrl: "" }))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="h-16 w-24 rounded-lg border-2 border-dashed flex items-center justify-center bg-muted/50">
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <ObjectUploader
                    maxNumberOfFiles={1}
                    maxFileSize={10485760}
                    onGetUploadParameters={async () => {
                      const response = await apiRequest("POST", "/api/objects/upload");
                      const data = await response.json() as { uploadURL: string };
                      return { method: "PUT" as const, url: data.uploadURL };
                    }}
                    onComplete={async (result: UploadResult<Record<string, unknown>, Record<string, unknown>>) => {
                      if (result.successful?.[0]?.uploadURL) {
                        const response = await apiRequest("PUT", "/api/venue-images", { 
                          imageURL: result.successful[0].uploadURL 
                        });
                        const data = await response.json() as { objectPath: string };
                        setFormData(prev => ({ ...prev, coverImageUrl: data.objectPath }));
                        toast({ title: "Cover image uploaded successfully" });
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

            {/* Gallery Images Section - Up to 6 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Gallery Images</Label>
                <span className="text-xs text-muted-foreground">
                  {formData.imageUrls.length}/{maxGalleryImages} images
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
                    <div key={idx} className="relative aspect-video rounded-lg overflow-hidden border group">
                      <img 
                        src={url} 
                        alt={`Gallery ${idx + 1}`} 
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors z-10" />
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
                              imageUrls: prev.imageUrls.filter((_, i) => i !== idx) 
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
                  maxFileSize={10485760}
                  onGetUploadParameters={async () => {
                    const response = await apiRequest("POST", "/api/objects/upload");
                    const data = await response.json() as { uploadURL: string };
                    return { method: "PUT" as const, url: data.uploadURL };
                  }}
                  onComplete={async (result: UploadResult<Record<string, unknown>, Record<string, unknown>>) => {
                    const newUrls: string[] = [];
                    for (const file of result.successful || []) {
                      if (file.uploadURL) {
                        const response = await apiRequest("PUT", "/api/venue-images", { 
                          imageURL: file.uploadURL 
                        });
                        const data = await response.json() as { objectPath: string };
                        newUrls.push(data.objectPath);
                      }
                    }
                    if (newUrls.length > 0) {
                      setFormData(prev => ({ 
                        ...prev, 
                        imageUrls: [...prev.imageUrls, ...newUrls].slice(0, maxGalleryImages) 
                      }));
                      toast({ title: `${newUrls.length} image(s) uploaded successfully` });
                    }
                  }}
                  buttonVariant="outline"
                  buttonSize="sm"
                  buttonClassName="w-full"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Add Gallery Images ({maxGalleryImages - formData.imageUrls.length} remaining)
                </ObjectUploader>
              )}
              <p className="text-xs text-muted-foreground">
                Upload photos of your venue's interior, exterior, atmosphere, etc.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                value={formData.address}
                onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                placeholder="123 Main Street"
                data-testid="input-venue-address"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) => setFormData(prev => ({ ...prev, city: e.target.value }))}
                  placeholder="City"
                  data-testid="input-venue-city"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                  placeholder="(555) 123-4567"
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dressCode">Dress Code</Label>
                <Input
                  id="dressCode"
                  value={formData.dressCode}
                  onChange={(e) => setFormData(prev => ({ ...prev, dressCode: e.target.value }))}
                  placeholder="e.g., Smart Casual, No Sneakers"
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
                    <SelectValue placeholder="Select age restriction" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="18">18+</SelectItem>
                    <SelectItem value="21">21+</SelectItem>
                    <SelectItem value="25">25+</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Music Types</Label>
              <div className="flex flex-wrap gap-2">
                {musicTypeOptions.map(type => (
                  <Badge
                    key={type}
                    variant={formData.musicTypes.includes(type) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleMusicType(type)}
                    data-testid={`badge-music-${type.toLowerCase().replace(/\s+/g, '-')}`}
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
                    className="cursor-pointer"
                    onClick={() => toggleAmenity(amenity)}
                    data-testid={`badge-amenity-${amenity.toLowerCase().replace(/\s+/g, '-')}`}
                  >
                    {formData.amenities.includes(amenity) && <X className="h-3 w-3 mr-1" />}
                    {amenity}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4">
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
                data-testid="button-save-venue"
              >
                {createMutation.isPending ? "Saving..." : (isEditing ? "Update Venue" : "Create Venue")}
              </Button>
            </div>
          </form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
