import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "../types";
import { motion, useAnimate } from "motion/react";

const ReplaceIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = "currentColor", strokeWidth = 2, className = "" }, ref) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      animate(scope.current, { rotate: 180 }, { duration: 0.4, ease: "easeInOut" });
    }, [animate, scope]);

    const stop = useCallback(async () => {
      animate(scope.current, { rotate: 0 }, { duration: 0.4, ease: "easeInOut" });
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
        <path d="M14 4a2 2 0 0 1 2-2" />
        <path d="M16 10a2 2 0 0 1-2-2" />
        <path d="M20 2a2 2 0 0 1 2 2" />
        <path d="M22 8a2 2 0 0 1-2 2" />
        <path d="m3 7 3 3 3-3" />
        <path d="M6 10V5a3 3 0 0 1 3-3h1" />
        <rect x="2" y="14" width="8" height="8" rx="2" />
      </motion.svg>
    );
  }
);

ReplaceIcon.displayName = "ReplaceIcon";
export default ReplaceIcon;
