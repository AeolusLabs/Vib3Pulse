import { Bell, Check, CheckCheck, Heart, MessageCircle, UserPlus, Ticket, CalendarCheck, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  useNotifications, 
  useUnreadNotificationCount, 
  useMarkNotificationAsRead, 
  useMarkAllNotificationsAsRead,
  useNotificationWebSocket,
  type NotificationWithUser 
} from "@/hooks/useNotifications";
import { formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";
import { useState } from "react";

function getNotificationIcon(type: string) {
  switch (type) {
    case "post_like":
    case "story_like":
      return <Heart className="h-4 w-4 text-red-500" />;
    case "post_comment":
    case "story_comment":
      return <MessageCircle className="h-4 w-4 text-blue-500" />;
    case "new_message":
      return <MessageCircle className="h-4 w-4 text-primary" />;
    case "new_follower":
      return <UserPlus className="h-4 w-4 text-green-500" />;
    case "event_rsvp":
      return <CalendarCheck className="h-4 w-4 text-primary" />;
    case "ticket_purchase":
      return <Ticket className="h-4 w-4 text-amber-500" />;
    case "buddy_alert":
      return <AlertTriangle className="h-4 w-4 text-red-500" />;
    default:
      return <Bell className="h-4 w-4 text-muted-foreground" />;
  }
}

function NotificationItem({ 
  notification, 
  onRead, 
  onNavigate 
}: { 
  notification: NotificationWithUser; 
  onRead: (id: string) => void;
  onNavigate: (link: string) => void;
}) {
  const handleClick = () => {
    if (!notification.isRead) {
      onRead(notification.id);
    }
    if (notification.link) {
      onNavigate(notification.link);
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`w-full flex items-start gap-3 p-3 text-left hover-elevate rounded-md transition-colors ${
        !notification.isRead ? "bg-primary/5" : ""
      }`}
      data-testid={`notification-item-${notification.id}`}
    >
      <div className="flex-shrink-0 mt-0.5">
        {notification.relatedUser ? (
          <Avatar className="h-8 w-8">
            <AvatarImage src="" alt={notification.relatedUser.displayName || notification.relatedUser.username} />
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {(notification.relatedUser.displayName || notification.relatedUser.username)?.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            {getNotificationIcon(notification.type)}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {getNotificationIcon(notification.type)}
          <span className="font-medium text-sm">{notification.title}</span>
          {!notification.isRead && (
            <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
          )}
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
          {notification.message}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
        </p>
      </div>
    </button>
  );
}

export default function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  
  const { data: notifications = [], isLoading } = useNotifications(30);
  const { data: unreadCount = 0 } = useUnreadNotificationCount();
  const markAsRead = useMarkNotificationAsRead();
  const markAllAsRead = useMarkAllNotificationsAsRead();

  useNotificationWebSocket();

  const handleMarkAsRead = (id: string) => {
    markAsRead.mutate(id);
  };

  const handleMarkAllAsRead = () => {
    markAllAsRead.mutate();
  };

  const handleNavigate = (link: string) => {
    setOpen(false);
    setLocation(link);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button 
          variant="ghost" 
          size="icon" 
          className="relative"
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge 
              variant="destructive" 
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
              data-testid="badge-unread-count"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[380px] p-0" 
        align="end"
        data-testid="notification-dropdown"
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllAsRead}
              disabled={markAllAsRead.isPending}
              data-testid="button-mark-all-read"
            >
              <CheckCheck className="h-4 w-4 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
        
        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              Loading notifications...
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No notifications yet</p>
              <p className="text-sm mt-1">You'll see updates here when people interact with your content</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onRead={handleMarkAsRead}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
