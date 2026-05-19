import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "../types";
import { motion, useAnimate } from "motion/react";

const ImagesIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = "currentColor", strokeWidth = 2, className = "" }, ref) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      animate(scope.current, { x: -2, y: 2 }, { duration: 0.2, ease: "easeOut" });
    }, [animate, scope]);

    const stop = useCallback(async () => {
      animate(scope.current, { x: 0, y: 0 }, { duration: 0.3, ease: "easeInOut" });
    }, [animate, scope]);

    useImperativeHandle(ref, () => ({ startAnimation: start, stopAnimation: stop }));

    return (
      <motion.svg
        ref={scope}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`cursor-pointer ${className}`}
        onHoverStart={start}
        onHoverEnd={stop}
      >
        <path d="M18 22H4a2 2 0 0 1-2-2V6" />
        <path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
        <circle cx="12" cy="8" r="2" />
        <rect width="16" height="16" x="6" y="2" rx="2" />
      </motion.svg>
    );
  }
);

ImagesIcon.displayName = "ImagesIcon";
export default ImagesIcon;
