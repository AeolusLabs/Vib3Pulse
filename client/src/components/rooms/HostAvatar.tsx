import { Avatar as AvatarArt } from "@/components/avatar/Avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { sanitizeAvatarConfig } from "@shared/avatar";

interface Props {
  person: { avatar?: unknown; avatarUrl?: string | null; displayName?: string | null; organizationName?: string | null; username?: string | null };
  /** Tailwind size classes for the circle/figure box. */
  className?: string;
  mode?: "portrait" | "head" | "bust" | "full";
}

/** The person's avatar figure when they made one, otherwise their photo or initial. Always decorative: the name is shown beside it. */
export default function HostAvatar({ person, className = "h-10 w-10", mode = "portrait" }: Props) {
  const name = person.displayName || person.organizationName || person.username || "?";
  if (person.avatar && sanitizeAvatarConfig(person.avatar)) {
    // overflow-hidden: the art is clipped to whatever shape the caller gives it (a circle), instead of spilling out of it
    return <AvatarArt config={person.avatar} mode={mode} className={`${className} shrink-0 overflow-hidden`} decorative />;
  }
  return (
    <Avatar className={className}>
      <AvatarImage src={person.avatarUrl || undefined} alt="" />
      <AvatarFallback className="bg-primary/15 text-primary">{name.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
