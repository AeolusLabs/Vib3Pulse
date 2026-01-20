import { useState, useEffect } from "react";
import { X, Upload, Plus, Trash2, Edit2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Event, EventCreateDto, EventUpdateDto } from "@shared/schema";

interface TicketTier {
  id: string;
  name: string;
  price: number;
  quantity: number;
  salesEndDate: string;
  dayDate?: string; // For multi-day events: null/undefined = all-days pass, date string = specific day
}

interface ExternalTicketLink {
  id: string;
  platform: string;
  url: string;
}

interface EventFormData {
  // Step 1
  name: string;
  type: string;
  description: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  isMultiDay: boolean;
  locationType: "physical" | "virtual";
  location: string;
  ageRestriction: "all" | "18+" | "21+";
  parentalGuidance: "none" | "advised";
  entryType: "free" | "ticketed" | "external";
  thumbnailUrl: string;
  externalTicketUrl: string;
  externalTicketLinks: ExternalTicketLink[];
  
  // Step 2
  tickets: TicketTier[];
  requireRSVP: boolean;
  rsvpGeneratesTicket: boolean;
  
  // Community
  createCommunity: boolean;
  communityName: string;
}

interface CreateEventModalProps {
  open: boolean;
  onClose: () => void;
  event?: Event; // If provided, modal is in edit mode
}

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
  "Theatre"
];

