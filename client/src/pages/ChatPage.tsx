import { useState } from "react";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import CreateStoryModal from "@/components/CreateStoryModal";

//todo: remove mock functionality
const conversations = [
  {
    id: '1',
    name: 'Alex Martinez',
    username: 'alexm',
    avatar: '',
    lastMessage: 'See you at the festival!',
    timestamp: '2m ago',
    unread: 2,
    online: true
  },
  {
    id: '2',
    name: 'Maria Chen',
    username: 'mariachen',
    avatar: '',
    lastMessage: 'Thanks for the event recommendation',
    timestamp: '1h ago',
    unread: 0,
    online: true
  },
  {
    id: '3',
    name: 'Live Events Co',
    username: 'liveevents',
    avatar: '',
    lastMessage: 'Your tickets are confirmed!',
    timestamp: '3h ago',
    unread: 1,
    online: false
  },
  {
    id: '4',
    name: 'Sarah Johnson',
    username: 'sarahj',
    avatar: '',
    lastMessage: 'How was the yoga session?',
    timestamp: '1d ago',
    unread: 0,
    online: false
  }
];

export default function ChatPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [createStoryOpen, setCreateStoryOpen] = useState(false);

  const filteredConversations = conversations.filter(
    conv => 
      conv.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conv.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation userType="social" onSearch={() => {}} />

      <main className="max-w-[800px] mx-auto px-4 sm:px-6 py-6">
        <h1 className="text-3xl font-serif font-bold mb-6" data-testid="heading-chat">Messages</h1>

        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search messages..."
              className="pl-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="input-search-chat"
            />
          </div>
        </div>

        <div className="space-y-2">
          {filteredConversations.map((conversation) => (
            <Card 
              key={conversation.id} 
              className="hover-elevate cursor-pointer"
              data-testid={`card-conversation-${conversation.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={conversation.avatar} alt={conversation.name} />
                      <AvatarFallback>
                        {conversation.name.split(' ').map(n => n[0]).join('')}
                      </AvatarFallback>
                    </Avatar>
                    {conversation.online && (
                      <div className="absolute bottom-0 right-0 h-3 w-3 bg-green-500 rounded-full border-2 border-background" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <p className="font-semibold truncate" data-testid="text-contact-name">
                        {conversation.name}
                      </p>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {conversation.timestamp}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate" data-testid="text-last-message">
                      {conversation.lastMessage}
                    </p>
                  </div>

                  {conversation.unread > 0 && (
                    <div className="flex-shrink-0">
                      <div className="bg-primary text-primary-foreground rounded-full h-5 w-5 flex items-center justify-center text-xs font-medium">
                        {conversation.unread}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredConversations.length === 0 && (
          <div className="text-center py-16">
            <p className="text-muted-foreground">No messages found</p>
          </div>
        )}
      </main>

      <CreateStoryModal
        open={createStoryOpen}
        onClose={() => setCreateStoryOpen(false)}
        onCreateStory={(type, content) => console.log('Story created:', type, content)}
      />

      <BottomNavigation onCreateClick={() => setCreateStoryOpen(true)} />
    </div>
  );
}
