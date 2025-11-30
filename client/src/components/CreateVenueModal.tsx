import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { X, Plus } from "lucide-react";
import type { Venue, InsertVenue } from "@shared/schema";

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
    address: "",
    city: "",
    phone: "",
    website: "",
    dressCode: "",
    ageRestriction: "",
    musicTypes: [] as string[],
    amenities: [] as string[],
  });

  useEffect(() => {
    if (editingVenue) {
      setFormData({
        name: editingVenue.name || "",
        category: editingVenue.category || "",
        description: editingVenue.description || "",
        imageUrl: editingVenue.imageUrl || "",
        coverImageUrl: editingVenue.coverImageUrl || "",
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
                <Label htmlFor="imageUrl">Logo/Image URL</Label>
                <Input
                  id="imageUrl"
                  value={formData.imageUrl}
                  onChange={(e) => setFormData(prev => ({ ...prev, imageUrl: e.target.value }))}
                  placeholder="https://..."
                  data-testid="input-venue-image"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="coverImageUrl">Cover Image URL</Label>
                <Input
                  id="coverImageUrl"
                  value={formData.coverImageUrl}
                  onChange={(e) => setFormData(prev => ({ ...prev, coverImageUrl: e.target.value }))}
                  placeholder="https://..."
                  data-testid="input-venue-cover"
                />
              </div>
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
