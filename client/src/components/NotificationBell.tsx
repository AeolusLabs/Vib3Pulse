import { useState, useMemo, useCallback } from "react";
import { NotificationItemSkeleton } from "@/components/ui/skeleton-layouts";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  useDeleteNotification,
  type NotificationWithUser,
} from "@/hooks/useNotifications";
import { formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";
import {
  BellIcon,
  CheckCheckIcon,
  CheckIcon,
  CheckCircleIcon,
  HeartIcon,
  MessageCircleIcon,
  UserPlusIcon,
  TicketIcon,
  CalendarCheckIcon,
  AlertTriangleIcon,
  ShieldIcon,
  XIcon,
} from "@/components/ui/icons";

// Ease-out quart — fast start, smooth settle. Matches DESIGN.md motion spec.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

// --- Types ---

interface NotificationGroup {
  id: string;
  type: string;
  notifications: NotificationWithUser[];
  isRead: boolean;
  link: string | null;
  createdAt: Date;
}

// --- Notification type icon ---

function getTypeIcon(type: string, className = "h-3 w-3") {
  switch (type) {
    case "post_like":
    case "story_like":
      return <HeartIcon className={`${className} text-rose-400`} />;
    case "post_comment":
    case "story_comment":
      return <MessageCircleIcon className={`${className} text-blue-400`} />;
    case "new_message":
      return <MessageCircleIcon className={`${className} text-primary`} />;
    case "new_follower":
    case "buddy_request_response":
      return <UserPlusIcon className={`${className} text-emerald-400`} />;
    case "event_rsvp":
      return <CalendarCheckIcon className={`${className} text-primary`} />;
    case "ticket_purchase":
      return <TicketIcon className={`${className} text-amber-400`} />;
    case "buddy_alert":
      return <AlertTriangleIcon className={`${className} text-rose-400`} />;
    case "buddy_request":
      return <ShieldIcon className={`${className} text-primary`} />;
    case "buddy_alert_resolved":
      return <CheckCircleIcon className={`${className} text-emerald-400`} />;
    default:
      return <BellIcon className={`${className} text-muted-foreground`} />;
  }
}

// --- Grouping ---

// Only aggregate repeated social actions (likes, follows) within the same hour.
// Messages, buddy alerts, comments, and RSVPs always show individually.
const GROUPABLE_TYPES = new Set(["post_like", "story_like", "new_follower"]);

function groupNotifications(items: NotificationWithUser[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const map = new Map<string, NotificationGroup>();

  for (const n of items) {
    const hourBucket = Math.floor(new Date(n.createdAt).getTime() / (60 * 60 * 1000));
    const key = GROUPABLE_TYPES.has(n.type)
      ? `${n.type}:${n.relatedEntityId ?? ""}:${hourBucket}`
      : n.id;

    if (map.has(key)) {
      const g = map.get(key)!;
      g.notifications.push(n);
      if (!n.isRead) g.isRead = false;
    } else {
      const g: NotificationGroup = {
        id: n.id,
        type: n.type,
        notifications: [n],
        isRead: n.isRead,
        link: n.link,
        createdAt: new Date(n.createdAt),
      };
      map.set(key, g);
      groups.push(g);
    }
  }

  return groups;
}

function buildGroupTitle(g: NotificationGroup): string {
  const { notifications, type } = g;
  if (notifications.length === 1) return notifications[0].title;

  const names = notifications
    .slice(0, 2)
    .map((n) => n.relatedUser?.displayName || n.relatedUser?.username || "Someone");

  const rest = notifications.length - 2;
  const nameStr =
    rest > 0 ? `${names.join(", ")} and ${rest} other${rest > 1 ? "s" : ""}` : names.join(" and ");

  const verb =
    type === "post_like"
      ? "liked your post"
      : type === "story_like"
        ? "liked your story"
        : "followed you";

  return `${nameStr} ${verb}`;
}


// --- Empty state ---

function EmptyState({ tab }: { tab: string }) {
  const config: Record<string, { icon: typeof BellIcon; heading: string; sub: string }> = {
    all: { icon: BellIcon, heading: "All caught up", sub: "New activity will appear here" },
    messages: {
      icon: MessageCircleIcon,
      heading: "No messages yet",
      sub: "When someone messages you, you'll see it here",
    },
    safety: {
      icon: ShieldIcon,
      heading: "No safety alerts",
      sub: "Buddy requests and SOS alerts appear here",
    },
  };
  const { icon: Icon, heading, sub } = config[tab] ?? config.all;

  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <div className="h-11 w-11 rounded-full bg-muted/50 flex items-center justify-center mb-3">
        <Icon className="h-5 w-5 text-muted-foreground/50" />
      </div>
      <p className="text-sm font-medium text-foreground/70">{heading}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-[200px] leading-relaxed">{sub}</p>
    </div>
  );
}

// --- Notification item ---

function NotificationItem({
  group,
  index,
  onRead,
  onDelete,
  onNavigate,
}: {
  group: NotificationGroup;
  index: number;
  onRead: (ids: string[]) => void;
  onDelete: (id: string) => void;
  onNavigate: (link: string) => void;
}) {
  const primary = group.notifications[0];
  const isGrouped = group.notifications.length > 1;
  const hasLink = !!group.link;
  const title = buildGroupTitle(group);
  const avatarSrc = primary.relatedUser?.avatarUrl ?? undefined;
  const avatarAlt = primary.relatedUser?.displayName || primary.relatedUser?.username || "User";
  const initial = avatarAlt.charAt(0).toUpperCase();

  const allIds = group.notifications.map((n) => n.id);

  const handleClick = useCallback(() => {
    if (!group.isRead) onRead(allIds);
    if (group.link) onNavigate(group.link);
  }, [group.isRead, group.link, allIds, onRead, onNavigate]);

  const handleMarkRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRead(allIds);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(group.id);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{
        duration: 0.17,
        ease: EASE_OUT,
        delay: Math.min(index * 0.035, 0.21),
      }}
      className="group relative border-b border-border/40 last:border-b-0"
    >
      {/* Unread accent — subtle left stripe replaced by bg tint */}
      {!group.isRead && (
        <span className="absolute inset-0 bg-primary/[0.04] pointer-events-none" aria-hidden />
      )}

      <div
        role={hasLink ? "button" : "article"}
        tabIndex={hasLink ? 0 : undefined}
        onClick={hasLink ? handleClick : undefined}
        onKeyDown={hasLink ? (e) => e.key === "Enter" && handleClick() : undefined}
        aria-label={hasLink ? title : undefined}
        className={[
          "relative flex items-start gap-3 px-4 py-3.5 transition-colors duration-150",
          hasLink ? "cursor-pointer hover:bg-muted/30" : "cursor-default",
        ].join(" ")}
      >
        {/* Avatar + type badge */}
        <div className="flex-shrink-0 mt-0.5">
          <div className="relative">
            <Avatar className="h-10 w-10 border-2 border-background ring-1 ring-border/40">
              <AvatarImage src={avatarSrc} alt={avatarAlt} />
              <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                {initial}
              </AvatarFallback>
            </Avatar>
            {/* Type icon — absolute bottom-right */}
            <div className="absolute -bottom-1 -right-1 h-[18px] w-[18px] rounded-full bg-background border border-border/50 flex items-center justify-center shadow-sm">
              {getTypeIcon(group.type, "h-2.5 w-2.5")}
            </div>
          </div>

          {/* Stacked mini-avatars for grouped notifications */}
          {isGrouped && group.notifications.length > 1 && (
            <div className="flex -space-x-2 mt-1.5 ml-1">
              {group.notifications.slice(1, 3).map((n, i) => (
                <Avatar
                  key={n.id}
                  className="h-4 w-4 border border-background"
                  style={{ zIndex: 2 - i }}
                >
                  <AvatarImage src={n.relatedUser?.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="bg-muted text-[7px]">
                    {(n.relatedUser?.displayName || n.relatedUser?.username || "?")
                      .charAt(0)
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-14">
          <div className="flex items-start gap-1.5">
            <span className="text-sm font-medium text-foreground leading-snug line-clamp-2 flex-1">
              {title}
            </span>
            {/* Unread dot — static, not pulsing */}
            {!group.isRead && (
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-primary flex-shrink-0"
                aria-label="Unread"
              />
            )}
          </div>
          {!isGrouped && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
              {primary.message}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/60 mt-1 tabular-nums">
            {formatDistanceToNow(new Date(primary.createdAt), { addSuffix: true })}
          </p>
        </div>
      </div>

      {/* Hover action buttons — revealed on group:hover, hidden on touch */}
      <div
        aria-hidden
        className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1
          opacity-0 pointer-events-none
          group-hover:opacity-100 group-hover:pointer-events-auto
          transition-opacity duration-150
          [@media(hover:none)]:hidden"
      >
        {!group.isRead && (
          <button
            onClick={handleMarkRead}
            aria-label="Mark as read"
            className="h-7 w-7 min-w-[44px] rounded-full bg-background/90 backdrop-blur-sm
              border border-border/50 flex items-center justify-center
              text-muted-foreground hover:text-foreground hover:bg-muted
              transition-colors duration-150 shadow-sm
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <CheckIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={handleDelete}
          aria-label="Dismiss notification"
          className="h-7 w-7 min-w-[44px] rounded-full bg-background/90 backdrop-blur-sm
            border border-border/50 flex items-center justify-center
            text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10
            transition-colors duration-150 shadow-sm
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

// --- Notification list ---

function NotificationList({
  groups,
  tab,
  onRead,
  onDelete,
  onNavigate,
}: {
  groups: NotificationGroup[];
  tab: string;
  onRead: (ids: string[]) => void;
  onDelete: (id: string) => void;
  onNavigate: (link: string) => void;
}) {
  if (groups.length === 0) return <EmptyState tab={tab} />;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {groups.map((group, index) => (
        <NotificationItem
          key={group.id}
          group={group}
          index={index}
          onRead={onRead}
          onDelete={onDelete}
          onNavigate={onNavigate}
        />
      ))}
    </AnimatePresence>
  );
}

// --- Tab trigger with count badge ---

function TabBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 h-4 min-w-[16px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-semibold inline-flex items-center justify-center tabular-nums">
      {count > 9 ? "9+" : count}
    </span>
  );
}

// --- Main component ---

export default function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  const { data: notifications = [], isLoading } = useNotifications(50);
  const { data: unreadCount = 0 } = useUnreadNotificationCount();
  const markAsRead = useMarkNotificationAsRead();
  const markAllAsRead = useMarkAllNotificationsAsRead();
  const deleteNotification = useDeleteNotification();

  // Partition by tab
  const tabItems = useMemo(() => {
    const safetyTypes = new Set([
      "buddy_alert",
      "buddy_alert_resolved",
      "buddy_request",
      "buddy_request_response",
      "buddy_timer_expiry",
    ]);
    return {
      all: notifications,
      messages: notifications.filter((n) => n.type === "new_message"),
      safety: notifications.filter((n) => safetyTypes.has(n.type)),
    };
  }, [notifications]);

  const allGrouped = useMemo(
    () => ({
      all: groupNotifications(tabItems.all),
      messages: groupNotifications(tabItems.messages),
      safety: groupNotifications(tabItems.safety),
    }),
    [tabItems],
  );

  const tabUnread = useMemo(
    () => ({
      messages: tabItems.messages.filter((n) => !n.isRead).length,
      safety: tabItems.safety.filter((n) => !n.isRead).length,
    }),
    [tabItems],
  );

  const handleMarkAsRead = useCallback(
    (ids: string[]) => ids.forEach((id) => markAsRead.mutate(id)),
    [markAsRead],
  );

  const handleDelete = useCallback(
    (id: string) => deleteNotification.mutate(id),
    [deleteNotification],
  );

  const handleNavigate = useCallback(
    (link: string) => {
      setOpen(false);
      setLocation(link);
    },
    [setLocation],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
          data-testid="button-notifications"
        >
          <span className="relative inline-flex">
            <BellIcon className="h-5 w-5" />
            <AnimatePresence>
              {unreadCount > 0 && (
                <motion.span
                  key="badge"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.15, ease: EASE_OUT }}
                  className="absolute -top-2 -right-2 pointer-events-none"
                >
                  <span
                    className="min-w-[18px] h-[18px] px-1 bg-destructive text-destructive-foreground
                      flex items-center justify-center text-[10px] font-semibold rounded-full
                      border-2 border-background tabular-nums"
                    data-testid="badge-unread-count"
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[min(380px,calc(100vw-16px))] p-0 shadow-xl border-border/60 overflow-hidden"
        align="end"
        sideOffset={8}
        style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
        data-testid="notification-dropdown"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground -mr-1 gap-1"
              onClick={() => markAllAsRead.mutate()}
              disabled={markAllAsRead.isPending}
              data-testid="button-mark-all-read"
            >
              <CheckCheckIcon className="h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full rounded-none border-b border-border/50 bg-transparent h-auto p-0">
            {(["all", "messages", "safety"] as const).map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className="flex-1 rounded-none h-10 border-b-2 border-transparent
                  data-[state=active]:border-primary data-[state=active]:bg-transparent
                  data-[state=active]:shadow-none data-[state=active]:text-foreground
                  text-xs font-medium capitalize text-muted-foreground
                  transition-colors duration-150
                  focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-primary"
              >
                {tab}
                {tab === "messages" && <TabBadge count={tabUnread.messages} />}
                {tab === "safety" && <TabBadge count={tabUnread.safety} />}
              </TabsTrigger>
            ))}
          </TabsList>

          {(["all", "messages", "safety"] as const).map((tab) => (
            <TabsContent key={tab} value={tab} className="m-0">
              <ScrollArea className="h-[360px]">
                {isLoading ? (
                  Array.from({ length: 5 }, (_, i) => <NotificationItemSkeleton key={i} index={i} />)
                ) : (
                  <NotificationList
                    groups={allGrouped[tab]}
                    tab={tab}
                    onRead={handleMarkAsRead}
                    onDelete={handleDelete}
                    onNavigate={handleNavigate}
                  />
                )}
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}