import { cn } from "@/lib/utils"
import { Skeleton } from "./skeleton"

export function PostSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="p-4 space-y-3" style={{ animationDelay: `${index * 50}ms` }}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-3 w-10" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="flex gap-6 pt-1">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-8 ml-auto" />
      </div>
    </div>
  )
}

export function StoryCircleSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="flex flex-col items-center gap-1.5 flex-shrink-0"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Skeleton className="h-14 w-14 rounded-full" />
      <Skeleton className="h-2.5 w-12 rounded-full" />
    </div>
  )
}

export function ProfileHeaderSkeleton() {
  return (
    <div>
      <Skeleton className="h-40 md:h-52 rounded-none" />
      <div className="px-4 pb-4">
        <div className="flex justify-between items-end -mt-14 mb-4">
          <Skeleton className="h-28 w-28 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
        <Skeleton className="h-6 w-40 mb-2" />
        <Skeleton className="h-4 w-28 mb-3" />
        <Skeleton className="h-4 w-full mb-1.5" />
        <Skeleton className="h-4 w-3/4 mb-4" />
        <div className="flex gap-6">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  )
}

export function CommentSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="flex gap-3" style={{ animationDelay: `${index * 50}ms` }}>
      <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  )
}

export function NotificationItemSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="flex items-start gap-3 px-4 py-3.5 border-b border-border/40"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-2 pt-1">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-2.5 w-1/4" />
      </div>
    </div>
  )
}

export function ConversationItemSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <Skeleton className="h-12 w-12 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="flex justify-between items-center gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    </div>
  )
}

export function MessageBubbleSkeleton({ index = 0 }: { index?: number }) {
  const isOwn = index % 2 === 0
  return (
    <div
      className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-1`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Skeleton
        className={cn("h-10 rounded-2xl", isOwn ? "w-40 rounded-br-sm" : "w-48 rounded-bl-sm")}
      />
    </div>
  )
}

export function EventCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="rounded-xl overflow-hidden border border-border"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="p-4 space-y-2.5">
        <Skeleton className="h-5 w-3/4" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3.5 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      </div>
    </div>
  )
}

export function SearchResultSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Skeleton className="h-12 w-12 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3.5 w-24" />
      </div>
      <Skeleton className="h-8 w-20 rounded-full" />
    </div>
  )
}

export function UserListItemSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="flex items-center gap-3 p-3"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  )
}