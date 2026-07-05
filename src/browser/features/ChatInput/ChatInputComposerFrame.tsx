import type { ReactNode } from "react";
import { cn } from "@/common/lib/utils";

interface ChatInputComposerFrameProps {
  variant: "creation" | "workspace";
  toastLayer: ReactNode;
  children: ReactNode;
}

export function ChatInputComposerFrame(props: ChatInputComposerFrameProps) {
  return (
    <div
      data-component="ChatInputComposerFrame"
      // Anchor stacked toasts to the centered composer column, not the full bottom bar.
      className={cn("relative w-full", props.variant !== "creation" && "mx-auto max-w-4xl")}
    >
      <div
        data-component="ChatInputToastOverlay"
        className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 flex flex-col gap-2 [&>*]:pointer-events-auto"
      >
        {props.toastLayer}
      </div>
      {props.children}
    </div>
  );
}
