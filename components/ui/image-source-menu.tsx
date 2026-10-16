"use client";

import type { ReactNode } from "react";
import { Images, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

type Props = {
  /** Opens the file dialog. Called inside the click, so the browser allows it. */
  onUpload: () => void;
  /** Opens the Media Library picker. */
  onChooseFromLibrary: () => void;
  /** What the add control looks like; it becomes the menu's button. */
  children: ReactNode;
  className?: string;
  /** Accessible name when `children` is only an icon. */
  label?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
};

/**
 * An "add image" control that asks where the image comes from: the computer
 * or the store's Media Library. One button per photo slot, so a merchant never
 * has to find a second control to reuse a photo they already have.
 */
export function ImageSourceMenu({
  onUpload,
  onChooseFromLibrary,
  children,
  className,
  label,
  disabled = false,
  align = "center",
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={disabled}
        aria-label={label}
        className={className}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-auto min-w-[220px]">
        <DropdownMenuItem className="cursor-pointer" onClick={onUpload}>
          <Upload aria-hidden />
          Upload from computer
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={onChooseFromLibrary}
        >
          <Images aria-hidden />
          Choose from Media Library
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
