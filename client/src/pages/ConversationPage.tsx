import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Send, MoreVertical, Phone, Video } from "lucide-react";
import { Card } from "@/components/ui/card";
import CreateStoryModal from "@/components/CreateStoryModal";

interface Message {
  id: string;
  senderId: string;
  text: string;
  timestamp: string;
  read: boolean;
}

interface Contact {
  id: string;
  name: string;
  username: string;
  avatar: string;
  online: boolean;
}

//todo: remove mock functionality
const mockContacts: Record<string, Contact> = {
  '1': {
    id: '1',
    name: 'Alex Martinez',
    username: 'alexm',
    avatar: '',
    online: true
  },
  '2': {
    id: '2',
    name: 'Maria Chen',
    username: 'mariachen',
    avatar: '',
    online: true
  },
  '3': {
    id: '3',
    name: 'Live Events Co',
    username: 'liveevents',
    avatar: '',
    online: false
  },
  '4': {
    id: '4',
    name: 'Sarah Johnson',
    username: 'sarahj',
    avatar: '',
    online: false
  }
};

//todo: remove mock functionality
const mockMessages: Record<string, Message[]> = {
  '1': [
    { id: '1', senderId: '1', text: 'Hey! Are you going to the Summer Music Festival?', timestamp: '10:30 AM', read: true },
    { id: '2', senderId: 'me', text: 'Yes! I just got my tickets 🎵', timestamp: '10:32 AM', read: true },
    { id: '3', senderId: '1', text: 'Awesome! We should meet up there', timestamp: '10:33 AM', read: true },
    { id: '4', senderId: 'me', text: 'Definitely! What time are you planning to arrive?', timestamp: '10:35 AM', read: true },
    { id: '5', senderId: '1', text: 'Probably around 2pm, want to catch the first few acts', timestamp: '10:36 AM', read: true },
    { id: '6', senderId: '1', text: 'See you at the festival!', timestamp: '10:38 AM', read: false }
  ],
  '2': [
    { id: '1', senderId: '2', text: 'Thanks for the event recommendation!', timestamp: 'Yesterday', read: true },
    { id: '2', senderId: 'me', text: 'No problem! I thought you\'d love the yoga session', timestamp: 'Yesterday', read: true },
    { id: '3', senderId: '2', text: 'It was perfect! The instructor was amazing', timestamp: 'Yesterday', read: true }
  ],
  '3': [
    { id: '1', senderId: '3', text: 'Thank you for your ticket purchase!', timestamp: '2 hours ago', read: true },
    { id: '2', senderId: '3', text: 'Your tickets are confirmed!', timestamp: '2 hours ago', read: true },
    { id: '3', senderId: 'me', text: 'Great! Can I get a refund if something comes up?', timestamp: '1 hour ago', read: true }
  ],
  '4': [
    { id: '1', senderId: '4', text: 'How was the yoga session?', timestamp: '1 day ago', read: true },
    { id: '2', senderId: 'me', text: 'It was really relaxing! You should come next time', timestamp: '1 day ago', read: true }
  ]
};

export default function ConversationPage() {
  const [, params] = useRoute("/chat/:userId");
  const [, navigate] = useLocation();
  const userId = params?.userId || '1';
  const currentUser = 'me';
  
  const contact = mockContacts[userId];
  const [messages, setMessages] = useState<Message[]>(mockMessages[userId] || []);
  const [newMessage, setNewMessage] = useState("");
  const [createStoryOpen, setCreateStoryOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = () => {
    if (newMessage.trim()) {
      const message: Message = {
        id: String(messages.length + 1),
        senderId: currentUser,
        text: newMessage,
        timestamp: 'Just now',
        read: false
      };
      setMessages([...messages, message]);
      setNewMessage("");
      
      //todo: replace with backend mutation
      console.log('Sending message:', message);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (!contact) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Conversation not found</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0 flex flex-col">
      <Navigation userType="social" onSearch={() => {}} />

      <div className="flex-1 flex flex-col max-w-[1000px] mx-auto w-full">
        <div className="sticky top-0 z-10 bg-background border-b">
          <div className="flex items-center gap-3 px-4 py-3">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => navigate('/chat')}
              data-testid="button-back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>

            <div className="relative">
              <Avatar className="h-10 w-10">
                <AvatarImage src={contact.avatar} alt={contact.name} />
                <AvatarFallback>
                  {contact.name.split(' ').map(n => n[0]).join('')}
                </AvatarFallback>
              </Avatar>
              {contact.online && (
                <div className="absolute bottom-0 right-0 h-3 w-3 bg-green-500 rounded-full border-2 border-background" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate" data-testid="text-contact-name">
                {contact.name}
              </p>
              <p className="text-sm text-muted-foreground" data-testid="text-contact-status">
                {contact.online ? 'Active now' : 'Offline'}
              </p>
            </div>

            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                data-testid="button-voice-call"
              >
                <Phone className="h-5 w-5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                data-testid="button-video-call"
              >
                <Video className="h-5 w-5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                data-testid="button-more-options"
              >
                <MoreVertical className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="space-y-4 max-w-[800px] mx-auto">
            {messages.map((message) => {
              const isSent = message.senderId === currentUser;
              
              return (
                <div
                  key={message.id}
                  className={`flex ${isSent ? 'justify-end' : 'justify-start'}`}
                  data-testid={`message-${message.id}`}
                >
                  <div className={`flex gap-2 max-w-[70%] ${isSent ? 'flex-row-reverse' : 'flex-row'}`}>
                    {!isSent && (
                      <Avatar className="h-8 w-8 flex-shrink-0">
                        <AvatarImage src={contact.avatar} alt={contact.name} />
                        <AvatarFallback className="text-xs">
                          {contact.name.split(' ').map(n => n[0]).join('')}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    
                    <div className={`flex flex-col ${isSent ? 'items-end' : 'items-start'}`}>
                      <div
                        className={`rounded-2xl px-4 py-2 ${
                          isSent
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        }`}
                        data-testid={`message-bubble-${message.id}`}
                      >
                        <p className="text-sm break-words">{message.text}</p>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1 px-1" data-testid={`message-timestamp-${message.id}`}>
                        {message.timestamp}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="sticky bottom-0 bg-background border-t p-4">
          <div className="max-w-[800px] mx-auto">
            <div className="flex items-end gap-2">
              <Input
                type="text"
                placeholder="Type a message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                className="flex-1 resize-none"
                data-testid="input-message"
              />
              <Button
                size="icon"
                onClick={handleSendMessage}
                disabled={!newMessage.trim()}
                data-testid="button-send"
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <CreateStoryModal
        open={createStoryOpen}
        onClose={() => setCreateStoryOpen(false)}
        onCreateStory={(type, content) => console.log('Story created:', type, content)}
      />

      <BottomNavigation onCreateClick={() => setCreateStoryOpen(true)} />
    </div>
  );
}
