import { VolumeXIcon } from "@/components/ui/icons";

/** Small corner badge on a muted guest's avatar. Decorative: the avatar button's label already says "muted". */
export function MicOffMark() {
  return <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow" aria-hidden><VolumeXIcon className="h-3 w-3" /></span>;
}
