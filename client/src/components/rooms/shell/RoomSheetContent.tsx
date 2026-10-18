import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { SheetContent } from "@/components/ui/sheet";
import { ROOM_SHEET_CLOSE } from "@/lib/roomIntegration";

type Props = ComponentPropsWithoutRef<typeof SheetContent> & {
  /**
   * Where focus goes when the sheet closes. Radix returns focus to whatever was focused when the sheet opened, which is
   * gone when this sheet was opened from another sheet (Room safety from Room options). Give the button that started it.
   */
  returnFocusTo?: () => HTMLElement | null;
};

/**
 * Every room sheet: the shared Sheet with a 44 px close button (the shared one is about 16 px) and an optional focus target
 * for when it closes. Other pages' sheets are unchanged; only room sheets pass `closeClassName`.
 */
const RoomSheetContent = forwardRef<ElementRef<typeof SheetContent>, Props>(({ returnFocusTo, onCloseAutoFocus, ...props }, ref) => (
  <SheetContent
    ref={ref}
    closeClassName={ROOM_SHEET_CLOSE}
    onCloseAutoFocus={(e) => {
      onCloseAutoFocus?.(e);
      const el = returnFocusTo?.();
      if (el && el.isConnected) { e.preventDefault(); el.focus(); }
    }}
    {...props}
  />
));
RoomSheetContent.displayName = "RoomSheetContent";

export default RoomSheetContent;
