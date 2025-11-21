import { useState, useEffect } from "react";
import { X, Upload, Plus, Trash2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  entryType: "free" | "ticketed";
  thumbnailUrl: string;
  
  // Step 2
  tickets: TicketTier[];
  requireRSVP: boolean;
  rsvpGeneratesTicket: boolean;
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
  "Entertainment"
];

export default function CreateEventModal({ open, onClose, event }: CreateEventModalProps) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const isEditMode = !!event;
  
  const [formData, setFormData] = useState<EventFormData>({
    name: "",
    type: "",
    description: "",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    isMultiDay: false, // Kept in state but UI removed - schema only supports single date
    locationType: "physical",
    location: "",
    ageRestriction: "all",
    parentalGuidance: "none",
    entryType: "free",
    thumbnailUrl: "",
    tickets: [],
    requireRSVP: false,
    rsvpGeneratesTicket: true,
  });

  // Pre-fill form when editing
  useEffect(() => {
    if (event && open) {
      const eventDate = new Date(event.eventDate);
      const date = eventDate.toISOString().split('T')[0];
      const time = eventDate.toTimeString().slice(0, 5);
      
      setFormData({
        name: event.title,
        type: event.category,
        description: event.description,
        startDate: date,
        startTime: time,
        endDate: "",
        endTime: "",
        isMultiDay: false,
        locationType: "physical",
        location: event.location,
        ageRestriction: "all",
        parentalGuidance: "none",
        entryType: event.ticketPrice === 0 ? "free" : "ticketed",
        thumbnailUrl: event.imageUrl || "",
        tickets: event.ticketPrice > 0 ? [{
          id: "1",
          name: "General Admission",
          price: event.ticketPrice,
          quantity: event.ticketsAvailable,
          salesEndDate: date,
        }] : [],
        requireRSVP: event.requiresRSVP,
        rsvpGeneratesTicket: true,
      });
    } else if (!open) {
      // Reset form when modal closes
      setStep(1);
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
        tickets: [],
        requireRSVP: false,
        rsvpGeneratesTicket: true,
      });
    }
  }, [event, open]);

  const createEventMutation = useMutation<Event, Error, EventCreateDto>({
    mutationFn: async (eventData) => {
      const response = await apiRequest('POST', '/api/events', eventData);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
      toast({
        title: "Event created!",
        description: "Your event has been successfully created.",
      });
      onClose();
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
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
      toast({
        title: "Event updated!",
        description: "Your event has been successfully updated.",
      });
      onClose();
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
    
    // Calculate ticket price and quantity
    const ticketPrice = formData.entryType === "free" 
      ? 0 
      : (formData.tickets[0]?.price || 0);
    
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
      location: formData.location,
      category: formData.type,
      ticketPrice: ticketPrice,
      requiresRSVP: formData.requireRSVP,
      ticketsAvailable: ticketsAvailable,
      imageUrl: formData.thumbnailUrl || null,
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

  const handleThumbnailUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      //todo: replace mock functionality with real upload
      const mockUrl = URL.createObjectURL(file);
      updateFormData({ thumbnailUrl: mockUrl });
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

  const isStep1Valid = () => {
    const baseValid = (
      formData.name.trim() !== "" &&
      formData.type !== "" &&
      formData.description.trim() !== "" &&
      formData.startDate !== "" &&
      formData.startTime !== "" &&
      formData.location.trim() !== "" &&
      formData.thumbnailUrl !== ""
    );
    
    if (formData.isMultiDay) {
      if (formData.endDate === "" || formData.endTime === "") {
        return false;
      }
      // Ensure end date/time is after start date/time
      const startDateTime = new Date(`${formData.startDate}T${formData.startTime}`);
      const endDateTime = new Date(`${formData.endDate}T${formData.endTime}`);
      return baseValid && endDateTime > startDateTime;
    }
    
    return baseValid;
  };

  const isStep2Valid = () => {
    if (formData.entryType === "ticketed") {
      return formData.tickets.length > 0 && formData.tickets.every(t =>
        t.name.trim() !== "" && t.price > 0 && t.quantity > 0 && t.salesEndDate !== ""
      );
    }
    return true;
  };

  return (
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start-date">Start Date *</Label>
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
                onValueChange={(value: "free" | "ticketed") => updateFormData({ entryType: value })}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="free" id="free" data-testid="radio-free" />
                  <Label htmlFor="free">Free Event</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="ticketed" id="ticketed" data-testid="radio-ticketed" />
                  <Label htmlFor="ticketed">Ticketed Event</Label>
                </div>
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
            {formData.entryType === "ticketed" ? (
              <>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">Ticket Tiers</h3>
                      <p className="text-sm text-muted-foreground">
                        Create different ticket types for your event
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
                                <h4 className="font-semibold">Tier {index + 1}</h4>
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

                {formData.entryType === "ticketed" ? (
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
                          <p className="font-semibold text-primary">${ticket.price.toFixed(2)}</p>
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
  );
}