export default function CreateEventModal({ open, onClose, event }: CreateEventModalProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [step, setStep] = useState(1);
  const isEditMode = !!event;
  
  // Only verified/official users can add external ticket links
  const canAddExternalTicketUrl = currentUser?.isVerified || currentUser?.isOfficial;
  
  const [formData, setFormData] = useState<EventFormData>({
    name: "",
    type: "",
    description: "",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    isMultiDay: false,
    locationType: "physical",
    location: "",
    ageRestriction: "all",
    parentalGuidance: "none",
    entryType: "free",
    thumbnailUrl: "",
    externalTicketUrl: "",
    externalTicketLinks: [],
    tickets: [],
    requireRSVP: false,
    rsvpGeneratesTicket: true,
    createCommunity: false,
    communityName: "",
  });
  
  const [externalLinksModalOpen, setExternalLinksModalOpen] = useState(false);

  // Pre-fill form when editing
  useEffect(() => {
    if (event && open) {
      const eventDate = new Date(event.eventDate);
      const startDateStr = eventDate.toISOString().split('T')[0];
      const startTimeStr = eventDate.toTimeString().slice(0, 5);
      
      // Calculate end date/time and isMultiDay from eventEndDate
      let endDateStr = "";
      let endTimeStr = "";
      let isMultiDayEvent = false;
      
      if (event.eventEndDate) {
        const endDate = new Date(event.eventEndDate);
        endDateStr = endDate.toISOString().split('T')[0];
        endTimeStr = endDate.toTimeString().slice(0, 5);
        // Multi-day if end date is different from start date
        isMultiDayEvent = startDateStr !== endDateStr;
      }
      
      // Helper to build form data
      const buildFormData = (tiers: any[] = []) => ({
        name: event.title,
        type: event.category,
        description: event.description,
        startDate: startDateStr,
        startTime: startTimeStr,
        endDate: isMultiDayEvent ? endDateStr : "",
        endTime: endTimeStr,
        isMultiDay: isMultiDayEvent,
        locationType: "physical" as const,
        location: event.location,
        ageRestriction: "all" as const,
        parentalGuidance: "none" as const,
        entryType: event.externalTicketUrl ? "external" as const : (event.ticketPrice > 0 ? "ticketed" as const : "free" as const),
        thumbnailUrl: event.imageUrl || "",
        externalTicketUrl: event.externalTicketUrl || "",
        externalTicketLinks: event.externalTicketUrl ? [{ id: "1", platform: "External", url: event.externalTicketUrl }] : [],
        tickets: tiers.length > 0 ? tiers.map((tier, index) => ({
          id: tier.id || String(index + 1),
          name: tier.name,
          price: tier.priceCents / 100,
          quantity: tier.quantity,
          salesEndDate: tier.salesEndDate ? new Date(tier.salesEndDate).toISOString().split('T')[0] : startDateStr,
          dayDate: tier.dayDate ? new Date(tier.dayDate).toISOString().split('T')[0] : undefined,
        })) : (event.ticketPrice > 0 ? [{
          id: "1",
          name: "General Admission",
          price: event.ticketPrice / 100,
          quantity: event.ticketsAvailable,
          salesEndDate: startDateStr,
        }] : []),
        requireRSVP: event.requiresRSVP,
        rsvpGeneratesTicket: true,
        createCommunity: false,
        communityName: "",
      });
      
      // Fetch existing ticket tiers if this is a ticketed event
      if (event.ticketPrice > 0) {
        fetch(`/api/events/${event.id}/ticket-tiers`, { credentials: "include" })
          .then(res => res.json())
          .then((tiers: any[]) => {
            setFormData(buildFormData(tiers));
          })
          .catch(() => {
            // Fallback if tier fetch fails
            setFormData(buildFormData([]));
          });
      } else {
        setFormData(buildFormData([]));
      }
    } else if (!open) {
      // Reset form when modal closes
      setStep(1);
      setExternalLinksModalOpen(false);
      setFormData({
        name: "",
        type: "",
        description: "",
        startDate: "",
        startTime: "",
        endDate: "",
        endTime: "",
        isMultiDay: false,
        locationType: "physical",
        location: "",
        ageRestriction: "all",
        parentalGuidance: "none",
        entryType: "free",
        thumbnailUrl: "",
        externalTicketUrl: "",
        externalTicketLinks: [],
        tickets: [],
        requireRSVP: false,
        rsvpGeneratesTicket: true,
        createCommunity: false,
        communityName: "",
      });
    }
  }, [event, open]);

  const createEventMutation = useMutation<Event, Error, EventCreateDto>({
    mutationFn: async (eventData) => {
      const response = await apiRequest('POST', '/api/events', eventData);
      if (!response.ok) {
        if (response.status === 413) {
          throw new Error('Event image is too large. Please use a smaller image.');
        }
        const errorData = await response.json().catch(() => ({ message: 'Failed to create event' }));
        throw new Error(errorData.message || 'Failed to create event');
      }
      return await response.json();
    },
    onSuccess: async (event) => {
      try {
        if (formData.entryType === "ticketed" && formData.tickets.length > 0) {
          const tiers = formData.tickets.map(ticket => ({
            name: ticket.name,
            priceCents: Math.round(ticket.price * 100),
            quantity: ticket.quantity,
            salesEndDate: ticket.salesEndDate || null,
            dayDate: ticket.dayDate || null,
          }));

          const tiersResponse = await apiRequest('POST', `/api/events/${event.id}/ticket-tiers`, { tiers });
          if (!tiersResponse.ok) {
            const errorData = await tiersResponse.json().catch(() => ({ message: 'Failed to create ticket tiers' }));
            throw new Error(errorData.message || 'Failed to create ticket tiers');
          }
        }

        queryClient.invalidateQueries({ queryKey: ["/api/events"] });
        queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
        toast({
          title: "Event created!",
          description: "Your event has been successfully created.",
        });
        onClose();
      } catch (error: any) {
        toast({
          title: "Error creating ticket tiers",
          description: error.message || "Failed to create ticket tiers. Please try again.",
          variant: "destructive",
        });
        // Don't close modal - let user retry
      }
    },
    onError: (error) => {
      toast({
        title: "Error creating event",
        description: error.message || "Failed to create event. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateEventMutation = useMutation<Event, Error, EventUpdateDto>({
    mutationFn: async ({ id, ...eventData }) => {
      const response = await apiRequest('PUT', `/api/events/${id}`, eventData);
      if (!response.ok) {
        if (response.status === 413) {
          throw new Error('Event image is too large. Please use a smaller image.');
        }
        const errorData = await response.json().catch(() => ({ message: 'Failed to update event' }));
        throw new Error(errorData.message || 'Failed to update event');
      }
      return await response.json();
    },
    onSuccess: async (updatedEvent) => {
      try {
        // Always delete existing tiers first
        const existingTiersResponse = await fetch(`/api/events/${updatedEvent.id}/ticket-tiers`, {
          credentials: "include",
        });
        if (existingTiersResponse.ok) {
          const existingTiers = await existingTiersResponse.json();
          if (existingTiers.length > 0) {
            await Promise.all(
              existingTiers.map((tier: any) =>
                apiRequest('DELETE', `/api/ticket-tiers/${tier.id}`)
              )
            );
          }
        }

        // Create new tiers only if ticketed and has tiers
        if (formData.entryType === "ticketed" && formData.tickets.length > 0) {
          const tiers = formData.tickets.map(ticket => ({
            name: ticket.name,
            priceCents: Math.round(ticket.price * 100),
            quantity: ticket.quantity,
            salesEndDate: ticket.salesEndDate || null,
            dayDate: ticket.dayDate || null,
          }));

          const tiersResponse = await apiRequest('POST', `/api/events/${updatedEvent.id}/ticket-tiers`, { tiers });
          if (!tiersResponse.ok) {
            const errorData = await tiersResponse.json().catch(() => ({ message: 'Failed to update ticket tiers' }));
            throw new Error(errorData.message || 'Failed to update ticket tiers');
          }
        }

        queryClient.invalidateQueries({ queryKey: ["/api/events"] });
        queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
        toast({
          title: "Event updated!",
          description: "Your event has been successfully updated.",
        });
        onClose();
      } catch (error: any) {
        toast({
          title: "Error updating ticket tiers",
          description: error.message || "Failed to update ticket tiers. Please try again.",
          variant: "destructive",
        });
        // Don't close modal - let user retry
      }
    },
    onError: (error) => {
      toast({
        title: "Error updating event",
        description: error.message || "Failed to update event. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateFormData = (updates: Partial<EventFormData>) => {
    setFormData(prev => ({ ...prev, ...updates }));
  };

  const handleNext = () => {
    if (step < 3) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleSubmit = () => {
    // Convert form data to match Event schema
    const eventDate = new Date(`${formData.startDate}T${formData.startTime}`);
    
    // Calculate event end date
    let eventEndDate: Date | null = null;
    if (formData.isMultiDay && formData.endDate && formData.endTime) {
      eventEndDate = new Date(`${formData.endDate}T${formData.endTime}`);
    } else if (!formData.isMultiDay && formData.endTime) {
      // For single-day events, end date is same day but at end time
      eventEndDate = new Date(`${formData.startDate}T${formData.endTime}`);
    }
    
    // Calculate ticket price and quantity - CONVERT TO CENTS
    const ticketPrice = formData.entryType === "free" 
      ? 0 
      : Math.round((formData.tickets[0]?.price || 0) * 100);
    
    // For free events, set ticketsAvailable to 9999 to indicate unlimited
    const ticketsAvailable = formData.entryType === "free"
      ? 9999
      : formData.tickets.reduce((sum, ticket) => sum + ticket.quantity, 0);
    
    // Build event data without organizerId (backend sets it from req.user)
    // Convert Date to ISO string for API compatibility
    const baseEventData = {
      title: formData.name,
      description: formData.description,
      eventDate: eventDate.toISOString(),
      eventEndDate: eventEndDate ? eventEndDate.toISOString() : null,
      location: formData.location,
      category: formData.type,
      ticketPrice: ticketPrice,
      requiresRSVP: formData.requireRSVP,
      ticketsAvailable: ticketsAvailable,
      imageUrl: formData.thumbnailUrl || null,
      externalTicketUrl: formData.entryType === "external" && formData.externalTicketLinks.length > 0 
        ? formData.externalTicketLinks[0].url 
        : (formData.externalTicketUrl || null),
      externalTicketLinks: formData.entryType === "external" ? formData.externalTicketLinks : undefined,
      createCommunity: formData.createCommunity,
      communityName: formData.communityName,
    };
    
    if (isEditMode && event) {
      updateEventMutation.mutate({ id: event.id, ...baseEventData });
    } else {
      // Only create needs organizerId placeholder (backend will replace it)
      const createEventData: EventCreateDto = {
        organizerId: "", // Backend replaces this from req.user
        ...baseEventData,
      };
      createEventMutation.mutate(createEventData);
    }
  };

  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
          }

          // Set max dimensions for thumbnail
          const MAX_WIDTH = 800;
          const MAX_HEIGHT = 600;
          let width = img.width;
          let height = img.height;

          // Calculate new dimensions maintaining aspect ratio
          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);

          // Convert to base64 with compression
          const base64 = canvas.toDataURL('image/jpeg', 0.85);
          resolve(base64);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const handleThumbnailUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        // Validate file type
        if (!file.type.startsWith('image/')) {
          toast({
            title: "Invalid file",
            description: "Please upload an image file",
            variant: "destructive",
          });
          return;
        }

        // Validate file size (max 5MB before compression)
        if (file.size > 5 * 1024 * 1024) {
          toast({
            title: "File too large",
            description: "Please upload an image smaller than 5MB",
            variant: "destructive",
          });
          return;
        }

        // Compress and convert to base64
        const base64Url = await compressImage(file);
        
        // Check compressed size (base64 is ~33% larger than binary)
        const sizeInBytes = base64Url.length * 0.75;
        const sizeInMB = sizeInBytes / (1024 * 1024);
        
        if (sizeInMB > 1.5) {
          toast({
            title: "Image too large",
            description: `Compressed image is ${sizeInMB.toFixed(1)}MB. Please use a smaller or simpler image.`,
            variant: "destructive",
          });
          return;
        }
        
        updateFormData({ thumbnailUrl: base64Url });
      } catch (error) {
        console.error('Error uploading image:', error);
        toast({
          title: "Upload failed",
          description: "Failed to process image. Please try again.",
          variant: "destructive",
        });
      }
    }
  };

  const addTicketTier = () => {
    const newTicket: TicketTier = {
      id: Date.now().toString(),
      name: "",
      price: 0,
      quantity: 0,
      salesEndDate: "",
    };
    updateFormData({ tickets: [...formData.tickets, newTicket] });
  };

  const updateTicket = (id: string, updates: Partial<TicketTier>) => {
    updateFormData({
      tickets: formData.tickets.map(ticket =>
        ticket.id === id ? { ...ticket, ...updates } : ticket
      ),
    });
  };

  const removeTicket = (id: string) => {
    updateFormData({
      tickets: formData.tickets.filter(ticket => ticket.id !== id),
    });
  };

  // Get all days for multi-day event ticket selection
  const getEventDays = () => {
    if (!formData.isMultiDay || !formData.startDate || !formData.endDate) {
      return [];
    }
    
    const days: { value: string; label: string }[] = [];
    
    // Parse dates as local dates to avoid timezone issues
    const [startYear, startMonth, startDay] = formData.startDate.split('-').map(Number);
    const [endYear, endMonth, endDay] = formData.endDate.split('-').map(Number);
    
    // Create dates at noon to avoid DST issues
    const start = new Date(startYear, startMonth - 1, startDay, 12, 0, 0);
    const end = new Date(endYear, endMonth - 1, endDay, 12, 0, 0);
    
    // Use a Set to prevent duplicates
    const addedDates = new Set<string>();
    
    // Add each day between start and end (inclusive)
    const current = new Date(start);
    while (current <= end) {
      const year = current.getFullYear();
      const month = String(current.getMonth() + 1).padStart(2, '0');
      const day = String(current.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      // Only add if not already added
      if (!addedDates.has(dateStr)) {
        addedDates.add(dateStr);
        days.push({
          value: dateStr,
          label: current.toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'short', 
            day: 'numeric' 
          }),
        });
      }
      current.setDate(current.getDate() + 1);
    }
    
    return days;
  };

  const isStep1Valid = () => {
    const baseValid = (
      formData.name.trim() !== "" &&
      formData.type !== "" &&
      formData.description.trim() !== "" &&
      formData.startDate !== "" &&
      formData.startTime !== "" &&
      formData.endTime !== "" &&
      formData.location.trim() !== ""
    );
    
    if (formData.isMultiDay) {
      if (formData.endDate === "") {
        return false;
      }
      // Ensure end date/time is after start date/time
      const startDateTime = new Date(`${formData.startDate}T${formData.startTime}`);
      const endDateTime = new Date(`${formData.endDate}T${formData.endTime}`);
      return baseValid && endDateTime > startDateTime;
    }
    
    // For single-day events, ensure end time is after start time
    if (formData.endTime <= formData.startTime) {
      return false;
    }
    
    return baseValid;
  };

  const isStep2Valid = () => {
    if (formData.entryType === "ticketed") {
      return formData.tickets.length > 0 && formData.tickets.every(t =>
        t.name.trim() !== "" && t.price > 0 && t.quantity > 0 && t.salesEndDate !== ""
      );
    }
    if (formData.entryType === "external") {
      return formData.externalTicketLinks.length > 0 && formData.externalTicketLinks.every(l =>
        l.platform.trim() !== "" && l.url.trim() !== "" && isValidUrl(l.url)
      );
    }
    return true;
  };
  
  const isValidUrl = (url: string) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-2xl">
              {isEditMode ? 'Edit Event' : 'Create Event'} - Step {step} of 3
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              data-testid="button-close-event-modal"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`flex-1 h-1 rounded-full ${
                s <= step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Event Details */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="event-name">Event Name *</Label>
              <Input
                id="event-name"
                placeholder="Enter event name"
                value={formData.name}
                onChange={(e) => updateFormData({ name: e.target.value })}
                data-testid="input-event-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-type">Event Type *</Label>
              <Select value={formData.type} onValueChange={(value) => updateFormData({ type: value })}>
                <SelectTrigger data-testid="select-event-type">
                  <SelectValue placeholder="Select event category" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-description">Event Description *</Label>
              <Textarea
                id="event-description"
                placeholder="Describe your event..."
                value={formData.description}
                onChange={(e) => updateFormData({ description: e.target.value })}
                rows={4}
                data-testid="input-event-description"
              />
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Event Schedule *</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.isMultiDay}
                    onCheckedChange={(checked) => updateFormData({ isMultiDay: checked })}
                    data-testid="switch-multi-day"
                  />
                  <span className="text-sm text-muted-foreground">Multi-day event</span>
                </div>
              </div>

              <div className={`grid grid-cols-1 ${formData.isMultiDay ? 'md:grid-cols-2' : 'md:grid-cols-3'} gap-4`}>
                <div className="space-y-2">
                  <Label htmlFor="start-date">{formData.isMultiDay ? 'Start Date *' : 'Date *'}</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => updateFormData({ startDate: e.target.value })}
                    data-testid="input-start-date"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start-time">Start Time *</Label>
                  <Input
                    id="start-time"
                    type="time"
                    value={formData.startTime}
                    onChange={(e) => updateFormData({ startTime: e.target.value })}
                    data-testid="input-start-time"
                  />
                </div>

                {!formData.isMultiDay && (
                  <div className="space-y-2">
                    <Label htmlFor="end-time">End Time *</Label>
                    <Input
                      id="end-time"
                      type="time"
                      value={formData.endTime}
                      onChange={(e) => updateFormData({ endTime: e.target.value })}
                      data-testid="input-end-time"
                      className={
                        formData.endTime === "" || 
                        (formData.startDate && formData.startTime && formData.endTime && 
                         formData.endTime <= formData.startTime)
                          ? "border-destructive" 
                          : ""
                      }
                    />
                    {formData.endTime === "" && (
                      <p className="text-xs text-destructive">End time is required</p>
                    )}
                    {formData.endTime !== "" && formData.startTime && formData.endTime <= formData.startTime && (
                      <p className="text-xs text-destructive">End time must be after start time</p>
                    )}
                  </div>
                )}
              </div>

              {formData.isMultiDay && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="end-date">End Date *</Label>
                    <Input
                      id="end-date"
                      type="date"
                      value={formData.endDate}
                      onChange={(e) => updateFormData({ endDate: e.target.value })}
                      data-testid="input-end-date"
                      className={
                        formData.endDate === "" || 
                        (formData.startDate && formData.startTime && formData.endDate && formData.endTime && 
                         new Date(`${formData.endDate}T${formData.endTime}`) <= new Date(`${formData.startDate}T${formData.startTime}`))
                          ? "border-destructive" 
                          : ""
                      }
                    />
                    {formData.endDate === "" && (
                      <p className="text-xs text-destructive">End date is required</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="end-time">End Time *</Label>
                    <Input
                      id="end-time"
                      type="time"
                      value={formData.endTime}
                      onChange={(e) => updateFormData({ endTime: e.target.value })}
                      data-testid="input-end-time"
                      className={
                        formData.endTime === "" || 
                        (formData.startDate && formData.startTime && formData.endDate && formData.endTime && 
                         new Date(`${formData.endDate}T${formData.endTime}`) <= new Date(`${formData.startDate}T${formData.startTime}`))
                          ? "border-destructive" 
                          : ""
                      }
                    />
                    {formData.endTime === "" && (
                      <p className="text-xs text-destructive">End time is required</p>
                    )}
                  </div>
                </div>
              )}
              
              {formData.isMultiDay && formData.endDate !== "" && formData.endTime !== "" && formData.startDate && formData.startTime && 
               new Date(`${formData.endDate}T${formData.endTime}`) <= new Date(`${formData.startDate}T${formData.startTime}`) && (
                <p className="text-xs text-destructive">End date/time must be after start date/time</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Location Type *</Label>
              <RadioGroup
                value={formData.locationType}
                onValueChange={(value: "physical" | "virtual") => updateFormData({ locationType: value, location: "" })}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="physical" id="physical" data-testid="radio-physical" />
                  <Label htmlFor="physical">Physical Event</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="virtual" id="virtual" data-testid="radio-virtual" />
                  <Label htmlFor="virtual">Virtual Event</Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location">
                {formData.locationType === "physical" ? "Address *" : "Stream Link *"}
              </Label>
              <Input
                id="location"
                placeholder={formData.locationType === "physical" ? "Enter venue address" : "Enter stream URL"}
                value={formData.location}
                onChange={(e) => updateFormData({ location: e.target.value })}
                data-testid="input-location"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="age-restriction">Age Restriction</Label>
                <Select
                  value={formData.ageRestriction}
                  onValueChange={(value: "all" | "18+" | "21+") => updateFormData({ ageRestriction: value })}
                >
                  <SelectTrigger data-testid="select-age-restriction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Ages</SelectItem>
                    <SelectItem value="18+">18+</SelectItem>
                    <SelectItem value="21+">21+</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="parental-guidance">Parental Guidance</Label>
                <Select
                  value={formData.parentalGuidance}
                  onValueChange={(value: "none" | "advised") => updateFormData({ parentalGuidance: value })}
                >
                  <SelectTrigger data-testid="select-parental-guidance">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="advised">Advised</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Entry Type *</Label>
              <RadioGroup
                value={formData.entryType}
                onValueChange={(value: "free" | "ticketed" | "external") => updateFormData({ entryType: value })}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="free" id="free" data-testid="radio-free" />
                  <Label htmlFor="free">Free Event</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="ticketed" id="ticketed" data-testid="radio-ticketed" />
                  <Label htmlFor="ticketed">Ticketed Event</Label>
                </div>
                {canAddExternalTicketUrl && (
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="external" id="external" data-testid="radio-external" />
                    <Label htmlFor="external">External Ticket Link(s)</Label>
                  </div>
                )}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label>Event Thumbnail *</Label>
              <div className="border-2 border-dashed rounded-lg p-6 hover-elevate active-elevate-2 transition-colors">
                <input
                  type="file"
                  id="thumbnail"
                  accept="image/*"
                  onChange={handleThumbnailUpload}
                  className="hidden"
                  data-testid="input-thumbnail"
                />
                <label
                  htmlFor="thumbnail"
                  className="flex flex-col items-center gap-2 cursor-pointer"
                >
                  {formData.thumbnailUrl ? (
                    <div className="relative w-full">
                      <img
                        src={formData.thumbnailUrl}
                        alt="Thumbnail preview"
                        className="w-full h-48 object-cover rounded-lg"
                      />
                      <Badge className="absolute top-2 right-2">Uploaded</Badge>
                    </div>
                  ) : (
                    <>
                      <Upload className="h-12 w-12 text-muted-foreground" />
                      <div className="text-center">
                        <p className="text-sm font-medium">Click to upload thumbnail</p>
                        <p className="text-xs text-muted-foreground">PNG, JPG up to 10MB</p>
                      </div>
                    </>
                  )}
                </label>
              </div>
            </div>

            {!isEditMode && (
              <div className="space-y-4 p-4 border rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="create-community" className="text-base font-medium">Create Event Community</Label>
                    <p className="text-sm text-muted-foreground">
                      Create a community for attendees to connect and discuss this event
                    </p>
                  </div>
                  <Switch
                    id="create-community"
                    checked={formData.createCommunity}
                    onCheckedChange={(checked) => updateFormData({ 
                      createCommunity: checked,
                      communityName: checked && !formData.communityName ? formData.name : formData.communityName
                    })}
                    data-testid="switch-create-community"
                  />
                </div>
                
                {formData.createCommunity && (
                  <div className="space-y-2">
                    <Label htmlFor="community-name">Community Name</Label>
                    <Input
                      id="community-name"
                      placeholder="Enter community name"
                      value={formData.communityName}
                      onChange={(e) => updateFormData({ communityName: e.target.value })}
                      data-testid="input-community-name"
                    />
                    <p className="text-xs text-muted-foreground">
                      You'll be added as the admin of this community
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={handleNext}
                disabled={!isStep1Valid()}
                data-testid="button-next-step1"
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Entry Configuration */}
        {step === 2 && (
          <div className="space-y-6">
            {formData.entryType === "external" ? (
              <>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">External Ticket Links</h3>
                      <p className="text-sm text-muted-foreground">
                        Add links to external ticketing platforms (Eventbrite, Ticketmaster, Dice, etc.)
                      </p>
                    </div>
                    <Button
                      onClick={() => setExternalLinksModalOpen(true)}
                      size="sm"
                      data-testid="button-manage-external-links"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      {formData.externalTicketLinks.length > 0 ? "Manage Links" : "Add Links"}
                    </Button>
                  </div>

                  {formData.externalTicketLinks.length === 0 ? (
                    <Card>
                      <CardContent className="py-12 text-center">
                        <p className="text-muted-foreground">
                          No ticket links yet. Click "Add Links" to add external ticketing links.
                        </p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {formData.externalTicketLinks.map((link, index) => (
                        <Card key={link.id}>
                          <CardContent className="py-3 flex items-center justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">{link.platform}</p>
                              <p className="text-xs text-muted-foreground truncate">{link.url}</p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                const newLinks = formData.externalTicketLinks.filter(l => l.id !== link.id);
                                updateFormData({ externalTicketLinks: newLinks });
                              }}
                              data-testid={`button-remove-link-${index}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : formData.entryType === "ticketed" ? (
              <>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">Ticket Tiers</h3>
                      <p className="text-sm text-muted-foreground">
                        {formData.isMultiDay 
                          ? "Create tickets for specific days or an all-days pass"
                          : "Create different ticket types for your event"
                        }
                      </p>
                    </div>
                    <Button
                      onClick={addTicketTier}
                      size="sm"
                      data-testid="button-add-ticket"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Tier
                    </Button>
                  </div>

                  {formData.tickets.length === 0 ? (
                    <Card>
                      <CardContent className="py-12 text-center">
                        <p className="text-muted-foreground">
                          No ticket tiers yet. Click "Add Tier" to create one.
                        </p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-4">
                      {formData.tickets.map((ticket, index) => (
                        <Card key={ticket.id}>
                          <CardContent className="pt-6">
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <h4 className="font-semibold">Tier {index + 1}</h4>
                                  {formData.isMultiDay && (
                                    <Badge variant={ticket.dayDate ? "secondary" : "default"}>
                                      {ticket.dayDate 
                                        ? new Date(ticket.dayDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                        : "All Days Pass"
                                      }
                                    </Badge>
                                  )}
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeTicket(ticket.id)}
                                  data-testid={`button-remove-ticket-${index}`}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label>Ticket Name</Label>
                                  <Input
                                    placeholder="e.g., General Admission"
                                    value={ticket.name}
                                    onChange={(e) => updateTicket(ticket.id, { name: e.target.value })}
                                    data-testid={`input-ticket-name-${index}`}
                                  />
                                </div>

                                <div className="space-y-2">
                                  <Label>Price ($)</Label>
                                  <Input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    placeholder="0.00"
                                    value={ticket.price || ""}
                                    onChange={(e) => updateTicket(ticket.id, { price: parseFloat(e.target.value) || 0 })}
                                    data-testid={`input-ticket-price-${index}`}
                                  />
                                </div>

                                <div className="space-y-2">
                                  <Label>Quantity Available</Label>
                                  <Input
                                    type="number"
                                    min="1"
                                    placeholder="100"
                                    value={ticket.quantity || ""}
                                    onChange={(e) => updateTicket(ticket.id, { quantity: parseInt(e.target.value) || 0 })}
                                    data-testid={`input-ticket-quantity-${index}`}
                                  />
                                </div>

                                <div className="space-y-2">
                                  <Label>Sales End Date</Label>
                                  <Input
                                    type="datetime-local"
                                    value={ticket.salesEndDate}
                                    onChange={(e) => updateTicket(ticket.id, { salesEndDate: e.target.value })}
                                    data-testid={`input-ticket-sales-end-${index}`}
                                  />
                                </div>

                                {formData.isMultiDay && (
                                  <div className="space-y-2 md:col-span-2">
                                    <Label>Valid For</Label>
                                    <Select
                                      value={ticket.dayDate || "all-days"}
                                      onValueChange={(value) => updateTicket(ticket.id, { 
                                        dayDate: value === "all-days" ? undefined : value 
                                      })}
                                    >
                                      <SelectTrigger data-testid={`select-ticket-day-${index}`}>
                                        <SelectValue placeholder="Select day" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="all-days">All Days Pass</SelectItem>
                                        {getEventDays().map((day) => (
                                          <SelectItem key={day.value} value={day.value}>
                                            {day.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                      {ticket.dayDate 
                                        ? "This ticket is valid only for the selected day"
                                        : "This ticket grants access to all days of the event"
                                      }
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">Free Event Settings</h3>
                    <p className="text-sm text-muted-foreground">
                      Configure how attendees can join your free event
                    </p>
                  </div>

                  <Card>
                    <CardContent className="pt-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label htmlFor="require-rsvp" className="text-base">Require RSVP</Label>
                          <p className="text-sm text-muted-foreground">
                            Attendees must RSVP to attend this event
                          </p>
                        </div>
                        <Switch
                          id="require-rsvp"
                          checked={formData.requireRSVP}
                          onCheckedChange={(checked) => updateFormData({ requireRSVP: checked })}
                          data-testid="switch-require-rsvp"
                        />
                      </div>

                      {formData.requireRSVP && (
                        <div className="flex items-center justify-between pt-4 border-t">
                          <div>
                            <Label htmlFor="rsvp-ticket" className="text-base">Generate Free Entry Ticket</Label>
                            <p className="text-sm text-muted-foreground">
                              Send a free ticket to attendees who RSVP
                            </p>
                          </div>
                          <Switch
                            id="rsvp-ticket"
                            checked={formData.rsvpGeneratesTicket}
                            onCheckedChange={(checked) => updateFormData({ rsvpGeneratesTicket: checked })}
                            data-testid="switch-rsvp-ticket"
                          />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </>
            )}

            <div className="flex justify-between gap-2">
              <Button onClick={handleBack} variant="outline" data-testid="button-back-step2">
                Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={!isStep2Valid()}
                data-testid="button-next-step2"
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold">Review Your Event</h3>
              <p className="text-sm text-muted-foreground">
                Review all details before creating your event
              </p>
            </div>

            {/* Event Details */}
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="flex items-start justify-between">
                  <h4 className="font-semibold">Event Details</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep(1)}
                    data-testid="button-edit-step1"
                  >
                    <Edit2 className="h-4 w-4 mr-2" />
                    Edit
                  </Button>
                </div>

                {formData.thumbnailUrl && (
                  <img
                    src={formData.thumbnailUrl}
                    alt="Event thumbnail"
                    className="w-full h-48 object-cover rounded-lg"
                  />
                )}

                <div className="space-y-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Event Name</p>
                    <p className="font-medium" data-testid="text-review-name">{formData.name}</p>
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground">Category</p>
                    <Badge variant="secondary" data-testid="text-review-type">{formData.type}</Badge>
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="text-sm" data-testid="text-review-description">{formData.description}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Start</p>
                      <p className="text-sm" data-testid="text-review-start-date">
                        {new Date(`${formData.startDate}T${formData.startTime}`).toLocaleString()}
                      </p>
                    </div>
                    {formData.isMultiDay && formData.endDate && formData.endTime && (
                      <div>
                        <p className="text-sm text-muted-foreground">End</p>
                        <p className="text-sm" data-testid="text-review-end-date">
                          {new Date(`${formData.endDate}T${formData.endTime}`).toLocaleString()}
                        </p>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground">Location</p>
                    <p className="text-sm" data-testid="text-review-location">
                      {formData.locationType === "physical" ? "📍 " : "🌐 "}
                      {formData.location}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Badge variant="outline" data-testid="text-review-age">{formData.ageRestriction}</Badge>
                    {formData.parentalGuidance === "advised" && (
                      <Badge variant="outline">Parental Guidance Advised</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Entry Configuration */}
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="flex items-start justify-between">
                  <h4 className="font-semibold">Entry Configuration</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep(2)}
                    data-testid="button-edit-step2"
                  >
                    <Edit2 className="h-4 w-4 mr-2" />
                    Edit
                  </Button>
                </div>

                {formData.entryType === "external" ? (
                  <div className="space-y-3">
                    <Badge className="bg-blue-500" data-testid="text-review-entry-type">External Ticketing</Badge>
                    {formData.externalTicketLinks.map((link, index) => (
                      <div
                        key={link.id}
                        className="p-4 border rounded-lg space-y-2"
                        data-testid={`review-link-${index}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">{link.platform}</p>
                          <ExternalLink className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <p className="text-sm text-muted-foreground truncate">{link.url}</p>
                      </div>
                    ))}
                  </div>
                ) : formData.entryType === "ticketed" ? (
                  <div className="space-y-3">
                    <Badge className="bg-primary" data-testid="text-review-entry-type">Ticketed Event</Badge>
                    {formData.tickets.map((ticket, index) => (
                      <div
                        key={ticket.id}
                        className="p-4 border rounded-lg space-y-2"
                        data-testid={`review-ticket-${index}`}
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-medium">{ticket.name}</p>
                          <p className="font-semibold text-primary">£{ticket.price.toFixed(2)}</p>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span>Qty: {ticket.quantity}</span>
                          <span>•</span>
                          <span>Sales end: {new Date(ticket.salesEndDate).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Badge className="bg-green-500" data-testid="text-review-entry-type">Free Event</Badge>
                    {formData.requireRSVP ? (
                      <div className="text-sm">
                        <p className="text-muted-foreground">RSVP Required</p>
                        {formData.rsvpGeneratesTicket && (
                          <p className="text-muted-foreground">✓ Free entry ticket will be generated</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Open to all, no RSVP required</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-between gap-2">
              <Button onClick={handleBack} variant="outline" data-testid="button-back-step3" disabled={createEventMutation.isPending || updateEventMutation.isPending}>
                Back
              </Button>
              <Button onClick={handleSubmit} disabled={createEventMutation.isPending || updateEventMutation.isPending} data-testid="button-create-event">
                {isEditMode 
                  ? (updateEventMutation.isPending ? "Updating..." : "Update Event")
                  : (createEventMutation.isPending ? "Creating..." : "Create Event")
                }
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    
    {/* External Links Modal */}
    <Dialog open={externalLinksModalOpen} onOpenChange={setExternalLinksModalOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage External Ticket Links</DialogTitle>
        </DialogHeader>
        <ExternalLinksModalContent
          links={formData.externalTicketLinks}
          onSave={(links) => {
            updateFormData({ externalTicketLinks: links });
            setExternalLinksModalOpen(false);
          }}
          onCancel={() => setExternalLinksModalOpen(false)}
        />
      </DialogContent>
    </Dialog>
    </>
  );
}

// Common ticketing platforms
const TICKETING_PLATFORMS = [
  "Eventbrite",
  "Ticketmaster",
  "Dice",
  "See Tickets",
  "Skiddle",
  "Resident Advisor",
  "AXS",
  "Ticketswap",
  "Fatsoma",
  "Other",
];

interface ExternalLinksModalContentProps {
  links: ExternalTicketLink[];
  onSave: (links: ExternalTicketLink[]) => void;
  onCancel: () => void;
}

function ExternalLinksModalContent({ links, onSave, onCancel }: ExternalLinksModalContentProps) {
  const [localLinks, setLocalLinks] = useState<ExternalTicketLink[]>(
    links.length > 0 ? [...links] : [{ id: "1", platform: "", url: "" }]
  );

  const addLink = () => {
    setLocalLinks([...localLinks, { id: String(Date.now()), platform: "", url: "" }]);
  };

  const removeLink = (id: string) => {
    if (localLinks.length > 1) {
      setLocalLinks(localLinks.filter(l => l.id !== id));
    }
  };

  const updateLink = (id: string, field: "platform" | "url", value: string) => {
    setLocalLinks(localLinks.map(l => l.id === id ? { ...l, [field]: value } : l));
  };

  const isValid = () => {
    return localLinks.every(l => l.platform.trim() !== "" && l.url.trim() !== "" && isValidUrlCheck(l.url));
  };

  const isValidUrlCheck = (url: string) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add links to external ticketing platforms where users can purchase tickets.
      </p>
      
      <div className="space-y-3 max-h-[40vh] overflow-y-auto">
        {localLinks.map((link, index) => (
          <div key={link.id} className="p-4 border rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Link {index + 1}</span>
              {localLinks.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLink(link.id)}
                  data-testid={`button-remove-modal-link-${index}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select
                value={link.platform}
                onValueChange={(value) => updateLink(link.id, "platform", value)}
              >
                <SelectTrigger data-testid={`select-platform-${index}`}>
                  <SelectValue placeholder="Select platform" />
                </SelectTrigger>
                <SelectContent>
                  {TICKETING_PLATFORMS.map((platform) => (
                    <SelectItem key={platform} value={platform}>
                      {platform}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label>Ticket URL</Label>
              <Input
                type="url"
                placeholder="https://..."
                value={link.url}
                onChange={(e) => updateLink(link.id, "url", e.target.value)}
                data-testid={`input-link-url-${index}`}
              />
              {link.url && !isValidUrlCheck(link.url) && (
                <p className="text-xs text-destructive">Please enter a valid URL</p>
              )}
            </div>
          </div>
        ))}
      </div>
      
      <Button
        variant="outline"
        onClick={addLink}
        className="w-full"
        data-testid="button-add-another-link"
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Another Link
      </Button>
      
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} data-testid="button-cancel-links">
          Cancel
        </Button>
        <Button onClick={() => onSave(localLinks)} disabled={!isValid()} data-testid="button-save-links">
          Save Links
        </Button>
      </div>
    </div>
  );
}
